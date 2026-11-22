# Litiges

Status: done
Dépend de : 01, 02, 03

## À faire
- Table des litiges (Dossier, montant, motif, statut, date limite, id Stripe, brouillon de preuves) ; webhook `charge.dispute.created/updated/closed`.
- Email d'alerte aux admins du tenant ; bandeau rouge fiche Dossier (+ marque dans la liste des réservations).
- Actions : Accepter (`disputes.close`) ; Répondre : formulaire prérempli (séjour, chambres, montant, voyageur, date de réservation, confirmation envoyée, conditions copiées au paiement), « Enregistrer le brouillon » (`disputes.update` sans submit), « Envoyer à la banque » (submit, confirmation, définitif) ; lien vers le litige dans le tableau de bord Stripe.
- Clôture : perdu → compté comme remboursé dans `dossierMoney` ; gagné → bandeau puis disparition. Remboursement désactivé pendant un litige ouvert.

## Tests
Création par webhook → alerte + bandeau ; brouillon puis envoi ; double envoi refusé ; accepter ; gagné / perdu ; date limite dépassée ; isolation tenant ; démo sans email ; XSS dans les preuves.

## Comments

- Migration `db/migrations/0029_disputes.sql` (appliquée à `maresa` par `npm run db:migrate`, à `maresa_test` par psql) : table `disputes` (tenant, `dossier_id` / `payment_id` cascade, `stripe_dispute_id` unique, `amount`, `reason` = code Stripe, `status` = statut Stripe en texte, `evidence_due_by`, `evidence` jsonb = brouillon, `submitted_at`, `alerted_at`, `closed_at`).
- Webhook : `charge.dispute.created|updated|closed` → `lib/dispute-sync.ts` (`handleDisputeEvent`). Rattachement partagé avec les remboursements : `resolveEventPayment` extrait de `lib/refund-sync.ts` (payment_intent → paiement, `event.account` = compte du tenant, démo plateforme en test). Upsert sur `stripe_dispute_id`, statut qui ne recule jamais (`nextDisputeStatus`), un litige déjà rattaché à un autre paiement/tenant est ignoré ; `submission_count > 0` (réponse faite dans Stripe) → lecture seule. Alerte `sendDisputeAlert` (`lib/email.ts`) une seule fois via `UPDATE … WHERE alerted_at IS NULL`, à chaque admin, jamais depuis la démo. Erreur → 500 (Stripe rejoue).
- Logique : pur `lib/dispute-evidence.ts` (champs, motifs FR, `canRespond`, `defaultEvidence`, `cleanEvidence`), affichage `lib/dispute-display.ts` (bandeau, JJ/MM Paris, gagné visible 30 jours après `closed_at`, lien `dashboard.stripe.com[/test]/disputes/<id>`), serveur `lib/disputes.ts` (`saveDisputeEvidence(tenantId, disputeId, input, submit)` et `acceptDispute(tenantId, disputeId)` en transaction, litige verrouillé `FOR UPDATE` : double envoi refusé ; Stripe sur le compte connecté, démo en test ; Stripe en erreur → rien ne change), actions `lib/actions/disputes.ts`.
- **Écart assumé** : chez Stripe `cancellation_policy` et `refund_policy` sont des **ids de fichier**, pas du texte. Le texte accepté au paiement va dans `cancellation_policy_disclosure` (« … acceptées par le voyageur au paiement le … » + texte), la politique dans `refund_policy_disclosure`. Autres champs : `product_description`, `customer_name`, `customer_email_address`, `service_date`, `refund_refusal_explanation`, `access_activity_log` (réservation, paiement, confirmation, remboursements), `uncategorized_text`. Tous envoyés à chaque enregistrement (champ vidé = "").
- `hasOpenDispute` (`lib/refunds.ts`) lit la table (statuts ouverts). `dossierMoney` reçoit remboursements + litiges perdus ; le plafond serveur de `refundDossierPayment` retire aussi les litiges perdus.
- UI : fiche Dossier → bandeau(x) `data-dispute-banner`, carte « Litige » (Répondre / Voir la réponse, Accepter avec confirmation, Voir sur Stripe), ligne « Litige perdu · repris par la banque » dans les mouvements, flash `?litige=envoye|accepte` ; page `/admin/dossiers/[id]/litige` (dernier litige du Dossier ; formulaire contrôlé `components/admin/DisputeForms.tsx`, ou lecture seule + lien « Ajouter des fichiers sur Stripe ») ; liste des réservations : pastille « Litige » (litige ouvert).
- Faux Stripe : `POST /v1/disputes/:id` et `/close` (`disputes`, `disputeError`).
- Tests : `e2e/admin/disputes.spec.ts` (11), `e2e/unit/dispute-isolation.spec.ts` (2) + sonde, `e2e/unit/dispute-evidence.spec.ts` (8), `e2e/mobile/disputes-mobile.spec.ts` (1). Obsidian : `Tests de non-régression.md`, `Schema DB.md`, `Déploiement.md` ; `CONTEXT.md` : terme « Dispute ».
- À activer : endpoint Connect live + endpoint sandbox (démo) → `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`. Clé restreinte live, Connect permissions : **Disputes → Write** (Files → Write en v2).
