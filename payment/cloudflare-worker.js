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
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, Authorization",
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

      // ───────── Auth (comptes clients, session par jeton) ─────────
      if (request.method === "POST" && path === "/auth/signup") return authSignup(request, env, cors);
      if (request.method === "POST" && path === "/auth/login") return authLogin(request, env, cors);
      if (request.method === "POST" && path === "/auth/google") return authGoogle(request, env, cors);
      if (request.method === "GET" && path === "/auth/me") return authMe(request, env, cors);
      if (request.method === "POST" && path === "/auth/logout") return authLogout(request, env, cors);
      if (path === "/me/cart") return meCart(request, env, cors);
      if (path === "/me/orders") return meOrders(request, env, cors);

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
  if (body.userId) form.set("metadata[userId]", String(body.userId).slice(0, 60));

  // Adresse de livraison → attachée au PaymentIntent (visible Stripe + dashboard)
  const sh = body.shipping;
  if (sh && sh.address) {
    if (sh.name) form.set("shipping[name]", String(sh.name).slice(0, 200));
    if (sh.phone) form.set("shipping[phone]", String(sh.phone).slice(0, 40));
    const a = sh.address;
    if (a.line1) form.set("shipping[address][line1]", String(a.line1).slice(0, 200));
    if (a.line2) form.set("shipping[address][line2]", String(a.line2).slice(0, 200));
    if (a.city) form.set("shipping[address][city]", String(a.city).slice(0, 100));
    if (a.state) form.set("shipping[address][state]", String(a.state).slice(0, 100));
    if (a.postal_code) form.set("shipping[address][postal_code]", String(a.postal_code).slice(0, 30));
    if (a.country) form.set("shipping[address][country]", String(a.country).slice(0, 2));
  }

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
      shipping: pi.shipping || null,
      created: pi.created * 1000
    };
  });
  return json({ orders }, 200, cors, { "Cache-Control": "no-store" });
}

// ───────────────────────── Auth (comptes clients) ─────────────────────────
function b64(buf){var a=new Uint8Array(buf),s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s);}
function unb64(str){var bin=atob(str),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}
function randHex(n){var a=crypto.getRandomValues(new Uint8Array(n));return Array.prototype.map.call(a,function(b){return ("0"+b.toString(16)).slice(-2);}).join("");}
async function derive(password, saltBytes){
  var km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  var bits = await crypto.subtle.deriveBits({ name:"PBKDF2", salt:saltBytes, iterations:100000, hash:"SHA-256" }, km, 256);
  return b64(bits);
}
async function hashPassword(password){ var salt = crypto.getRandomValues(new Uint8Array(16)); return { salt:b64(salt.buffer), hash:(await derive(password, salt)) }; }
async function verifyPassword(password, saltB64, hashB64){ return (await derive(password, unb64(saltB64))) === hashB64; }
function pubUser(u){ return { id:u.id, email:u.email, name:u.name, provider:u.provider, createdAt:u.createdAt }; }
function newUid(){ return "u" + Date.now().toString(36) + randHex(4); }
function validEmail(e){ return /.+@.+\..+/.test(e); }

async function kvGetUserByEmail(env, email){ var id = await env.KV.get("email:"+email); return id ? await env.KV.get("user:"+id, { type:"json" }) : null; }
async function kvPutUser(env, u){ await env.KV.put("user:"+u.id, JSON.stringify(u)); await env.KV.put("email:"+u.email, u.id); }
async function createSession(env, userId){
  var token = randHex(32), ttl = 60*60*24*60; // 60 jours
  await env.KV.put("sess:"+token, JSON.stringify({ userId:userId, exp:Date.now()+ttl*1000 }), { expirationTtl: ttl });
  return token;
}
async function userFromRequest(env, request){
  var h = request.headers.get("Authorization") || "", m = h.match(/^Bearer\s+(.+)$/i);
  if(!m) return null;
  var sess = await env.KV.get("sess:"+m[1], { type:"json" });
  if(!sess || (sess.exp && sess.exp < Date.now())) return null;
  var u = await env.KV.get("user:"+sess.userId, { type:"json" });
  if(u) u._token = m[1];
  return u;
}

