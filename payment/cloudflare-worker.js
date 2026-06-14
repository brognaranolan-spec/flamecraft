/**
 * FLAMECRAFT — Worker Cloudflare (paiement + backend dashboard)
 * =============================================================
 * Ce Worker fait 2 choses :
 *   1) PAIEMENT : crée un PaymentIntent Stripe. Le montant est TOUJOURS
 *      recalculé côté serveur (catalogue de référence ci-dessous + prix
 *      publiés dans le KV) → impossible de payer moins en bidouillant.
 *   2) BACKEND DASHBOARD (temps réel) : config produits/contenu, modèles 3D,
 *      analytics (vues/achats), commandes (lues depuis Stripe).
 *
 * Bindings / variables à configurer dans Cloudflare (Settings) :
 *   - STRIPE_SECRET_KEY  (Secret)  sk_test_... puis sk_live_...        [paiement]
 *   - ADMIN_TOKEN        (Secret)  mot de passe du dashboard            [admin]
 *   - KV  (KV Namespace binding, nom de variable = "KV")               [stockage]
 *   - ALLOWED_ORIGIN     (optionnel) ex : https://brognaranolan-spec.github.io
 *
 * Endpoints :
 *   GET  /                        → health
 *   GET  /config                  → config publiée (produits + contenu) [public]
 *   POST /create-payment-intent   → { clientSecret, amount }            [public]
 *   POST /track                   → { event, key?, amount? }            [public]
 *   GET  /model/:key              → fichier 3D (STL/OBJ)                 [public]
 *   POST /admin/config            → enregistre la config                [admin]
 *   GET  /admin/stats             → analytics agrégées                  [admin]
 *   GET  /admin/orders            → commandes (depuis Stripe)           [admin]
 *   POST /admin/model/:key        → importe un modèle 3D (corps = fichier)[admin]
 *   DELETE /admin/model/:key      → supprime un modèle 3D               [admin]
 *   GET  /admin/ping              → vérifie le token admin              [admin]
 */

// Prix de référence en CENTIMES — clé = "type:id" (type = "coque" ou "fig").
// Sert de repli si le KV n'a pas de prix publié pour un article.
const DEFAULT_CATALOG = {
  "coque:0": 1390, "coque:1": 1450, "coque:2": 1890,
  "coque:3": 1390, "coque:4": 1550, "coque:5": 1990,
  "fig:0": 3400, "fig:1": 2800, "fig:2": 2600, "fig:3": 3800
};
const FREE_SHIPPING_THRESHOLD = 5000; // 50,00 €
const SHIPPING_FEE = 490;             // 4,90 €
const MAX_MODEL_BYTES = 9 * 1024 * 1024; // 9 Mo max par modèle 3D

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // ───────── Public ─────────
      if (request.method === "GET" && path === "/") {
        return json({ ok: true, service: "flamecraft-pay", kv: !!env.KV, admin: !!env.ADMIN_TOKEN }, 200, cors);
      }
      if (request.method === "GET" && path === "/config") {
        const cfg = env.KV ? (await env.KV.get("config", { type: "json" })) : null;
        return json(cfg || { products: {}, content: {}, settings: {}, updatedAt: 0 }, 200, cors, {
          "Cache-Control": "public, max-age=20"
        });
      }
      if (request.method === "POST" && path === "/create-payment-intent") {
        return createPaymentIntent(request, env, cors);
      }
      if (request.method === "POST" && path === "/track") {
        return track(request, env, cors);
      }
      if (request.method === "GET" && path.startsWith("/model/")) {
        return getModel(env, decodeURIComponent(path.slice("/model/".length)), cors);
      }

      // ───────── Admin (token requis) ─────────
      if (path.startsWith("/admin/")) {
        if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN non configuré" }, 500, cors);
        if ((request.headers.get("X-Admin-Token") || "") !== env.ADMIN_TOKEN) {
          return json({ error: "Token admin invalide" }, 401, cors);
        }
        if (request.method === "GET" && path === "/admin/ping") return json({ ok: true }, 200, cors);
        if (request.method === "POST" && path === "/admin/config") return saveConfig(request, env, cors);
        if (request.method === "GET" && path === "/admin/stats") return getStats(env, cors);
        if (request.method === "GET" && path === "/admin/orders") return getOrders(env, cors);
        if (request.method === "POST" && path.startsWith("/admin/model/")) {
          return putModel(request, env, decodeURIComponent(path.slice("/admin/model/".length)), cors);
        }
        if (request.method === "DELETE" && path.startsWith("/admin/model/")) {
          return delModel(env, decodeURIComponent(path.slice("/admin/model/".length)), cors);
        }
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ error: "Worker error: " + (e && e.message || e) }, 500, cors);
    }
  }
};

