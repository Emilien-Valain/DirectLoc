# DirectLoc

Plateforme de réservation directe en marque blanche pour gîtes, chambres d'hôtes et petits hôtels.
Un seul déploiement, plusieurs établissements, chacun avec son domaine, son site et son back-office.
Site : https://directloc.app

```
hotelducoin.fr  ──┐
villarose.fr    ──┼──▶  DirectLoc (Next.js)  ──▶  PostgreSQL
giteduvallon.fr ──┘          │
directloc.app ───────────────┘  (vitrine commerciale, MARKETING_HOST)
```

Vocabulaire métier : [`CONTEXT.md`](CONTEXT.md). Décisions d'architecture : [`docs/adr/`](docs/adr/). Produit et cibles : [`PRODUCT.md`](PRODUCT.md).

## Stack

Next.js 16 / React 19 / TypeScript / Tailwind v4 / Drizzle ORM / PostgreSQL / Better Auth / Stripe (Connect, Accounts v2) / Nodemailer / PostHog / Playwright

## Fonctionnalités

### Site public (par établissement)

- **Multi-tenant** : résolution par domaine (ou sous-domaine), isolation complète des données
- **4 modèles** : Plaque émaillée (`classic`), Linge de maison (`boutique`), Affiche touristique (`affiche`), Classique (`standard`), thémés par couleurs, logo, photos
- **Recherche** : dates + nombre de voyageurs, disponibilité temps réel, combinaison de plusieurs chambres
- **Dossiers** : réserver plusieurs chambres en une fois, options payantes (petit-déj, linge…), frais et taxe de séjour
- **Paiement Stripe** : Checkout sur le compte connecté de l'hôtel (direct charge), webhooks, pas de paiement sans compte connecté
- **Réseau des Voisins** : quand c'est complet, renvoi vers les établissements DirectLoc proches et libres (ou séjour partagé)
- **SEO** : sitemap/robots par site, Schema.org `LodgingBusiness`, IndexNow, inscription Search Console automatique
- **Pages légales** : mentions, CGV, conditions d'annulation, confidentialité, bandeau de consentement

### Admin

- **Tableau de bord**, **calendrier** (timeline chambres × jours), **réservations / dossiers** (cycle de statuts, saisie manuelle, changement de dates, ajout de chambre, export PDF)
- **Chambres** : CRUD, photos, infos pratiques (étage, code, wifi) réutilisables dans les emails
- **Règles** : règles de réservation, tarification par précédence (promos), blocages manuels, sur une ou plusieurs chambres
- **Paramètres** : général, apparence, localisation, emails (confirmation, rappel, remerciement), iCal, paiements, documents légaux
- **Argent** : remboursements partiels, suivi des litiges Stripe, reste à payer / trop-perçu
- **Synchronisation iCal** avec Airbnb/Booking : import des blocages (toutes les 15 min) + export par chambre
- **Multi-établissements** : un compte admin gère plusieurs hôtels ; utilisable en application installée sur téléphone
- **Démo** : établissement de démonstration réinitialisé automatiquement (`/essayer`)

## Démarrage local

```bash
npm install

# PostgreSQL (ici en Docker)
docker run -d --name maresa-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
createdb -h localhost -U postgres maresa

# .env.local : DATABASE_URL, BETTER_AUTH_URL, SMTP_*, STRIPE_* … (voir ci-dessous)
npm run db:migrate

# Premier établissement + admin
npm run create-admin -- \
  --name "Mon Hôtel" \
  --slug "mon-hotel" \
  --domain "monhotel.fr" \
  --email "admin@monhotel.fr" \
  --password "motdepasse" \
  --template classic          # classic | boutique | affiche | standard
# Email déjà admin d'un autre hôtel : ajouter --link-existing

npm run dev
```

Accès : `http://mon-hotel.localhost:3000` (site) et `http://mon-hotel.localhost:3000/admin`.
Sur `localhost:3000` sans sous-domaine, l'établissement servi est celui de `PUBLIC_TENANT_SLUG`.

### Variables d'environnement principales

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | PostgreSQL |
| `BETTER_AUTH_URL` | URL de base de l'auth |
| `MARKETING_HOST` | Domaine de la vitrine (directloc.app) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Envoi des emails |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | Paiements (clés `sk_` ou `rk_`) |
| `CRON_SECRET` | Protège `/api/cron/*` |
| `UPLOADS_DIR` | Photos (volume persistant en prod) |
| `POSTHOG_KEY`, `POSTHOG_HOST` | Analytics (optionnel) |

Liste complète et valeurs de prod : `Déploiement.md` dans le vault Obsidian.

## Tests

```bash
npm test                          # suite E2E complète (Playwright)
npx playwright test --project=unit  # tests unitaires (~40 s)
npm run test:ui                   # interface visuelle
npm run test:analytics            # suite PostHog (serveur séparé)
```

- Projets Playwright : `unit`, `auth`, `admin`, `public`, `mobile` (Pixel 7) ; paiement dans `e2e/payment/`
- Base dédiée via `TEST_DATABASE_URL` dans `.env.test`, jamais la prod
- Arrêter `npm run dev` avant : Next 16 n'accepte qu'un seul `next dev`
- Hooks Husky : **pre-commit** = `tsc` + `eslint` + tests unitaires ; **pre-push** = suite E2E complète (~10 min)

## Déploiement

Image Docker (`Dockerfile`, sortie `standalone`) déployée par Coolify sur un VPS, Traefik pour le SSL de chaque domaine.
Les migrations s'appliquent au démarrage du conteneur (`scripts/migrate.mjs`).
Créer un établissement en prod : `node scripts/create-admin.mjs --name … --slug … --email … --password …`

Tâches planifiées (appel HTTP avec `Authorization: Bearer $CRON_SECRET`) :

| Endpoint | Fréquence | Rôle |
|---|---|---|
| `/api/cron/ical-sync` | 15 min | Import des calendriers Airbnb/Booking |
| `/api/cron/booking-emails` | quotidien | Rappels avant arrivée, remerciements, séjours terminés |
| `/api/cron/network-report` | mensuel | Bilan du réseau des Voisins |
| `/api/cron/search-console` | quotidien | Inscription des domaines à Google Search Console |
| `/api/cron/indexnow` | quotidien | Signalement des pages modifiées |
| `/api/cron/demo-reset` | périodique | Réinitialisation de l'établissement de démo |

## Structure

```
app/
  page.tsx, chambres/, reserver/    Site public de l'établissement
  vitrine/                          Site commercial directloc.app
  admin/                            Back-office (calendrier, réservations, dossiers, chambres, règles, paramètres)
  (auth)/                           Login, mot de passe oublié
  api/                              Disponibilité, tarifs, iCal, webhooks Stripe, crons
components/
  public/                           Site public (templates CSS dans templates/)
  admin/                            Écrans d'admin
lib/                                Domaine : disponibilité, admission, tarifs, dossiers, remboursements, réseau…
db/                                 Schéma Drizzle + migrations
scripts/                            create-admin, migrate, envoi d'emails de test
e2e/                                Tests Playwright (unit, auth, admin, public, payment, mobile, analytics)
docs/adr/                           Décisions d'architecture
```

## Licence

[Business Source License 1.1](LICENSE) : code lisible et modifiable, tests et usage non commercial gratuits.
Prendre de vraies réservations ou revendre le service demande une licence commerciale : voir [`COMMERCIAL-LICENSE.md`](COMMERCIAL-LICENSE.md).
Chaque version passe sous AGPL-3.0 quatre ans après sa publication.
