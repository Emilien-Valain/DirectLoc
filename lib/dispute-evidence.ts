/**
 * Litiges, partie pure (issue 04) : statuts et motifs Stripe en français, champs de preuves
 * texte proposés à l'hôte, et leur préremplissage à partir du Dossier. Aucun accès base ni Stripe.
 *
 * Champs evidence Stripe retenus pour un hébergement. `cancellation_policy` et `refund_policy`
 * sont des fichiers chez Stripe : le texte des conditions va dans les `*_disclosure` (texte).
 */

export const EVIDENCE_FIELDS = [
  { key: "product_description", label: "Séjour vendu", hint: "Séjour, dates, chambres, montant.", rows: 5 },
  { key: "customer_name", label: "Nom du voyageur", rows: 1 },
  { key: "customer_email_address", label: "Email du voyageur", rows: 1 },
  { key: "service_date", label: "Dates du séjour", rows: 1 },
  {
    key: "cancellation_policy_disclosure",
    label: "Conditions d'annulation acceptées",
    hint: "Texte exact accepté par le voyageur au paiement, avec la date.",
    rows: 8,
  },
  { key: "refund_policy_disclosure", label: "Politique de remboursement", rows: 4 },
  {
    key: "refund_refusal_explanation",
    label: "Pourquoi le paiement n'a pas été remboursé",
    hint: "À compléter : expliquez à la banque pourquoi le voyageur n'a pas droit au remboursement.",
    rows: 4,
  },
  {
    key: "access_activity_log",
    label: "Historique de la réservation",
    hint: "Date de réservation, paiement, confirmation envoyée, remboursements déjà faits.",
    rows: 5,
  },
  { key: "uncategorized_text", label: "Autres informations", hint: "Échanges avec le voyageur, arrivée constatée…", rows: 4 },
] as const;

export type EvidenceKey = (typeof EVIDENCE_FIELDS)[number]["key"];
export type Evidence = Partial<Record<EvidenceKey, string>>;

/** Stripe : 20 000 caractères par champ texte (150 000 au total). */
export const EVIDENCE_MAX = 20_000;
const SHORT_FIELDS = new Set<EvidenceKey>(["customer_name", "customer_email_address", "service_date"]);
const SHORT_MAX = 500;

/** Ne garde que les champs connus, en texte, coupés à la longueur permise par Stripe. */
export function cleanEvidence(input: Record<string, unknown>): Evidence {
  const out: Evidence = {};
  for (const { key } of EVIDENCE_FIELDS) {
    const v = input[key];
    if (typeof v !== "string") continue;
    const t = v.replace(/\r\n/g, "\n").trim();
    if (t) out[key] = t.slice(0, SHORT_FIELDS.has(key) ? SHORT_MAX : EVIDENCE_MAX);
  }
  return out;
}

const OPEN = new Set(["warning_needs_response", "needs_response", "warning_under_review", "under_review"]);
const NEEDS_RESPONSE = new Set(["warning_needs_response", "needs_response"]);
const FINAL = new Set(["won", "lost", "warning_closed", "prevented"]);

export const disputeIsOpen = (status: string) => OPEN.has(status);
export const disputeIsFinal = (status: string) => FINAL.has(status);

/** Ordre des statuts : un événement en retard ne fait jamais reculer un litige (réponse → examen → clos). */
function rank(status: string) {
  if (FINAL.has(status)) return 2;
  if (status === "under_review" || status === "warning_under_review") return 1;
  return 0;
}
export function nextDisputeStatus(current: string, incoming: string): string {
  return rank(incoming) >= rank(current) ? incoming : current;
}

/** L'hôte peut encore répondre (ou accepter) : en attente de réponse, rien envoyé, date limite pas passée. */
export function canRespond(d: { status: string; submittedAt: Date | null; evidenceDueBy: Date | null }, now = new Date()) {
  return NEEDS_RESPONSE.has(d.status) && !d.submittedAt && (!d.evidenceDueBy || new Date(d.evidenceDueBy) > now);
}

