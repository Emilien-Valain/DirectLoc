# Partage d'un groupe entre l'hôte et un Voisin

Status: done
Dépend de : 02

## À faire
- Si ni dates proches ni Voisin ne logent tout le groupe : proposer « Nous logeons N personnes ici, [Voisin] (X km) peut loger les M autres », un seul Voisin, avec la mention 2 réservations / 2 paiements.
- Le voyageur réserve d'abord sa part chez l'hôte (parcours Dossier normal, nombre de personnes réduit).
- Page de confirmation : revérifie le Voisin ; lien Renvoi (`kind = shared`) pour les M personnes restantes ; sinon un autre Voisin ; sinon téléphone de l'hôte.

## Tests
- 9 personnes, hôte loge 5, Voisin loge 4 → partage proposé → confirmation propose le Voisin avec 4 personnes.
- Voisin rempli entre-temps → autre Voisin ou téléphone. Aucun Voisin ne loge le reste → pas de proposition de partage.

## Comments
- 2026-11-22 : fait, sans migration. `findShareProposal` (hôte N = capacité max via le moteur, un seul Voisin le plus proche qui loge les M autres ; répartition adultes/mineurs par `planShare`, pur, 1 adulte de chaque côté) et `recheckShare` (confirmation : Voisin préféré s'il loge encore, sinon le plus proche, sinon téléphone de l'hôte) dans `lib/network.ts` ; `parseShare`/`planShare` dans `lib/network-geo.ts`. `/api/network/full` ajoute `share` (null si dates proches ou Voisin entier existent). Le partage voyage dans l'URL (`share=<slug>:<adultes>:<mineurs>`, pas de cookie) de la recherche → réservation → `success_url` → confirmation ; revalidé à chaque étape, dates relues sur la réservation. `/voisin/<slug>?kind=shared` (kind inconnu → 404). Notifications du partage (nom + téléphone de l'autre hôte) = issue 04. Tests : `e2e/public/network-share.spec.ts`, `e2e/unit/network-geo.spec.ts`.
