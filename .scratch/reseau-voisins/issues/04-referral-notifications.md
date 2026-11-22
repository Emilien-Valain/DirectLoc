# Notifications de Renvoi et saisie « Venu par le réseau »

Status: done
Dépend de : 02, dossiers/05

## À faire
- À la confirmation d'un Dossier attribué (paiement ou saisie admin) : email au Voisin « Réservation obtenue grâce à X (réseau DirectLoc) » ; email à l'envoyeur « Votre établissement était complet du … : le voyageur que vous avez orienté vers Y y a réservé. » Aucune donnée voyageur pour l'envoyeur.
- Groupe partagé (les deux Dossiers confirmés) : chaque hôte reçoit nom + téléphone de l'autre.
- Saisie manuelle de Dossier : case « Venu par le réseau : [Voisin] » (liste des Voisins membres) → même attribution et mêmes emails.
- Une seule notification par Dossier (pas de doublon si le webhook rejoue).

## Tests
- Dossier attribué payé → 2 emails, contenu de l'envoyeur sans nom ni email du voyageur. Webhook rejoué → pas de 2ᵉ email. Case admin cochée → emails envoyés. XSS dans le nom du tenant échappé.

## Comments
- 2026-11-22 : fait. Migration `0031_network_notifications` (`dossiers.network_notified_at`, `referrals.from_dossier_id`/`to_dossier_id` (unique)/`share_notified_at`). `lib/network-notify.ts` (`notifyNetworkConfirmation`, appelé par le webhook `completed`, la saisie manuelle d'une chambre ou d'un Dossier, et « Confirmer ») ; template `sendNetworkNotice` (receiver / sender / partner) dans `lib/email.ts`, noms échappés, destinataires = admins du tenant (`tenantAdminEmails`). Une seule notification : marqueurs réservés par `UPDATE … WHERE … IS NULL` avant l'envoi (best-effort : un envoi SMTP raté n'est pas rejoué). Saisie admin : case « Venu par le réseau » + liste `listNetworkVoisins`, revérifiée serveur par `resolveVoisinId` (lib/network.ts).
- Décision (lien du groupe partagé) : le lien de la page de confirmation de l'hôte porte `dossier=<id de son Dossier>` ; `/voisin` (même domaine que l'hôte) le garde sur le Renvoi `shared` seulement si le Dossier est à cet hôte et aux mêmes dates, et ne le met PAS dans la redirection : rien ne passe chez le Voisin. À la confirmation du Dossier attribué du Voisin, le Renvoi partagé du même couple d'hôtels et des mêmes dates (le plus récent, non relié) est relié (`to_dossier_id`). Dès que les deux Dossiers sont confirmés, chaque hôte reçoit nom + téléphone (config) de l'autre : dans les emails d'attribution s'ils partent au même moment, sinon un email « Groupe partagé avec … ». Ambiguïté possible (deux partages identiques entre les mêmes hôtels aux mêmes dates) sans conséquence : le contact échangé est le même. Aucune donnée voyageur ne traverse.
- Envoyeur d'un partage : texte « ne pouvait pas loger tout le groupe du … » au lieu de « était complet ». Tests : `e2e/payment/network-notifications.spec.ts` (5), `e2e/admin/network-manual-entry.spec.ts` (4) ; specs 02/03 ajustées (colonnes de `referrals`, `dossier` dans le lien de partage). Helper `mailText` (corps HTML sans en-têtes, accents décodés).
