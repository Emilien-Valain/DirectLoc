# PRD — Réseau des Voisins

Source : grill du 2026-11-20/21. Décisions : `CONTEXT.md` (Voisin, Renvoi, Dossier) + `docs/adr/0013-the-network-is-the-only-cross-tenant-read.md`. Promis sur la vitrine (`app/vitrine/page.tsx`, section « Le réseau ») et dans `PRODUCT.md`.
Prérequis : `.scratch/dossiers/` (moteur de combinaison, Dossier).

## Problème
Quand un hôte est complet, le voyageur repart sur Booking/Airbnb. Le réseau le garde chez un autre hôte DirectLoc et prouve la valeur de l'abonnement aux deux hôtes.

## Règles
- Membre du réseau : activé par défaut, réciproque, interrupteur opérateur par tenant. Sans GPS → hors réseau, avec un avertissement dans Paramètres → Localisation et à côté du compteur.
- Déclencheur : l'hôte ne peut pas loger tout le groupe aux dates demandées. Ordre affiché :
  1. Dates proches chez l'hôte : même nombre de nuits, ±7 jours, 3 créneaux max.
  2. Jusqu'à 3 Voisins qui logent tout le groupe, les plus proches d'abord (30 km, complétés au-delà si moins de 3 ; distance toujours affichée).
  3. Partage : l'hôte loge une partie, un seul Voisin le reste. Mention : « Votre groupe sera réparti sur 2 hébergements à X km, avec 2 réservations et 2 paiements séparés. »
- Voisin « libre » = dry run de son admission (combinaison + ses règles), sans rien écrire.
- Affiché : nom, commune (nouveau champ config), distance à vol d'oiseau, photo principale. Pas de prix.
- Renvoi : clic → `/voisin/<slug>` sur le domaine de l'hôte qui envoie, enregistre le Renvoi (envoyeur, receveur, dates, personnes, horodatage, type ; aucune donnée voyageur), puis redirige vers le site du Voisin avec dates/personnes pré-remplies et `via=<slug>`. `via` vit dans l'URL pour la visite, pas de cookie ; enregistré sur le Dossier créé.
- Partage : l'hôte d'abord ; la page de confirmation revérifie le Voisin et propose le lien pour le reste ; sinon autre Voisin ; sinon téléphone de l'hôte.
- Saisie admin : case « Venu par le réseau : [Voisin] » sur la saisie manuelle.
- Notifications à la confirmation d'un Dossier attribué : Voisin « Réservation obtenue grâce à X (réseau DirectLoc) » ; envoyeur « Votre établissement était complet du … : le voyageur que vous avez orienté vers Y y a réservé. » Jamais de données voyageur pour l'envoyeur. Groupe partagé : chaque hôte reçoit nom + téléphone de l'autre.
- Valeur : compteur au tableau de bord (envoyés / reçus / réservations) ; Bilan mensuel le 1er, seulement s'il y a eu ≥ 1 Renvoi.

## Hors scope
Articles SEO réseau et « Prévenez-moi si ça se libère » → Obsidian `Ajout Post MVP.md`. Partage sur 3 établissements ou plus. Rotation entre Voisins. Affichage de prix.

## Issues (dans l'ordre)
1. `issues/01-network-membership-and-query.md`
2. `issues/02-full-state-and-referral.md`
3. `issues/03-shared-stay.md`
4. `issues/04-referral-notifications.md`
5. `issues/05-network-counter-and-monthly-report.md`

## Règles pour chaque agent
Mêmes que `.scratch/dossiers/PRD.md`. En plus : l'isolation multi-tenant est testée à chaque issue — le module réseau est la seule lecture entre tenants (ADR-0013).
5. `issues/05-network-counter-and-monthly-report.md`
