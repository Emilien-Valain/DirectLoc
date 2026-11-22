import { formatEuros } from "@/lib/utils";
import { canRespond, disputeIsOpen } from "@/lib/dispute-evidence";

/** Affichage des litiges dans l'admin (bandeau de la fiche Dossier, page « Répondre »). */

/** « 05/03 » ou « 05/03/2037 », heure de Paris. */
export const disputeDay = (d: Date, withYear = false) =>
  new Date(d).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "Europe/Paris",
  });

/** Le litige dans le tableau de bord Stripe de l'hôte (connecté à son propre compte) ; démo : mode test. */
export const disputeStripeUrl = (stripeDisputeId: string, test: boolean) =>
  `https://dashboard.stripe.com/${test ? "test/" : ""}disputes/${encodeURIComponent(stripeDisputeId)}`;

/** Un litige gagné reste affiché 30 jours après sa clôture, puis disparaît. */
const WON_VISIBLE_MS = 30 * 86_400_000;

type D = { amount: string; status: string; submittedAt: Date | null; evidenceDueBy: Date | null; closedAt: Date | null };

/** Bandeau de la fiche Dossier pour ce litige ; `null` : plus rien à montrer. */
export function disputeBanner(d: D, now = new Date()): { variant: "error" | "success"; text: string; open: boolean } | null {
  const amount = formatEuros(d.amount);
  if (disputeIsOpen(d.status)) {
    const text = d.submittedAt
      ? `Litige en cours : ${amount}, réponse envoyée le ${disputeDay(d.submittedAt)} ; la banque décide.`
      : canRespond(d, now)
        ? `Litige en cours : ${amount}, réponse avant le ${disputeDay(d.evidenceDueBy ?? now)}.`
        : `Litige en cours : ${amount}, date limite de réponse dépassée${d.evidenceDueBy ? ` (${disputeDay(d.evidenceDueBy)})` : ""}.`;
    return { variant: "error", text, open: true };
  }
  if (d.status === "lost") return { variant: "error", text: `Litige perdu : ${amount} repris par la banque.`, open: false };
  const closed = d.closedAt ? new Date(d.closedAt).getTime() : now.getTime();
  if (now.getTime() - closed > WON_VISIBLE_MS) return null;
  if (d.status === "won") return { variant: "success", text: `Litige gagné : ${amount} vous restent acquis.`, open: false };
  return { variant: "success", text: `Litige clos : rien n'est repris sur ${amount}.`, open: false };
}
