# Litiges

Status: ready-for-agent
Dépend de : 01, 02, 03

## À faire
- Table des litiges (Dossier, montant, motif, statut, date limite, id Stripe, brouillon de preuves) ; webhook `charge.dispute.created/updated/closed`.
- Email d'alerte aux admins du tenant ; bandeau rouge fiche Dossier (+ marque dans la liste des réservations).
- Actions : Accepter (`disputes.close`) ; Répondre : formulaire prérempli (séjour, chambres, montant, voyageur, date de réservation, confirmation envoyée, conditions copiées au paiement), « Enregistrer le brouillon » (`disputes.update` sans submit), « Envoyer à la banque » (submit, confirmation, définitif) ; lien vers le litige dans le tableau de bord Stripe.
- Clôture : perdu → compté comme remboursé dans `dossierMoney` ; gagné → bandeau puis disparition. Remboursement désactivé pendant un litige ouvert.

## Tests
Création par webhook → alerte + bandeau ; brouillon puis envoi ; double envoi refusé ; accepter ; gagné / perdu ; date limite dépassée ; isolation tenant ; démo sans email ; XSS dans les preuves.
