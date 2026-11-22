# PRD — Remboursements, litiges et documents légaux

Source : grill du 2026-11-22. Prérequis : comptes hôtels Stripe Connect v2 « SaaS » (dashboard full, pertes et frais côté Stripe/hôtel, direct charges) — chantier en cours hors de ce PRD.

## Problème
L'hôte doit aujourd'hui aller sur Stripe pour rembourser (l'app dit « remboursez X € depuis votre tableau de bord Stripe ») et n'est pas prévenu d'un litige. Les sites des hôtels n'ont aucune page légale (mentions légales, CGV, confidentialité, conditions d'annulation) : obligation légale en France, et sans conditions d'annulation acceptées au paiement un litige « annulé non remboursé » est presque toujours perdu.

## Décisions
### Documents légaux
- 4 documents par tenant, modifiables dans Paramètres → Documents légaux : conditions d'annulation (niveaux Flexible : 100 % jusqu'à J-1 ; Modérée : 100 % jusqu'à J-7 puis 50 % ; Stricte : 50 % jusqu'à J-30 puis 0 ; ou texte personnalisé), CGV (incluent les conditions d'annulation), mentions légales (éditeur + hébergeur DirectLoc), politique de confidentialité (données, durées, Stripe, emails, droits RGPD).
- Préremplis depuis les infos du tenant ; nouveaux champs Paramètres : raison sociale, SIRET (et ce qui manque aux mentions légales).
- Mention « Modèle fourni à titre indicatif, à vérifier et adapter » **dans l'admin uniquement**, jamais sur le site public.
- Texte simple avec titres, rendu sans HTML (pas d'éditeur riche, pas de XSS).
- Pages publiques sur tous les templates : `/conditions-annulation`, `/cgv`, `/mentions-legales`, `/confidentialite`, liées en pied de page.
- Sous le bouton de paiement : « En payant, vous acceptez les conditions d'annulation et les CGV de l'établissement » (liens, pas de case). Au paiement, le texte exact des deux documents + la date sont copiés sur le Dossier (preuve).
- Facultatif : sans conditions, avertissement dans Paramètres → Paiements (« Sans conditions d'annulation, vous perdrez la plupart des litiges »), paiement en ligne autorisé.
- Tenants existants : niveau Modérée et modèles préremplis, **non publiés** tant que l'hôte n'a pas cliqué « Publier mes documents » ; d'ici là, pages légales minimales (nom, adresse, hébergeur).
- Relecture des 4 modèles par un juriste : à faire par le propriétaire avant mise en ligne.

### Remboursements
- Tout admin du tenant. Montant libre (centimes) ≤ restant remboursable ; plusieurs remboursements partiels. Raccourcis : prix de la chambre annulée, trop-perçu, total, suggestion selon le niveau d'annulation (« 50 % selon vos conditions (modérée, moins de 7 jours) ») ; conditions personnalisées → total + « conditions personnalisées, vérifiez le montant ».
- Point d'entrée : dialog d'annulation d'une chambre / du Dossier (case « Rembourser X € » cochée par défaut, montant modifiable) + bouton « Rembourser » toujours sur la fiche Dossier. Le bandeau « remboursez depuis Stripe » disparaît.
- Rattaché au Dossier (+ chambre si issu d'une annulation), motif facultatif. Statuts en cours / effectué / échoué via webhook ; échec → bandeau rouge + email admin.
- Remboursement fait dans le tableau de bord Stripe → synchronisé par webhook (`charge.refunded`, `refund.updated` sur l'endpoint Connect).
- Argent du Dossier : encaissé net = payé en ligne − remboursé ; reste à payer = dû − net ; trop-perçu = net − dû. Fiche : une ligne par mouvement.
- Email au voyageur à chaque remboursement (« Remboursement de X € pour votre réservation », délai bancaire 5-10 j) ; jamais depuis la démo.
- Non remboursable depuis l'app : paiement hors ligne (« marqué réglé ») ; paiement en litige (bouton désactivé « Litige en cours, répondez-y d'abord »).
- Une ligne : les frais Stripe ne sont pas rendus.

### Litiges
- Webhook `charge.dispute.created/updated/closed` (endpoint Connect). Email d'alerte à tous les admins du tenant (pas au propriétaire de la plateforme) ; bandeau rouge sur le Dossier (montant, date limite).
- Actions dans l'admin : Accepter ; ou Répondre avec preuves texte préremplies (séjour, chambres, montant, voyageur, date de réservation, confirmation envoyée, conditions acceptées au paiement) ; « Enregistrer le brouillon » (evidence sans submit) ; « Envoyer à la banque » définitif avec confirmation.
- Pièces jointes : v2 ; v1 = lien vers le litige dans le tableau de bord Stripe de l'hôte.
- Perdu → montant compté comme remboursé, bandeau « Litige perdu : X € repris par la banque » ; gagné → « Litige gagné » puis disparaît. Statut des réservations jamais changé automatiquement.

### Démo
Remboursements et litiges en mode test sur le compte plateforme sandbox, sans email. Carte litige : `4000 0000 0000 0259`.

## Prérequis d'exploitation (propriétaire)
- Clé restreinte live : ajouter en « Connect permissions » Refunds (write), Disputes (write), Charges/PaymentIntents (read) ; Files (write) en v2.
- Endpoint webhook Connect live : ajouter `charge.refunded`, `refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`. Idem endpoint sandbox (démo).

## Hors scope
Pièces jointes de litige (v2). Politique d'annulation appliquée automatiquement. Remboursement de paiements hors ligne. Commission plateforme.

## Issues (dans l'ordre)
1. `issues/01-legal-documents.md`
2. `issues/02-refunds.md`
3. `issues/03-refund-webhook-sync.md`
4. `issues/04-disputes.md`

## Règles pour chaque agent
Lire `AGENTS.md` (Next.js 16). Tests Playwright happy path + cas qui cassent (CLAUDE.md), nettoyage ; Stripe simulé (`e2e/helpers/fake-stripe.ts`, à étendre : refunds, disputes) ; mettre à jour `Tests de non-régression.md` et `Schema DB.md` (vault réel : `/home/richard/Documents/ObsidianVault/GitSync/PROJETS/Projet Booking Manager/`). Rien sur :3000 avant `npm test`. Attente d'un run long : `until grep -qE "^\s+[0-9]+ passed" <log>` sur un log du scratchpad, jamais sur tasks/*.output. Fin : `Status: done` + `## Comments`.
