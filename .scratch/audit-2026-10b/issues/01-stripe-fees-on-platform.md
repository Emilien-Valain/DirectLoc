# The platform may pay the Stripe fees on every Connect booking

Status: implemented — direct charges (option 2) ; reste à vérifier sur un paiement test-mode
Group: Must fix

## Problem

`lib/actions/bookings-public.ts:150-158` uses `payment_intent_data.on_behalf_of` + `transfer_data.destination`, which is a Stripe **destination charge**. The comment says "les frais Stripe sont à sa charge" (the hotel pays the fees). With destination charges, Stripe normally takes its fee from the **platform** balance, and `on_behalf_of` does not change who pays it.

Example: a €300 booking. The hotel receives €300 and the platform pays about €4.75 in fees.

## Why human

This is a business decision (who pays the fees, and whether there is a commission), and it needs checking on a real payment in the Stripe dashboard.

## Options

1. Keep destination charges and set `application_fee_amount` so the fee is covered (an approximation).
2. Switch to direct charges: create the Checkout Session with `{ stripeAccount }`. That also needs a Connect webhook endpoint, because `checkout.session.*` events then arrive as Connect events.
3. Accept the cost: fix the misleading comment only.

## Acceptance

- Checked on one real or test-mode payment: whose balance carries the fee.
- The chosen option is implemented, or the comment is corrected.

## Comments

- Décision humaine (2026-10-24) : la plateforme ne paie pas les frais → **option 2, direct charges**.
- `lib/actions/bookings-public.ts` : plus de `payment_intent_data` (`on_behalf_of` / `transfer_data`) ; la session est créée avec `{ stripeAccount: tenant.stripeAccountId }`. Tenant sans Connect : inchangé (session plateforme).
- `app/api/webhooks/stripe/route.ts` : signature vérifiée avec `STRIPE_WEBHOOK_SECRET` puis `STRIPE_CONNECT_WEBHOOK_SECRET` ; un événement `checkout.session.*` porteur de `account` est ignoré (200 + log) si ce compte n'est pas celui du tenant de `metadata.tenantId`.
- Rien d'autre ne relit la session chez Stripe (la confirmation lit la DB), pas de remboursement automatique dans le code.
- Tests : `e2e/payment/stripe-webhook.spec.ts` (Connect légitime → confirmed ; compte étranger / tenant sans compte / tenantId malformé → pending). `playwright.config.ts` pose un `STRIPE_CONNECT_WEBHOOK_SECRET` de test.
- Docs : `Guide Déploiement VPS.md` §8.1 (endpoint Connect + nouvelle variable), `Tests de non-régression.md`.
- **À faire par un humain** (acceptance) : 1) dans Stripe, endpoint « comptes connectés » → secret dans `STRIPE_CONNECT_WEBHOOK_SECRET` (ou garder l'existant dans `STRIPE_WEBHOOK_SECRET`) ; 2) un paiement test-mode sur un tenant connecté : vérifier dans le dashboard que le frais est débité du compte connecté, et que le booking passe `confirmed`.
- Point d'attention : Stripe recommande plutôt les direct charges avec des comptes Standard ; avec Express, le tenant n'a qu'un dashboard Express (litiges/remboursements gérés par lui via ce dashboard ou par la plateforme via l'API avec `stripeAccount`).
