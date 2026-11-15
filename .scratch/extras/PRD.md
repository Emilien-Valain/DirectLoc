# PRD — Extras (options payantes sur les réservations)

Source : grill du 2026-11-15. Stockage commun avec Fees et taxe : table `booking_lines` (ADR-0011). Décisions : `CONTEXT.md` (Extra, Balance due) + `docs/adr/0010-extras-are-snapshotted-lines.md`.

## Problème
Un hôtel veut vendre linge de lit, serviettes, petit-déjeuner… avec la réservation. Aujourd'hui `bookings.totalPrice` ne contient que l'hébergement.

## Règles (résumé — l'ADR fait foi)
- Catalogue par tenant, toutes chambres. Champs : libellé, description courte facultative, prix ≥ 0, unité, actif.
- Unités : par séjour · par nuit · par personne · par personne et par nuit. Quantité dérivée (nuits, `guestCount` tous âges), jamais saisie.
- Choisis par le guest (site public) et par l'admin (création + modification).
- Ligne copiée sur la réservation (libellé, unité, prix unitaire). Modif dates/personnes → quantité recalculée au prix figé. Décocher/recocher → nouveau prix catalogue.
- Calcul dans `admitBooking` ; le serveur ignore tout montant venant du formulaire ; id d'Extra inactif ou d'un autre tenant → refusé.
- `totalPrice` = hébergement + Extras. Prix convenu = hébergement seulement.
- Extra ajouté après paiement en ligne → « Reste à payer » = total − payé en ligne ; `paidAt` solde le reste. Aucun remboursement auto.
- Affiché : récap public, Stripe Checkout (1 line item par Extra), email confirmation, email modification, notification admin, PDF.

## Hors scope
Frais obligatoires (ménage, taxe de séjour) → `.scratch/mandatory-fees/`. Restriction par chambre. Stock/quantité limitée. Second lien Stripe.

## Issues
1. `issues/01-extras-catalog.md`
2. `issues/02-public-booking-with-extras.md`
3. `issues/03-manual-booking-with-extras.md`
4. `issues/04-balance-due.md`
5. `issues/05-extras-in-emails-and-pdf.md`
