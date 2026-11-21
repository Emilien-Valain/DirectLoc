# Admin : fiche Dossier, calendrier, saisie et annulation partielle

Status: done
Dépend de : 01, 02

## À faire
- Fiche Dossier : voyageur, paiement, reste à payer, chambres (lien vers chaque réservation). Liste des réservations : lien vers le Dossier quand il a ≥ 2 chambres.
- Calendrier : marque « groupe » sur les réservations d'un Dossier de ≥ 2 chambres.
- Saisie manuelle d'un Dossier (plusieurs chambres, mêmes dates), avec le « Forcer » existant.
- Annuler une chambre seule (les autres restent) ; annuler tout le Dossier. Pas de remboursement auto.
- PDF : export du Dossier entier.

## Tests — `e2e/admin/` (+ `mobile/` pour la fiche)
- Créer un Dossier manuel de 2 chambres ; annuler une chambre → l'autre reste confirmée et la chambre annulée est libre.
- UUID de Dossier inexistant → 404 ; Dossier d'un autre tenant → 404 ; non authentifié → /login.

## Comments

**Fait (2026-11-21)**

UI admin (« Dossier » = l'ensemble, « réservation » = une chambre) :
- Fiche `/admin/dossiers/[id]` (`app/admin/dossiers/[id]/page.tsx`) : en-tête « Dossier · N chambres », voyageur (lu sur `dossiers`), dates/nuits/personnes, une carte numérotée par chambre (statut, personnes, total, « Voir la réservation », « Annuler cette chambre »), Paiement (total du séjour = chambres non annulées, payé en ligne, reste à payer, Marquer réglé / Pas encore réglé pour toutes les chambres), bandeau « remboursez X € depuis Stripe » quand le paiement dépasse ce que le séjour coûte, « PDF du Dossier », « Annuler tout le Dossier ». Pensée pour 360 px (cibles ≥ 40 px, pas de débordement). UUID inconnu / mal formé / autre tenant → 404.
- Liste des réservations : marque `GroupTag` « Groupe · N chambres » = lien vers le Dossier (≥ 2 chambres, annulées comprises). Calendrier : icône groupe dans la barre, « Groupe de N chambres » dans le libellé, `data-group`, lien « Dossier · N chambres » dans le détail ; liste mobile : `GroupTag` ; légende.
- Fiche réservation d'une chambre d'un Dossier ≥ 2 : bandeau-lien vers le Dossier ; « Règlement » renvoie au Dossier (« Payé en ligne avec le Dossier ») ; plus de « reste à payer » ni de « payé X € » par chambre (raccourci (b) corrigé) ; dialog d'annulation : « Seule cette chambre est annulée… ».
- Saisie manuelle (`ManualBookingForm`, création seulement) : « + Ajouter une chambre » (chambre, voyageurs, enfants si taxe), champ caché `moreRooms` (JSON, `manualMoreRoomsSchema`) ; devis par chambre + total ; options et frais cochés appliqués à chaque chambre qui les propose ; prix convenu désactivé (une chambre seule : on modifie ensuite chaque chambre). Serveur : `createDossierManual` (dans `lib/actions/bookings.ts`) = même gate que la chambre seule, chambres admises dans UNE transaction via `admitRoomsInTx` (extrait de `createDossierPublic`, réutilisé par les deux), tout ou rien, « Forcer » vaut pour toutes ; refus nommant la chambre (« Chambre B : Ces dates chevauchent… »). Redirection vers la fiche Dossier.
- PDF : `lib/reservation-pdf.ts` (rendu partagé, plusieurs pages si besoin) ; `/api/admin/reservations/[id]/pdf` inchangé côté sortie, nouveau `/api/admin/dossiers/[id]/pdf` (toutes les chambres, une section par chambre avec son statut, total du séjour hors chambres annulées).

Décisions :
- (a) Modifier une chambre d'un Dossier ≥ 2 : le voyageur (nom, email, téléphone) est celui du Dossier → recopié sur le Dossier et **toutes** ses réservations ; les dates ne divergent pas (v1) : refus serveur si elles changent (« Annulez cette chambre et saisissez-la à nouveau, ou annulez le Dossier »), champs en lecture seule + explication dans le formulaire. `shortcut:` retiré. Changer de chambre, de personnes, d'options reste possible.
- (b) Argent : `dossierMoney` (`lib/queries/dossiers.ts`) — dû = Σ chambres non annulées ; reste = dû − payé en ligne (0 si toutes réglées) ; trop-perçu = payé − dû. Le formulaire de modification d'une chambre d'un Dossier ≥ 2 n'affiche plus d'écart « déjà payé » (il comparait la chambre au Dossier entier).
- (c) Webhook `completed` : si des chambres du Dossier sont déjà annulées, les autres sont confirmées puis `alertPartialRefund` envoie à chaque admin `sendPaidAfterCancellationAlert` avec `cancelledRooms` (sujet « Paiement reçu, une chambre annulée — remboursement partiel à faire via Stripe »). Une seule fois (une re-livraison ne confirme plus rien).
- Taille d'un Dossier = toutes ses réservations, annulées comprises (une chambre restante d'un groupe reste marquée groupe et liée à sa fiche).

