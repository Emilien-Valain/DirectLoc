import { todayStart } from "@/lib/date-windows";

/**
 * Documents légaux d'un établissement (PRD remboursements-litiges § Documents légaux) :
 * conditions d'annulation, CGV, mentions légales, politique de confidentialité.
 *
 * Module pur (aucun accès base) : partagé par l'admin (aperçu en direct), les pages publiques,
 * la copie sur le Dossier au paiement et la suggestion de remboursement (issue 02).
 *
 * Un texte se rédige en texte simple : une ligne « ## Titre » est un titre, une ligne « - … »
 * un élément de liste, une ligne vide sépare les paragraphes. Jamais de HTML : le rendu
 * passe par `parseLegalText` puis React, qui échappe tout.
 *
 * Les modèles sont remplis avec les informations du tenant ; un champ absent reste visible
 * sous la forme `[à compléter]` (signalé dans l'admin par `missingLegalFields`).
 */

export const MISSING = "[à compléter]";

/**
 * Hébergeur du site (art. 6 III de la LCEN) : DirectLoc, pour tous les établissements.
 * shortcut: à compléter par le propriétaire de la plateforme (raison sociale, adresse, téléphone).
 */
/** Hébergeur de chaque site (LCEN art. 6) : l'exploitant de DirectLoc, puis l'infrastructure physique. */
export const PLATFORM_HOST_IDENTITY =
  "Emilien Valain, micro-entreprise (SIREN 898 875 059), 2 rue de la Bachellerie, 85290 Saint-Laurent-sur-Sèvre, France — 07 69 23 96 53 — emilien.valain@gmail.com. Serveurs : OVH SAS, 2 rue Kellermann, 59100 Roubaix, France";

export const CANCELLATION_LEVELS = ["flexible", "moderate", "strict", "custom"] as const;
export type CancellationLevel = (typeof CANCELLATION_LEVELS)[number];

export const CANCELLATION_LEVEL_INFO: Record<CancellationLevel, { label: string; summary: string }> = {
  flexible: { label: "Flexible", summary: "Remboursement intégral jusqu'à la veille de l'arrivée, rien ensuite." },
  moderate: {
    label: "Modérée",
    summary: "Remboursement intégral jusqu'à 7 jours avant l'arrivée, 50 % ensuite.",
  },
  strict: { label: "Stricte", summary: "Remboursement de 50 % jusqu'à 30 jours avant l'arrivée, rien ensuite." },
  custom: { label: "Personnalisé", summary: "Vos propres conditions, rédigées librement." },
};

export const LEGAL_DOC_KINDS = ["cancellation", "cgv", "legalNotice", "privacy"] as const;
export type LegalDocKind = (typeof LEGAL_DOC_KINDS)[number];

export const LEGAL_PAGES: Record<LegalDocKind, { path: string; title: string; short: string }> = {
  cancellation: { path: "/conditions-annulation", title: "Conditions d'annulation", short: "Conditions d'annulation" },
  cgv: { path: "/cgv", title: "Conditions générales de vente", short: "CGV" },
  legalNotice: { path: "/mentions-legales", title: "Mentions légales", short: "Mentions légales" },
  privacy: { path: "/confidentialite", title: "Politique de confidentialité", short: "Confidentialité" },
};

/** Les informations du tenant reprises dans les modèles. */
export type LegalInfo = {
  name: string;
  legalName?: string | null;
  legalForm?: string | null;
  siret?: string | null;
  publicationDirector?: string | null;
  mediator?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  checkInTime?: string | null;
  checkOutTime?: string | null;
};

/** Ce qui est stocké sur le tenant (NULL = le modèle). */
export type LegalSettings = LegalInfo & {
  cancellationLevel: CancellationLevel;
  cancellationText?: string | null;
  cgvText?: string | null;
  legalNoticeText?: string | null;
  privacyText?: string | null;
  legalPublishedAt?: Date | string | null;
};

const FIELD_LABELS: { key: keyof LegalInfo; label: string }[] = [
  { key: "legalName", label: "Raison sociale" },
  { key: "legalForm", label: "Forme juridique" },
  { key: "siret", label: "SIRET" },
  { key: "address", label: "Adresse" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Téléphone" },
  { key: "publicationDirector", label: "Directeur de la publication" },
  { key: "mediator", label: "Médiateur de la consommation" },
];

/** Champs utilisés par les modèles et non renseignés (libellés lisibles par l'hôte). */
export function missingLegalFields(info: LegalInfo): string[] {
  return FIELD_LABELS.filter(({ key }) => !String(info[key] ?? "").trim()).map((f) => f.label);
}

const val = (v: string | null | undefined) => (v ?? "").replace(/\s*\n\s*/g, ", ").trim() || MISSING;

/** SIRET tel qu'affiché : « 123 456 789 00012 », quelle que soit la saisie (espaces ou non). */
function siret(info: LegalInfo) {
  const digits = (info.siret ?? "").replace(/\s+/g, "");
  return /^\d{14}$/.test(digits) ? digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{5})$/, "$1 $2 $3 $4") : val(info.siret);
}

