# Taxe de séjour (réglage + calcul)

Status: done
Blocked by: 01

## Étape 0 (humain ou agent avec web)
Vérifier sur service-public.fr / impots.gouv.fr la règle 2026 du mode pourcentage (taux 1–5 %, plafond, base HT par personne, mineurs exonérés). Corriger ADR-0011 si écart.

## À faire
- Réglage tenant (dans `tenants.config` ou colonnes) : mode `off | fixed | percentage`, montant ou taux + plafond, TVA hébergement (10 % défaut). Section « Taxe de séjour » dans Paramètres > Mon établissement.
- `bookings.childCount` (défaut 0, ≤ `guestCount`). Champ public « dont enfants (−18 ans) » sous « Nombre de personnes », masqué si mode `off`. Validation serveur.
- Calcul dans `admitBooking` → ligne `kind = tax` (base = hébergement seul ou prix convenu, HT, ÷ occupants, plafonné, × adultes × nuits).
- Formulaire manuel : champ enfants + case « exonérer la taxe » → ligne `exempt`, montant 0.

## Tests
- Fixe : 2 adultes + 2 enfants → taxe sur 2 ; que des enfants → 0 ; pourcentage avec plafond atteint et non atteint ; TVA 0 % ; prix convenu change la taxe % ; enfants > personnes refusé (public + manuel) ; taux négatif refusé ; mode `off` → aucun champ enfants, aucune ligne.

## Comments
