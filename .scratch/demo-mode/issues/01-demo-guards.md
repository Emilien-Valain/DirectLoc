# Garde-fous du tenant démo

Status: resolved

## Pourquoi

L'admin démo est ouvert à tout internet. Sans garde-fous : envoi d'emails arbitraires depuis `send.directloc.app` (spam, réputation Resend), un visiteur connecte son propre compte Stripe, upload de fichiers arbitraires, changement du mot de passe du compte partagé (verrouille la démo pour tous), changement de slug/domaine (casse la démo).

## Attendu

Pour un tenant où `isDemoTenant(tenantId)` (`lib/demo.ts`) est vrai :
1. **Emails** : aucun email ne part pour ce tenant (confirmation, modification, annulation, notification admin, rappel, remerciement, alerte paiement après annulation). Le flux métier continue normalement (la réservation est confirmée, seul l'envoi est sauté). Un seul point de contrôle si possible (là où `lib/email.ts` reçoit le tenant), pas un `if` par appelant. `sendCallbackRequest` (vitrine) n'est pas concerné.
2. **Stripe Connect** : `app/api/admin/stripe/connect/route.ts` (POST et DELETE) refuse (403) ; la section Paiements de `/admin/parametres` affiche un message clair (« Désactivé en démo ») au lieu du bouton.
3. **Uploads** : `app/api/admin/rooms/[id]/photos`, `gallery-photos`, `hero-photo` refusent les POST/PUT/DELETE (403) ; les uploaders affichent « Désactivé en démo ».
4. **Compte** : changement de mot de passe et reset password impossibles pour l'utilisateur du tenant démo (vérifier ce que l'admin expose ; `sendResetPassword` dans `lib/auth.ts` ne doit rien envoyer pour lui).
5. **Paramètres Général** : slug et domaine non modifiables (l'action serveur ignore/refuse ; champs en lecture seule).

Les refus serveur sont la vraie protection ; l'UI ne fait qu'expliquer.

## Done quand

- Specs E2E dans `e2e/admin/demo-guards.spec.ts` contre le tenant `demo-tenant` (connecté avec le compte démo seedé par le ticket 02 — si 02 n'est pas encore là, créer le tenant/utilisateur dans le `beforeAll` du spec avec les helpers existants de `e2e/helpers`, et le nettoyer) : POST connect → 403, upload → 403, réservation démo confirmée sans email capturé (`startSmtpSink`), changement de slug refusé. Plus un test de non-régression : le tenant `test-tenant` (non démo) garde tout.
- `npx tsc --noEmit` et `npx eslint` propres.

## Comments

### Implémentation (agent, 2026-11-15)

**Changé**
- `lib/email.ts:121-125` — point de contrôle unique : `sendEmail` reçoit `tenantId` et ne fait rien si `isDemoTenant`. Les 8 envois liés à un tenant le passent (`:223 … :517`) ; `tenantId` est requis sur les types de données réservation (`:149, :340, :394, :448`), optionnel pour le reset password (`:494`). `sendCallbackRequest` inchangé.
- `lib/queries/bookings.ts:230` — `loadEmailContext` ajoute `tenantId` à `emailData` : webhook, cron et actions admin le propagent sans modification (aucune retouche de `app/api/webhooks/stripe/route.ts`).
- `lib/auth.ts:69` — `sendResetPassword` passe le tenant de l'admin : aucun lien de reset ne part pour le compte démo. Pas de changement de mot de passe dans l'admin (seul `/api/auth/change-password` de Better Auth existe, il exige le mot de passe actuel, aléatoire et inconnu).
- 403 « Désactivé en démo » juste après `requireSession()` : `app/api/admin/stripe/connect/route.ts:16,75` (POST/DELETE), `hero-photo/route.ts:44,106`, `gallery-photos/route.ts:58,129,168`, `rooms/[id]/photos/route.ts:38,132,182`.
- UI : `components/admin/ui.tsx:501` nouveau primitif `DemoLock` (bandeau info + zone `inert`) ; utilisé `ContentSection.tsx:73,82` (hero, galerie) et `app/admin/chambres/[id]/edit/page.tsx:66` (photos de chambre). `StripeConnectSection.tsx:81` affiche « Désactivé en démo : … mode test Stripe » à la place des boutons. `demo` calculé dans `app/admin/parametres/page.tsx:59-62` et passé via `SettingsPageClient`.
- Slug/domaine : déjà non modifiables (affichage texte, `updateGeneral` ne lit que nom/contact ; zod jette les clés inconnues) — rien à changer, couvert par le spec.
- `e2e/admin/demo-guards.spec.ts` — nouveau.

**Vérifié** : `npx tsc --noEmit` et `npx eslint` (13 fichiers + spec) propres. Playwright non lancé (consigne).

**À savoir**
- Le spec crée son propre admin (mot de passe connu) rattaché à `demo-tenant`, plus une chambre ; il réutilise le tenant seedé par 02 s'il existe, sinon le crée et le supprime. Nettoyage complet en afterAll.
- En démo, l'annulation/modification admin redirige avec `?annulee=1` / `?modifiee=1` (« client prévenu ») alors que rien n'est parti : choix assumé, la démo se comporte comme la vraie app.

**Spec pour « Tests de non-régression.md »**
> **Garde-fous du tenant démo** (`e2e/admin/demo-guards.spec.ts`) — Connecté à l'admin de `demo-tenant` : `POST`/`DELETE /api/admin/stripe/connect` → 403 sans toucher au compte Stripe ; les 8 routes d'upload (hero, galerie, photos de chambre en POST/PUT/DELETE) → 403. Une réservation démo payée (webhook `checkout.session.completed`) passe en `confirmed`/`paid` sans aucun email capturé ; « mot de passe oublié » n'envoie rien au compte démo. Slug et domaine sont absents du formulaire et ignorés s'ils sont injectés. L'UI affiche « Désactivé en démo » (Paiements, hero, galerie, photos de chambre). Non-régression : sur `test-tenant`, aucun bandeau démo, bouton Stripe présent, upload sans fichier → 400 (pas 403).
