# Paiement FLAMECRAFT — mise en service (Stripe + Cloudflare Worker)

Le site est statique (GitHub Pages). Pour encaisser des paiements (carte, Apple Pay,
Google Pay, PayPal) en toute sécurité, **une seule petite fonction serveur** est
nécessaire : un *Cloudflare Worker* qui détient la clé secrète Stripe et crée le
paiement. Le navigateur ne voit jamais la clé secrète.

## 1. Compte Stripe (gratuit)
1. Crée un compte sur https://stripe.com (reste en **mode Test** pour commencer).
2. Dashboard → **Developers → API keys** : note
   - **Publishable key** (`pk_test_…`) → ira dans le site.
   - **Secret key** (`sk_test_…`) → ira dans le Worker (jamais dans le site).
3. Dashboard → **Settings → Payment methods** : active **Carte**, **Apple Pay**,
   **Google Pay**, **Link**, **PayPal** (PayPal nécessite parfois une activation séparée).

## 2. Déployer le Worker Cloudflare (sans rien installer)
1. Crée un compte sur https://dash.cloudflare.com (gratuit).
2. **Workers & Pages → Create application → Create Worker** → donne-lui un nom
   (ex. `flamecraft-pay`) → **Deploy**.
3. **Edit code** : remplace tout par le contenu de [`cloudflare-worker.js`](./cloudflare-worker.js) → **Deploy**.
4. **Settings → Variables and Secrets → Add** :
   - `STRIPE_SECRET_KEY` = ta clé secrète Stripe (`sk_test_…`), type **Secret/Encrypt**.
   - (optionnel) `ALLOWED_ORIGIN` = `https://brognaranolan-spec.github.io`
     pour n'autoriser que ton site.
5. Note l'URL publique du Worker : `https://flamecraft-pay.<ton-sous-domaine>.workers.dev`.
   Teste-la dans le navigateur : elle doit répondre `{"ok":true,...}`.

## 3. Brancher le site
Dans `index.html`, en haut du bloc « PAIEMENT », renseigne :
```js
const STRIPE_PUBLISHABLE_KEY = 'pk_test_xxxxxxxx';                 // clé publique Stripe
const PAYMENT_API_URL        = 'https://flamecraft-pay.xxx.workers.dev';  // URL du Worker
```
Commit + push → le checkout bascule sur le vrai paiement.

## 4. Apple Pay (vérification du domaine)
Apple Pay sur le web exige de prouver que tu possèdes le domaine :
1. Stripe Dashboard → **Settings → Payment methods → Apple Pay → Add domain** :
   `brognaranolan-spec.github.io`.
2. Stripe te donne un fichier `apple-developer-merchantid-domain-association`.
   Place-le dans le dépôt sous `.well-known/apple-developer-merchantid-domain-association`
   (le fichier `.nojekyll` à la racine est déjà là pour que GitHub Pages serve `.well-known`).
3. Re-déploie. Google Pay ne demande pas cette étape.

## 5. Passer en production (vrai argent)
Quand tout est validé en test : repasse Stripe en **mode Live**, remplace les clés
`pk_test_…`/`sk_test_…` par les `pk_live_…`/`sk_live_…` (site + Worker), redéploie.

## Sécurité — à renforcer pour la prod
Le Worker fait confiance au montant envoyé par le navigateur (garde-fou 0,50 €–5 000 €).
Pour empêcher toute manipulation du prix, recalcule le total côté Worker à partir d'un
catalogue de prix (codé dans le Worker ou lu depuis Supabase). À faire avant gros volume.
