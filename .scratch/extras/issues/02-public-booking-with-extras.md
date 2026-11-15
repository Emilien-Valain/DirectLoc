# Réservation publique avec Extras

Status: done
Blocked by: 01

## À faire
- `admitBooking` accepte `extraIds`, charge les Extras actifs du tenant (sinon erreur), calcule les lignes ; `breakdown` expose hébergement + lignes + total. Seuil Stripe 0,50 € sur le grand total.
- `createBookingPublic` insère les `booking_extras` dans la même transaction.
- `BookingForm` : cases sous « Nombre de personnes » avec prix calculé ; récap une ligne par Extra ; `/api/pricing` renvoie le détail.
- Stripe Checkout : 1 line item hébergement + 1 par Extra payant.
- Page confirmation : lignes affichées.

## Tests — `e2e/public/extras.spec.ts`
- Petit-déj coché → total récap = total Stripe ; Extra inactif absent ; 1 nuit / 1 personne ; Extra 0 € ; id inactif / autre tenant injecté → refusé ; aucun Extra → flux inchangé.

## Comments

- 2026-11-15 (agent) : `/api/pricing` non modifié — le récap public calcule les lignes avec `lib/extras.ts`, la même fonction que `admitBooking`, donc pas de divergence possible. Stripe : 1 line item par Extra payant (prix unitaire × quantité), les Extras à 0 € n'y figurent pas (Stripe refuse 0).
