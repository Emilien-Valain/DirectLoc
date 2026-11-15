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
