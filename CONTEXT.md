# DirectLoc

White-label direct-booking platform for small independent hotels and short-term rental hosts. A single multi-tenant deployment serves each hotel its own themed booking site on its own domain; the operator manages everything (no client-facing configuration UI).

## Language

### Acteurs

**Tenant**:
A hotel business that is DirectLoc's customer — owns a domain, a theme, and its isolated data. The unit of data isolation: every row carries a `tenantId`. One hotel = one tenant; an operator running several hotels does so as several tenants linked to one [[admin]] via `user_tenants`. (See ADR-0002.)
_Avoid_: client, hôtel client, compte

**Admin**:
A logged-in `users` row authorized to manage one or more [[tenant|tenants]] (membership via `user_tenants`). Distinct from the [[operator]] (the human running DirectLoc) and from a [[guest]] (who never logs in).
_Avoid_: utilisateur, compte

**Property** — _not a domain concept._
The `properties` table is dormant: exactly one is auto-created per [[tenant]] and every room attaches to it. Reason about rooms as belonging to a tenant, not a property. "Multiple buildings under one site" is not a product capability. (See ADR-0002.)

**Guest**:
The person who reserves and stays. A single concept — the booker and the occupant are not distinguished (a head-count is just `guestCount`, plus how many of them are under 18 — used only for the [[tourist-tax]]). Stored inline on a booking (`guestName`, `guestEmail`, `guestPhone`, `guestAddress`, …); there is no separate guest entity. The public site asks first name and last name separately, plus phone and postal address, all required; they are stored as one `guestName` ("Prénom Nom"). An admin entering a booking keeps a single name and optional phone/address.
_Avoid_: client, voyageur, customer

**Operator**:
The human (DirectLoc itself) who creates tenants and runs the platform. Distinct from an _admin_, who is a logged-in user managing one or more tenants.
_Avoid_: owner, gérant

### Réseau

**Voisin** (_Neighbour_):
Another [[tenant]] offered to a [[guest]] when the tenant they are visiting cannot host them for the requested stay. Membership in the network is on by default, reciprocal (a tenant that is in both sends and receives guests), and requires the tenant's GPS position — a tenant without one is outside the network. A Voisin is only offered if it can actually admit the stay (same dates, its own booking rules) — for the whole party, or, in a **shared stay**, for the part the full tenant cannot host (at most one Voisin per shared stay).
_Avoid_: partenaire, recommandation, voisin as a geographic word only

**Renvoi** (_Referral_):
The act of sending a [[guest]] from a full tenant to a [[voisin|Voisin]], carrying the stay (dates, the head-count still to be housed) and the sending tenant's identity, so a resulting [[dossier]] can be attributed to the network. Every Renvoi is recorded when the guest follows it (no guest data); a Dossier entered by an admin can be marked as coming from a Voisin. A Renvoi never moves money or guest data between tenants: the Voisin's Dossier is a separate reservation on the Voisin's own site.
_Avoid_: redirection, recommandation

### Réservation & disponibilité

**Booking**:
A reservation record — a [[guest]] holding a room for a date interval, with a price and a [[booking-status|status]]. The `[checkIn, checkOut)` interval (the "séjour") is an aspect of the booking, not a separate entity.
_Avoid_: réservation, résa, séjour, stay

**Dossier**:
A stay reserved in one go by one [[guest]]: one or more [[booking|Bookings]] (one per room) sharing the same dates, guest and a single payment. Every Booking belongs to exactly one Dossier, even a one-room stay. The guest never sees the word: to them the Dossier is « votre réservation », listing its rooms; the admin sees « Dossier » for the whole and « réservation » for each room. A Dossier is admitted all-or-nothing, but a single room can later be cancelled on its own. Editing one of its Bookings changes the guest of the whole Dossier; its dates cannot diverge from the other rooms' (v1): the admin changes the dates of the whole Dossier at once (every non-cancelled room re-admitted and re-priced, all or nothing), and may add a room to an existing Dossier (same dates, same guest). (See ADR-0012.)
_Avoid_: groupe, commande, panier, réservation groupée

**Block**:
A non-booking source of unavailability: either an **iCal block** (imported from an external channel via iCal) or a **manual block** (an admin closing dates). A Block has no guest and no revenue and is never a [[booking]] — iCal feeds from Airbnb/Booking carry no guest or price data, so an imported hold cannot be promoted to a Booking. (See ADR on channel integration.)
_Avoid_: réservation, blocage (in code)

**Availability**:
The derived answer to "can this room be reserved for `[checkIn, checkOut)`?" — the *complement* of the room's [[hold|Holds]] over that window. Not stored; always computed. The public iCal export must mirror this exact set so DirectLoc acts as the cross-channel sync hub (ADR-0004).
_Avoid_: disponibilité (in code)

