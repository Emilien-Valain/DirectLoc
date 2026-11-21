# Moteur de combinaison de chambres (module pur)

Status: done
Dépend de : 01

## À faire
- Fonction : (chambres libres du tenant pour `[checkIn, checkOut)` selon les Holds + règles, personnes adultes/mineurs) → combinaison suggérée (moins de chambres, puis prix total le plus bas) + répartition des personnes par chambre (remplit chaque chambre), ou « impossible » avec la capacité max atteignable (utilisée par le réseau pour le partage).
- Validation d'une combinaison modifiée par le voyageur : capacité totale ≥ personnes, chaque chambre ≤ sa capacité, mineurs ≤ personnes par chambre.
- Pas de dépendance au rendu ; réutilisable côté serveur pour un autre tenant (réseau, ADR-0013).

## Tests (unitaires, projet `unit`)
- 1 personne / capacité exacte / 9 personnes sur 4+3+2 / égalité de nombre de chambres → la moins chère / aucune combinaison → capacité max / chambre refusée par une règle (nuits min) exclue / 0 personne et valeurs négatives refusées.

## Comments
Module pur `lib/room-combination.ts` (tests : `e2e/unit/room-combination.spec.ts`) ; adaptateur DB `lib/room-combination-candidates.ts`.

- `type RoomCandidate = { id; capacity; totalPrice; excludedReason?: string }` (excludedReason = refus par règle ; la chambre n'est jamais proposée).
- `suggestCombination(candidates, adults, minors): CombinationResult` — `{ ok:true, rooms:[{roomId, capacity, totalPrice, guests, adults, minors}], totalPrice, totalCapacity }` | `{ ok:false, reason:"insufficient_capacity", maxCapacity }` | `{ ok:false, reason:"invalid_input", message, maxCapacity:0 }`. Minimum de chambres, puis prix le plus bas, départage par id (stable). DP exact, borné à `MAX_CANDIDATE_ROOMS = 30`. Il faut >= 1 adulte.
- Répartition : les personnes remplissent les chambres de la plus grande à la plus petite ; 1 adulte par chambre d'abord, puis les adultes restants, puis mineurs.
- `validateCombination(candidates, [{roomId, guests, minors}], adults, minors): { ok:true, totalPrice, totalCapacity } | { ok:false, errors: CombinationError[] }` (codes : empty, duplicate_room, unknown_room, room_excluded, invalid_count, empty_room, over_capacity, minors_exceed_guests, insufficient_capacity, people_mismatch, minors_mismatch, invalid_input).
- `loadRoomCandidates(tenantId, checkIn, checkOut): Promise<RoomCandidate[]>` — chambres actives libres (Holds) ; prix via `calculatePrice`, règles via `validateBookingRules` (1re violation -> excludedReason).

Mise à jour (décision : chaque chambre >= 1 adulte) : `suggestCombination` n'admet que des combinaisons de <= `adults` chambres ; si la capacité suffit sans cela -> `{ ok:false, reason:"not_enough_adults", maxCapacity }` (capacité max avec au plus `adults` chambres). `validateCombination` ajoute l'erreur `{ code:"no_adult"; roomId }` (guests - minors < 1).
