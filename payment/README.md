# FLAMECRAFT — Worker Cloudflare : paiement + dashboard

Le site est statique (GitHub Pages). Un **seul Worker Cloudflare** (`flamecraft-pay`)
sert à la fois :
1. le **paiement** Stripe (création sécurisée du PaymentIntent, prix recalculé serveur) ;
2. le **backend du dashboard** : config produits/contenu en temps réel, modèles 3D,
   analytics (vues/achats), commandes — le tout stocké dans un **KV namespace**.

## Variables / bindings à configurer (Cloudflare → Worker → Settings)
| Nom | Type | Rôle |
|-----|------|------|
| `STRIPE_SECRET_KEY` | Secret | `sk_test_…` puis `sk_live_…` — paiement *(déjà fait)* |
| `ADMIN_TOKEN` | Secret | mot de passe du dashboard (à inventer, ex. long aléatoire) |
| `KV` | **KV Namespace binding** | stockage config + modèles 3D + analytics |
| `ALLOWED_ORIGIN` | (option) | ex. `https://brognaranolan-spec.github.io` pour restreindre |

### Créer le KV et le lier (≈ 3 min)
1. Cloudflare → **Storage & Databases → KV → Create namespace** → nom : `flamecraft` → Create.
2. Worker `flamecraft-pay` → **Settings → Bindings → Add → KV namespace** :
   - Variable name : **`KV`** (exactement)
   - KV namespace : `flamecraft`
   - Save.
3. Worker → **Settings → Variables and Secrets → Add** : `ADMIN_TOKEN` = ton mot de passe (Secret).
4. Re-déploie le Worker avec le code à jour : ouvre `cloudflare-worker.js`, copie tout,
   colle dans **Edit code** du Worker → **Deploy**.
5. Vérifie : ouvre `https://flamecraft-pay.brognaranolan.workers.dev/` →
   `{"ok":true,"service":"flamecraft-pay","kv":true,"admin":true}` (kv et admin à `true`).

## Le dashboard
- URL : **`https://brognaranolan-spec.github.io/flamecraft/admin.html`** (non listée, `noindex`).
- Connexion : le **token admin** (`ADMIN_TOKEN`).
- **Partager l'accès** : donne l'URL + le token à la personne. Pour révoquer : change `ADMIN_TOKEN`.
- Sections : Vue d'ensemble (KPIs + graphe), Produits (prix/stock/desc/badges/archive/ajout),
  Studio 3D (import STL/OBJ + aperçu), Contenu (hero/textes/liens), Commandes (Stripe), Analytics, Réglages.
- Les modifs sont un **brouillon** → bouton **« Publier »** = visible par tous les visiteurs
  (le site lit la config du Worker à chaque chargement, ~temps réel).

## Endpoints du Worker
| Méthode | Chemin | Accès |
|--------|--------|-------|
| GET | `/` | public (health) |
| GET | `/config` | public (config publiée) |
| POST | `/create-payment-intent` | public (paiement) |
| POST | `/track` | public (analytics) |
| GET | `/model/:key` | public (fichier 3D) |
| POST | `/admin/config` | token |
| GET | `/admin/stats` | token |
| GET | `/admin/orders` | token (lit Stripe) |
| POST/DELETE | `/admin/model/:key` | token |

## Sécurité
- Le prix payé est **toujours recalculé côté Worker** (catalogue `DEFAULT_CATALOG` +
  prix publiés dans le KV) → impossible de payer moins en trafiquant la requête.
- Les écritures (config, modèles) exigent `ADMIN_TOKEN`. Les lectures publiques (`/config`)
  n'exposent que ce qui est déjà affiché sur le site.
- Pense à garder `ADMIN_TOKEN` long et privé. `ALLOWED_ORIGIN` peut restreindre le CORS.

## Passer le paiement en production (vrai argent)
Stripe en mode **Live** → remplace `pk_test`/`sk_test` par `pk_live`/`sk_live`
(site `index.html` + variable Cloudflare), redéploie. Pour Apple Pay : enregistrer le
domaine dans Stripe + déposer le fichier `.well-known/apple-developer-merchantid-domain-association`.
