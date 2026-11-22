# Synchro des remboursements par webhook

Status: ready-for-agent
Dépend de : 02

## À faire
- Webhook (endpoint Connect + plateforme pour la démo) : `charge.refunded` / `refund.updated` → crée ou met à jour la ligne de remboursement (remboursement fait dans le tableau de bord Stripe inclus), statuts en cours / effectué / échoué ; échec → bandeau + email admin ; email voyageur pour un remboursement venu de Stripe.
- Rattachement au Dossier via le payment_intent du paiement ; événement inconnu / autre tenant → ignoré (journalisé), jamais d'effet croisé.
- Idempotence (re-livraisons).

## Tests
Remboursement créé dans l'app puis confirmé par webhook (pas de doublon) ; remboursement venu de Stripe ; échec ; re-livraison ; isolation tenant ; signature invalide.
