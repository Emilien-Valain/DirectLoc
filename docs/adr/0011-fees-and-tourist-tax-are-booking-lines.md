# Fees and tourist tax are snapshotted booking lines, collected online

Besides optional [[extra|Extras]] (ADR-0010), a [[booking]] carries two mandatory charges:

- **[[fee|Fees]]** — set by the hotel (cleaning, booking fee…). A list per tenant, same four units as Extras (per stay / night / guest / guest-night), applying to all rooms unless restricted to some.
- **[[tourist-tax|Tourist tax]]** — legal, collected for the municipality. Only the *au réel* regime is modelled. Two modes, chosen once per tenant:
  - **fixed**: amount × adults × nights (classified accommodation);
  - **percentage**: per night, `min(cap, rate × (accommodationPriceHT / occupants))` × adults × `(1 + additional)` (unclassified accommodation). `rate` is 1–5 % (law, checked 2026-11). `occupants` includes minors; only adults pay. `accommodationPriceHT` = the night's accommodation price (or the agreed price spread evenly over the nights, ADR-0010) divided by `1 + accommodation VAT` — a tenant setting, 10 % by default, 0 % for VAT-exempt hosts. `additional` = the cumulated additional taxes (departmental 10 %, regional…) levied on top of the capped amount; 10 % by default. In fixed mode the admin enters the published tariff, additional taxes included. Extras and Fees are never part of the base.

## One line model for everything added to a booking

Extras, Fees and the tax are all rows of one `booking_lines` table, `kind = extra | fee | tax`, each copying its label, unit, unit price/rate and computed amount at admission (`admitBooking`, ADR-0008). `bookings.totalPrice` = accommodation + sum of lines. Recap, Stripe line items, emails, PDF and [[balance-due|Balance due]] read this one list. Editing dates or guests recomputes quantities with the snapshotted rates.

Extras and Fees keep their snapshotted price on edit. The tax line is recomputed from the tenant's current setting whenever the admin edits the stay (the percentage base changes with the stay anyway, and a frozen rate + cap + VAT would need three more columns). Known limit: a booking that is never edited keeps the rate of its admission day, even across a 1 January change; the gap is cents.

## Collected online, waivable only by an admin

Fees and tax are included in the online Stripe payment — the guest pays once. On a booking the admin enters, the admin may waive a Fee (cleaning offered) or the tax (legal exemptions only they can know: seasonal worker, emergency housing…); a waived tax line is kept, marked exempt, so the declaration export shows it.

No automatic refund on cancellation (consistent with ADR-0010). A cancelled booking owes no tax and is excluded from the declaration export (one row per stay, confirmed or completed, filtered by check-out date).

## Rejected alternatives

- *Tax paid on site* — a second payment moment for the guest and cash handling for the host.
- *A municipal rate table maintained by DirectLoc* — ~35 000 municipalities voting rates yearly; the admin enters their own rate.
- *Forfait regime* — produces no charge on a booking, so there is nothing to model; such tenants disable the tax.
- *Separate tables for extras, fees and tax* — every consumer would sum three sources.
- *Tax rate per room* — mixed classifications under one tenant are rare; tenant-level until a real case appears.
