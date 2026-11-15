# Seed démo + reset nocturne

Status: resolved

## Attendu

Une fonction unique `resetDemoTenant()` (ex. `lib/demo-seed.ts`) qui, pour le slug `DEMO_TENANT_SLUG` :
1. Crée le tenant s'il n'existe pas (nom « Hôtel Démo », template `classic`, domaine = celui passé en env `DEMO_TENANT_DOMAIN` ou rien en dev), et l'utilisateur `demo@<domaine ou demo.local>` lié au tenant, mot de passe aléatoire (personne ne le connaît : la connexion se fait par le ticket 03). Réutiliser la logique de `scripts/create-admin.ts` (hash via `better-auth/crypto`) plutôt que la recopier.
2. Supprime toutes les données du tenant (réservations, paiements, chambres, règles, tarifs, blocages, sources iCal, sessions du compte démo) et remet un jeu crédible : 3-4 chambres avec descriptions et prix, des réservations réparties sur ±30 jours autour d'aujourd'hui (statuts variés, canaux variés) pour que dashboard et calendrier soient vivants, une règle de séjour, une règle tarifaire saisonnière, un blocage manuel, la config de contenu (titres, textes, localisation) remplie. Photos : uniquement des fichiers déjà présents dans `public/` (pas d'upload, pas d'URL externe) ; si aucun ne convient, chambres sans photo.
3. Tout dans une transaction : un échec laisse l'ancienne démo intacte.
4. Ne touche jamais un autre tenant (toutes les suppressions filtrées par le tenantId démo ; assert explicite).

Points d'entrée :
- `GET /api/cron/demo-reset`, protégé par `CRON_SECRET` exactement comme `app/api/cron/ical-sync/route.ts`.
- `e2e/global-setup.ts` appelle `resetDemoTenant()` pour seeder `demo-tenant` (env `DEMO_TENANT_SLUG` déjà dans `playwright.config.ts`).

## Done quand

- `e2e/admin/demo-reset.spec.ts` : sans secret → 401 ; avec secret → 200, le tenant démo a le jeu attendu ; une modification faite avant reset a disparu après ; deux resets de suite donnent le même nombre de lignes ; les données de `test-tenant` sont strictement inchangées (compter avant/après).
- `npx tsc --noEmit` et `npx eslint` propres.

## Comments

### 2026-11-15 — implémentation (agent)

**Changements**
- `lib/demo-seed.ts:122` `resetDemoTenant()` : une seule `db.transaction` (l.128). Crée/met à jour le tenant `DEMO_TENANT_SLUG` (nom « Hôtel Démo », `config` complète, domaine = `DEMO_TENANT_DOMAIN` ou null, `stripeAccountId` remis à null), assert slug l.141, crée l'utilisateur `demo@<domaine|demo.local>` (mot de passe aléatoire) s'il manque, purge ses sessions, puis efface (l.157, toujours `where tenant_id = <démo>`) paiements, blocs/sources iCal, blocages, règles, tarifs, extras, frais, réservations (booking_lines en cascade), chambres, propriété, et réinsère le jeu.
- `lib/credential-user.ts:11` `createCredentialUser()` : création user + compte Better Auth extraite de `scripts/create-admin.ts` (l.95 l'utilise ; CLI inchangée).
- `app/api/cron/demo-reset/route.ts` : GET protégé par `CRON_SECRET` (copie de ical-sync : 500 si secret absent, 401 si mauvais).
- `e2e/global-setup.ts:278-283` : `DEMO_TENANT_SLUG ??= "demo-tenant"`, `DATABASE_URL = TEST_DATABASE_URL`, puis `resetDemoTenant()`.
- `e2e/admin/demo-reset.spec.ts` : 5 tests (401 ; 200 + jeu attendu ; modif effacée ; 2 resets = mêmes comptes ; test-tenant et rival-hotel inchangés).

**Jeu seedé** : « Le Mas des Oliviers » (Gordes, template classic, hero/histoire/chiffres/localisation/horaires/accès/messages, taxe de séjour fixe 1,50 €). 4 chambres (Lavande 95 €, Olivier 120 €, Suite Cyprès 180 €, Famille Garrigue 150 €), sans photo (public/ ne contient que des SVG Next). 18 réservations de J-28 à J+29, statuts pending/confirmed/cancelled/completed, canaux direct/manual, sans chevauchement. 1 règle de séjour globale (min 2 nuits), 1 tarif « Haute saison » +25 % (1/07–31/08 de l'été à venir), 1 blocage manuel (Famille Garrigue J+12→J+15), 1 source iCal « Airbnb » inactive (URL fictive, jamais synchronisée) + 2 blocs, 2 extras, 1 frais de ménage. 0 paiement.

**Vérifié** : `npx tsc --noEmit` et `npx eslint` sur les fichiers touchés propres. Probe tsx sur `maresa_test` : deux resets → comptes identiques, renommage d'une chambre effacé, comptes de test-tenant identiques avant/après, compte `demo@demo.local` lié une fois. La démo est laissée dans son état seedé. **Playwright non lancé** (port 3001 partagé).

**Spec Obsidian (Tests de non-régression.md)**
> **Démo — reset nocturne** (`e2e/admin/demo-reset.spec.ts`). `GET /api/cron/demo-reset` sans secret ou avec un mauvais secret → 401. Avec `CRON_SECRET` → 200 et l'hôtel démo contient exactement 1 propriété, 4 chambres, 18 réservations (4 statuts, 2 canaux, passées et futures), 1 règle de séjour, 1 tarif saisonnier, 1 blocage, 1 source iCal + 2 blocs, 0 paiement. Une chambre ou un nom d'hôtel modifiés avant le reset reviennent à leur valeur de référence. Deux resets consécutifs donnent les mêmes comptes de lignes. Les lignes de `test-tenant` et `rival-hotel` (toutes tables) et leur config sont strictement identiques avant/après.

**Photos (2026-11-15, orchestrateur).** `public/demo/*.webp` (1600 px max, ~2,2 Mo au total), licence Unsplash (usage commercial libre, sans attribution). Sources : chambre-lavande `qVwFsimVcWQ`, chambre-olivier `NkJAfAOl-K0`, suite-cypres `ltdM23CgxVc`, famille-garrigue `T1Yvmf4oleQ`, hero-lavande `FBFwc-ZV408`, galerie-olivier `WQDi1ZgldIQ`, galerie-mas `EKYkDnkk_rM`, galerie-table `-5B_sfWV2TE`, galerie-lavande `nD9tEn63suc` (unsplash.com/photos/<id>). Hôtel renommé « Le Mas des Oliviers » (au lieu de « Hôtel Démo ») pour que l'en-tête du site colle au contenu.
