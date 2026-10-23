# Public booking form has no rate limit: a bot can hold every room

Status: resolved — 5 envois / 10 min par IP sur createBookingPublic
Group: Must fix

## Problem

`createBookingPublic` (`lib/actions/bookings-public.ts:34`) creates a `pending` booking plus a Stripe Checkout Session with a 30-minute expiry. Pending bookings are Holds: they block the room on the site and are exported in the iCal feed (`app/api/ical/[roomId]/route.ts`), so Airbnb and Booking block those dates too.

The rate limit in `proxy.ts:94-104` only covers `/api/*`. The form is a server action POSTed to a page path (`/reserver/[roomId]`), so it has no limit at all.

Failure case: a script submits the form for every room every 30 minutes and never pays. The hotel shows as full everywhere.

## Fix

At the top of `createBookingPublic`, after reading `headersList`:
- Get the IP the same way `proxy.ts` does (`x-forwarded-for` first entry, then `x-real-ip`, then `"unknown"`).
- `checkRateLimit({ name: "booking-public", limit: 5, windowSec: 600 }, ip)` from `lib/rate-limit.ts`.
- If limited, return a `PublicBookingState` with a clear French error ("Trop de tentatives, réessayez dans quelques minutes.") and the `values`. Do not throw.

Reuse the existing helper. No new dependency.

## Acceptance

- A Playwright test (`e2e/public/booking-flow.spec.ts` or `security.spec.ts`) with its own `x-forwarded-for` IP (see how `holds.spec.ts` / `rule-resolution.spec.ts` get a dedicated budget): the 6th submit within the window shows the error and creates no booking. Clean up the bookings that were created.
- Existing booking-flow tests still pass (each test should use its own IP if they would hit 5).
- Obsidian spec updated.

## Comments

- `lib/actions/bookings-public.ts` : IP lue comme dans `proxy.ts` (x-forwarded-for → x-real-ip → "unknown"), `checkRateLimit({ name: "booking-public", limit: 5, windowSec: 600 })` juste après la lecture des `values`, refus rendu au formulaire (« Trop de tentatives, réessayez dans quelques minutes. ») avec la saisie.
- Le contrôle est avant la validation : un envoi invalide consomme aussi le budget (voulu, un bot n'a pas besoin de dates valides pour sonder).
- Test : `e2e/public/booking-flow.spec.ts` « rate limit : le 6e envoi… » (5 envois email invalide, 6e valide → refus, 0 résa, nettoyage par email).
- Les tests de `booking-flow.spec.ts` prennent chacun une IP aléatoire (`beforeEach` + `setExtraHTTPHeaders`) : le fichier faisait 6–7 envois sur 10.10.0.3.
- Obsidian : section « Moteur de réservation ».
