# Stripe test pour le tenant démo

Status: resolved

## Pourquoi

Aujourd'hui la prod tourne avec `sk_test_`. Au passage en live, la démo encaisserait de vrais paiements. La démo doit rester en mode test quelle que soit la clé principale.

## Attendu

- Env optionnelles `STRIPE_TEST_SECRET_KEY` et `STRIPE_TEST_WEBHOOK_SECRET`.
- `lib/stripe.ts` : `getStripe()` inchangé pour le cas général ; un moyen d'obtenir le client test (ex. `getStripe({ test: true })`) qui utilise `STRIPE_TEST_SECRET_KEY`, à défaut `STRIPE_SECRET_KEY` **seulement si** celle-ci commence par `sk_test_` ; sinon erreur explicite (le booking est alors refusé proprement par le chemin d'erreur existant de `lib/actions/bookings-public.ts`).
- `lib/actions/bookings-public.ts` : pour le tenant démo (`isDemoTenant`), session Checkout créée avec le client test, sur le compte plateforme (jamais de `stripeAccount`).
- `app/api/webhooks/stripe/route.ts` : ajouter `STRIPE_TEST_WEBHOOK_SECRET` à la liste des secrets essayés. Un événement test ne doit pouvoir confirmer qu'un booking du tenant démo (event.livemode === false ⇒ booking.tenantId doit être le démo ; sinon ignoré + log). Un événement live ne touche jamais le tenant démo.
- Documenter les 2 variables dans `Déploiement.md` (Obsidian : `/home/richard/Documents/ObsidianVault/GitSync/PROJETS/Projet Booking Manager/Déploiement.md`, table des variables).

## Done quand

- Tests (unit ou E2E, au choix le plus simple) : clé principale `sk_live_…` + pas de clé test → réservation démo refusée proprement, aucun booking résiduel ; événement `livemode:false` pour un booking non démo → ignoré, booking inchangé ; événement `livemode:false` pour un booking démo → confirmé.
- `npx tsc --noEmit` et `npx eslint` propres.

## Comments

### Implémentation (agent, 2026-11-15)

**Changé**
- `lib/stripe.ts:12` — `getStripe({ test: true })` : `STRIPE_TEST_SECRET_KEY`, à défaut `STRIPE_SECRET_KEY` si `sk_test_…`, sinon erreur explicite (client test mis en cache à part). `getStripe()` sans argument inchangé (4 appelants intacts).
- `lib/stripe.ts:32` — `stripeModeAllowed(livemode, demo)` : un événement live ne touche jamais le démo ; un événement test ne touche un tenant non démo que si `STRIPE_SECRET_KEY` n'est **pas** `sk_live_`.
- `lib/actions/bookings-public.ts:207-213` — `isDemoTenant` dans le `try` : client test, jamais de `stripeAccount` pour le démo. Si la clé test manque, l'erreur tombe dans le catch existant → booking pending supprimé + message d'erreur au formulaire.
- `app/api/webhooks/stripe/route.ts:40-44` — `STRIPE_TEST_WEBHOOK_SECRET` ajouté aux secrets essayés ; `:77-80` — après la vérif « session à nous », mode incompatible ⇒ ignoré + log `[stripe] … mode incompatible`, réponse 200.
- `e2e/unit/demo-stripe.spec.ts` — nouveau (projet `unit`).
- Obsidian `Déploiement.md` — 2 lignes dans la table des variables.

**Écart volontaire au ticket** : la règle « livemode:false ⇒ doit être le démo » n'est appliquée que si la clé principale est `sk_live_`. Appliquée telle quelle, elle aurait cassé la prod actuelle (en `sk_test_`, tous les événements sont test) et les E2E webhook existants.

**Vérifié** : `npx tsc --noEmit` et `npx eslint` (4 fichiers) propres ; sonde `npx tsx` sur `getStripe`/`stripeModeAllowed` conforme aux 3 cas du « Done quand ». Playwright non lancé (consigne) : `npx playwright test --project=unit e2e/unit/demo-stripe.spec.ts` + `e2e/payment/` à lancer. Non couvert en E2E : le flux complet de réservation démo (dépend du seed du tenant démo, issue 02) — la suppression du booking résiduel repose sur le catch existant, déjà couvert par les tests d'échec Stripe.

**Spec pour « Tests de non-régression.md »**
> **Stripe test du tenant démo** (`e2e/unit/demo-stripe.spec.ts`) — Avec une clé principale `sk_live_` et sans `STRIPE_TEST_SECRET_KEY`, le client Stripe test est refusé : la réservation démo échoue proprement (message au formulaire, booking pending supprimé). Avec une clé principale `sk_test_`, elle est réutilisée pour la démo. Plateforme live : un événement webhook `livemode:false` sur un booking non démo est ignoré (booking inchangé), sur un booking démo il est traité (confirmé). Un événement live n'agit jamais sur le tenant démo.
