# `/essayer` : connexion auto + liens croisés

Status: resolved
Blocked by: 01, 02

## Attendu

1. Sur le domaine vitrine (`MARKETING_HOST`), `/essayer` redirige (302) vers `https://<domaine du tenant démo>/essayer` (en dev/test : `http://demo-tenant.localhost:3001/essayer`). La branche vitrine de `proxy.ts` réécrit tout vers `/vitrine/*` : traiter `/essayer` avant.
2. Sur le domaine du tenant démo, `/essayer` crée une session Better Auth pour l'utilisateur démo **sans mot de passe** (API serveur de Better Auth, ex. `internalAdapter.createSession` + cookie signé comme Better Auth le fait — vérifier dans `node_modules/better-auth`), pose le cookie et redirige vers `/admin`. Sur tout autre tenant : 404. Si l'env `DEMO_TENANT_SLUG` est absente : 404.
3. Chaque visite crée sa propre session (pas de session partagée entre visiteurs) ; durée courte (ex. 2 h).
4. Liens croisés :
   - admin démo : bandeau discret « Démo — données remises à zéro chaque nuit » + lien « Voir le site de réservation » (ouvre `/` du domaine démo) ;
   - site public démo : bandeau « Site de démonstration » + lien « Voir l'admin » (vers `/essayer`) + mention carte de test `4242 4242 4242 4242` sur le formulaire de réservation.
   Aucun de ces éléments n'apparaît sur un tenant non démo.
5. Respecter le style existant : admin = tokens `--admin-*` (`components/admin/ui.tsx`) ; public = templates (`components/public/site.css`). Lire `DESIGN.md`.

## Done quand

- `e2e/public/demo-access.spec.ts` : vitrine `/essayer` → 302 vers le domaine démo ; démo `/essayer` → arrive sur `/admin` connecté (dashboard visible) ; `test-tenant` `/essayer` → 404 ; bandeaux présents sur la démo, absents sur `test-tenant` ; lien « Voir l'admin » du site démo mène à l'admin connecté.
- `npx tsc --noEmit` et `npx eslint` propres.

## Comments

### Implémentation (agent, 2026-11-15)

**Changé**
- `lib/auth.ts:18-48` — plugin Better Auth inline `demo-session`, endpoint `demoSignIn` (`/demo/sign-in`, `metadata.SERVER_ONLY` : exclu du routeur `/api/auth`, appelable via `auth.api` seulement). `internalAdapter.createSession(user, dontRememberMe=true, {expiresAt: +2 h}, overrideAll)` puis `setSessionCookie` de `better-auth/cookies` (`maxAge` 2 h) : cookie identique à celui de Better Auth (nom, signature `BETTER_AUTH_SECRET`, préfixe/flag secure en prod, host-only). `dontRememberMe` ⇒ Better Auth ne prolonge jamais ces sessions (refresh 7 j désactivé) ; les sessions admin normales sont inchangées.
- `lib/demo.ts:20` `demoUserEmail()` (réutilisé par `lib/demo-seed.ts:126`).
- `app/essayer/route.ts` — GET : 404 si `x-tenant-id` n'est pas le tenant démo (ou `DEMO_TENANT_SLUG` absente, ou compte démo pas seedé) ; sinon `auth.api.demoSignIn({ returnHeaders: true })`, recopie les `Set-Cookie`, 302 `Location: /admin`, `no-store`.
- `proxy.ts:91` `demoOrigin()` + `:164` — vitrine `/essayer` → 302 `https://$DEMO_TENANT_DOMAIN/essayer` (dev/test : `http://<slug>.localhost:<port>/essayer`), 404 si non configuré ; traité avant la réécriture `/vitrine`. `:17,120` règle de rate limit `essayer` 20 req/min/IP (vitrine et démo).
- `app/vitrine/page.tsx:133,174,279` — `<Link>` → `<a>` : un prefetch Next de `/essayer` aurait ouvert une session à chaque affichage de la vitrine.
- Bandeaux : `app/admin/layout.tsx:35,68` (tokens `--admin-primary(-light)`, « Démo — données remises à zéro chaque nuit » + « Voir le site de réservation » → `/` nouvel onglet) ; `components/public/PublicLayout.tsx:63,89` + `site.css:29` `.s-demo` (couleurs `--s-accent`/`--s-surface`/`--s-ink` : suit les 4 templates) « Site de démonstration · Voir l'admin » ; `components/public/BookingForm.tsx:449` `.s-note` carte de test, prop `demo` passée par `app/reserver/[roomId]/page.tsx:19,55`.
- `e2e/public/demo-access.spec.ts` — nouveau (11 tests).

**Vérifié** : `npx playwright test e2e/public/demo-access.spec.ts e2e/public/vitrine.spec.ts` → 22 passed (26.6 s). `npx tsc --noEmit` et `npx eslint` (11 fichiers) propres. Note : la 1re version du rate limit (10/min) était atteinte par le spec lui-même → passée à 20/min.

**Spec pour « Tests de non-régression.md »**
> **Démo — accès « Essayer »** (`e2e/public/demo-access.spec.ts`) — Vitrine `/essayer` → 302 vers `demo-tenant.localhost:3001/essayer` ; le bouton « Essayer l'admin » de la vitrine aboutit sur le tableau de bord démo connecté. Démo `/essayer` → 302 `/admin`, cookie `better-auth.session_token` HttpOnly, host-only sur le domaine démo, durée 2 h (cookie et base), non prolongée par la navigation ; deux visiteurs reçoivent deux sessions distinctes ; la session démo ne vaut pas sur `test-tenant` (`/admin` → `/login`). `test-tenant` `/essayer` → 404 sans cookie ; au-delà de 20 hits/min/IP → 429. Bandeaux : admin démo (« Démo — données remises à zéro chaque nuit » + lien site), site démo (« Site de démonstration » + « Voir l'admin » → admin connecté), carte de test 4242 sur le formulaire de réservation ; aucun de ces éléments sur `test-tenant` (site, réservation, admin). Nettoyage : sessions du compte démo supprimées en afterAll.