/** « Le Mas (SARL Les Oliviers) » : le nom commercial, et la raison sociale si elle diffère. */
function operator(info: LegalInfo) {
  const legal = info.legalName?.trim();
  return legal && legal !== info.name.trim() ? `${info.name} (${legal})` : info.name;
}

function contactLines(info: LegalInfo) {
  return [`- Adresse : ${val(info.address)}`, `- Email : ${val(info.email)}`, `- Téléphone : ${val(info.phone)}`].join(
    "\n",
  );
}

// ── Conditions d'annulation ─────────────────────────────────────────────────

const CANCELLATION_RULES: Record<Exclude<CancellationLevel, "custom">, string[]> = {
  flexible: [
    "- Annulation jusqu'à la veille de la date d'arrivée (1 jour avant) : remboursement intégral du montant payé.",
    "- Annulation le jour de l'arrivée : aucun remboursement.",
  ],
  moderate: [
    "- Annulation jusqu'à 7 jours avant la date d'arrivée : remboursement intégral du montant payé.",
    "- Annulation moins de 7 jours avant la date d'arrivée, et jusqu'au jour de l'arrivée : remboursement de 50 % du montant payé.",
  ],
  strict: [
    "- Annulation jusqu'à 30 jours avant la date d'arrivée : remboursement de 50 % du montant payé.",
    "- Annulation moins de 30 jours avant la date d'arrivée : aucun remboursement.",
  ],
};

export function cancellationTemplate(level: CancellationLevel, info: LegalInfo): string {
  const rules = CANCELLATION_RULES[level === "custom" ? "moderate" : level];
  return `Les présentes conditions s'appliquent à toute réservation effectuée en ligne auprès de ${operator(info)}. Elles sont acceptées au moment du paiement. Les délais se comptent en jours avant la date d'arrivée prévue, à l'heure de Paris.

## Annulation par le voyageur
${rules.join("\n")}

Pour annuler, écrivez à ${val(info.email)} ou appelez le ${val(info.phone)} en rappelant le nom de la réservation et les dates du séjour. La date de réception de la demande fait foi.

## Non-présentation
Si vous ne vous présentez pas à la date d'arrivée sans avoir annulé, le séjour est dû en totalité : aucun remboursement n'est effectué, hors taxe de séjour.

## Départ anticipé
Un séjour interrompu de votre fait, quelle qu'en soit la raison, ne donne lieu à aucun remboursement des nuits non consommées, hors taxe de séjour.

## Remboursement
Le remboursement est effectué sur le moyen de paiement utilisé lors de la réservation, dans un délai de 14 jours suivant l'annulation. Le délai d'apparition sur votre compte dépend de votre banque (généralement 5 à 10 jours ouvrés).

## Taxe de séjour
La taxe de séjour n'est due que pour les nuits passées dans l'établissement : elle vous est remboursée pour toute nuit annulée ou non consommée.

## Annulation par l'établissement
Si l'établissement doit annuler votre réservation, sauf cas de force majeure, la totalité du montant payé vous est remboursée.`;
}

// ── Conditions générales de vente ───────────────────────────────────────────

