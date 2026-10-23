# Remove the dead `tenantId` columns on users and sessions

Status: resolved — colonnes supprimées, migration 0008 appliquée sur maresa_test
Group: Should fix (lean)

## Problem

`users.tenantId` (`db/schema.ts:42`) and `sessions.tenantId` (`db/schema.ts:57`) are left over from before `user_tenants`. They are exposed through `additionalFields` in `lib/auth.ts:64-81` and written only by `scripts/create-admin.ts:114`. Nothing reads them: `proxy.ts` and `lib/session.ts` always check `user_tenants`. Risk: a future change trusts `session.tenantId` and skips the membership check.

## Fix

1. Grep the whole tree first (including `e2e/`, `scripts/`, `.tsx`) for `tenantId` on user/session objects and `tenant_id` in raw SQL, to confirm nothing reads them.
2. Remove both columns from `db/schema.ts`, both `additionalFields` blocks from `lib/auth.ts`, and the `tenantId` write in `scripts/create-admin.ts` (and in `e2e/global-setup.ts` if it sets them).
3. `npm run db:generate` to create the migration. Check that the generated SQL only drops those 2 columns.

## Acceptance

- `npx tsc --noEmit` passes.
- Full suite passes (login, subdomain session, multi-tenant).
- Migration applies on the test DB.

## Comments

- Grep : aucun lecteur de `users.tenantId` / `sessions.tenantId` hors la relation Drizzle `usersRelations.tenant` (inutilisée, retirée avec `tenantsRelations.users`).
- Retirés : 2 colonnes de `db/schema.ts`, les 2 `additionalFields` de `lib/auth.ts`, l'écriture dans `scripts/create-admin.ts` et `e2e/global-setup.ts`.
- `npm run db:generate` → `db/migrations/0008_foamy_zombie.sql` : 2 DROP CONSTRAINT (FK) + 2 DROP COLUMN, rien d'autre.
- Appliquée sur `maresa_test` via psql. **Pas appliquée sur la DB dev `maresa`** : lancer `npm run db:migrate`.
- `npx tsc --noEmit` OK ; suite complète OK (login, subdomain session, multi-tenant).
- Obsidian : `Schema DB.md` mis à jour.
