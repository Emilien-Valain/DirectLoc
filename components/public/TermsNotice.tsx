import { LEGAL_PAGES } from "@/lib/legal-documents";

/** Sous le bouton de paiement : payer vaut acceptation (liens, pas de case à cocher). */
export default function TermsNotice({ summary }: { summary: string | null }) {
  return (
    <p className="s-terms" data-testid="booking-terms">
      En payant, vous acceptez les{" "}
      <a href={LEGAL_PAGES.cancellation.path} target="_blank" rel="noopener">
        conditions d&apos;annulation
      </a>{" "}
      et les{" "}
      <a href={LEGAL_PAGES.cgv.path} target="_blank" rel="noopener">
        CGV
      </a>{" "}
      de l&apos;établissement.
      {summary && <> Annulation : {summary.charAt(0).toLowerCase() + summary.slice(1)}</>}
    </p>
  );
}
