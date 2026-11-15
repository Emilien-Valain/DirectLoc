# Catalogue d'Extras (schéma + section Paramètres)

Status: done

## À faire
- Tables Drizzle : `extras` (tenantId, label, description?, price decimal(10,2) ≥ 0, unit enum `per_stay|per_night|per_guest|per_guest_night`, active, timestamps) et `booking_lines` (bookingId, kind enum `extra|fee|tax`, sourceId nullable, label, unit, unitPrice, quantity, total, exempt bool — copies, ADR-0010/0011). Seul `kind = extra` est utilisé ici ; fee/tax arrivent avec `.scratch/mandatory-fees/`. Migration.
- Server actions CRUD scoped tenant (`requireTenantId`), validation zod (prix ≥ 0, libellé requis, ≤ 500 car.).
- Section « Options » dans Paramètres > Mon établissement (`SettingsPageClient`), même patterns que les sections existantes.
- Obsidian : `Schema DB.md`.

## Tests — `e2e/admin/extras.spec.ts`
- Créer / modifier / désactiver / supprimer un Extra ; prix 0 accepté ; prix négatif et libellé vide refusés ; XSS dans le libellé échappé ; 500 car. ; nettoyage des données.
- Obsidian : `Tests de non-régression.md`.

## Comments

- 2026-11-15 (agent) : livré avec `booking_lines` (kind/sourceId/exempt) suite à ADR-0011, migration `0009_extras_and_booking_lines.sql`. `sourceId` sans FK (polymorphe extra/fee) : la copie survit à la suppression de l'Extra. Le module Extras ne lit/écrit que `kind = extra` ; en modification, les lignes fee/tax existantes sont gardées telles quelles dans le total (recalcul → `.scratch/mandatory-fees/issues/01`).
