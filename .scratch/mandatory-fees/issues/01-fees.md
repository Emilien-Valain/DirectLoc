# Fees (frais obligatoires)

Status: done
Blocked by: .scratch/extras/issues/03

## À faire
- Table `fees` (tenantId, label, price ≥ 0, unit, active) + liaison aux chambres (vide = toutes). Migration.
- Section « Frais » dans Paramètres > Mon établissement (à côté de « Options »), CRUD scoped tenant.
- `admitBooking` ajoute une ligne `kind = fee` par Fee actif applicable à la chambre.
- Formulaire manuel : Fees cochés d'office, décochables (création + modification).
- Fiches chambre publiques : mention « + frais de ménage et taxe de séjour » sous « à partir de » quand des Fees ou la taxe existent.
- Obsidian : `Schema DB.md`.

## Tests — `e2e/admin/fees-tax.spec.ts`, `e2e/public/fees-tax.spec.ts`
- Ménage par séjour visible dans récap + Stripe ; Fee limité à la chambre A absent sur la chambre B ; Fee 0 € ; prix négatif refusé ; XSS libellé ; admin décoche le ménage → total sans ; 3 → 5 nuits recalcule un Fee par nuit au taux figé.
- Obsidian : `Tests de non-régression.md`.

## Comments