async function authSignup(request, env, cors){
  if(!env.KV) return json({ error:"KV non lié" }, 500, cors);
  var b; try{ b = await request.json(); }catch(e){ return json({ error:"JSON invalide" }, 400, cors); }
  var email = (b.email||"").trim().toLowerCase(), pw = b.password||"";
  if(!validEmail(email)) return json({ error:"E-mail invalide" }, 400, cors);
  if(pw.length < 6) return json({ error:"Mot de passe : 6 caractères minimum" }, 400, cors);
  if(await kvGetUserByEmail(env, email)) return json({ error:"Un compte existe déjà avec cet e-mail" }, 409, cors);
  var hp = await hashPassword(pw);
  var u = { id:newUid(), email:email, name:(b.name||"").trim()||email.split("@")[0], salt:hp.salt, hash:hp.hash, provider:"password", createdAt:Date.now() };
  await kvPutUser(env, u);
  return json({ token:(await createSession(env, u.id)), user:pubUser(u) }, 200, cors);
}
async function authLogin(request, env, cors){
  if(!env.KV) return json({ error:"KV non lié" }, 500, cors);
  var b; try{ b = await request.json(); }catch(e){ return json({ error:"JSON invalide" }, 400, cors); }
  var email = (b.email||"").trim().toLowerCase();
  var u = await kvGetUserByEmail(env, email);
  if(!u || !u.hash || !(await verifyPassword(b.password||"", u.salt, u.hash))) return json({ error:"E-mail ou mot de passe incorrect" }, 401, cors);
  return json({ token:(await createSession(env, u.id)), user:pubUser(u) }, 200, cors);
}
async function authGoogle(request, env, cors){
  if(!env.KV) return json({ error:"KV non lié" }, 500, cors);
  var b; try{ b = await request.json(); }catch(e){ return json({ error:"JSON invalide" }, 400, cors); }
  if(!env.GOOGLE_CLIENT_ID) return json({ error:"Connexion Google non configurée (GOOGLE_CLIENT_ID manquant)" }, 500, cors);
  if(!b.credential) return json({ error:"Jeton Google manquant" }, 400, cors);
  var r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(b.credential));
  if(!r.ok) return json({ error:"Jeton Google invalide" }, 401, cors);
  var info = await r.json();
  if(info.aud !== env.GOOGLE_CLIENT_ID) return json({ error:"Application Google non autorisée" }, 401, cors);
  if(String(info.email_verified) !== "true") return json({ error:"E-mail Google non vérifié" }, 401, cors);
  var email = (info.email||"").toLowerCase();
  if(!validEmail(email)) return json({ error:"E-mail Google absent" }, 400, cors);
  var u = await kvGetUserByEmail(env, email);
  if(!u){ u = { id:newUid(), email:email, name:info.name||email.split("@")[0], provider:"google", sub:info.sub, createdAt:Date.now() }; await kvPutUser(env, u); }
  return json({ token:(await createSession(env, u.id)), user:pubUser(u) }, 200, cors);
}
async function authMe(request, env, cors){
  if(!env.KV) return json({ error:"KV non lié" }, 500, cors);
  var u = await userFromRequest(env, request);
  if(!u) return json({ error:"Session invalide" }, 401, cors);
  return json({ user:pubUser(u) }, 200, cors);
}
async function authLogout(request, env, cors){
  var h = request.headers.get("Authorization")||"", m = h.match(/^Bearer\s+(.+)$/i);
  if(m && env.KV) await env.KV.delete("sess:"+m[1]);
  return json({ ok:true }, 200, cors);
}
async function meCart(request, env, cors){
  if(!env.KV) return json({ error:"KV non lié" }, 500, cors);
  var u = await userFromRequest(env, request);
  if(!u) return json({ error:"Non authentifié" }, 401, cors);
  if(request.method === "GET"){ var items = await env.KV.get("cart:"+u.id, { type:"json" }); return json({ items:items||[] }, 200, cors, { "Cache-Control":"no-store" }); }
  var b; try{ b = await request.json(); }catch(e){ return json({ error:"JSON invalide" }, 400, cors); }
  await env.KV.put("cart:"+u.id, JSON.stringify(Array.isArray(b.items)?b.items:[]));
  return json({ ok:true }, 200, cors);
}
async function meOrders(request, env, cors){
  if(!env.KV) return json({ error:"KV non lié" }, 500, cors);
  var u = await userFromRequest(env, request);
  if(!u) return json({ error:"Non authentifié" }, 401, cors);
  if(request.method === "GET"){ var o = await env.KV.get("orders:"+u.id, { type:"json" }); return json({ orders:o||[] }, 200, cors, { "Cache-Control":"no-store" }); }
  var b; try{ b = await request.json(); }catch(e){ return json({ error:"JSON invalide" }, 400, cors); }
  if(!b.order) return json({ error:"Commande manquante" }, 400, cors);
  var arr = (await env.KV.get("orders:"+u.id, { type:"json" })) || [];
  arr.unshift(b.order);
  if(arr.length > 200) arr = arr.slice(0, 200);
  await env.KV.put("orders:"+u.id, JSON.stringify(arr));
  return json({ ok:true }, 200, cors);
}

// ───────────────────────── util ─────────────────────────
function json(obj, status, cors, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, cors, extra || {})
  });
}