export function cgvTemplate(info: LegalInfo): string {
  const hours =
    info.checkInTime || info.checkOutTime
      ? ` Sauf accord préalable, l'arrivée se fait à partir de ${info.checkInTime || MISSING} et le départ avant ${info.checkOutTime || MISSING}.`
      : "";
  return `## Article 1 — Objet
Les présentes conditions générales de vente régissent les réservations d'hébergement effectuées sur ce site auprès de ${operator(info)}, ${val(info.legalForm)}, SIRET ${siret(info)}, dont le siège est situé ${val(info.address)} (ci-après « l'établissement »). Toute réservation implique leur acceptation sans réserve par le voyageur.

## Article 2 — Réservation
Le voyageur choisit ses dates, son ou ses hébergements, le nombre de personnes et les éventuelles options. Un récapitulatif détaillé et le prix total lui sont présentés avant le paiement. La réservation est ferme dès que le paiement est accepté ; une confirmation est alors envoyée par email à l'adresse indiquée. En payant, le voyageur reconnaît avoir pris connaissance des présentes conditions et des conditions d'annulation de l'établissement, et les accepter.

## Article 3 — Prix
Les prix sont indiqués en euros, toutes taxes comprises. Ils comprennent l'hébergement, les frais obligatoires et les options choisies, détaillés avant le paiement. La taxe de séjour est collectée pour le compte de la commune, en sus du prix de l'hébergement ; son montant est indiqué avant le paiement. Une option ajoutée après le paiement se règle sur place.

## Article 4 — Paiement
Le séjour est payé en totalité au moment de la réservation, par carte bancaire, sur la page de paiement sécurisée de notre prestataire Stripe. L'établissement n'a jamais accès aux données de votre carte.

## Article 5 — Absence de droit de rétractation
Conformément à l'article L221-28 12° du Code de la consommation, le droit de rétractation ne s'applique pas aux prestations d'hébergement fournies à une date ou selon une périodicité déterminée. Seules les conditions d'annulation de l'établissement s'appliquent.

## Article 6 — Annulation et modification
Toute annulation par le voyageur est régie par les conditions d'annulation de l'établissement, publiées sur ce site et reproduites en annexe. Une demande de modification (dates, nombre de personnes) est acceptée dans la limite des disponibilités ; à défaut, elle vaut annulation. En cas d'annulation par l'établissement, sauf force majeure, le voyageur est remboursé intégralement.

## Article 7 — Arrivée, départ et capacité
Les horaires d'arrivée et de départ sont rappelés dans l'email de confirmation.${hours} Le voyageur prévient l'établissement en cas d'arrivée tardive. Le nombre de personnes ne peut dépasser la capacité de l'hébergement réservé : l'établissement peut refuser l'accès aux personnes en surnombre, sans remboursement.

## Article 8 — Séjour et responsabilité
Le voyageur s'engage à occuper les lieux paisiblement, à respecter le règlement intérieur éventuel et à rendre l'hébergement en bon état. Toute dégradation qui lui est imputable peut lui être facturée. La responsabilité de l'établissement ne peut être engagée en cas de force majeure ou du fait d'un tiers.

## Article 9 — Réclamations
Toute réclamation est adressée par écrit à l'établissement, de préférence dans les 30 jours suivant la fin du séjour :
${contactLines(info)}

## Article 10 — Médiation de la consommation
Conformément aux articles L612-1 et suivants du Code de la consommation, après une réclamation écrite restée sans réponse satisfaisante dans un délai de deux mois, le voyageur peut recourir gratuitement au médiateur de la consommation dont relève l'établissement : ${val(info.mediator)}.

## Article 11 — Données personnelles
Les données recueillies lors de la réservation sont traitées conformément à la politique de confidentialité publiée sur ce site.

## Article 12 — Droit applicable
Les présentes conditions sont soumises au droit français. À défaut de règlement amiable, tout litige est porté devant la juridiction compétente selon les règles de droit commun ; le voyageur consommateur peut saisir, à son choix, la juridiction du lieu où il demeurait lors de la réservation ou celle du lieu de l'hébergement.`;
}

// ── Mentions légales ────────────────────────────────────────────────────────

export function legalNoticeTemplate(info: LegalInfo): string {
  return `## Éditeur du site
Le site est édité par ${operator(info)}.
- Raison sociale : ${val(info.legalName)}
- Forme juridique : ${val(info.legalForm)}
- SIRET : ${siret(info)}
${contactLines(info)}
- Directeur de la publication : ${val(info.publicationDirector)}

## Hébergement
Le site est hébergé par DirectLoc : ${PLATFORM_HOST_IDENTITY}.

## Propriété intellectuelle
Les textes et photographies de ce site appartiennent à l'établissement ou sont utilisés avec l'accord de leurs auteurs. Toute reproduction sans autorisation est interdite.

## Données personnelles
Le traitement des données personnelles des voyageurs est décrit dans la politique de confidentialité publiée sur ce site.`;
}

// ── Politique de confidentialité ────────────────────────────────────────────