export const DISPUTE_REASONS: Record<string, string> = {
  bank_cannot_process: "la banque ne peut pas traiter le paiement",
  check_returned: "chèque refusé",
  credit_not_processed: "remboursement promis non reçu",
  customer_initiated: "contesté par le client",
  debit_not_authorized: "prélèvement non autorisé",
  duplicate: "paiement en double",
  fraudulent: "fraude : le titulaire de la carte ne reconnaît pas le paiement",
  general: "motif non précisé",
  incorrect_account_details: "coordonnées bancaires incorrectes",
  insufficient_funds: "provision insuffisante",
  noncompliant: "paiement non conforme aux règles du réseau",
  product_not_received: "séjour non fourni",
  product_unacceptable: "séjour non conforme à la description",
  subscription_canceled: "abonnement résilié",
  unrecognized: "paiement non reconnu",
};
export const disputeReasonFr = (reason: string) => DISPUTE_REASONS[reason] ?? "motif non précisé";

const fr = (d: Date, opts: Intl.DateTimeFormatOptions = {}) =>
  new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC", ...opts });
const frParis = (d: Date) =>
  new Date(d).toLocaleString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });
const eur = (n: number) => `${n.toFixed(2).replace(".", ",").replace(",00", "")} €`;

export type EvidenceSource = {
  hotelName: string;
  guestName: string;
  guestEmail: string;
  checkIn: Date;
  checkOut: Date;
  bookedAt: Date | null;
  rooms: { name: string; total: number; cancelled: boolean }[];
  paidAmount: number;
  paidAt: Date | null;
  confirmed: boolean;
  termsAcceptedAt: Date | null;
  cancellationText: string | null;
  cgvText: string | null;
  refunds: { amount: number; at: Date; status: string }[];
};

/** Preuves préremplies à partir du Dossier ; l'hôte les relit et les complète avant l'envoi. */
export function defaultEvidence(s: EvidenceSource): Evidence {
  const nights = Math.round((new Date(s.checkOut).getTime() - new Date(s.checkIn).getTime()) / 86_400_000);
  const rooms = s.rooms
    .map((r) => `- ${r.name} : ${eur(r.total)}${r.cancelled ? " (chambre annulée)" : ""}`)
    .join("\n");
  const log = [
    s.bookedAt && `Réservation faite en ligne le ${frParis(s.bookedAt)} sur le site de ${s.hotelName}.`,
    s.termsAcceptedAt && `Conditions d'annulation et CGV acceptées au paiement le ${frParis(s.termsAcceptedAt)}.`,
    s.paidAt && `Paiement en ligne de ${eur(s.paidAmount)} le ${frParis(s.paidAt)}.`,
    s.confirmed && `Confirmation de réservation envoyée par email à ${s.guestEmail} après le paiement.`,
    ...s.refunds
      .filter((r) => r.status !== "failed")
      .map((r) => `Remboursement de ${eur(r.amount)} le ${fr(r.at)}${r.status === "pending" ? " (en cours)" : ""}.`),
  ].filter(Boolean);
  return cleanEvidence({
    product_description:
      `Séjour à ${s.hotelName} du ${fr(s.checkIn)} au ${fr(s.checkOut)} (${nights} nuit${nights > 1 ? "s" : ""}).\n` +
      `Chambres :\n${rooms}\nMontant payé en ligne : ${eur(s.paidAmount)}.`,
    customer_name: s.guestName,
    customer_email_address: s.guestEmail,
    service_date: `${fr(s.checkIn)} – ${fr(s.checkOut)}`,
    cancellation_policy_disclosure: s.cancellationText
      ? `Conditions d'annulation acceptées par le voyageur au paiement${s.termsAcceptedAt ? ` le ${frParis(s.termsAcceptedAt)}` : ""} (mention « En payant, vous acceptez les conditions d'annulation et les CGV » sous le bouton de paiement, avec un lien vers le texte) :\n\n${s.cancellationText}`
      : "",
    refund_policy_disclosure: s.cancellationText
      ? "Les remboursements suivent les conditions d'annulation ci-dessus, acceptées avant le paiement."
      : "",
    access_activity_log: log.join("\n"),
  });
}
