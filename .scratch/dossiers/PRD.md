# PRD — Dossiers (réserver plusieurs chambres en une fois)

Source : grill du 2026-11-20/21. Décisions : `CONTEXT.md` (Dossier, Booking) + `docs/adr/0012-a-dossier-groups-one-room-bookings.md`. Remplace l'idée « Panier multi-logements » du Plan de développement.

## Problème
Une réservation = une chambre, et le sélecteur public plafonne le nombre de personnes à la plus grande chambre (`app/page.tsx:41`). Un groupe de 9 ne peut même pas chercher. Cas très fréquent (familles, groupes Puy du Fou).

## Règles (l'ADR fait foi)
- Le voyageur saisit autant de personnes qu'il veut. Le moteur propose une combinaison : le moins de chambres, puis la moins chère. Le voyageur la modifie (ajouter / retirer / échanger une chambre) tant que la capacité totale ≥ personnes.
- Personnes (adultes + mineurs) réparties automatiquement chambre par chambre, corrigeables. Sert à la taxe de séjour et aux options « par personne ».
- Dossier = mêmes dates pour toutes les chambres, même voyageur, un paiement Stripe. Toute réservation appartient à un Dossier (Dossier d'une chambre compris) ; migration : un Dossier par réservation existante.
- Admission tout ou rien : `admitBooking` par chambre dans une transaction. Une chambre refusée → rien n'est créé, nouvelle combinaison proposée.
- Paiement réussi → toutes les chambres `confirmed` ; expiration → toutes `cancelled`.
- Options choisies par chambre + bouton « Appliquer à toutes les chambres ».
- Un email par Dossier (confirmation, rappel, remerciement) ; annulation d'une seule chambre → email dédié.
- Vocabulaire : voyageur = « réservation » uniquement ; admin = « Dossier » (ensemble) / « réservation » (chambre).
- Admin : fiche Dossier, marque « groupe » au calendrier, création manuelle d'un Dossier, annulation d'une chambre seule (remboursement manuel Stripe).

## Hors scope
Dates différentes par chambre. Remboursement automatique. Dossier réparti sur plusieurs tenants (→ partage, `.scratch/reseau-voisins/`).

## Issues (dans l'ordre)
1. `issues/01-dossier-schema-and-payment.md`
2. `issues/02-room-combination-engine.md`
3. `issues/03-public-multi-room-booking.md`
4. `issues/04-dossier-emails.md`
5. `issues/05-admin-dossier.md`

## Règles pour chaque agent
- Lire `AGENTS.md` (Next.js 16) avant de toucher routing/actions.
- Tests Playwright happy path + cas qui cassent (CLAUDE.md), nettoyage des données ; mettre à jour `Tests de non-régression.md` (vault : mémoire `obsidian-vault-path`) et `Schema DB.md` si schéma.
- Arrêter `next dev` sur :3000 avant `npm test`.
- Fin : `Status: done` + notes sous `## Comments`.
