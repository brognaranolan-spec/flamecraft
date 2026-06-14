/**
 * FLAMECRAFT — Worker de paiement Stripe (Cloudflare Workers)
 * --------------------------------------------------------------
 * Rôle : créer un PaymentIntent Stripe côté serveur (la clé SECRÈTE
 * ne doit JAMAIS être dans le navigateur). Renvoie le `clientSecret`
 * que le site utilise pour afficher carte / Apple Pay / Google Pay / PayPal.
 *
 * SÉCURITÉ : le Worker NE FAIT PAS confiance au montant envoyé par le
 * navigateur. Il **recalcule lui-même** le total à partir d'un catalogue
 * de prix de référence (CATALOG ci-dessous) et des articles (type+id+qty).
 * Impossible donc de payer moins que le vrai prix en bidouillant la requête.
 *
 * ⚠️ Garder CATALOG synchronisé avec les prix de index.html (COQUES / FIGS).
 *
 * Variables d'environnement (Cloudflare > Settings > Variables) :
 *   - STRIPE_SECRET_KEY   (obligatoire, "Encrypt")  sk_test_... puis sk_live_...
 *   - ALLOWED_ORIGIN      (optionnel) ex : https://brognaranolan-spec.github.io
 *
 * Endpoint : POST /create-payment-intent
 *   body JSON : { currency:"eur", email, ref, items:[{type,id,qty}, ...] }
 *   réponse   : { clientSecret, amount }
 */

// Prix de référence en CENTIMES — clé = "type:id" (type = "coque" ou "fig")
const CATALOG = {
  "coque:0": 1390, "coque:1": 1450, "coque:2": 1890,
  "coque:3": 1390, "coque:4": 1550, "coque:5": 1990,
  "fig:0": 3400, "fig:1": 2800, "fig:2": 2600, "fig:3": 3800
};
const FREE_SHIPPING_THRESHOLD = 5000; // 50,00 €
const SHIPPING_FEE = 490;             // 4,90 €

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method === "GET") return json({ ok: true, service: "flamecraft-pay" }, 200, cors);

    const url = new URL(request.url);
    if (request.method !== "POST" || !url.pathname.endsWith("/create-payment-intent")) {
      return json({ error: "Not found" }, 404, cors);
    }
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: "STRIPE_SECRET_KEY non configurée sur le Worker" }, 500, cors);
    }

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "JSON invalide" }, 400, cors); }

    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) return json({ error: "Panier vide" }, 400, cors);

    // ── Recalcul du total à partir du catalogue de référence ──
    let subtotal = 0;
    const summary = [];
    for (const it of items) {
      const key = String(it.type) + ":" + String(it.id);
      const price = CATALOG[key];
      if (price === undefined) {
        return json({ error: "Article inconnu : " + key }, 400, cors);
      }
      let qty = parseInt(it.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) qty = 1;
      if (qty > 99) qty = 99;
      subtotal += price * qty;
      summary.push(key + "x" + qty);
    }
    const shipping = (subtotal >= FREE_SHIPPING_THRESHOLD || subtotal === 0) ? 0 : SHIPPING_FEE;
    const amount = subtotal + shipping;

    // garde-fou final
    if (amount < 50 || amount > 500000) {
      return json({ error: "Montant hors limites" }, 400, cors);
    }

    const currency = (body.currency || "eur").toLowerCase();
    const form = new URLSearchParams();
    form.set("amount", String(amount));
    form.set("currency", currency);
    form.set("automatic_payment_methods[enabled]", "true");
    if (body.email) form.set("receipt_email", String(body.email).slice(0, 200));
    if (body.ref) form.set("metadata[ref]", String(body.ref).slice(0, 100));
    form.set("metadata[items]", summary.join(",").slice(0, 480));
    form.set("metadata[computed_amount]", String(amount));

    const resp = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });
    const data = await resp.json();
    if (!resp.ok) {
      return json({ error: (data.error && data.error.message) || "Erreur Stripe" }, 502, cors);
    }
    return json({ clientSecret: data.client_secret, amount: amount }, 200, cors);
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, cors)
  });
}
