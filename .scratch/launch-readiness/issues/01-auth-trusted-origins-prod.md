# Better Auth refuse les POST avec cookie sur les domaines tenants en prod

Status: resolved

## Problème

`lib/auth.ts` ne définit `trustedOrigins` qu'en `NODE_ENV=development`. En prod, `BETTER_AUTH_URL=https://directloc.app` est la seule origine de confiance. Better Auth (`node_modules/better-auth/dist/api/middlewares/origin-check.mjs`, `validateOrigin`) valide l'en-tête `Origin` de tout POST qui porte un cookie. Donc sur `https://hotelducoin.fr` :
- `signOut()` (`components/admin/Sidebar.tsx:86`) → 403 `INVALID_ORIGIN`, la session reste active ;
- une reconnexion avec un vieux cookie présent → 403.

Les E2E tournent en dev (`*.localhost` de confiance), d'où l'absence de test rouge.

## Attendu

En production, les origines de confiance = `BETTER_AUTH_URL` + `https://<domain>` de chaque ligne `tenants` ayant un `domain`. Better Auth accepte une fonction async `trustedOrigins: (request) => Promise<string[]>`. Le comportement dev actuel (`*.localhost<port>`) reste identique.

Extraire la construction de la liste dans une fonction exportée testable (ex. `prodTrustedOrigins(domains: string[], baseURL: string): string[]`), la requête DB restant dans `lib/auth.ts`. Un domaine tenant inconnu n'est jamais de confiance.

## Done quand

- Test unitaire dans `e2e/unit/` (projet Playwright `unit`) : un domaine tenant est inclus, un domaine absent est exclu, `BETTER_AUTH_URL` est inclus, une ligne `domain = null` est ignorée.
- `npx tsc --noEmit` et `npx eslint` sans nouvelle erreur.

## Comments

**Fait (agent).**
- `lib/trusted-origins.ts:6` — `prodTrustedOrigins(domains, baseURL)` : origine de `BETTER_AUTH_URL` + `https://<domain>` et `https://www.<domain>` (proxy.ts sert le `www.` comme le même tenant) ; `null`/vide ignorés.
- `lib/auth.ts:75-102` — hors `development`, `trustedOrigins` devient une fonction async qui lit `tenants.domain IS NOT NULL` et appelle `prodTrustedOrigins`. Sans `request` (init Better Auth, build) elle renvoie `[]` pour ne pas toucher la DB. Le dev (`*.localhost<port>`) est inchangé. Limite notée en `shortcut:` : une requête DB par appel auth (deux sur un POST avec cookie), pas de cache.
- `e2e/unit/trusted-origins.spec.ts` — nouveau (projet `unit`).
- Vérif : `npx tsc --noEmit` et `npx eslint` propres ; assertions du helper vérifiées via `npx tsx`. Playwright non lancé. Le comportement prod réel (signOut sur un domaine tenant) n'a pas été testé de bout en bout.

**Spec Obsidian (Tests de non-régression.md) :**
> **Origines de confiance Better Auth (prod)** — `e2e/unit/trusted-origins.spec.ts`. Test unitaire de `prodTrustedOrigins` : l'origine de `BETTER_AUTH_URL` est incluse (sans chemin), un domaine tenant est inclus avec son `www.`, un domaine absent de la table n'est jamais de confiance, et une ligne `domain = null` (ou vide) est ignorée. Régression : sans ces domaines, `signOut` et les reconnexions sur un domaine client renvoyaient 403 `INVALID_ORIGIN`.
