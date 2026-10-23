# Test: the orphan-pending cleanup cancels only real orphans

Status: resolved — test 5 cas (A annulé ; B, C, D, E intacts)
Group: Should fix (missing test)

## Problem

`cancelOrphanPending` (`lib/queries/bookings.ts:83-98`, run by `/api/cron/booking-emails`) cancels bookings. A wrong condition (say a missing `source = 'direct'` or `not exists payments`) would cancel manual or in-payment bookings, and no test covers it.

## Fix

Test only, in `e2e/admin/cron-booking-emails.spec.ts`. Seed 3 bookings directly in the DB:
- A: `pending`, `source=direct`, `createdAt` 2h ago, no payment row: **cancelled**.
- B: same as A but with a `payments` row: **stays pending**.
- C: `pending`, `source=direct`, `createdAt` 10 min ago, no payment: **stays pending**.
- (Optional) D: `pending`, `source=manual`, 2h ago: **stays pending**.
Call the cron with `CRON_SECRET`, then assert the statuses. Clean up.

## Acceptance

- The test fails if any one condition of the WHERE clause is removed.
- Obsidian spec updated.

## Comments

- `e2e/admin/cron-booking-emails.spec.ts` : seed A (orphelin), B (avec payment), C (10 min), D (manual), E (confirmed) puis cron → seul A passe `cancelled`. Un cas par condition du WHERE. Nettoyage par email taggé.
- `CRON_SECRET` n'était pas défini en test (le test « bon secret » était toujours skippé) : `playwright.config.ts` pose `process.env.CRON_SECRET ??= "test-cron-secret-for-playwright"` et le passe au webServer.
- Vérifié par mutation : sans `source = 'direct'`, le test échoue.
- Obsidian : section « Cron emails automatiques ».
