import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { formatEuros } from "@/lib/utils";
import { isUuid } from "@/lib/validation";
import { isDemoTenant } from "@/lib/demo";
import { getDossierForAdmin } from "@/lib/queries/dossiers";
import { disputeEvidenceFor, latestDossierDispute } from "@/lib/disputes";
import { EVIDENCE_FIELDS, canRespond, disputeIsFinal, disputeReasonFr } from "@/lib/dispute-evidence";
import { DisputeResponseForm } from "@/components/admin/DisputeForms";
import { StatusBanner } from "@/components/admin/ui";
import { disputeDay, disputeStripeUrl } from "@/lib/dispute-display";

export const metadata = { title: "Litige" };

/**
 * Réponse à un litige (issue 04) : preuves texte préremplies depuis le Dossier, brouillon puis
 * envoi définitif à la banque. Après envoi, ou date limite dépassée : lecture seule.
 */
export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tenantId } = await requireSession();
  if (!isUuid(id)) notFound();
  const [found, dispute] = await Promise.all([getDossierForAdmin(id, tenantId), latestDossierDispute(tenantId, id)]);
  if (!found || !dispute) notFound();
  const { dossier } = found;
  const evidence = await disputeEvidenceFor(tenantId, dispute);
  const open = canRespond(dispute);
  const stripeUrl = disputeStripeUrl(dispute.stripeDisputeId, await isDemoTenant(tenantId));

  return (
    <div className="space-y-5 max-w-2xl admin-fade-in" data-dispute-page>
      <Link
        href={`/admin/dossiers/${dossier.id}`}
        className="inline-flex items-center min-h-[44px] -my-2 text-[13px] font-semibold"
        style={{ color: "var(--admin-text-muted)" }}
      >
        ← Dossier de {dossier.guestName}
      </Link>
      <header className="space-y-2">
        <p className="text-[12px] font-bold uppercase" style={{ color: "var(--admin-danger)", letterSpacing: "0.06em" }}>
          Litige · {formatEuros(dispute.amount)}
        </p>
        <h1 className="text-[24px] font-extrabold leading-tight break-words" style={{ color: "var(--admin-text)", letterSpacing: "-0.6px" }}>
          Répondre à la banque
        </h1>
        <p className="text-[13.5px] leading-[1.5]" style={{ color: "var(--admin-text-muted)" }}>
          Motif : {disputeReasonFr(dispute.reason)}.
          {dispute.evidenceDueBy && <> Réponse avant le {disputeDay(dispute.evidenceDueBy, true)}.</>}
        </p>
      </header>

      {open ? (
        <p className="text-[13px] leading-[1.55]" style={{ color: "var(--admin-text-muted)" }}>
          Relisez et complétez ces preuves : elles sont préremplies à partir du Dossier. Le brouillon s&apos;enregistre
          aussi chez Stripe ; rien ne part à la banque avant « Envoyer à la banque ».
        </p>
      ) : (
        <StatusBanner variant={dispute.submittedAt ? "info" : "error"}>
          <span data-dispute-readonly>
            {dispute.submittedAt
              ? `Réponse envoyée à la banque le ${disputeDay(dispute.submittedAt, true)} : elle ne se modifie plus. La banque décide, souvent en 2 à 3 mois.`
              : disputeIsFinal(dispute.status)
                ? "Ce litige est clos : la réponse ne se modifie plus."
                : `Date limite dépassée${dispute.evidenceDueBy ? ` (${disputeDay(dispute.evidenceDueBy, true)})` : ""} : la réponse ne peut plus être envoyée.`}
          </span>
        </StatusBanner>
      )}

      <p className="text-[13px]">
        <a
          href={stripeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 font-semibold"
          style={{ color: "var(--admin-primary)" }}
          data-dispute-stripe-link
        >
          Ajouter des fichiers sur Stripe
        </a>{" "}
        <span style={{ color: "var(--admin-text-subtle)" }}>(photos, échanges avec le voyageur : dans votre tableau de bord Stripe)</span>
      </p>

      <section
        className="p-4 sm:p-5"
        style={{ background: "var(--admin-surface)", border: "1px solid var(--admin-border)", borderRadius: "var(--admin-radius)" }}
      >
        {open ? (
          <DisputeResponseForm dossierId={dossier.id} disputeId={dispute.id} evidence={evidence} />
        ) : (
          <dl className="space-y-3" data-dispute-evidence-readonly>
            {EVIDENCE_FIELDS.filter((f) => evidence[f.key]).map((f) => (
              <div key={f.key}>
                <dt className="text-[12px] font-bold uppercase" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
                  {f.label}
                </dt>
                <dd className="text-[13px] leading-[1.5] whitespace-pre-line break-words mt-1" style={{ color: "var(--admin-text)" }}>
                  {evidence[f.key]}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  );
}
