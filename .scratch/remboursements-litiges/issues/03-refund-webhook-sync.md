# Synchro des remboursements par webhook

Status: done
Dépend de : 02

## À faire
- Webhook (endpoint Connect + plateforme pour la démo) : `charge.refunded` / `refund.updated` → crée ou met à jour la ligne de remboursement (remboursement fait dans le tableau de bord Stripe inclus), statuts en cours / effectué / échoué ; échec → bandeau + email admin ; email voyageur pour un remboursement venu de Stripe.
- Rattachement au Dossier via le payment_intent du paiement ; événement inconnu / autre tenant → ignoré (journalisé), jamais d'effet croisé.
- Idempotence (re-livraisons).

## Tests
Remboursement créé dans l'app puis confirmé par webhook (pas de doublon) ; remboursement venu de Stripe ; échec ; re-livraison ; isolation tenant ; signature invalide.

## Comments

- Webhook (`app/api/webhooks/stripe/route.ts`) : `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed` délégués à `lib/refund-sync.ts` (`handleRefundEvent`). Rattachement : `payment_intent` → `payments.stripe_payment_id` → tenant ; le compte de l'événement doit être `tenants.stripe_account_id` (démo : événement plateforme sans `account`, test uniquement, via `stripeModeAllowed`). Sinon 200 + log, rien ne bouge. `tenantAdminEmails` déplacé dans `lib/refund-sync.ts`.
- Ligne existante (`stripe_refund_id`) : mise à jour du statut + `failure_reason` (un final ne repasse jamais « en cours » ; mise à jour conditionnelle → une seule alerte). Sinon insertion `ON CONFLICT DO NOTHING` (`stripe_<re_id>`, motif « Remboursé depuis Stripe ») puis `notifyGuestRefund` une seule fois ; échec → `sendRefundFailedAlert` (nouveau, `lib/email.ts`) à chaque admin du tenant. Démo : jamais d'email (`sendEmail`).
- `charge.refunded` : liste `refunds.data` si présente, sinon `GET /v1/refunds?payment_intent=` (compte de l'hôtel). Course avec l'app : un Refund portant `metadata.dossierId` sans ligne et d'un événement de moins de 2 min → 503 (Stripe rejoue) ; `refundDossierPayment` fait un upsert sur `stripe_refund_id` si le webhook a été plus rapide.
- Fiche Dossier : bandeau rouge permanent `data-refund-failed` quand le dernier remboursement est échoué (le bandeau « remboursez depuis Stripe » n'existe plus depuis l'issue 02).
- Tests : `e2e/admin/refund-webhook.spec.ts` (10) ; faux Stripe : `GET /v1/refunds` (`listedRefunds`, `refundLists`). Obsidian : `Tests de non-régression.md`, `Déploiement.md`, `Guide Déploiement VPS.md`.
- À activer : endpoint Connect live et endpoint sandbox (démo) → `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed` (en plus des `checkout.session.*`). Clé restreinte : Refunds write, PaymentIntents/Charges read.
