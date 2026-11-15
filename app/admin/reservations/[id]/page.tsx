import { formatEuros } from "@/lib/utils";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import {
  getBookingByIdAndTenant,
  getLatestPayment,
  completeFinishedStays,
} from "@/lib/queries/bookings";
import { confirmBooking, cancelBooking, setBookingPaid } from "@/lib/actions/bookings";
import ReservationPdfActions from "@/components/admin/ReservationPdfActions";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { openCheckoutDeadline } from "@/lib/checkout-window";
import { HOTEL_TIME_ZONE } from "@/lib/date-windows";
import { getBookingLines } from "@/lib/queries/extras";
import { balanceDue, grandTotal } from "@/lib/extras";
import { ChannelTag, PrimaryButton, StatusBadge, StatusBanner } from "@/components/admin/ui";

// Statut du paiement en ligne → libellé hôte + couleur de badge (palette des statuts).
const PAYMENT_LABEL: Record<string, { label: string; tone: string }> = {
  paid: { label: "Payé en ligne", tone: "confirmed" },
  pending: { label: "Paiement en cours", tone: "pending" },
  failed: { label: "Paiement échoué", tone: "cancelled" },
  expired: { label: "Paiement non abouti", tone: "cancelled" },
  refunded: { label: "Remboursé", tone: "completed" },
};

export const metadata = { title: "Réservation" };

