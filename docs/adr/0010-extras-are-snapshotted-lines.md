# Extras are snapshotted lines on the booking; the agreed price covers accommodation only

A [[booking]] can carry [[extra|Extras]] (breakfast, linen, towels…) chosen by the guest online or added by an admin. Each attached Extra is stored as a **line on the booking that copies the Extra's label, unit and unit price at the moment it was attached**. The catalog is only read when an Extra is (re)attached; later catalog edits, deactivation or deletion never change an existing booking.

The quantity is never stored as a free input: it is derived from the booking's nights and guest count according to the unit (per stay, per night, per guest, per guest per night). When an admin edits dates or guest count, quantities are recomputed with the **snapshotted** unit price. Unticking an Extra removes its line; re-ticking creates a new line at the current catalog price.

`bookings.totalPrice` stays the single grand total (accommodation + Extras) — what Stripe charges, what the PDF and emails show, what the 0,50 € Stripe floor checks. Extras are priced inside `admitBooking` (ADR-0008), so public and manual intake cannot diverge, and the server always recomputes — any amount sent by a form is ignored.

The admin's **agreed price** (« prix convenu ») replaces the **accommodation part only**: total = agreed price + Extras.

Extras added after an online payment raise the total; the difference is the [[balance-due|Balance due]], settled on site (no second Stripe link). Removing an Extra or cancelling a booking never refunds automatically — the admin refunds in Stripe, as for cancellations today.

## Rejected alternatives

- *Read Extras live from the catalog* — a price change would silently rewrite the bill of already-paid bookings.
- *Agreed price overrides the whole total, Extras included* — the lines would no longer sum to the displayed total, making the PDF and emails self-contradictory.
- *Free quantity per Extra* — lets a stay extended from 3 to 5 nights keep billing 3 breakfasts; derivation from nights × guests stays correct on every edit.

## Out of scope

Mandatory charges (cleaning fee, tourist tax) are not Extras — the tourist tax has its own legal rules (adults only, per night, municipal scale). To be modelled in a separate session.

## Amendment (2026-11-19): « per bed » is a chosen quantity

Hosts charge bed linen per bed, and guests often want fewer sets than the room has beds (4 beds, one pair of sheets). We add a fifth unit, `per_bed`, whose quantity is **chosen** by the guest (or the admin) rather than derived — bounded server-side to `[1, rooms.beds]` (`rooms.capacity` when beds are unset), defaulting to every bed. The chosen quantity is snapshotted on the line like the price; editing a booking keeps it unless changed, and re-clamps it if the room changed. Other units stay derived; Fees cannot be `per_bed` (a mandatory charge has no one to choose its quantity).

## Amendment (2026-11-19): any Extra can offer a chosen count

Hosts sell things guests take several of (2 picnic baskets, 3 bikes). An Extra gets an optional **maximum** (`extras.max_quantity`, 2–99; empty or 1 = no choice). The guest (or admin) picks a **count** in `[1, max]`, snapshotted on the line as `booking_lines.chosen`; the line quantity is **derived quantity × count** (per stay: count; per night: nights × count; …). The derivation from nights and guests is kept, so the rejected *free quantity* still does not apply: extending a stay still re-derives the nights, only the count is chosen. `per_bed` is the same mechanism with the count bounded by the room's beds (default every bed) instead of a host maximum; other units default to 1. The server clamps every count; editing a booking keeps the saved count, and its bound never drops below that count when the host later lowers the maximum. Fees never have a count.
