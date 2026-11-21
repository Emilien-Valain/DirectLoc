# Parcours public : réserver plusieurs chambres

Status: done
Dépend de : 01, 02

## À faire
- Sélecteur de personnes sans plafond (adultes + mineurs).
- Affichage de la combinaison suggérée ; le voyageur ajoute / retire / échange une chambre ; répartition des personnes modifiable.
- Formulaire : identité une fois, options par chambre + « Appliquer à toutes les chambres ».
- Récapitulatif : chaque chambre (personnes, prix, options), total. Le voyageur ne voit jamais le mot « Dossier ».
- Création : admission de chaque chambre dans une transaction, tout ou rien ; chambre prise entre-temps → message + nouvelle combinaison. Un seul Stripe Checkout (line items par chambre et par option). Le serveur recalcule tout.
- Une seule chambre = parcours identique à aujourd'hui.

## Tests — `e2e/public/`
- Réserver 3 chambres pour 9 personnes → un paiement, 3 réservations confirmées.
- Modifier la combinaison ; capacité insuffisante refusée ; répartition invalide (mineurs > personnes) refusée.
- Course : une chambre prise juste avant validation → rien créé. Montants falsifiés ignorés. XSS dans le nom. Nettoyage.

## Comments

**Fait (2026-11-21)**

UI (voyageur : « réservation », jamais « Dossier ») :
- Accueil (`components/public/Search.tsx`) : « Voyageurs » remplacé par deux petits champs **Adultes** (1–30) et **Enfants** (0–20), sans plafond lié aux chambres (`maxGuests` retiré de `app/page.tsx` / `HomeHero`). Si une chambre loge tout le groupe : liste d'une chambre inchangée (lien `…&guests=N[&children=M]`) + lien « Plutôt plusieurs chambres ? ». Sinon : appel à `/api/rooms/combination` et carte « N chambres pour X personnes » (chambres, répartition, hébergement total) → « Réserver ces N chambres ». Pas de combinaison : message (`noCombinationMessage`, capacité max ou « au moins un adulte par chambre »).
- Page `/reserver/chambres?checkIn&checkOut&adults&minors[&rooms=id,id]` (`app/reserver/chambres/page.tsx` + `components/public/DossierForm.tsx`) : séjour (dates en lecture, « Changer de dates »), groupe (adultes/enfants, changer = répartition automatique), une carte numérotée par chambre (adultes/enfants de la chambre, options de la chambre, « Appliquer ces options à toutes les chambres », « Échanger contre » (select), « Retirer cette chambre »), « Ajouter une chambre », identité une fois, récap par chambre (hébergement, options, frais, taxe) + total, barre de paiement mobile. Toute modification de chambres redistribue (`distributeGuests`), le voyageur corrige ensuite. Validation client = `validateCombination` + messages partagés (`lib/dossier-messages.ts`) ; paiement bloqué tant que la répartition est invalide. Paramètres invalides → message + lien vers la recherche (jamais 500) ; chambres de l'URL plus libres ignorées (avertissement).
- Composants extraits de `BookingForm` sans changement de DOM : `ExtraOptions`, `GuestFields`. `BookingForm` lit aussi `?children=`.
- Confirmation : toutes les chambres (une ligne par chambre « Nom · N pers. » + ses lignes, total du Dossier) ; une seule chambre = affichage identique à avant. Référence = 1re réservation créée. Shortcut retiré.

