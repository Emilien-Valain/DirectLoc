# A Dossier groups one-room Bookings; a Booking never spans several rooms

Guests frequently need several rooms for one stay (families, groups visiting the Puy du Fou). We model this as a **Dossier**: one guest, one `[checkIn, checkOut)`, one payment, grouping one or more [[booking|Bookings]] that each still hold exactly one room. Every Booking belongs to a Dossier — a one-room stay is a Dossier of one — so there is a single code path, and the payment hangs off the Dossier rather than a Booking.

Everything that is per room today stays per room and untouched: [[hold|Holds]], the admission gate (ADR-0008, run once per room inside one transaction — all rooms admitted or none), booking rules, Extras (chosen per room, ADR-0010), tourist-tax lines (ADR-0011), the iCal export (ADR-0004) and the calendar. The Dossier adds only what is shared: guest identity, dates, the Stripe checkout, and one email per lifecycle event. Payment success confirms every Booking of the Dossier; expiry cancels them all. An admin may cancel a single room afterwards; the money is given back from DirectLoc as a Refund on the Dossier (see CONTEXT.md, never automatic).

All rooms of a Dossier share the same dates (v1).

## Rejected alternatives

- *A Booking holding several rooms (`booking_rooms`)* — every per-room mechanism (holds, rules, extras, tourist tax, iCal, calendar spans) would have to learn about multi-room bookings; high regression risk for no gain, and partial cancellation becomes an edit rather than a status change.
- *Dossier only for 2+ rooms* — two code paths everywhere (payment attached to a Booking or to a Dossier).
