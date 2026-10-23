# Room photo API returns 500 on a malformed room id

Status: resolved — garde isUuid → 404 dans POST, DELETE, PUT
Group: Should fix

## Problem

`app/api/admin/rooms/[id]/photos/route.ts` (POST, DELETE and PUT) passes `id` straight to a uuid column. `/api/admin/rooms/abc/photos` gives a Postgres "invalid input syntax for type uuid" error and a 500. Project rule: unknown resource gives 404, never 500.

## Fix

At the top of each of the 3 handlers: `if (!isUuid(roomId)) return NextResponse.json({ error: "Chambre introuvable" }, { status: 404 });` (`isUuid` from `lib/validation.ts`, same pattern as the other routes).

## Acceptance

- Test in `e2e/admin/admin-errors.spec.ts`: POST, DELETE and PUT with a non-UUID id each return 404.

## Comments

- `app/api/admin/rooms/[id]/photos/route.ts` : `isUuid(roomId)` en tête des 3 handlers (avant la session et la lecture du body).
- Test : `e2e/admin/admin-errors.spec.ts` « POST, DELETE et PUT sur /api/admin/rooms/abc/photos → 404 ».
