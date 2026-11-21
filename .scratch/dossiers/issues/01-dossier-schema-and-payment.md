# Table `dossiers`, migration, paiement rattaché au Dossier

Status: done

## À faire
- Table `dossiers` (tenantId, dates, identité voyageur partagée, timestamps) ; `bookings.dossierId` NOT NULL ; `payments.dossierId` remplace `payments.bookingId`. Décider quels champs voyageur vivent sur le Dossier vs restent recopiés sur la réservation (les listes/emails/PDF lisent aujourd'hui `bookings.guest*`) — garder le changement minimal, noter le choix en commentaire.
- Migration : un Dossier par réservation existante, paiements rattachés. Voir mémoire `drizzle-generate-no-tty` (add + drop en deux generate).
- Webhook Stripe : `checkout.session.completed` confirme toutes les réservations du Dossier, `expired` les annule toutes (transitions gardées, ADR-0003).
- Aucun changement visible : le parcours actuel crée un Dossier d'une chambre.
- Obsidian : `Schema DB.md`.

## Tests
- Suite existante verte. Webhook : Dossier de 2 chambres → les 2 `confirmed` ; expiration → les 2 `cancelled`, chambres libérées.
- Isolation : un Dossier d'un autre tenant n'est jamais lu.

## Comments

**Fait (2026-11-21)**

- Table `dossiers` : `tenantId`, `checkIn`, `checkOut`, identité voyageur (`guestName`, `guestFirstName`, `guestLastName`, `guestEmail`, `guestPhone`, `guestAddress`, `guestCountry`), `createdAt`, `updatedAt`. `bookings.dossierId` NOT NULL, `payments.dossierId` NOT NULL remplace `payments.bookingId`.
- **Choix des champs** : le Dossier porte dates + voyageur, mais ces champs restent **recopiés sur chaque réservation** (`bookings.guest*`, `checkIn/checkOut`), qui reste la source lue partout (listes, recherche, emails, PDF, iCal, calendrier, taxe de séjour). Changement minimal, zéro changement visible. Toute écriture tient les deux à jour : création publique/admin (même valeurs), modification admin (`updateBookingManual` recopie voyageur + dates sur le Dossier), seed démo. `guestCount`/`childCount`/`notes`/`source`/`paidAt` restent par réservation (répartition par chambre).
- Migrations : `db/migrations/0024_dossiers.sql` (table, colonnes nullable, backfill **un Dossier par réservation avec le même id**, `payments.dossier_id = booking_id`, puis NOT NULL + FK + index) et `0025_payments_drop_booking_id.sql`. Appliquées sur `maresa` (drizzle) et `maresa_test` (psql).
- Code : `lib/dossiers.ts` (`createDossier`, `getDossierBookingIds`, `confirmDossier`, `cancelPendingDossier`, isolation tenant sur chaque lecture). Webhook : la session est résolue par `payments.stripeSessionId` + `tenantId` (payment ET Dossier du tenant) ; metadata `dossierId` (sessions actuelles) ou `bookingId` d'une réservation du Dossier (sessions créées avant le déploiement, encore valides pendant le TTL du checkout) ; `completed` confirme toutes les `pending` du Dossier, `expired` annule toutes les `pending` (transitions gardées) ; paiement après annulation = toutes les réservations du Dossier annulées. `getLatestPayment`/`cancelOrphanPending`/page de confirmation passent par le Dossier.
- Tests : `e2e/payment/stripe-webhook.spec.ts` (nouveau describe Dossier 2 chambres : completed, expired + chambres libres, chambre annulée avant paiement, isolation tenant/metadata), `demo-reset` compte 18 Dossiers ; toutes les fixtures qui insèrent des réservations créent un Dossier (`e2e/helpers/dossier.ts`), global-setup purge les Dossiers orphelins. Obsidian : `Schema DB.md`, `Tests de non-régression.md`.

**Reste / pour les issues suivantes**

- 03 : `admitBooking` ouvre sa propre transaction (une chambre). Pour « tout ou rien », il faut une variante qui prend une `tx` externe (ou admet N chambres) ; dans la même tx : `createDossier(tx, {...})` une fois, puis par chambre l'admission + `insert(bookings).values({ dossierId, ... })` + `saveLines`. Session Stripe : `metadata: { dossierId, tenantId }`, un `payments` avec `dossierId` et le total du Dossier. Le rollback sur échec Stripe supprime déjà toutes les réservations du Dossier puis le Dossier (`bookings-public.ts`). La page `/reserver/confirmation` n'affiche que la 1re réservation du Dossier (`shortcut:`).
- 04 : le webhook envoie encore un email par réservation confirmée/annulée (`shortcut:` dans `app/api/webhooks/stripe/route.ts`) — identique pour un Dossier d'une chambre ; à remplacer par un email par Dossier.
- 05 : `updateBookingManual` recopie dates + voyageur sur le Dossier sans vérifier qu'il n'a qu'une chambre (`shortcut:`) — à cadrer (dates communes v1). La fiche admin affiche `payment.amount` du Dossier entier comme « payé en ligne » pour la réservation : faux dès 2 chambres. Paiement reçu alors qu'**une seule** chambre a été annulée : les autres sont confirmées, payment `paid`, aucune alerte de remboursement partiel.
- Nettoyages de tests qui ne suppriment que `bookings` laissent des Dossiers orphelins jusqu'au global-setup suivant (purgés là).
