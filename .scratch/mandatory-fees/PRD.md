# PRD — Frais obligatoires (Fees + Taxe de séjour)

Source : grill du 2026-11-15. Décisions : `CONTEXT.md` (Fee, Tourist tax, Guest) + `docs/adr/0011-fees-and-tourist-tax-are-booking-lines.md`.
Prérequis : `.scratch/extras/` issues 01–03 (table `booking_lines`, calcul des lignes dans `admitBooking`).

## Règles (résumé — l'ADR fait foi)
- **Fees** : liste par tenant, 4 unités des Extras, toutes chambres sauf restriction. Appliqués d'office ; l'admin peut en retirer sur une résa manuelle.
- **Taxe de séjour** (au réel seulement) : réglage par tenant — désactivée | montant fixe /adulte/nuit | pourcentage + plafond + TVA hébergement (10 % défaut, 0 % franchise). Base % = hébergement seul (ou prix convenu), HT, ÷ occupants (enfants compris), × adultes.
- `bookings` gagne « dont enfants (−18 ans) » ≤ `guestCount`, demandé seulement si la taxe est active.
- Lignes `kind = fee | tax` figées à l'admission ; recalcul des quantités au taux figé quand le séjour change. Taxe retirée par l'admin = ligne `exempt`.
- Tout est payé en ligne dans `totalPrice`. Aucun remboursement auto.
- « À partir de X €/nuit » = hébergement seul + mention « + frais de ménage et taxe de séjour ».
- Export CSV : 1 ligne par séjour confirmé/terminé, filtré par date de départ ; annulées exclues.

## Hors scope
Régime au forfait. Barèmes communaux maintenus par DirectLoc. Taux par chambre. Re-calcul du taux au 1er janvier.

## Issues
1. `issues/01-fees.md`
2. `issues/02-tourist-tax.md`
3. `issues/03-tourist-tax-export.md`
