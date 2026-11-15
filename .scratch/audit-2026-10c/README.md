# Audit 2026-10 (c)

Source: third `/ponytail-audit` run on 2026-10-24, after `audit-2026-10b`. Same assumed load. All fixed in one pass; tests in `/e2e/` are tagged `audit 2026-10c/<n>`.

| # | Group | Status | Issue |
|---|-------|--------|-------|
| 1 | Must | resolved | Public sign-up was open: pre-create a future host's account, `create-admin` linked it to the hotel. `disableSignUp: true` + `--link-existing` required |
| 2 | Should | resolved | Webhook ignored payments made after a Stripe disconnect/reconnect. Now checks the `payments` row (session + booking + tenant) instead of the tenant's current account |
| 3 | Should | resolved | Booking rate limit counted typos. Now counted after form validation |
| 4 | Should | resolved | Manual block with end = start blocked nothing. Now refused |
| 5 | Should | resolved | -100 % promo / totals under 0.50 € broke Stripe with a misleading error. Modifier must be > -100; totals < 0.50 € refused before any insert |
| 6 | Should | resolved | Email context loaded by hand in 3 places → `loadEmailContext` in `lib/queries/bookings.ts` |
| 7 | Should | resolved | Hand-copied Better Auth hash in `create-admin` and `e2e/global-setup.ts` → `better-auth/crypto` |
| 8 | Nice | resolved | `syncTenantIcalSources` + `syncAllIcalSources` → `syncIcalSources(tenantId?)` |
| 9 | Nice | resolved | `parseDays` written twice in `lib/actions/rules.ts` |

## Comments
- `e2e/auth/login.spec.ts`: 4–6 login tests time out at 5 s on a cold `next dev`. Same failures with fix 1 reverted, so this flakiness was already there. Not fixed here.
