# Remboursements depuis l'admin

Status: ready-for-agent
Dépend de : 01

## À faire
- Table des remboursements (Dossier, chambre facultative, montant, motif, statut, id Stripe, auteur, dates) ; `dossierMoney` intègre le remboursé.
- Server action (logique tenant-explicite dans `lib/dossier-admin.ts`) : `refunds.create` sur le compte connecté (direct charge, `stripeAccount`), démo en test sur la plateforme ; idempotency key ; plafond restant remboursable ; refus si hors ligne ou litige ouvert.
- UI : bouton « Rembourser » fiche Dossier (raccourcis, suggestion selon niveau via `suggestedRefund`, ligne frais non rendus) ; case « Rembourser X € » dans les dialogs d'annulation (chambre / Dossier) ; historique des mouvements ; bandeau « remboursez depuis Stripe » supprimé.
- Email voyageur à chaque remboursement (sauf démo).

## Tests
Remboursement total / partiel / multiple jusqu'au plafond ; dépassement refusé ; annulation + remboursement ; suggestion par niveau ; hors ligne et litige → refus ; Stripe en erreur → rien enregistré, message ; isolation tenant (unitaire comme `e2e/unit/dossier-isolation.spec.ts`) ; email voyageur ; démo sans email.
