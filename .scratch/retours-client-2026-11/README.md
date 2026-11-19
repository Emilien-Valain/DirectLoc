# Retours client du 2026-11-19 — décisions mises de côté

Status: ready-for-agent

Liste des modifications demandées. Fait et poussé : bouton Modifier sur les 3 onglets de Règles ; règles tarifaires multi-chambres et « une valeur par chambre » ; rappel avant l'arrivée réglable ; message d'email par chambre + variables ; option « par lit » à quantité choisie ; nombre de voyageurs dans la recherche ; prénom/nom/téléphone/adresse obligatoires ; icône d'onglet ; lien « Voir mon site ».

Restent ces choix, pas évidents, à trancher :

## 1. Aperçu du site intégré dans l'admin (iframe)
Demandé : « visuel rapide de son site en construction ». Fait : lien « Voir mon site ↗ » (nouvel onglet) dans la barre latérale et l'onglet Mon site.
Un aperçu **intégré** (iframe, bascule ordinateur/téléphone, rechargé après chaque enregistrement) exige d'assouplir `X-Frame-Options: DENY` / `frame-ancestors 'none'` en `SAMEORIGIN` / `'self'` sur les pages publiques (tests `e2e/public/security.spec.ts` l'interdisent aujourd'hui). Risque faible (même origine), mais c'est un choix de sécurité.
→ Garder le lien, ou autoriser le cadrage same-origin pour un aperçu intégré ?

## 2. Modifier en bloc des règles existantes
Fait : à la création, une règle peut viser plusieurs chambres (même prix) ou créer une règle par chambre avec des valeurs différentes (même nom, période, jours).
Pas fait : modifier d'un coup un **groupe** de règles déjà créées (ex. décaler la saison « Été » de 5 chambres à prix différents). Il faudrait une notion de « saison » partagée (table `seasons` liée aux règles) ou une édition multi-sélection.
→ Le besoin réel est-il « une saison, N prix » (modèle saison) ou « éditer plusieurs lignes à la fois » ?

## 3. Propriétés libres des logements dans les emails ({etage}…)
Fait : variables `{client} {chambre} {arrivee} {depart} {nuits} {voyageurs} {capacite} {lits} {etablissement}` et un message par chambre (où l'hôte peut écrire l'étage en clair).
Pas fait : des **propriétés personnalisées** par chambre (étage, code porte, wifi…) utilisables comme variables. Choix : champs fixes (étage…) ou paires clé/valeur libres par chambre ?

## 4. Quantité choisie pour d'autres unités d'option
Fait : unité « par lit » où le client choisit le nombre de lits (≤ lits de la chambre).
Pas fait : rendre **toute** option quantifiable (ex. 2 paniers pique-nique « par séjour »). Change la règle du domaine « quantité dérivée, jamais saisie » (ADR-0010).
→ Utile au-delà des draps ? Si oui, quelle borne max par option ?

## 5. Prénom et nom stockés séparément
Fait : formulaire public Prénom + Nom, stockés en `guestName = "Prénom Nom"` ; la saisie admin garde un seul champ.
Pas fait : colonnes séparées (utile pour une variable `{prenom}` « Bonjour Marie », un registre de police, l'export taxe de séjour).
→ Séparer en base et dans le formulaire admin ?

## 6. Adresse postale structurée
Fait : un champ « Adresse postale » obligatoire (texte libre, 300 car.).
Pas fait : rue / code postal / ville / pays séparés (utile pour factures ou fiche de police).

## Décisions (2026-11-19)
1. Aperçu intégré : **non**, on garde le lien « Voir mon site ».
2. Modifier en bloc : **groupe de règles** — les règles créées ensemble restent liées ; modifier le groupe change période/jours de toutes, un prix par chambre.
3. Propriétés des logements : **champs fixes (étage, code porte, wifi…) + champs libres ajoutables**, utilisables comme variables d'email. UI/UX très claire et simple.
4. Options quantifiables : **oui, toutes**, avec un maximum par option fixé par l'hôte (ADR-0010 à amender).
5. Prénom / nom : **séparés** en base et dans la saisie admin ; variable `{prenom}` ; anciens noms découpés au premier espace.
6. Adresse : **texte libre + menu Pays**.
