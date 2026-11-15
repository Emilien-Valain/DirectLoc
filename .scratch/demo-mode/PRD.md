# Mode démo public

Status: in-progress

Le site vitrine (`directloc.app`, `app/vitrine/page.tsx:133,173,278`) a 3 liens « Essayer l'admin… » vers `/essayer`, qui n'existe pas (404). Objectif : un visiteur clique, arrive **connecté** dans l'admin d'un hôtel démo (`demo.directloc.app`), peut tout modifier, voir le site de réservation démo et réserver avec Stripe en mode test. Les données démo sont remises à zéro chaque nuit.

## Décisions (utilisateur, 2026-11-15)

- **Accès admin** : connexion automatique, aucun mot de passe à connaître. Le compte démo a une adresse factice (`demo@demo.directloc.app`).
- **Droits** : tout modifiable ; **reset nocturne** des données démo. Bloqués pour le tenant démo : emails sortants, Stripe Connect, uploads de photos, changement de mot de passe / reset password, modification du slug et du domaine.
- **Réservation** : vrai Stripe Checkout en **mode test** même quand la prod passe en clés live, avec un bandeau « carte de test 4242 4242 4242 4242 ». Aucun email envoyé.

## Socle commun (déjà en place)

- `lib/demo.ts` : `DEMO_TENANT_SLUG` (env) + `isDemoTenant(tenantId)`. Tout le code démo passe par là.
- Tests : `playwright.config.ts` webServer env `DEMO_TENANT_SLUG: "demo-tenant"` → hôte `http://demo-tenant.localhost:3001`.

| # | Issue | Status | Dépend de |
|---|-------|--------|-----------|
| 01 | Garde-fous du tenant démo | resolved | — |
| 02 | Seed démo + reset nocturne | resolved | — |
| 03 | `/essayer` : connexion auto + liens croisés | resolved | 01, 02 |
| 04 | Stripe test pour le tenant démo | resolved | — |
| 05 | Mise en prod de la démo | ready-for-human | 01-04 |
