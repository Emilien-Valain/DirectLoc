# Test: an iCal source returning HTML must not wipe its blocks

Status: resolved — test réécrit avec flux local ; corrige aussi node-ical cassé dans Next (BigInt)
Group: Should fix (missing test)

## Problem

`lib/ical-sync.ts:85-87` throws when the response has no `BEGIN:VCALENDAR`. Without this guard, an error page served with status 200 parses as "zero events", the sync deletes every block of the source, and rooms booked on Airbnb show as free (double bookings). No test fails if the guard is removed.

## Fix

Test only. In `e2e/admin/ical-sync.spec.ts` (reuse how the existing tests serve a local feed with `ICAL_ALLOW_PRIVATE=1` / `localhost`):
1. Sync a valid feed and check the blocks exist.
2. Point the source to (or switch the served response to) an HTML 200 page and sync again.
3. Assert the blocks are still there and the sync reports an error.
Clean up the source and blocks.

## Acceptance

- The test fails when lines 85-87 are commented out and passes with them.
- Obsidian spec updated.

## Comments

- Il existait déjà un test (`e2e/admin/ical-sync.spec.ts`) pointé sur `/login`, mais il passait même garde retiré : **toute synchro iCal échouait dans le serveur Next** avec `TypeError: e.BigInt is not a function` (node-ical / temporal-polyfill bundlé par Turbopack). Donc en dev/test (et probablement en prod, `next build` utilise aussi Turbopack) aucun calendrier Airbnb/Booking n'était importé.
- Fix hors périmètre « test only », mais nécessaire pour l'acceptance : `serverExternalPackages: ["node-ical"]` dans `next.config.ts` (1 ligne).
- Test réécrit : serveur HTTP local (`localhost`, seul nom exempté par `ICAL_ALLOW_PRIVATE=1`), 1re synchro d'un vrai .ics → 1 bloc ; 2e synchro d'une page HTML 200 → bloc conservé et `errors` +1. Source et blocs supprimés en afterAll.
- Vérifié : avec le garde désactivé, le test échoue (errors inchangé) ; avec le garde, il passe.
- À vérifier par un humain : une synchro réelle sur un build de prod (`next build && next start`).
- Obsidian : section « Calendriers externes ».