export function privacyTemplate(info: LegalInfo): string {
  return `## Responsable du traitement
Les données personnelles recueillies sur ce site sont traitées par ${operator(info)}, ${val(info.legalForm)}, SIRET ${siret(info)}.
${contactLines(info)}

## Données collectées
- Identité : nom et prénom.
- Coordonnées : adresse email, téléphone, adresse postale et pays.
- Séjour : dates, hébergements, nombre de voyageurs dont mineurs, options choisies et demandes particulières.
- Paiement : montant, statut et référence du paiement. Le paiement par carte est traité par Stripe : ni l'établissement ni DirectLoc n'ont accès au numéro de votre carte.

## Finalités et bases légales
- Gérer votre réservation et votre séjour (confirmation, rappel avant l'arrivée, accueil) : exécution du contrat.
- Encaisser le paiement, effectuer les remboursements et traiter les contestations : exécution du contrat et intérêt légitime de l'établissement.
- Tenir la comptabilité et reverser la taxe de séjour à la commune : obligation légale.
- Vous remercier après votre séjour et vous inviter à donner votre avis : intérêt légitime de l'établissement.
- Mesurer l'audience du site, uniquement avec votre accord : consentement.

## Durées de conservation
- Données de réservation : pendant la relation commerciale, puis 5 ans à compter de la fin du séjour (prescription des actions en justice).
- Pièces comptables : 10 ans, comme l'exige le Code de commerce.
- Mesure d'audience : cookies conservés 13 mois au plus, données de mesure 25 mois au plus.

## Destinataires
Vos données sont destinées à l'établissement. Elles sont aussi traitées, pour son compte et dans la limite de leur mission, par :
- Stripe, prestataire de paiement (Stripe Payments Europe, Irlande) ;
- le prestataire d'envoi des emails liés à votre réservation ;
- DirectLoc, éditeur du logiciel de réservation et hébergeur du site ;
- PostHog, outil de mesure d'audience hébergé dans l'Union européenne, seulement si vous l'acceptez.
Certains de ces prestataires peuvent transférer des données hors de l'Union européenne ; ces transferts sont encadrés par des garanties appropriées (clauses contractuelles types de la Commission européenne ou décision d'adéquation). Vos données ne sont jamais vendues.

## Cookies et mesure d'audience
La réservation ne dépose aucun cookie publicitaire. Avec votre accord, donné dans le bandeau affiché à votre première visite, l'outil PostHog dépose des cookies pour mesurer la fréquentation du site et peut enregistrer anonymement certaines navigations (les saisies dans les formulaires sont masquées). Si vous refusez, les visites sont comptées de façon anonyme, sans cookie. Vous pouvez changer d'avis en effaçant les cookies de ce site dans votre navigateur.

## Vos droits
Vous disposez d'un droit d'accès, de rectification, d'effacement, de limitation, d'opposition et de portabilité de vos données, ainsi que du droit de définir des directives sur leur sort après votre décès. Pour les exercer, écrivez à ${val(info.email)}. Si vous estimez, après nous avoir contactés, que vos droits ne sont pas respectés, vous pouvez adresser une réclamation à la CNIL (www.cnil.fr).`;
}

// ── Résolution : texte de l'hôte ou modèle ─────────────────────────────────

/** Le modèle d'un document, rempli avec les informations du tenant. */
export function templateFor(kind: LegalDocKind, info: LegalInfo, level: CancellationLevel = "moderate"): string {
  switch (kind) {
    case "cancellation":
      return cancellationTemplate(level, info);
    case "cgv":
      return cgvTemplate(info);
    case "legalNotice":
      return legalNoticeTemplate(info);
    case "privacy":
      return privacyTemplate(info);
  }
}

const STORED: Record<Exclude<LegalDocKind, "cancellation">, "cgvText" | "legalNoticeText" | "privacyText"> = {
  cgv: "cgvText",
  legalNotice: "legalNoticeText",
  privacy: "privacyText",
};

/**
 * Le texte d'un document tel qu'il s'affiche : celui de l'hôte s'il l'a modifié, sinon le modèle.
 * Conditions d'annulation : le modèle du niveau choisi, ou le texte libre en « Personnalisé ».
 */
export function documentText(kind: LegalDocKind, s: LegalSettings): string {
  if (kind === "cancellation") {
    return s.cancellationLevel === "custom" && s.cancellationText?.trim()
      ? s.cancellationText
      : cancellationTemplate(s.cancellationLevel, s);
  }
  return s[STORED[kind]]?.trim() ? s[STORED[kind]]! : templateFor(kind, s);
}

export const CGV_ANNEX_HEADING = "Annexe : conditions d'annulation";

/** Les CGV incluent toujours les conditions d'annulation en vigueur (en annexe). */
export function cgvWithAnnex(s: LegalSettings): string {
  return `${documentText("cgv", s)}\n\n## ${CGV_ANNEX_HEADING}\n${documentText("cancellation", s)}`;
}

