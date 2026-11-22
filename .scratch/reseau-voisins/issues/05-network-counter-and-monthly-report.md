# Compteur réseau et Bilan mensuel

Status: done
Dépend de : 02, 04

## À faire
- Tableau de bord admin : « Réseau : X voyageurs envoyés · Y reçus · Z réservations » (mois en cours + total), toujours affiché ; avertissement GPS à côté si coordonnées manquantes ; mention si le tenant est hors réseau.
- Cron le 1er du mois (route cron existante ou nouvelle, même protection) : Bilan du mois précédent par tenant, envoyé seulement si ≥ 1 Renvoi envoyé ou reçu. Ne jamais citer de chiffres globaux du réseau.

## Tests
- Compteur cohérent avec les `referrals` créés dans le test ; tenant sans activité → pas de Bilan ; avec activité → 1 Bilan. Projet `mobile` : compteur visible sans `page.reload()`.

## Comments
- 2026-11-22 : fait. Migration `0032_network_reports` (table `network_reports`, unique tenant+mois : idempotence du cron). `networkCounts` / `networkStatus` dans `lib/network.ts` ; bloc `[data-network-counter]` en haut du tableau de bord (toujours affiché, GPS manquant, mention hors réseau). Décision : réservations = Dossiers confirmés attribués où l'hôtel est envoyeur OU receveur (un compte seulement, rien d'un autre tenant). `lib/network-report.ts` + `GET /api/cron/network-report` (CRON_SECRET, 1er du mois 9h, voir Déploiement.md), `sendNetworkMonthlyReport` (email, noms échappés). Tests : `e2e/admin/network-counter.spec.ts` (2), `e2e/mobile/network-counter-mobile.spec.ts` (1), `e2e/payment/network-report.spec.ts` (2). La planification Coolify (`0 9 1 * *`) reste à créer en prod.
