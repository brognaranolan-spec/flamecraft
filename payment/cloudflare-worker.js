/**
 * FLAMECRAFT — Worker de paiement Stripe (Cloudflare Workers)
 * --------------------------------------------------------------
 * Rôle : créer un PaymentIntent Stripe côté serveur (la clé SECRÈTE
 * ne doit JAMAIS être dans le navigateur). Renvoie le `clientSecret`
 * que le site utilise pour afficher carte / Apple Pay / Google Pay / PayPal.
 *
 * Variables d'environnement à définir dans Cloudflare (Settings > Variables) :
 *   - STRIPE_SECRET_KEY   (obligatoire, "Encrypt")  ex : sk_test_... puis sk_live_...
 *   - ALLOWED_ORIGIN      (optionnel) ex : https://brognaranolan-spec.github.io
 *
 * Endpoint : POST /create-payment-intent
 *   body JSON : { amount: <centimes int>, currency: "eur", email, ref, items:[...] }
 *   réponse   : { clientSecret: "pi_..._secret_..." }
 */
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

    const url = new URL(request.url);
    // petit health-check
    if (request.method === "GET") return json({ ok: true, service: "flamecraft-pay" }, 200, cors);

    if (request.method !== "POST" || !url.pathname.endsWith("/create-payment-intent")) {
      return json({ error: "Not found" }, 404, cors);
    }
    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: "STRIPE_SECRET_KEY non configurée sur le Worker" }, 500, cors);
    }

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "JSON invalide" }, 400, cors); }

    const amount = parseInt(body.amount, 10);
    const currency = (body.currency || "eur").toLowerCase();
    // garde-fous : entre 0,50 € et 5 000 €
    if (!Number.isInteger(amount) || amount < 50 || amount > 500000) {
      return json({ error: "Montant invalide" }, 400, cors);
    }

    const form = new URLSearchParams();
    form.set("amount", String(amount));
    form.set("currency", currency);
    form.set("automatic_payment_methods[enabled]", "true");
    if (body.email) form.set("receipt_email", String(body.email).slice(0, 200));
    if (body.ref) form.set("metadata[ref]", String(body.ref).slice(0, 100));
    if (body.items) {
      try { form.set("metadata[items]", JSON.stringify(body.items).slice(0, 480)); } catch (e) {}
    }

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
    return json({ clientSecret: data.client_secret }, 200, cors);
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, cors)
  });
}
