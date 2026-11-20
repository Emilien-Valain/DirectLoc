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

## Amendment (2026-11-19, revised): the guest chooses within the stay

Guests often want an Extra for part of the stay (breakfast for 2 people out of 4, parking for 2 nights out of 5, linen for 1 bed out of 3). Every Extra therefore lets the guest (or admin) pick a **count of the unit's own dimension**, bounded by the stay rather than by a host setting: nights for *per night*, guests for *per guest* and *per guest per night* (quantity = chosen guests × nights), beds for *per bed*. Only *per stay* has a host-set maximum (`extras.max_quantity`, 2–99; empty or 1 = no choice), for things taken several times (2 picnic baskets).

The count is snapshotted on the line as `booking_lines.chosen`. **`NULL` means "the whole stay"**: it is the default, and it keeps following the stay when the admin extends dates or adds guests — so the rejected *free quantity* still does not apply. A smaller explicit count is kept on edits and clamped if the stay shrinks; picking the maximum stores `NULL` again. Forms only send a count the user actually picked, so a stale selector never overrides "whole stay". *Per stay* keeps an explicit count (1 by default) and never drops below the saved one when the host later lowers the maximum. The server clamps every count. Fees never have a count.

## Amendment (2026-11-20): an Extra can be limited to some rooms

Not every room offers every Extra (a jacuzzi in the suite only). `extras.room_ids` lists the rooms that offer it; empty means all rooms — the same shape as `fees.room_ids` (ADR-0011), read by `ownedRoomIds`, shared with the Rules and Fees (a forged foreign room alone is refused, never turned into "all rooms"). The admin form uses the same room picker as the Rules tab (« Toutes les chambres » by default). The public form, the manual booking form and `resolveExtraLines` only accept an Extra for a room it applies to. Lines already on a booking are snapshots and stay, even if the Extra is later limited to other rooms. Deleting a room removes it from every Extra; an Extra that targeted only that room is deleted, like a Fee.
