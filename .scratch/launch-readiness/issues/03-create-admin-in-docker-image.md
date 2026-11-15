# `create-admin` absent de l'image Docker

Status: resolved

## Problème

L'étape « Ajouter un nouveau client » (Obsidian `Déploiement.md`) lance `npm run create-admin` dans le terminal Coolify. Le stage `runner` du `Dockerfile` ne copie que `scripts/migrate.mjs` : ni `scripts/create-admin.ts`, ni `tsx`, ni `package.json` scripts utilisables. La commande échoue en prod. Le script npm charge aussi `--env-file=.env.local`, absent du conteneur.

## Attendu

Une commande documentée qui crée un tenant + admin **depuis le conteneur de prod**, avec les mêmes options que `scripts/create-admin.ts` (`--name --slug --domain --email --password --template --link-existing`). Piste la plus courte : bundler `scripts/create-admin.ts` en un `.mjs` autonome au build (esbuild est déjà présent via tsx/next ? vérifier `node_modules/.bin`), le copier dans le runner, lancer avec `node scripts/create-admin.mjs ...` en lisant `DATABASE_URL` / `BETTER_AUTH_SECRET` de l'env du conteneur. `npm run create-admin` en local reste inchangé.

## Done quand

- `docker build .` réussit et `docker run --rm <img> node scripts/create-admin.mjs --help` (ou sans args) affiche l'usage sans crash de module manquant.
- Contre la DB dev locale (`maresa`, conteneur `maresa-pg`, réseau host), la création d'un tenant jetable fonctionne puis le tenant est supprimé.
- Le Dockerfile reste multi-stage ; pas de `node_modules` complet dans le runner.

## Comments

### Résolution (agent)

**Changements** (uniquement `Dockerfile`, `package.json` et `scripts/` inchangés) :
- `Dockerfile:12-15` (stage `builder`) : après `npm run build`, `npx esbuild` bundle `scripts/create-admin.ts` en `scripts/create-admin.mjs` autonome (ESM, node20, toutes deps incluses ; banner `createRequire` pour les deps CJS). Les alias `@/` sont résolus via `tsconfig.json`.
- `Dockerfile:35-36` (stage `runner`) : `COPY` de `scripts/create-admin.mjs`. Toujours multi-stage, runner = standalone Next seulement (pas de `node_modules` complet, pas de tsx).
- `npm run create-admin` en local : inchangé.

**Commande prod** (terminal Coolify du conteneur, `DATABASE_URL` lu depuis l'env du conteneur ; `BETTER_AUTH_SECRET` n'est pas utilisé par ce script) :
```
node scripts/create-admin.mjs --name "Hôtel du Coin" --slug hotel-du-coin --domain hotelducoin.fr --email contact@hotelducoin.fr --password "motdepasse" [--template classic|boutique|affiche|standard] [--link-existing]
```

**Vérification** :
- `docker build .` tel quel **échoue avant mon étape**, problème préexistant : `next build` → « Failed to collect page data for /api/admin/stripe/status » car `lib/stripe.ts` lève `STRIPE_SECRET_KEY manquant` à l'évaluation du module. À traiter à part (lazy init dans `lib/stripe.ts`, ou variable dispo au build dans Coolify). Pour vérifier, build avec une copie du Dockerfile ajoutant seulement `ENV STRIPE_SECRET_KEY=sk_test_dummy` avant `npm run build` → rc=0.
- `docker run --rm <img> node scripts/create-admin.mjs --help` → affiche l'usage, exit 1, aucune erreur de module.
- `docker run --rm --network host -e DATABASE_URL=postgres://postgres@localhost:5432/maresa <img> node scripts/create-admin.mjs --name "Test CA03" --slug zz-ca03-test --email zz-ca03@example.test --password '…' --template boutique` → tenant, propriété, admin, accès créés (rc=0). Hash vérifié avec `verifyPassword` de `better-auth/crypto` → `true`. Relance avec le même email sans `--link-existing` → refus attendu (rc=1).
- Nettoyage : tenant/propriété/user/account/user_tenants supprimés (compte final 0|0), image supprimée.
- Non vérifié : connexion réelle via l'UI avec ce compte (seul le hash a été vérifié).

**Snippet pour `Déploiement.md`, étape 3 de « Ajouter un nouveau client »** :

> 3. Dans Coolify, ouvrir le **Terminal** du conteneur de l'app et lancer :
>    ```bash
>    node scripts/create-admin.mjs \
>      --name "Hôtel du Coin" \
>      --slug hotel-du-coin \
>      --domain hotelducoin.fr \
>      --email contact@hotelducoin.fr \
>      --password "motdepasse-provisoire" \
>      --template boutique
>    ```
>    Le script utilise le `DATABASE_URL` du conteneur (pas de `.env.local` en prod). `--domain` et `--template` (`classic` par défaut, ou `boutique`, `affiche`, `standard`) sont optionnels. Si l'email existe déjà, le script refuse : vérifier qu'il s'agit bien de la même personne, puis relancer avec `--link-existing` pour lui donner accès au nouvel hôtel. Relancer la commande avec le même `--slug` ne recrée pas le tenant.
>    En local, l'équivalent reste `npm run create-admin -- --name …`.

**Suivi (orchestrateur).** Le blocage `STRIPE_SECRET_KEY` au build est corrigé : `lib/stripe.ts` exporte `getStripe()` (client créé à la 1re utilisation), 4 appelants mis à jour. Suite E2E complète : 409 passed, 2 skipped, 0 failed (2026-11-06).
