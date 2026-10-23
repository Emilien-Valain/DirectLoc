# Remove the Stripe webhook rate limit

Status: resolved — règle webhook supprimée et /api/webhooks/ exclu de la règle api
Group: Nice to have (lean)

## Problem

`proxy.ts:16` and `proxy.ts:89-90` limit `/api/webhooks/*` to 30 requests per minute per IP. The Stripe signature check already rejects fake calls and is cheap. A burst of real events from one Stripe IP gets a 429, and confirmations arrive late (Stripe retries with backoff).

## Fix

Delete the `webhook` entry in `RATE_RULES` and its `if` branch. Also exclude `/api/webhooks/` from the `api` rule (otherwise webhooks fall into the 60/min public rule): change the condition to skip `/api/webhooks/` like `/api/admin/` and `/api/cron/`.

## Acceptance

- `e2e/payment/stripe-webhook.spec.ts` passes.
- Test: 40 webhook posts with an invalid signature in a row all return 400, none 429.

## Comments

- `proxy.ts` : entrée `webhook` et sa branche supprimées ; la règle `api` saute `/api/webhooks/` comme `/api/admin/` et `/api/cron/`.
- Test : `e2e/payment/stripe-webhook.spec.ts` « rafale de 65 webhooks… » (65 > 30 et > 60, IP dédiée 10.10.9.7) → tous 400.
- Vérifié par mutation : si les webhooks retombent dans la règle `api`, le test échoue (429).
