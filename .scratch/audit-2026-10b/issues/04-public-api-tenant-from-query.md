# Public APIs let the caller choose the tenant

Status: resolved — le proxy résout le tenant depuis l'hôte et écrase x-tenant-id ; plus de ?tenantId
Group: Should fix

## Problem

`/api/availability`, `/api/pricing`, `/api/rules` and `/api/rooms/available` read `x-tenant-id ?? searchParams.get("tenantId")`. Their comments say the header is injected by the proxy in production. It is not: `proxy.ts:108` returns `NextResponse.next()` for every non-admin `/api/*` route **before** tenant resolution, so production always uses the `?tenantId=` query param (or a header the client sent itself). The frontend passes `tenantId` in the query (`components/public/BookingForm.tsx`, `HomeSearch.tsx`).

Failure case: on hotel A's domain, `/api/rooms/available?tenantId=<hotel B>` lists hotel B's rooms and prices. `/api/rules` returns B's rules. `loadPricingContext` (`lib/pricing.ts`) loads the room by id only, so it mixes one tenant's room price with another tenant's rules.

## Fix

1. In `proxy.ts`: for public `/api/*` routes that need a tenant (availability, pricing, rules, rooms/available), resolve the tenant from the host like other routes and **always overwrite** `x-tenant-id`. Keep the pass-through for `/api/webhooks/*`, `/api/cron/*`, `/api/health`, `/api/ical/*`, `/api/uploads/*` (they do not use a host tenant).
2. In the 4 routes: read only the header and drop the `tenantId` query param.
3. In `loadPricingContext`: also filter the room by `tenantId`.
4. Remove `tenantId` from the frontend query strings.
5. Update e2e tests that pass `?tenantId=`: they hit `localhost:3001`, which resolves through `PUBLIC_TENANT_SLUG` / `*.localhost`, so check how the test tenant is reached (`e2e/global-setup.ts`, `playwright.config.ts` webServer env).

## Acceptance

- Test: a request with `?tenantId=<other tenant>` (and one with a forged `x-tenant-id` header) still returns the host tenant's data only.
- Full suite passes.
- Obsidian spec updated.

## Comments

- `proxy.ts` : seules `/api/webhooks/`, `/api/cron/`, `/api/health`, `/api/ical/`, `/api/uploads/` (et les pages auth) passent sans résolution ; les autres API publiques passent par `resolveTenant(host)` et reçoivent `x-tenant-id` écrasé.
- Les 4 routes lisent uniquement l'en-tête. `loadPricingContext` filtre la chambre par `tenantId`.
- Front : `tenantId` retiré des query strings et de la chaîne de props devenue inutile (`BookingForm`, `HomeSearch`, `BookingFormSection`, blocs Classic/Boutique, `app/reserver/[roomId]/page.tsx`).
- Tests : `?tenantId=` retiré des specs (availability, holds, rule-resolution, rules-pricing, rules-booking-rules, booking-flow, security) ; cas « tenantId non-UUID → 400 » et « 400 si tenantId manquant » supprimés (le paramètre n'existe plus). Nouveaux : `availability.spec.ts` (dates réservées + `?tenantId=<rival>` / en-tête forgé → indisponible) et `security.spec.ts` (rooms/available avec rival en query/en-tête → jamais la chambre rivale).
- Effet de bord : un hôte inconnu reçoit 404 sur ces 4 API (comme sur les pages).
- Suite complète passée (voir README / résumé).