// ───────────────────────── Paiement ─────────────────────────
async function createPaymentIntent(request, env, cors) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "STRIPE_SECRET_KEY non configurée" }, 500, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "JSON invalide" }, 400, cors); }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return json({ error: "Panier vide" }, 400, cors);

  // table de prix = DEFAULT_CATALOG surchargée par les prix publiés (KV)
  const prices = Object.assign({}, DEFAULT_CATALOG);
  if (env.KV) {
    const cfg = await env.KV.get("config", { type: "json" });
    if (cfg && cfg.products) {
      for (const k in cfg.products) {
        const p = cfg.products[k];
        if (p && p.price != null && !p.archived) {
          const cents = Math.round(parseFloat(p.price) * 100);
          if (Number.isFinite(cents) && cents >= 0) prices[k] = cents;
        }
      }
    }
  }

  let subtotal = 0;
  const summary = [];
  for (const it of items) {
    const key = String(it.type) + ":" + String(it.id);
    const price = prices[key];
    if (price === undefined) return json({ error: "Article inconnu : " + key }, 400, cors);
    let qty = parseInt(it.qty, 10);
    if (!Number.isInteger(qty) || qty < 1) qty = 1;
    if (qty > 99) qty = 99;
    subtotal += price * qty;
    summary.push(key + "x" + qty);
  }
  const shipping = (subtotal >= FREE_SHIPPING_THRESHOLD || subtotal === 0) ? 0 : SHIPPING_FEE;
  const amount = subtotal + shipping;
  if (amount < 50 || amount > 500000) return json({ error: "Montant hors limites" }, 400, cors);

  const form = new URLSearchParams();
  form.set("amount", String(amount));
  form.set("currency", (body.currency || "eur").toLowerCase());
  form.set("automatic_payment_methods[enabled]", "true");
  if (body.email) form.set("receipt_email", String(body.email).slice(0, 200));
  if (body.ref) form.set("metadata[ref]", String(body.ref).slice(0, 100));
  form.set("metadata[items]", summary.join(",").slice(0, 480));

  const resp = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const data = await resp.json();
  if (!resp.ok) return json({ error: (data.error && data.error.message) || "Erreur Stripe" }, 502, cors);
  return json({ clientSecret: data.client_secret, amount }, 200, cors);
}

// ───────────────────────── Config ─────────────────────────
async function saveConfig(request, env, cors) {
  if (!env.KV) return json({ error: "KV non lié au Worker" }, 500, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "JSON invalide" }, 400, cors); }
  const cfg = {
    products: (body.products && typeof body.products === "object") ? body.products : {},
    content: (body.content && typeof body.content === "object") ? body.content : {},
    settings: (body.settings && typeof body.settings === "object") ? body.settings : {},
    updatedAt: Date.now()
  };
  await env.KV.put("config", JSON.stringify(cfg));
  return json({ ok: true, updatedAt: cfg.updatedAt }, 200, cors);
}

// ───────────────────────── Modèles 3D ─────────────────────────
async function getModel(env, key, cors) {
  if (!env.KV) return json({ error: "KV non lié" }, 500, cors);
  const safe = key.replace(/[^a-zA-Z0-9:_.-]/g, "");
  const res = await env.KV.getWithMetadata("model:" + safe, { type: "arrayBuffer" });
  if (!res || !res.value) return json({ error: "Modèle introuvable" }, 404, cors);
  const ct = (res.metadata && res.metadata.ct) || "application/octet-stream";
  return new Response(res.value, {
    status: 200,
    headers: Object.assign({}, cors, { "Content-Type": ct, "Cache-Control": "public, max-age=86400" })
  });
}
async function putModel(request, env, key, cors) {
  if (!env.KV) return json({ error: "KV non lié" }, 500, cors);
  const safe = key.replace(/[^a-zA-Z0-9:_.-]/g, "");
  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return json({ error: "Fichier vide" }, 400, cors);
  if (buf.byteLength > MAX_MODEL_BYTES) return json({ error: "Fichier trop volumineux (max 9 Mo)" }, 413, cors);
  const ct = request.headers.get("Content-Type") || "application/octet-stream";
  await env.KV.put("model:" + safe, buf, { metadata: { ct, size: buf.byteLength, at: Date.now() } });
  return json({ ok: true, key: safe, size: buf.byteLength }, 200, cors);
}
async function delModel(env, key, cors) {
  if (!env.KV) return json({ error: "KV non lié" }, 500, cors);
  const safe = key.replace(/[^a-zA-Z0-9:_.-]/g, "");
  await env.KV.delete("model:" + safe);
  return json({ ok: true }, 200, cors);
}