export default async function ReservationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ enregistree?: string; annulee?: string; modifiee?: string }>;
}) {
  const { id } = await params;
  const { enregistree, annulee, modifiee } = await searchParams;
  const { tenantId } = await requireSession();
  await completeFinishedStays(tenantId);
  const [reservation, payment] = await Promise.all([
    getBookingByIdAndTenant(id, tenantId),
    getLatestPayment(id, tenantId),
  ]);
  if (!reservation) notFound();
  const extraLines = await getBookingLines(id);
  const paidOnline = payment?.status === "paid" ? parseFloat(payment.amount) : 0;
  // Reste à payer : Extras ajoutés après le paiement en ligne, réglés sur place (ADR-0010).
  const balance =
    reservation.status === "cancelled" ? 0 : balanceDue(parseFloat(reservation.totalPrice), paidOnline, reservation.paidAt);
  // Annulée alors que l'argent est encaissé (annulation par l'hôte, ou paiement
  // arrivé après l'annulation via le webhook) : DirectLoc ne rembourse jamais seul.
  const paidAfterCancel = reservation.status === "cancelled" && payment?.status === "paid";
  const paymentInfo = paidAfterCancel
    ? { label: "Payé, à rembourser", tone: "cancelled" }
    : payment
      ? PAYMENT_LABEL[payment.status]
      : undefined;

  // Session Stripe encore ouverte : le webhook `expired` tranchera seul, l'hôte n'a rien à faire.
  const checkoutDeadline = openCheckoutDeadline(payment);

  const nights = Math.ceil(
    (new Date(reservation.checkOut).getTime() -
      new Date(reservation.checkIn).getTime()) /
      (1000 * 60 * 60 * 24),
  );

  return (
    <div className="space-y-6 max-w-2xl admin-fade-in">
      <Link
        href="/admin/reservations"
        className="inline-block text-[13px] font-semibold transition-colors"
        style={{ color: "var(--admin-text-muted)" }}
      >
        ← Réservations
      </Link>

      <div className="flex items-center gap-3 flex-wrap">
        <h1
          className="text-[24px] font-extrabold leading-tight"
          style={{ color: "var(--admin-text)", letterSpacing: "-0.6px" }}
        >
          {reservation.guestName}
        </h1>
        <StatusBadge status={reservation.status} />
      </div>

      {paidAfterCancel && (
        <StatusBanner variant="error">
          {reservation.guestName} a payé {formatEuros(payment.amount)} en ligne et la réservation est annulée :
          l&apos;argent n&apos;est pas rendu automatiquement. Remboursez-le depuis votre tableau de bord Stripe
          {payment.stripePaymentId ? ` (paiement ${payment.stripePaymentId})` : ""}.
        </StatusBanner>
      )}

      {/* Retour après action : l'hôte sait que c'est fait, et ce qui en découle. */}
      <div role="status">
        {enregistree && (
          <StatusBanner variant="success">
            Réservation enregistrée. Ces nuits ne sont plus proposées sur votre site.
          </StatusBanner>
        )}
        {annulee === "1" && (
          <StatusBanner variant="success">
            Réservation annulée. Un email d&apos;annulation a été envoyé à {reservation.guestEmail}.
          </StatusBanner>
        )}
        {modifiee === "1" && (
          <StatusBanner variant="success">
            Réservation modifiée. Le nouveau récapitulatif a été envoyé à {reservation.guestEmail}.
          </StatusBanner>
        )}
        {modifiee === "silence" && (
          <StatusBanner variant="success">Réservation modifiée. Aucun email envoyé au client.</StatusBanner>
        )}
        {modifiee === "sans-email" && (
          <StatusBanner variant="warning">
            Réservation modifiée, mais l&apos;email n&apos;a pas pu partir : prévenez{" "}
            {reservation.guestName} directement.
          </StatusBanner>
        )}
        {annulee === "sans-email" && (
          <StatusBanner variant="warning">
            Réservation annulée, mais l&apos;email n&apos;a pas pu partir : prévenez{" "}
            {reservation.guestName} directement.
          </StatusBanner>
        )}
      </div>

      {/* La décision d'abord (confirmer, modifier, annuler), le détail ensuite, les documents à la fin. */}
      {reservation.status === "pending" && (
        // « En attente » seul ne dit pas quoi faire : on nomme ce qui se passe et ce que fait « Confirmer ».
        <div
          data-pending-explainer
          className="rounded-[var(--admin-radius)] px-5 py-4"
          style={{ background: "#FEF9C3", border: "1px solid #FCD34D", color: "#92400E" }}
        >
          {checkoutDeadline ? (
            <>
              <p className="text-[13.5px] font-bold">Paiement en ligne en cours</p>
              <p className="text-[12.5px] leading-[1.5] mt-1">
                {reservation.guestName} est en train de payer. Sans paiement avant{" "}
                {checkoutDeadline.toLocaleTimeString("fr-FR", { timeZone: HOTEL_TIME_ZONE, hour: "2-digit", minute: "2-digit" })},
                la réservation sera annulée automatiquement et les nuits libérées.
              </p>
            </>
          ) : (
            <>
              <p className="text-[13.5px] font-bold">Pas encore confirmée : aucun paiement en ligne n&apos;est arrivé</p>
              <p className="text-[12.5px] leading-[1.5] mt-1">
                Les nuits restent bloquées pour {reservation.guestName}. Confirmez seulement si vous avez convenu
                d&apos;un autre règlement (sur place, virement, chèques-vacances). Confirmer n&apos;envoie pas
                d&apos;email au client.
              </p>
            </>
          )}
        </div>
      )}

      {(reservation.status === "pending" || reservation.status === "confirmed") && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex flex-wrap items-center gap-3">
            {reservation.status === "pending" && (
              <form action={confirmBooking.bind(null, id)}>
                <PrimaryButton type="submit" icon={null}>
                  Confirmer
                </PrimaryButton>
              </form>
            )}
            {/* Pendant un paiement en ligne, le prix ne doit pas bouger : la modification attend. */}
            {checkoutDeadline ? (
              <p className="text-[12.5px]" style={{ color: "var(--admin-text-subtle)" }}>
                Modifiable une fois le paiement en ligne terminé ou expiré.
              </p>
            ) : (
              <Link href={`/admin/reservations/${id}/modifier`} className="admin-btn admin-btn--ghost">
                Modifier
              </Link>
            )}
            {reservation.status === "confirmed" && (
              <p className="text-[12.5px]" style={{ color: "var(--admin-text-subtle)" }}>
                Passera automatiquement en « Terminée » après le départ.
              </p>
            )}
          </div>
          <ConfirmButton
            title={`Annuler la réservation de ${reservation.guestName} ?`}
            message={
              <>
                La chambre sera libérée et un email d&apos;annulation sera envoyé à{" "}
                <strong style={{ color: "var(--admin-text)" }}>{reservation.guestEmail}</strong>.
                Cette action est définitive.
                {/* La vraie question de l'hôte : y a-t-il de l'argent à rendre ? */}
                <span
                  data-refund-note
                  className="block mt-3 px-3 py-2 rounded-lg text-[12.5px] leading-[1.5]"
                  style={
                    payment?.status === "paid"
                      ? { background: "#FEF3C7", color: "#92400E" }
                      : { background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }
                  }
                >
                  {payment?.status === "paid" ? (
                    <>
                      <strong>{reservation.guestName} a payé {formatEuros(payment.amount)} en ligne.</strong>{" "}
                      L&apos;annulation ne le rembourse pas : faites-le depuis votre tableau de bord Stripe.
                    </>
                  ) : reservation.paidAt ? (
                    <>
                      Vous avez noté un règlement le{" "}
                      {new Date(reservation.paidAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: HOTEL_TIME_ZONE })} :
                      remboursez-le vous-même si nécessaire.
                    </>
                  ) : (
                    "Aucun paiement à rembourser."
                  )}
                </span>
              </>
            }
            cancelLabel="Garder"
            confirmLabel="Annuler la réservation"
            onConfirm={cancelBooking.bind(null, id)}
            style={{
              padding: "9px 18px",
              background: "transparent",
              color: "var(--admin-danger)",
              border: "1px solid #FCA5A5",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Annuler la réservation
          </ConfirmButton>
        </div>
      )}

      <div
        style={{
          background: "var(--admin-surface)",
          border: "1px solid var(--admin-border)",
          borderRadius: "var(--admin-radius)",
        }}
      >
        <Section label="Séjour">
          <Row label="Chambre" value={reservation.room?.name ?? "—"} />
          <Row
            label="Arrivée"
            value={new Date(reservation.checkIn).toLocaleDateString("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })}
          />
          <Row
            label="Départ"
            value={new Date(reservation.checkOut).toLocaleDateString("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })}
          />
          <Row label="Durée" value={`${nights} nuit${nights > 1 ? "s" : ""}`} />
          <Row
            label="Voyageurs"
            value={`${reservation.guestCount} personne${reservation.guestCount > 1 ? "s" : ""}${reservation.childCount > 0 ? ` dont ${reservation.childCount} enfant${reservation.childCount > 1 ? "s" : ""}` : ""}`}
          />
        </Section>

        <Section label="Client">
          <Row label="Nom" value={reservation.guestName} />
          <Row
            label="Email"
            value={<ContactLink href={`mailto:${reservation.guestEmail}`}>{reservation.guestEmail}</ContactLink>}
          />
          {reservation.guestPhone && (
            <Row
              label="Téléphone"
              value={
                <ContactLink href={`tel:${reservation.guestPhone.replace(/[^\d+]/g, "")}`}>
                  {reservation.guestPhone}
                </ContactLink>
              }
            />
          )}
        </Section>

        <Section label="Paiement">
          {extraLines.length > 0 && (
            <>
              <Row
                label="Hébergement"
                value={formatEuros(grandTotal(parseFloat(reservation.totalPrice), extraLines.map((l) => ({ total: -l.total }))))}
              />
              {extraLines.map((l) => (
                <Row
                  key={l.id}
                  // Taxe en % : prix moyen arrondi, le détail « q × prix » ne tomberait pas juste.
                  label={l.kind !== "tax" && l.quantity > 1 ? `${l.label} (${l.quantity} × ${formatEuros(l.unitPrice)})` : l.label}
                  value={l.exempt ? "Exonérée" : l.total === 0 ? "Offert" : formatEuros(l.total)}
                />
              ))}
            </>
          )}
          <Row label="Total" value={formatEuros(reservation.totalPrice)} />
          {balance > 0 && (
            <Row
              label="Reste à payer"
              value={
                <span className="inline-flex items-center gap-2 flex-wrap justify-end" data-balance-due>
                  <span style={{ color: "#92400E" }}>
                    Payé {formatEuros(paidOnline)} en ligne · reste {formatEuros(balance)}
                  </span>
                  <form action={setBookingPaid.bind(null, id, true)}>
                    <button
                      type="submit"
                      className="admin-btn"
                      style={{ padding: "5px 10px", fontSize: 12.5, color: "var(--admin-primary)", background: "var(--admin-primary-light)", border: "none" }}
                    >
                      Marquer réglé
                    </button>
                  </form>
                </span>
              }
            />
          )}
          <Row
            label="Règlement"
            value={
              paymentInfo && !(reservation.paidAt && paidOnline > 0 && reservation.status !== "cancelled") ? (
                <StatusBadge status={paymentInfo.tone} label={paymentInfo.label} />
              ) : reservation.paidAt ? (
                <span className="inline-flex items-center gap-2">
                  <StatusBadge
                    status="confirmed"
                    label={`Réglé le ${new Date(reservation.paidAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: HOTEL_TIME_ZONE })}`}
                  />
                  <form action={setBookingPaid.bind(null, id, false)}>
                    {/* « Annuler » ici se confondait avec « Annuler la réservation » plus bas. */}
                    <button type="submit" className="text-[12px] underline underline-offset-2 py-1.5" style={{ color: "var(--admin-text-muted)" }}>
                      Pas encore réglé
                    </button>
                  </form>
                </span>
              ) : reservation.status === "cancelled" ? (
                <StatusBadge status="completed" label="Rien à régler" />
              ) : reservation.source === "manual" ? (
                <span className="inline-flex items-center gap-2">
                  <StatusBadge status="pending" label="À régler avec le client" />
                  <form action={setBookingPaid.bind(null, id, true)}>
                    <button
                      type="submit"
                      className="admin-btn"
                      style={{ padding: "5px 10px", fontSize: 12.5, color: "var(--admin-primary)", background: "var(--admin-primary-light)", border: "none" }}
                    >
                      Marquer réglé
                    </button>
                  </form>
                </span>
              ) : (
                <StatusBadge status="completed" label="Aucun paiement enregistré" />
              )
            }
          />
          <Row label="Origine" value={<ChannelTag channel={reservation.source} />} />
        </Section>

        {reservation.notes && (
          <Section label="Notes">
            <p
              className="text-[13px] px-5 pb-4"
              style={{ color: "var(--admin-text)" }}
            >
              {reservation.notes}
            </p>
          </Section>
        )}
      </div>

      <ReservationPdfActions bookingId={id} />
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="py-4"
      style={{ borderTop: "1px solid var(--admin-border-light)" }}
    >
      <p
        className="text-[12px] font-bold uppercase px-5 mb-3"
        style={{
          color: "var(--admin-text-muted)",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </p>
      {children}
    </div>
  );
}

function ContactLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="underline underline-offset-2 decoration-[var(--admin-border)] hover:decoration-current break-all"
      style={{ color: "var(--admin-primary)" }}
    >
      {children}
    </a>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-4 px-5 py-1.5">
      <span className="text-[13px]" style={{ color: "var(--admin-text-muted)" }}>
        {label}
      </span>
      <span
        className="text-[13px] font-semibold text-right"
        style={{ color: "var(--admin-text)" }}
      >
        {value}
      </span>
    </div>
  );
}