**Point d'appel pour l'issue 04 (emails d'annulation)** : `notifyHostCancellation(tenantId, dossierId, cancelledBookingIds)` dans `lib/dossier-cancellation.ts`, seul appelant d'email après une annulation par l'hôte : `cancelBooking` (fiche réservation), `cancelDossierBooking` (une chambre depuis la fiche Dossier), `cancelDossier` (tout le Dossier). Il calcule `scope` : `"partial"` si d'autres chambres restent actives (→ email « annulation partielle »), `"total"` sinon (→ email d'annulation actuel, une fois pour le Dossier). Aujourd'hui (`shortcut:`) : l'email d'annulation actuel, un par chambre annulée. Retourne `true` si le client a été prévenu (bandeaux `?annulee=` / `?chambre-annulee=` / `?annule=` = `1` | `sans-email`). Les annulations du webhook (`expired`) restent dans `app/api/webhooks/stripe/route.ts` (déjà marquées pour 04).

Tests : `e2e/admin/dossier-admin.spec.ts` (13), `e2e/mobile/dossier-mobile.spec.ts` (1, 360 px, sans reload), `e2e/payment/stripe-webhook.spec.ts` (alerte remboursement partiel). Obsidian `Tests de non-régression.md` à jour ; pas de changement de schéma. `CONTEXT.md` : Balance due d'un Dossier, modification d'une chambre.

**Complément (2026-11-21) : dates du Dossier, ajout d'une chambre, isolation des actions**
- Logique serveur de la fiche extraite dans `lib/dossier-admin.ts` (tenant explicite, aucun `next/*`) : `cancelDossierRooms`, `setDossierPaidState`, `changeDossierDates`, `quoteDossierDatesFor`, `addRoomToDossier`. Les server actions (`cancelDossierBooking`, `cancelDossier`, `setDossierPaid`, `updateDossierDates`, `quoteDossierDates`, `addDossierRoom` dans `lib/actions/bookings.ts`) n'ajoutent que session, revalidation, email et redirection.
- **Changer les dates** (panneau de la fiche, `components/admin/DossierForms.tsx`) : Dossier verrouillé (`FOR UPDATE`), chaque chambre non annulée repasse `admitRoomsInTx` (options par chambre : sa propre réservation exclue des Holds, « Forcer » pour toutes) dans UNE transaction ; prix recalculé comme « Modifier » sans prix convenu (options/frais gardés à prix figé, quantités bornées par le nouveau séjour, exonération gardée, hébergement et taxe recalculés) ; refus nommant la chambre (« Chambre B : Ces dates chevauchent… ») ; devis par chambre avant d'enregistrer ; arrivée changée → `reminder_sent_at` et `thank_you_sent_at` du Dossier à NULL (départ seul changé → `thank_you_sent_at`) — aussi corrigé dans `updateBookingManual` pour un Dossier d'une chambre. Refus : départ ≤ arrivée, > 366 nuits, arrivée déplacée dans le passé, dates identiques, Dossier annulé/terminé, paiement en ligne en cours. Les chambres annulées gardent leurs anciennes dates. Les booking-rules ne s'appliquent pas (saisie hôte, ADR-0008). Email « Votre réservation a été modifiée » optionnel (`sendDossierModification`, récapitulatif du Dossier).
- **Ajouter une chambre** : chambres actives hors Dossier, libres d'abord, les occupées marquées ; personnes, enfants/exonération si taxe, options et frais (`StayChoicesFields`, extrait de `ManualBookingForm` avec `ForcePanel`) ; devis via `quoteManualBooking` ; admission dans la transaction du Dossier verrouillé ; voyageur recopié du Dossier, `source = manual`, statut `confirmed` dès qu'une chambre du Dossier l'est (sinon `pending`) ; refus : chambre déjà dans le Dossier, d'un autre tenant / inactive, capacité, chevauchement (Forcer).
- **Isolation** : `e2e/unit/dossier-isolation.spec.ts` (sonde tsx) — toutes ces fonctions appelées par le tenant A sur un Dossier du tenant B : aucune ligne de B ne bouge (instantané complet), témoin sur le Dossier de A.
- Tests : `dossier-admin.spec.ts` (19), `dossier-mobile.spec.ts` (2), `dossier-isolation.spec.ts` (1). Pas de changement de schéma.