**Hold**:
A span `[start, end)` for which a room is unavailable, *whatever the cause* — a [[booking|Booking]] (pending or confirmed), an **iCal Block**, or a **manual Block**. The unifying concept above [[booking]] and [[block]]: it carries no guest, price, or status of its own, only an occupied interval. [[availability|Availability]] is its complement. The availability module enumerates a room's Holds over a window once (collapsing the overlap predicate `start < windowEnd && end > windowStart` previously hand-written across each source) and the date-picker, the `isRoomAvailable` check, the room-list filter, and the iCal export all read that single set.
_Avoid_: blocage (in code — reserved for the manual [[block]]), réservation

**Source**:
Where a booking originated: `direct` (guest booked on the tenant's own site) or `manual` (an admin entered it). Reserved for future channel values (`airbnb`, `booking`) once a Channel Manager integration exists. A `manual` booking may be *admitted over an existing [[hold|Hold]]* — a deliberate admin override (the « Forcer » flag), e.g. recording a reservation already honored off-platform. A `direct` booking never may: the public engine always rejects overlap. Both pass the same admission gate (`admitBooking`, ADR-0008); they differ only in whether overlap and booking-rules are enforced.

**Booking status** — the *lifecycle & inventory* axis (`bookings.status`). Orthogonal to [[payment-status]]; says nothing about money. (See ADR-0003.)
- `pending` — created, room held, not yet committed (a direct booking awaiting payment).
- `confirmed` — **committed: the room is held and the reservation will be honored.** Not a statement about payment. A direct booking becomes confirmed *because* its payment succeeded; a manual booking is created confirmed and may be paid later (on arrival).
- `completed` — the stay is over (`checkOut` has passed). Set automatically, never by hand: `completeFinishedStays` moves `confirmed` bookings whose `checkOut` is before today (run by the `booking-emails` cron and when admin booking pages load). Terminal.
- `cancelled` — released; the room is freed. Terminal (a guest who wants to return makes a new booking).

Legal transitions (enforced): `pending → confirmed | cancelled`, `confirmed → completed | cancelled`. `completed` and `cancelled` are terminal. Any other jump is rejected.
_Avoid_: "confirmed = paid" (false — that conflates the two axes)

**Payment status** — the *money* axis (`payments.status`: `pending | paid | failed | refunded`). The only source of truth for "has the guest paid?" Never inferred from [[booking-status]].

**Balance due** (« Reste à payer »):
What the [[guest]] still owes on a [[booking]]: its total minus what was paid online. Arises when [[extra|Extras]] are added after an online payment. Zero once the admin marks the booking settled offline. Settled on site — never collected through a second online payment.
For a multi-room [[dossier|Dossier]] the online payment covers every room, so the balance is read on the Dossier, never per room: total of its non-cancelled Bookings minus what was **paid online** (gross: a [[refund]] never creates a balance due — a goodwill gesture or a refunded cancelled room leaves it at zero). The **net collected** (paid online minus refunds, pending ones included) is a separate figure: when it exceeds the total (a room cancelled after payment, not yet refunded), the difference is the **trop-perçu**, which the admin refunds from the Dossier page. Both are clamped at zero.
_Avoid_: solde, reliquat

**Refund** (« Remboursement »):
Money given back to a [[guest]] on a [[dossier|Dossier]]'s online payment, made by any [[admin]] of the tenant from DirectLoc (never automatically): a free amount, in cents, at most what remains refundable (paid online minus earlier refunds, pending ones included); several partial refunds are allowed. Attached to the Dossier, and to a Booking when it comes from cancelling that room; optional reason. Created on the tenant's own Stripe account (direct charge; the demo tenant refunds in test mode on the platform), status *en cours* / *effectué* / *échoué*. The guest gets an email for each one (never from the demo). Stripe fees are not returned. Not available for an offline settlement (« marqué réglé ») nor while the payment is disputed. The [[cancellation-policy|cancellation policy]] only suggests an amount.
_Avoid_: avoir, remise, rétrocession

**Dispute** (« Litige »):
A [[guest]] contesting a [[dossier|Dossier]]'s online payment with their bank (chargeback), reported by Stripe on the tenant's account. Every [[admin]] of the tenant gets one alert email (never from the demo); the Dossier shows a red banner (amount, response deadline) and the bookings list marks it. The admin either **accepts** it (the bank keeps the money) or **responds** with pre-filled text evidence (stay, rooms, guest, booking date, confirmation sent, the cancellation policy accepted at payment), saved as a draft then sent to the bank once, irreversibly; after sending, or past the deadline, it is read-only. While it is open the payment cannot be [[refund|refunded]]. Lost: the amount counts as refunded in the net collected. Won: a banner for 30 days. Never changes a [[booking-status|booking status]].
_Avoid_: contestation, opposition, chargeback (in UI)

**Cancellation policy** (« Conditions d'annulation »):
What a [[tenant]] refunds when a [[guest]] cancels, one of four levels: Flexible (100 % up to the day before arrival), Modérée (100 % up to 7 days before, 50 % after), Stricte (50 % up to 30 days before, nothing after), or Personnalisé (free text, no computed suggestion). Deadlines count in calendar days before the check-in date, in Paris time. One of the tenant's four **legal documents** (with CGV, mentions légales, politique de confidentialité), which start as pre-filled templates and stay unpublished — minimal public pages, nothing accepted at payment — until the host publishes them. Paying a [[dossier|Dossier]] accepts the published policy and CGV: their exact text and the date are copied onto the Dossier as proof. Never applied automatically; it only suggests a refund amount.
_Avoid_: politique de remboursement, CGU

**Night**:
The unit a booking is sold in — a *calendar date*, not an instant. Represented as UTC midnight and always compared date-only (`getUTC*`); it never carries a meaningful local time. Assumes metropolitan France and a UTC deployment (ADR-0005). The number of nights in a booking is the count of dates in `[checkIn, checkOut)`.
_Avoid_: nuitée (in code)

### Tarification

**Base price**:
A room's default per-night price (`rooms.pricePerNight`). The price for a night when no [[pricing-rule]] applies; not a floor — a rule may go below it.

**Extra**:
An optional paid add-on a [[tenant]] offers alongside a [[booking]] (bed linen, towels, breakfast…). Defined once per tenant, valid for every room. Priced in one of five units — per stay, per night, per guest, per guest per night, or per bed. By default an Extra covers the whole stay (every night, every guest, every bed); the guest may narrow it to a **count** of that unit, bounded by the stay — breakfast for 2 guests out of 4, parking for 2 nights out of 5, linen for 1 bed out of 3 (beds: the room's beds, or its capacity when not set). **Per stay** Extras have a tenant-set maximum instead (2 picnic baskets; 1 = no choice). A [[fee]] is never per bed. Chosen by the [[guest]] on the public site or added by an [[admin]]. A booking keeps the label, unit and price an Extra had when it was attached: later catalog changes never alter existing bookings. Always optional — mandatory charges (cleaning fee, tourist tax) are not Extras. May be free (e.g. a baby cot on request): a zero-priced Extra records the guest's request on the booking.
_Avoid_: option (overloaded with form/select options), supplément (in code)

**Fee** (« Frais »):
A mandatory charge the [[tenant]] adds to every [[booking]] (e.g. cleaning). Set by the hotel, not by law. Unlike an [[extra|Extra]], the guest cannot decline it. A tenant may define several (cleaning, booking fee…), each priced in the same four units as an Extra, and applying to all rooms unless restricted to some (a studio and a 6-person gîte need different cleaning fees). An admin may waive a Fee on a booking they enter (e.g. cleaning offered).
_Avoid_: supplément, option, charge

**Tourist tax** (« Taxe de séjour »):
A legal tax the [[tenant]] collects from the [[guest]] on behalf of the municipality and pays back to it. Governed by law, not by the hotel's pricing — distinct from a [[fee|Fee]] and from an [[extra|Extra]]. Only the *au réel* regime is modelled (charged per adult per night); a tenant taxed *au forfait* simply has no tourist tax on its bookings. The admin enters the municipality's rate (departmental surcharge included) — DirectLoc keeps no rate table. Guests under 18 are exempt. Two legal modes, chosen once per tenant: a **fixed amount** per adult per night (classified accommodation) or a **percentage** (1–5 %) of the per-person nightly price, capped, plus the additional taxes (departmental, regional…) on top (unclassified accommodation). That nightly price is the accommodation alone (the agreed price when there is one), excluding VAT, [[extra|Extras]] and [[fee|Fees]]. Due only for stays that took place: a cancelled booking owes none. An admin may waive it on a booking they enter, for the other legal exemptions (seasonal worker, emergency housing…).
_Avoid_: frais, taxe (alone)

**Pricing rule**:
A conditional override of the [[base-price|base price]] for a [[night]] (fixed price or percentage modifier), scoped to a room or global, optionally restricted by date window and days of week. May *raise* (seasonal/weekend surge) or *lower* (**promo**) the price. When several match a night, resolution is by precedence — highest `priority`, then specificity (room > global, day-restricted > all-days, narrower window > all-year), then recency (ADR-0006). This precedence is one shared primitive (`lib/rule-precedence.ts`): **booking rules** (minStay, allowed check-in days…) resolve by the same order, but field-by-field rather than to a single price — each constraint takes the value of the highest-precedence rule that defines it (ADR-0009).
_Avoid_: "highest price wins" (the rejected old model), whole-record override for booking rules
