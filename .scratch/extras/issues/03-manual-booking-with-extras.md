# Réservation manuelle (création + modification) avec Extras

Status: done
Blocked by: 02

## À faire
- `ManualBookingForm` : mêmes cases ; `quoteManualBooking` inclut les Extras.
- `createBookingManual` / `updateBookingManual` passent `extraIds` à `admitBooking`.
- Modification : lignes conservées → quantité recalculée au prix figé ; décochées → supprimées ; nouvelles → prix catalogue actuel. Extra désactivé déjà sur la résa reste affiché et conservé.
- Prix convenu = hébergement seulement ; `keepPrice` garde l'ancien hébergement (total − anciennes lignes).

## Tests — `e2e/admin/extras.spec.ts`
- 3 → 5 nuits recalcule ; changement de prix catalogue n'altère pas la résa ; décocher/recocher → nouveau prix ; prix convenu + Extras = total ; Extra désactivé conservé sur la résa.

## Comments