API serveur :
- `createDossierPublic` (`lib/actions/dossier-public.ts`, `useActionState`) : formData = identité + `checkIn/checkOut/adults/minors` + `plan` JSON `[{roomId, guests, minors, extraIds, extraQuantities}]` (`dossierPublicSchema`, clés inconnues ignorées : aucun montant lu). Rate limit partagé avec le formulaire d'une chambre. `loadRoomCandidates` + `validateCombination` → refus lisible ; chambre inconnue/exclue/prise → `{ gone, suggestion }` (nouvelle combinaison appliquée par le formulaire). Puis UNE transaction : `admitInTx` par chambre en ordre d'id croissant (pas d'interblocage entre deux groupes), `createDossier`, réservations + `saveLines` ; une chambre refusée → rollback complet + nouvelle combinaison. Une session Stripe : line items par chambre (hébergement) et par ligne (options / frais / taxe préfixés « Chambre · »), repli à une ligne par chambre au-delà de 100 items ; `metadata { dossierId, tenantId }` ; un `payments` du total ; `cancel_url` revient sur `/reserver/chambres` avec les mêmes chambres.
- `lib/booking-intake.ts` : `admitInTx(tx, input, options)` (le gate) ; `admitBooking` = `db.transaction(tx => persist(tx, admitInTx(...)))`, comportement inchangé.
- `lib/checkout-lines.ts` : `roomLineItems` (mêmes items qu'avant pour une chambre) et `openCheckoutOrRollback` (Connect/démo + suppression Dossier et réservations si Stripe échoue), utilisés par les deux actions.
- `GET /api/rooms/combination?from&to&adults&minors` (400 sur paramètres invalides, champs publics seulement).
- `lib/room-combination.ts` : `distributeGuests(rooms, adults, minors)` exporté (utilisé par `suggestCombination`, résultat identique). `loadRoomCandidates` renvoie aussi `name` et `nightPrices` (taxe en % côté client).
- Tests : `lib/stripe.ts` lit `STRIPE_API_BASE` (E2E seulement, posé dans `playwright.config.ts`) → faux Stripe `e2e/helpers/fake-stripe.ts`. Effet de bord voulu : les autres specs n'appellent plus le vrai Stripe (connexion refusée = même « momentanément indisponible »).

Tests : `e2e/public/dossier-booking.spec.ts` (23 tests, tenant dédié), `e2e/unit/room-combination.spec.ts` (+5 `distributeGuests`), `e2e/public/search-guests.spec.ts` adapté (le plafond « Voyageurs ≤ plus grande chambre » est précisément ce que l'issue retire). Obsidian `Tests de non-régression.md` à jour ; pas de changement de schéma.

**Raccourcis / pour la suite**
- Dates en lecture seule sur la page multi-chambres (« Changer de dates » renvoie à la recherche).
- Après « Annuler » sur Stripe, les chambres restent tenues par le Dossier pending jusqu'à expiration (comme le parcours d'une chambre) : elles disparaissent alors de la page de retour.
- Le test « formulaire complet … Stripe » de `booking-flow.spec.ts` (skippé avec la clé placeholder) partirait maintenant vers le faux Stripe s'il était activé avec une vraie clé.
- 04 (emails) : le webhook envoie encore un email par réservation confirmée → 3 emails pour 3 chambres ; à remplacer par un email par Dossier (lister les chambres comme la confirmation, total = `payments.amount`).
- 05 (admin) : la fiche réservation affiche `payment.amount` (total du Dossier) comme « payé en ligne » de chaque chambre — faux dès 2 chambres ; « Reste à payer » par chambre à revoir. Pas encore de vue Dossier ni de marque « groupe ».

**Flake corrigé en passant (stripe-webhook « expired → chambres de nouveau libres »)** : cause = `e2e/admin/rules-manual-blocks.spec.ts`. Trois tests cliquaient « Supprimer » + confirmaient puis se terminaient sans attendre : la page se fermait, la suppression n'aboutissait pas, et des blocages « toutes les chambres » restaient en base, dont « chaque lundi » ouvert. 2034-02-06 est un lundi, d'où `blockedDates = ["2034-02-06"]` sur une chambre pourtant dédiée, jusqu'au `cleanRules` d'une spec publique suivante. Le spec admin seul laissait 3 blocages (reproduit). Correctif : `deleteFirstBlock` attend la disparition de la ligne, plus `afterAll(cleanRules)` en filet.
