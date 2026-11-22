# Site public complet : dates proches, Voisins, Renvoi

Status: done
Dépend de : 01

## À faire
- Quand la recherche ne trouve aucune combinaison : bloc « Complet du … » avec 1) jusqu'à 3 créneaux ±7 jours même durée chez l'hôte, 2) jusqu'à 3 Voisins qui logent tout le groupe (≤ 30 km d'abord, complétés au-delà). Rien n'est affiché si la liste est vide.
- Table `referrals` (fromTenantId, toTenantId, checkIn, checkOut, guestCount, kind `full|shared`, createdAt). Pas de donnée voyageur.
- Route `/voisin/<slug>` : enregistre le Renvoi puis redirige vers le domaine du Voisin avec dates, personnes, `via`. Slug inconnu / hors réseau → 404. Rate limit comme les autres routes publiques (`proxy.ts`).
- Site du Voisin : pré-remplit la recherche ; `via` propagé dans l'URL jusqu'au Dossier (`dossiers.referredByTenantId`), pas de cookie. `via` inconnu → ignoré.
- Esthétique : suivre le template du tenant ; maquette de référence = `.alm-slip` de la vitrine.

## Tests — `e2e/public/`
- Tenant complet → Voisin affiché → clic → Renvoi enregistré → site du Voisin pré-rempli → réservation → Dossier attribué.
- `via` falsifié / d'un tenant hors réseau → réservation normale non attribuée. Dates invalides dans `/voisin/…` → 404, pas 500. Nettoyage (referrals compris).

## Comments
- 2026-11-22 : fait. Migration `0030_referrals` (table `referrals`, `dossiers.referred_by_tenant_id`). `/voisin/<slug>` (route handler), `/api/network/full`, `lib/network.ts` (`getVoisinTarget`, `resolveVia`, `findNearbySlots`, `pickVoisins`), bloc `.s-full-slip` dans `components/public/Search.tsx`. Hôtel démo exclu du réseau. Tests : `e2e/public/network-referral.spec.ts`.
