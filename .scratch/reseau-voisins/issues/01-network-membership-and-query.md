# Appartenance au réseau et requête des Voisins

Status: done
Dépend de : dossiers/02

## À faire
- Config tenant : `city` (commune) et `networkEnabled` (absent = activé). Interrupteur réservé à l'opérateur.
- Paramètres → Localisation : champ commune + encart « Sans position GPS, votre établissement n'apparaît pas dans le réseau des voisins » quand lat/lng manquent.
- Module unique de lecture entre tenants (ADR-0013) : pour un séjour (dates, personnes) et un tenant d'origine → Voisins membres avec GPS, distance haversine, et pour chacun « loge tout le groupe » ou capacité max (dry run du moteur de combinaison + règles). Ne renvoie que nom, commune, distance, photo, téléphone, slug/domaine.
- Exclut l'origine, les non-membres, les tenants sans GPS, les tenants sans domaine actif.

## Tests
- Unitaires : tri par distance, exclusion sans GPS / désactivé / origine, règles du Voisin respectées.
- Aucune donnée de réservation ni de voyageur dans la sortie (assertion sur les clés).
- Admin : encart GPS visible sans coordonnées, absent avec.

## Comments
- Fait : `city`/`networkEnabled` dans la config (jsonb, pas de migration), commune + encart GPS dans Paramètres → Localisation, `lib/network.ts` (`findVoisins`, seule lecture entre tenants, dry run via `loadRoomCandidates` + `suggestCombination`) et `lib/network-geo.ts` (pur). « Domaine actif » = `tenants.domain` non vide. Sortie : name, city, distanceKm, photoUrl (hero sinon 1re galerie), phone, slug, domain, fitsWholeGroup, maxCapacity. Les Voisins à 0 place sont renvoyés (à l'appelant de filtrer).
