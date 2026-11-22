# Documents légaux et conditions d'annulation

Status: ready-for-agent

## À faire
- Paramètres → Documents légaux : niveau d'annulation (Flexible / Modérée / Stricte / Personnalisé) + 4 textes préremplis modifiables (PRD § Documents légaux) ; champs raison sociale, SIRET ; mention « modèle à vérifier » admin seulement ; « Publier mes documents ».
- Stockage : niveau d'annulation (structuré, pour la suggestion de remboursement de l'issue 02) + textes publiés.
- Pages publiques `/conditions-annulation`, `/cgv`, `/mentions-legales`, `/confidentialite` sur les 4 templates, liens en pied de page ; version minimale si non publiés.
- Mention + liens sous le bouton de paiement (une chambre et multi-chambres) ; copie des textes + date sur le Dossier au paiement (migration).
- Avertissement Paramètres → Paiements si pas de conditions d'annulation.
- Fonction pure `suggestedRefund(level, checkIn, cancelledAt, amount)` testée en unitaire (utilisée en 02).

## Tests
Unitaires des modèles et de `suggestedRefund` (bornes J-1, J-7, J-30, le jour même, après l'arrivée). E2E : édition/publication, pages publiques sur 4 templates, pied de page, mention au paiement, copie sur le Dossier, XSS dans les textes, isolation tenant, mention « modèle » absente du site public, tenant sans documents publiés.
