# Lien reset password construit sur directloc.app

Status: resolved
Blocked by: 01 (l'URL absolue du tenant doit être une origine de confiance)

## Problème

`app/(auth)/forgot-password/page.tsx:39` envoie `redirectTo: "/reset-password"` (relatif). Better Auth construit le lien sur `BETTER_AUTH_URL` (`https://directloc.app`), qui n'a pas de tenant : l'admin de `hotelducoin.fr` atterrit hors de son hôtel.

## Attendu

`redirectTo` = URL absolue du domaine courant (`${window.location.origin}/reset-password`). Vérifier dans `lib/auth.ts` (`sendResetPassword`, param `url`) et dans le code Better Auth que le lien final de l'email ramène bien sur le domaine du tenant ; si le lien `/api/auth/reset-password/<token>` reste sur `BETTER_AUTH_URL`, le réécrire pour qu'il pointe sur le domaine du tenant de l'utilisateur (membership `userTenants` déjà résolu dans `sendResetPassword`).

## Done quand

- Le test existant `e2e/auth/forgot-password.spec.ts` est mis à jour : l'URL du lien capturé (helper `startSmtpSink`) commence par l'origine du tenant de test.
- `npx tsc --noEmit` et `npx eslint` sans nouvelle erreur.

## Comments

**Fait (agent).**
- `app/(auth)/forgot-password/page.tsx:40` — `redirectTo: \`${window.location.origin}/reset-password\``.
- `lib/auth.ts:49-60` — vérifié dans `better-auth/dist/api/routes/password.mjs` : le lien vaut `${ctx.context.baseURL}/reset-password/<token>?callbackURL=…`, donc toujours sur `BETTER_AUTH_URL`. `sendResetPassword` le réécrit : origine = `https://<tenant.domain>` du membership `userTenants`, à défaut l'origine du `callbackURL` (déjà validé par `originCheck`), à défaut celle d'origine ; le `callbackURL` est aligné sur la même origine (`<origine>/reset-password`). La route GET `/api/auth/reset-password/:token` valide ce `callbackURL` contre les origines de confiance (ticket 01 en prod, `*.localhost:<port>` en dev).
- `e2e/auth/forgot-password.spec.ts:43-75` — nouveau test avec `startSmtpSink`, depuis `http://test-tenant.localhost:3001` ; le commentaire d'en-tête qui disait « pas de boîte SMTP en test » est corrigé.
- Vérif : `npx tsc --noEmit` et `npx eslint` propres. Le décodage de l'email par le test (quoted-printable + `&amp;`) a été vérifié sur un vrai email produit par `sendPasswordResetEmail` vers le sink (sonde `npx tsx`). La logique de réécriture et `matchesOriginPattern` (`*.localhost:3001` et domaine prod) ont été vérifiés en node. Playwright non lancé.
- Limite : le test laisse une ligne `verifications` `reset-password:<token>` non consommée (expire après 1 h, comme les deux tests de soumission déjà présents).

**Spec Obsidian (Tests de non-régression.md) :**
> **Lien de reset sur le domaine du tenant** — `e2e/auth/forgot-password.spec.ts`. Depuis `http://test-tenant.localhost:3001/forgot-password` (alors que `BETTER_AUTH_URL` = `http://localhost:3001`), l'admin de test demande un reset. Le faux SMTP capture l'email : le lien commence par `http://test-tenant.localhost:3001/api/auth/reset-password/`, son `callbackURL` vaut `http://test-tenant.localhost:3001/reset-password`, et suivre le lien mène à `/reset-password?token=…` sur ce même domaine. En prod, c'est le `domain` du tenant de l'admin qui est utilisé.
