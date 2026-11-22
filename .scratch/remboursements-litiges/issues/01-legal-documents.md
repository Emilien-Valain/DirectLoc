# Documents légaux et conditions d'annulation

Status: done

## À faire
- Paramètres → Documents légaux : niveau d'annulation (Flexible / Modérée / Stricte / Personnalisé) + 4 textes préremplis modifiables (PRD § Documents légaux) ; champs raison sociale, SIRET ; mention « modèle à vérifier » admin seulement ; « Publier mes documents ».
- Stockage : niveau d'annulation (structuré, pour la suggestion de remboursement de l'issue 02) + textes publiés.
- Pages publiques `/conditions-annulation`, `/cgv`, `/mentions-legales`, `/confidentialite` sur les 4 templates, liens en pied de page ; version minimale si non publiés.
- Mention + liens sous le bouton de paiement (une chambre et multi-chambres) ; copie des textes + date sur le Dossier au paiement (migration).
- Avertissement Paramètres → Paiements si pas de conditions d'annulation.
- Fonction pure `suggestedRefund(level, checkIn, cancelledAt, amount)` testée en unitaire (utilisée en 02).

## Tests
Unitaires des modèles et de `suggestedRefund` (bornes J-1, J-7, J-30, le jour même, après l'arrivée). E2E : édition/publication, pages publiques sur 4 templates, pied de page, mention au paiement, copie sur le Dossier, XSS dans les textes, isolation tenant, mention « modèle » absente du site public, tenant sans documents publiés.

## Comments

- Migration `db/migrations/0027_legal_documents.sql` : enum `cancellation_level` ; `tenants` + `legal_name`, `legal_form`, `siret`, `publication_director`, `mediator`, `cancellation_level` (défaut `moderate`), `cancellation_text`, `cgv_text`, `legal_notice_text`, `privacy_text` (NULL = modèle, rempli à l'affichage), `legal_published_at` (NULL = non publiés) ; `dossiers` + `cancellation_level`, `accepted_cancellation_text`, `accepted_cgv_text`, `terms_accepted_at`. Appliquée à `maresa` et `maresa_test`.
- Module pur `lib/legal-documents.ts` : modèles (4 documents, 3 niveaux), `missingLegalFields`, `documentText`/`cgvWithAnnex` (les CGV portent toujours les conditions en vigueur en annexe), `acceptedTerms`, `paymentTerms`, `parseLegalText` (`## ` titre, `- ` liste, jamais de HTML), `suggestedRefund(level, checkIn, cancelledAt, amountCents)` → `{ amount (centimes), percent, daysBefore, label } | null` (pour l'issue 02). `PLATFORM_HOST_IDENTITY` = placeholder hébergeur à compléter par le propriétaire.
- `lib/legal-settings.ts` (lecture tenant, `acceptedTermsFor` dans la transaction d'admission), action `lib/actions/legal.ts` (`intent=publish`), onglet Paramètres « Documents légaux » (`components/admin/LegalDocumentsSection.tsx`), avertissement dans « Calendriers et paiements », pages `app/{conditions-annulation,cgv,mentions-legales,confidentialite}` via `components/public/LegalPage.tsx` (minimales + `noindex` tant que non publiés), liens en pied de page (`PublicLayout`), mention sous le bouton (`components/public/TermsNotice.tsx`, une et plusieurs chambres), copie sur le Dossier dans `createBookingPublic` / `createDossierPublic`, preuve dépliable sur la fiche Dossier, démo publiée d'office (`lib/demo-seed.ts`).
- Publier avec des champs « [à compléter] » reste possible (signalés, pas bloquants) : mieux vaut des conditions publiées qu'aucune.
- Tests : `e2e/unit/legal-documents.spec.ts`, `e2e/admin/legal-documents.spec.ts`, `e2e/public/legal-pages.spec.ts`, `e2e/mobile/legal-documents-mobile.spec.ts` ; `a11y.spec.ts` et `parametres.spec.ts` passent à 5 onglets.
- Obsidian : `Tests de non-régression.md`, `Schema DB.md` ; `CONTEXT.md` : terme « Cancellation policy ».
- À faire par le propriétaire : compléter `PLATFORM_HOST_IDENTITY`, faire relire les 4 modèles par un juriste.