/** Le texte publié d'une page (les CGV avec leur annexe). */
export function publishedText(kind: LegalDocKind, s: LegalSettings): string {
  return kind === "cgv" ? cgvWithAnnex(s) : documentText(kind, s);
}

/** Copie posée sur le Dossier au paiement (preuve d'acceptation), ou rien si non publiés. */
export function acceptedTerms(s: LegalSettings, now: Date = new Date()) {
  if (!s.legalPublishedAt) return null;
  return {
    cancellationLevel: s.cancellationLevel,
    acceptedCancellationText: documentText("cancellation", s),
    acceptedCgvText: cgvWithAnnex(s),
    termsAcceptedAt: now,
  };
}

// ── Rendu en texte simple ───────────────────────────────────────────────────

export type LegalBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

/** Texte simple → blocs (titres « ## », listes « - », paragraphes). Jamais de HTML. */
export function parseLegalText(text: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", text: para.join("\n") });
    if (list.length) blocks.push({ type: "list", items: list });
    para = [];
    list = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (/^#{1,3}\s+/.test(line)) {
      flush();
      blocks.push({ type: "heading", text: line.replace(/^#{1,3}\s+/, "") });
    } else if (/^[-•*]\s+/.test(line)) {
      if (para.length) {
        blocks.push({ type: "paragraph", text: para.join("\n") });
        para = [];
      }
      list.push(line.replace(/^[-•*]\s+/, ""));
    } else {
      if (list.length) {
        blocks.push({ type: "list", items: list });
        list = [];
      }
      para.push(line);
    }
  }
  flush();
  return blocks;
}

// ── Suggestion de remboursement (issue 02) ─────────────────────────────────

const DAY_MS = 86_400_000;

type Tier = { minDays: number; percent: number };
const TIERS: Record<Exclude<CancellationLevel, "custom">, Tier[]> = {
  flexible: [{ minDays: 1, percent: 100 }],
  moderate: [
    { minDays: 7, percent: 100 },
    { minDays: 0, percent: 50 },
  ],
  strict: [{ minDays: 30, percent: 50 }],
};

export type RefundSuggestion = {
  /** Montant suggéré, en centimes. */
  amount: number;
  percent: number;
  /** Nombre de jours entre la date d'annulation (à Paris) et l'arrivée ; négatif après l'arrivée. */
  daysBefore: number;
  /** « 50 % selon vos conditions (modérée, moins de 7 jours) ». */
  label: string;
};

/**
 * Remboursement suggéré par les conditions d'annulation : `amount` en centimes, `checkIn`
 * date domaine (UTC minuit), `cancelledAt` un instant, ramené au jour calendaire de Paris.
 * Les bornes sont inclusives (« jusqu'à 7 jours avant » : J-7 compris).
 * Après l'arrivée (départ anticipé, non-présentation) : 0. Conditions personnalisées → null.
 */
export function suggestedRefund(
  level: CancellationLevel,
  checkIn: Date,
  cancelledAt: Date,
  amount: number,
): RefundSuggestion | null {
  if (level === "custom") return null;
  const daysBefore = Math.round((checkIn.getTime() - todayStart(cancelledAt).getTime()) / DAY_MS);
  const tiers = TIERS[level];
  const tier = daysBefore >= 0 ? tiers.find((t) => daysBefore >= t.minDays) : undefined;
  const percent = tier?.percent ?? 0;
  const name = CANCELLATION_LEVEL_INFO[level].label.toLowerCase();
  const first = tiers[0].minDays;
  const when =
    daysBefore < 0
      ? "après l'arrivée"
      : level === "flexible"
        ? tier
          ? "jusqu'à la veille de l'arrivée"
          : "le jour de l'arrivée"
        : tier === tiers[0]
          ? `${first} jours ou plus avant l'arrivée`
          : `moins de ${first} jours`;
  return {
    amount: Math.round((amount * percent) / 100),
    percent,
    daysBefore,
    label: `${percent} % selon vos conditions (${name}, ${when})`,
  };
}

/** Mention sous le bouton de paiement : rien tant que les documents ne sont pas publiés. */
export function paymentTerms(s: Pick<LegalSettings, "legalPublishedAt" | "cancellationLevel">) {
  if (!s.legalPublishedAt) return null;
  return { summary: s.cancellationLevel === "custom" ? null : CANCELLATION_LEVEL_INFO[s.cancellationLevel].summary };
}
