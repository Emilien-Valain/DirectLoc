# Emails par Dossier

Status: done
Dépend de : 01, 03

## À faire
- Confirmation, rappel avant arrivée, remerciement : un email par Dossier listant les chambres (infos et message par chambre réglés dans Paramètres → Emails, commit 3c70375). Marqueurs `reminderSentAt` / `thankYouSentAt` au niveau Dossier (pas de doublon par chambre).
- Annulation d'une seule chambre → email « annulation partielle » ; annulation de tout le Dossier → email d'annulation actuel.
- Notification admin : une par Dossier.

## Tests
- Dossier de 2 chambres → 1 seul email de confirmation (boîte de test). Cron rappel/remerciement : 1 email par Dossier. Annulation partielle → email dédié.

## Comments

**Fait (2026-11-21)**

- Un email par Dossier pour confirmation, notification admin, rappel, remerciement, expiration du paiement et annulation. `loadDossierEmailContext(bookingIds, tenantId)` (`lib/queries/bookings.ts`) assemble le séjour commun, l'identité du voyageur (première réservation, comme avant) et une entrée par chambre non annulée ; total = somme des chambres listées. Une chambre : tableau et contenu historiques ; plusieurs : une ligne (+ options) par chambre avec prix et personnes, message et infos de chaque chambre avec SES variables. Messages généraux (confirmation / rappel / remerciement) : `{chambre}` = noms joints, `{voyageurs}`, `{capacite}`, `{lits}` additionnés.
- Annulation (`lib/dossier-cancellation.ts`, contrat `notifyHostCancellation` inchangé) : scope `partial` → nouvel email « Annulation partielle » (`sendPartialCancellation` : chambres annulées, maintenues, nouveau total, remboursement fait par l'établissement) ; `total` → un seul `sendBookingCancellation` listant les chambres annulées. Webhook `expired` : un seul email par Dossier. Webhook `completed` : une confirmation et une notification par admin pour les chambres qui viennent d'être confirmées. `alertPartialRefund` intact. Tous les `shortcut:` emails retirés.
- Décision marqueurs : **colonnes sur `dossiers`** (`reminder_sent_at`, `thank_you_sent_at`), migration `0026_dossier_email_markers` avec backfill (un Dossier est marqué si une de ses réservations l'est). Le cron sélectionne les Dossiers non marqués, **réserve** l'envoi par `UPDATE … WHERE marqueur IS NULL RETURNING` avant d'envoyer (cron relancé ou parallèle : un seul gagne), et remet le marqueur à NULL si l'envoi échoue (SMTP) pour réessayer au prochain passage. Choisi plutôt que « marquer chaque booking en bloc » : une seule source de vérité, pas de course entre chambres. `bookings.reminder_sent_at` / `thank_you_sent_at` ne sont plus lus ; colonnes conservées (pas de drop, à nettoyer plus tard).
- `reminderDue` : `createdAt` = la plus ancienne réservation du Dossier (pas `dossiers.created_at`, que les fixtures de test laissent à « maintenant »), `checkIn` = la plus proche arrivée parmi les chambres confirmées.
- Admin : notification par Dossier, sujet « Nouvelle réservation — Nom (Chambre A, Chambre B) ».
- Tests : `e2e/admin/dossier-emails.spec.ts` (8). Obsidian : `Tests de non-régression.md`, `Schema DB.md`.