// ───────────────────────── Analytics ─────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function emptyStats() { return { totals: { views: 0, products: 0, carts: 0, purchases: 0, revenue: 0 }, days: {}, products: {} }; }

async function track(request, env, cors) {
  if (!env.KV) return json({ ok: true, skipped: "no-kv" }, 200, cors);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "JSON invalide" }, 400, cors); }
  const ev = String(body.event || "");
  const field = { view: "views", product: "products", cart: "carts", purchase: "purchases" }[ev];
  if (!field) return json({ error: "Event inconnu" }, 400, cors);

  const s = (await env.KV.get("stats", { type: "json" })) || emptyStats();
  const d = today();
  if (!s.days[d]) s.days[d] = { views: 0, products: 0, carts: 0, purchases: 0, revenue: 0 };
  s.totals[field] = (s.totals[field] || 0) + 1;
  s.days[d][field] = (s.days[d][field] || 0) + 1;

  if (body.key) {
    const k = String(body.key).slice(0, 40);
    if (!s.products[k]) s.products[k] = { views: 0, carts: 0, purchases: 0 };
    const pf = { product: "views", cart: "carts", purchase: "purchases" }[ev];
    if (pf) s.products[k][pf] = (s.products[k][pf] || 0) + 1;
  }
  if (ev === "purchase") {
    const amt = Math.max(0, Math.round(parseFloat(body.amount) || 0));
    s.totals.revenue = (s.totals.revenue || 0) + amt;
    s.days[d].revenue = (s.days[d].revenue || 0) + amt;
    if (Array.isArray(body.keys)) {
      body.keys.forEach(function (rawk) {
        const k = String(rawk).slice(0, 40);
        if (!s.products[k]) s.products[k] = { views: 0, carts: 0, purchases: 0 };
        s.products[k].purchases = (s.products[k].purchases || 0) + 1;
      });
    }
  }
  // ne garder que les 120 derniers jours
  const days = Object.keys(s.days).sort();
  while (days.length > 120) { delete s.days[days.shift()]; }

  await env.KV.put("stats", JSON.stringify(s));
  return json({ ok: true }, 200, cors);
}

async function getStats(env, cors) {
  if (!env.KV) return json({ error: "KV non lié" }, 500, cors);
  const s = (await env.KV.get("stats", { type: "json" })) || emptyStats();
  return json(s, 200, cors, { "Cache-Control": "no-store" });
}

// ───────────────────────── Commandes (Stripe) ─────────────────────────
async function getOrders(env, cors) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "STRIPE_SECRET_KEY non configurée" }, 500, cors);
  const resp = await fetch("https://api.stripe.com/v1/payment_intents?limit=50", {
    headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY }
  });
  const data = await resp.json();
  if (!resp.ok) return json({ error: (data.error && data.error.message) || "Erreur Stripe" }, 502, cors);
  const orders = (data.data || []).map(function (pi) {
    return {
      id: pi.id,
      ref: (pi.metadata && pi.metadata.ref) || "",
      items: (pi.metadata && pi.metadata.items) || "",
      amount: pi.amount,
      currency: pi.currency,
      status: pi.status,
      email: pi.receipt_email || (pi.charges && pi.charges.data && pi.charges.data[0] && pi.charges.data[0].billing_details && pi.charges.data[0].billing_details.email) || "",
      created: pi.created * 1000
    };
  });
  return json({ orders }, 200, cors, { "Cache-Control": "no-store" });
}

// ───────────────────────── util ─────────────────────────
function json(obj, status, cors, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, cors, extra || {})
  });
}
