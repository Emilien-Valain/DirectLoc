# Reste à payer (Balance due)

Status: done
Blocked by: 03

## À faire
- Reste à payer = `totalPrice` − montant payé en ligne (`payments.status = paid`) ; 0 si `paidAt`.
- Fiche réservation (`app/admin/reservations/[id]/page.tsx`) : « Payé X € en ligne · reste Y € » si Y > 0 ; la note d'annulation reste correcte.
- Ajout d'Extra sur une résa directe payée : autorisé (vérifier `loadEditableBooking`).

## Tests
- Résa payée en ligne + Extra ajouté → reste affiché ; « Réglé » → reste 0 ; aucun remboursement déclenché.

## Comments
