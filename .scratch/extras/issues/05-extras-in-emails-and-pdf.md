# Extras dans les emails et le PDF

Status: done
Blocked by: 02

## À faire
- `lib/email.ts` : toutes les `booking_lines` (extra, fee, tax — échappées) dans confirmation, modification, notification admin. Rappel et remerciement inchangés.
- PDF (`app/api/admin/reservations/[id]/pdf/route.ts`) : lignes Extras ; le prix/nuit affiché est calculé sur l'hébergement seul, pas sur le grand total.

## Tests
- Sink SMTP (`startSmtpSink`) : email de confirmation contient la ligne Extra ; PDF généré sans erreur avec Extras.

## Comments

- 2026-11-15 (agent) : emails, PDF, fiche admin et page de confirmation lisent toutes les `booking_lines` (extra, fee, tax) via `getBookingLines`. Testé avec une ligne `fee` dans l'email de confirmation.
