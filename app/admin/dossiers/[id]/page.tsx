import { notFound } from "next/navigation";
import Link from "next/link";
import { countryName } from "@/lib/countries";
import { formatEuros } from "@/lib/utils";
import { requireSession } from "@/lib/session";
import { completeFinishedStays } from "@/lib/queries/bookings";
import { dossierMoney, getDossierForAdmin } from "@/lib/queries/dossiers";
import { cancelDossier, cancelDossierBooking, setDossierPaid } from "@/lib/actions/bookings";
import ReservationPdfActions from "@/components/admin/ReservationPdfActions";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { HOTEL_TIME_ZONE } from "@/lib/date-windows";
import { ChannelTag, StatusBadge, StatusBanner } from "@/components/admin/ui";
import { Icon } from "@/components/admin/icons";
import { DossierAddRoomForm, DossierDatesForm } from "@/components/admin/DossierForms";
import { openCheckoutDeadline } from "@/lib/checkout-window";
import { getRoomsByTenant } from "@/lib/queries/rooms";
import { getExtrasByTenant } from "@/lib/queries/extras";
import { getFeesByTenant, getTouristTax } from "@/lib/queries/fees";
import { isRoomAvailable } from "@/lib/availability";
import { bedLimit } from "@/lib/extras";
import { CANCELLATION_LEVEL_INFO } from "@/lib/legal-documents";
import { getDossierRefunds, refundedTotal } from "@/lib/refunds";
import { getDossierDisputes, lostDisputeTotal } from "@/lib/disputes";
import { canRespond, disputeIsOpen, disputeReasonFr } from "@/lib/dispute-evidence";
import { disputeBanner, disputeDay, disputeStripeUrl } from "@/lib/dispute-display";
import { acceptDisputeAction } from "@/lib/actions/disputes";
import { isDemoTenant } from "@/lib/demo";
import { cancellationRefund, cents, refundSuggestion, uniqueShortcuts } from "@/lib/refund-amounts";
import { CancelRefundFields, RefundButton } from "@/components/admin/RefundForms";

export const metadata = { title: "Dossier" };

const dateFr = (d: Date, withYear = true) =>
  new Date(d).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });

const people = (guests: number, children: number) =>
  `${guests} personne${guests > 1 ? "s" : ""}${children > 0 ? ` dont ${children} enfant${children > 1 ? "s" : ""}` : ""}`;

const dangerOutline = {
  padding: "9px 16px",
  minHeight: 40,
  background: "transparent",
  color: "var(--admin-danger)",
  border: "1px solid #FCA5A5",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
} as const;

/**
 * Fiche Dossier (ADR-0012) : le séjour réservé en une fois — voyageur, paiement commun,
 * reste à payer, et chaque chambre (réservation) avec son lien et son annulation.
 */
export default async function DossierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    enregistre?: string;
    annule?: string;
    "chambre-annulee"?: string;
    "dates-modifiees"?: string;
    "chambre-ajoutee"?: string;
    rembourse?: string;
    litige?: string;
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { tenantId } = await requireSession();
  await completeFinishedStays(tenantId);
  const found = await getDossierForAdmin(id, tenantId);
  if (!found || found.bookings.length === 0) notFound();
  const { dossier, bookings, payment } = found;

  const [refundRows, disputeRows, demo] = await Promise.all([
    getDossierRefunds(tenantId, id),
    getDossierDisputes(tenantId, id),
    isDemoTenant(tenantId),
  ]);
  const dispute = disputeRows.some((d) => disputeIsOpen(d.status));
  // Litige perdu : la banque a repris l'argent, compté comme remboursé dans l'encaissé net.
  const money = dossierMoney(bookings, payment, refundedTotal(refundRows) + lostDisputeTotal(disputeRows));
  const openDispute = disputeRows.findLast((d) => disputeIsOpen(d.status));
  // Remboursable depuis l'app : un paiement en ligne abouti, pas en litige (PRD Remboursements).
  const refundable = payment?.status === "paid" && payment.stripePaymentId ? cents(money.refundable) : 0;
  const canRefund = refundable > 0 && !dispute;
  const now = new Date();
  const level = dossier.cancellationLevel;
  const lastRefund = refundRows.at(-1);
  const active = bookings.filter((b) => b.status === "pending" || b.status === "confirmed");
  const nights = Math.round((new Date(dossier.checkOut).getTime() - new Date(dossier.checkIn).getTime()) / 86_400_000);
  const guests = bookings.filter((b) => b.status !== "cancelled").reduce((n, b) => n + b.guestCount, 0);
  const children = bookings.filter((b) => b.status !== "cancelled").reduce((n, b) => n + b.childCount, 0);
  const allCancelled = bookings.every((b) => b.status === "cancelled");
  const isManual = bookings.every((b) => b.source === "manual");
  // Dates et chambres se modifient tant que le séjour n'est ni annulé, ni terminé, ni en plein paiement en ligne.
  const editable =
    active.length > 0 && !bookings.some((b) => b.status === "completed") && !openCheckoutDeadline(payment);
  const iso = (d: Date) => new Date(d).toISOString().slice(0, 10);
  const [roomList, extraCatalog, feeCatalog, touristTax] = editable
    ? await Promise.all([
        getRoomsByTenant(tenantId),
        getExtrasByTenant(tenantId, { activeOnly: true }),
        getFeesByTenant(tenantId, { activeOnly: true }),
        getTouristTax(tenantId),
      ])
    : [[], [], [], null];
  // Chambres qu'on peut ajouter : actives, pas déjà dans le Dossier ; libres d'abord.
  const addable = await Promise.all(
    roomList
      .filter((r) => r.active && !active.some((b) => b.roomId === r.id))
      .map(async (r) => ({
        id: r.id,
        name: r.name,
        pricePerNight: String(r.pricePerNight),
        maxBeds: bedLimit(r),
        capacity: r.capacity,
        free: await isRoomAvailable(r.id, tenantId, dossier.checkIn, dossier.checkOut),
      })),
  );
  addable.sort((a, b) => Number(b.free) - Number(a.free));

  return (
    <div className="space-y-5 max-w-2xl admin-fade-in" data-dossier>
      <Link
        href="/admin/reservations"
        className="inline-flex items-center min-h-[44px] -my-2 text-[13px] font-semibold"
        style={{ color: "var(--admin-text-muted)" }}
      >
        ← Réservations
      </Link>

      <header className="space-y-2">
        <p
          className="inline-flex items-center gap-1.5 text-[12px] font-bold uppercase"
          style={{ color: "var(--admin-primary)", letterSpacing: "0.06em" }}
        >
          <Icon.Group size={14} aria-hidden />
          Dossier · {bookings.length} chambre{bookings.length > 1 ? "s" : ""}
        </p>
        <h1
          className="text-[24px] font-extrabold leading-tight break-words"
          style={{ color: "var(--admin-text)", letterSpacing: "-0.6px" }}
        >
          {dossier.guestName}
        </h1>
        <p className="text-[13.5px] leading-[1.5]" style={{ color: "var(--admin-text-muted)" }}>
          <span className="whitespace-nowrap">{dateFr(dossier.checkIn, false)}</span> →{" "}
          <span className="whitespace-nowrap">{dateFr(dossier.checkOut)}</span>
          {" · "}
          {nights} nuit{nights > 1 ? "s" : ""}
          {guests > 0 && <> · {people(guests, children)}</>}
        </p>
      </header>

      <div role="status">
        {disputeRows.map((d) => {
          const banner = disputeBanner(d, now);
          return (
            banner && (
              <StatusBanner key={d.id} variant={banner.variant}>
                <span data-dispute-banner={d.status}>
                  {banner.text}
                  {banner.open && !d.submittedAt && <> Motif : {disputeReasonFr(d.reason)}.</>}
                </span>
              </StatusBanner>
            )
          );
        })}
        {query.litige === "envoye" && (
          <StatusBanner variant="success">
            <span data-dispute-flash>Réponse envoyée à la banque. Elle décide, souvent en 2 à 3 mois ; vous serez prévenu ici.</span>
          </StatusBanner>
        )}
        {query.litige === "accepte" && (
          <StatusBanner variant="success">
            <span data-dispute-flash>Litige accepté : la banque garde le montant pour le voyageur.</span>
          </StatusBanner>
        )}
        {query.enregistre && (
          <StatusBanner variant="success">
            Dossier enregistré : {bookings.length} chambres. Ces nuits ne sont plus proposées sur votre site.
          </StatusBanner>
        )}
        {query["chambre-annulee"] === "1" && (
          <StatusBanner variant="success">
            Chambre annulée et libérée ; les autres chambres restent réservées. Un email a été envoyé à{" "}
            {dossier.guestEmail}.
          </StatusBanner>
        )}
        {query.annule === "1" && (
          <StatusBanner variant="success">
            Dossier annulé : toutes les chambres sont libérées. Un email a été envoyé à {dossier.guestEmail}.
          </StatusBanner>
        )}
        {(query["dates-modifiees"] || query["chambre-ajoutee"]) && (
          <StatusBanner variant={query["dates-modifiees"] === "sans-email" || query["chambre-ajoutee"] === "sans-email" ? "warning" : "success"}>
            {query["dates-modifiees"]
              ? `Dates changées pour ${active.length > 1 ? `les ${active.length} chambres` : "la chambre"} : du ${dateFr(dossier.checkIn, false)} au ${dateFr(dossier.checkOut)}. Les anciennes nuits sont libérées.`
              : "Chambre ajoutée au Dossier : ces nuits ne sont plus proposées sur votre site."}{" "}
            {(query["dates-modifiees"] ?? query["chambre-ajoutee"]) === "1"
              ? `Le nouveau récapitulatif a été envoyé à ${dossier.guestEmail}.`
              : (query["dates-modifiees"] ?? query["chambre-ajoutee"]) === "sans-email"
                ? `L'email n'a pas pu partir : prévenez ${dossier.guestName} directement.`
                : ""}
          </StatusBanner>
        )}
        {query.rembourse && query.rembourse !== "echec" && lastRefund && (
          <StatusBanner variant={query.rembourse === "1" ? "success" : "warning"}>
            <span data-refund-banner>
              Remboursement de {formatEuros(lastRefund.amount)}{" "}
              {lastRefund.status === "succeeded" ? "effectué" : lastRefund.status === "failed" ? "refusé par la banque" : "en cours"}.{" "}
              {query.rembourse === "1"
                ? `${dossier.guestEmail} a été prévenu par email (délai bancaire de 5 à 10 jours).`
                : `L'email n'a pas pu partir : prévenez ${dossier.guestName} directement.`}
            </span>
          </StatusBanner>
        )}
        {lastRefund?.status === "failed" && (
          <StatusBanner variant="error">
            <span data-refund-failed>
              Remboursement de {formatEuros(lastRefund.amount)} échoué
              {lastRefund.failureReason ? ` (${lastRefund.failureReason})` : ""} : rien n&apos;a été remboursé.
              Refaites-le avec « Rembourser » ci-dessous ou contactez {dossier.guestName}.
            </span>
          </StatusBanner>
        )}
        {query.rembourse === "echec" && (
          <StatusBanner variant="error">
            <span data-refund-banner>
              Annulation faite, mais le remboursement n&apos;a pas pu être fait (Stripe a refusé ou est injoignable) :
              rien n&apos;a été remboursé. Réessayez avec « Rembourser » ci-dessous.
            </span>
          </StatusBanner>
        )}
        {(query["chambre-annulee"] === "sans-email" || query.annule === "sans-email") && (
          <StatusBanner variant="warning">
            Annulation faite, mais l&apos;email n&apos;a pas pu partir : prévenez {dossier.guestName} directement.
          </StatusBanner>
        )}
      </div>

      {/* Les chambres d'abord : c'est ce que l'hôte vient vérifier ou annuler. */}
      <section aria-labelledby="dossier-rooms" className="space-y-2.5">
        <h2 id="dossier-rooms" className="text-[12px] font-bold uppercase" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
          Chambres
        </h2>
        <ol className="space-y-2.5">
          {bookings.map((b, i) => {
            const cancelled = b.status === "cancelled";
            const cancellable = (b.status === "pending" || b.status === "confirmed") && active.length > 1;
            return (
              <li
                key={b.id}
                data-dossier-room={b.id}
                className="rounded-[var(--admin-radius)] px-4 py-3.5"
                style={{
                  background: cancelled ? "var(--admin-surface-2)" : "var(--admin-surface)",
                  border: "1px solid var(--admin-border)",
                  boxShadow: cancelled ? "none" : "var(--admin-shadow-sm)",
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className="flex-shrink-0 w-7 h-7 rounded-full grid place-items-center text-[12.5px] font-bold tabular-nums"
                    style={{
                      background: cancelled ? "var(--admin-border)" : "var(--admin-primary-light)",
                      color: cancelled ? "var(--admin-text-muted)" : "var(--admin-primary)",
                    }}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p
                        className="text-[14.5px] font-bold break-words"
                        style={{ color: "var(--admin-text)", textDecoration: cancelled ? "line-through" : undefined }}
                      >
                        {b.room?.name ?? "Chambre"}
                      </p>
                      <StatusBadge status={b.status} />
                    </div>
                    <p className="text-[13px] mt-0.5 tabular-nums" style={{ color: "var(--admin-text-muted)" }}>
                      {people(b.guestCount, b.childCount)} · {formatEuros(b.totalPrice)}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap mt-2.5">
                      <Link
                        href={`/admin/reservations/${b.id}`}
                        className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg text-[13px] font-semibold"
                        style={{ background: "var(--admin-primary-light)", color: "var(--admin-primary)" }}
                      >
                        Voir la réservation
                        <Icon.ArrowRight size={14} aria-hidden />
                      </Link>
                      {cancellable && (
                        <ConfirmButton
                          title={`Annuler la chambre « ${b.room?.name ?? "Chambre"} » ?`}
                          message={
                            <>
                              Seule cette chambre est libérée ;{" "}
                              {active.length > 2 ? `les ${active.length - 1} autres restent réservées` : "l'autre chambre reste réservée"}. Un email d&apos;annulation
                              est envoyé à <strong style={{ color: "var(--admin-text)" }}>{dossier.guestEmail}</strong>.
                              {canRefund ? (
                                <CancelRefundFields
                                  guestEmail={dossier.guestEmail}
                                  refundable={refundable}
                                  {...cancellationRefund({
                                    level,
                                    checkIn: dossier.checkIn,
                                    now,
                                    base: cents(b.totalPrice),
                                    baseLabel: "Prix de la chambre",
                                    refundable,
                                  })}
                                />
                              ) : (
                                <span
                                  data-refund-note
                                  className="block mt-3 px-3 py-2 rounded-lg text-[12.5px] leading-[1.5]"
                                  style={{ background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }}
                                >
                                  {dispute
                                    ? "Litige en cours sur le paiement : répondez-y d'abord, rien n'est remboursé."
                                    : money.paidOnline > 0 && !payment?.stripePaymentId
                                      ? "Paiement en ligne sans référence Stripe : remboursez-le depuis votre tableau de bord Stripe."
                                      : money.paidOnline > 0
                                      ? "Le paiement en ligne est déjà entièrement remboursé."
                                      : "Aucun paiement en ligne à rembourser."}
                                </span>
                              )}
                            </>
                          }
                          cancelLabel="Garder"
                          confirmLabel="Annuler cette chambre"
                          onConfirm={cancelDossierBooking.bind(null, dossier.id, b.id)}
                          withForm
                          style={dangerOutline}
                        >
                          Annuler cette chambre
                        </ConfirmButton>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {editable && (
        <section aria-label="Modifier le séjour" className="space-y-2.5" data-dossier-edit>
          <DossierDatesForm
            dossierId={dossier.id}
            checkIn={iso(dossier.checkIn)}
            checkOut={iso(dossier.checkOut)}
            rooms={active.map((b) => ({ bookingId: b.id, name: b.room?.name ?? "Chambre", total: parseFloat(b.totalPrice) }))}
            guestEmail={dossier.guestEmail}
          />
          <DossierAddRoomForm
            dossierId={dossier.id}
            checkIn={iso(dossier.checkIn)}
            checkOut={iso(dossier.checkOut)}
            rooms={addable}
            extras={extraCatalog}
            fees={feeCatalog}
            taxEnabled={!!touristTax}
            guestEmail={dossier.guestEmail}
          />
        </section>
      )}

      {openDispute && (
        <section
          aria-label="Litige en cours"
          data-dispute-card
          className="px-4 sm:px-5 py-4 space-y-3"
          style={{ background: "var(--admin-surface)", border: "1px solid #FCA5A5", borderRadius: "var(--admin-radius)" }}
        >
          <div>
            <h2 className="text-[12px] font-bold uppercase" style={{ color: "var(--admin-danger)", letterSpacing: "0.06em" }}>
              Litige · {formatEuros(openDispute.amount)}
            </h2>
            <p className="text-[13px] leading-[1.5] mt-1" style={{ color: "var(--admin-text-muted)" }}>
              {dossier.guestName} conteste le paiement auprès de sa banque ({disputeReasonFr(openDispute.reason)}).{" "}
              {canRespond(openDispute, now)
                ? `Répondez avec vos preuves avant le ${disputeDay(openDispute.evidenceDueBy ?? now, true)}, ou acceptez : sans réponse, la banque donne raison au voyageur.`
                : openDispute.submittedAt
                  ? "Votre réponse est envoyée ; la banque décide."
                  : "La date limite de réponse est dépassée."}{" "}
              Les réservations ne changent pas.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/admin/dossiers/${dossier.id}/litige`}
              className="admin-btn"
              style={{ background: "var(--admin-primary)", color: "#fff", border: "none" }}
              data-dispute-respond
            >
              {canRespond(openDispute, now) ? "Répondre" : "Voir la réponse"}
            </Link>
            {canRespond(openDispute, now) && (
              <ConfirmButton
                title="Accepter le litige ?"
                message={
                  <>
                    La banque garde <strong style={{ color: "var(--admin-text)" }}>{formatEuros(openDispute.amount)}</strong> pour{" "}
                    {dossier.guestName} : le montant est compté comme remboursé. C&apos;est définitif, vous ne pourrez plus répondre.
                  </>
                }
                cancelLabel="Retour"
                confirmLabel="Accepter le litige"
                onConfirm={acceptDisputeAction.bind(null, dossier.id, openDispute.id)}
                style={dangerOutline}
              >
                Accepter le litige
              </ConfirmButton>
            )}
            <a
              href={disputeStripeUrl(openDispute.stripeDisputeId, demo)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12.5px] underline underline-offset-2 py-2"
              style={{ color: "var(--admin-text-muted)" }}
              data-dispute-stripe-link
            >
              Voir sur Stripe
            </a>
          </div>
        </section>
      )}

      <Card label="Paiement">
        <Row label="Total du séjour" value={formatEuros(money.due)} />
        {money.paidOnline > 0 && (
          // Une ligne par mouvement d'argent : le paiement, puis chaque remboursement.
          <ul className="px-4 sm:px-5 py-1" aria-label="Mouvements" data-money-moves>
            <Move
              label="Payé en ligne"
              date={payment?.createdAt ?? null}
              amount={`+ ${formatEuros(money.paidOnline)}`}
            />
            {refundRows.map((r) => {
              const room = r.bookingId ? bookings.find((b) => b.id === r.bookingId)?.room?.name : null;
              return (
                <Move
                  key={r.id}
                  refundId={r.id}
                  label={room ? `Remboursement · ${room}` : "Remboursement"}
                  date={r.createdAt}
                  detail={r.reason}
                  struck={r.status === "failed"}
                  amount={`− ${formatEuros(r.amount)}`}
                  badge={
                    <StatusBadge
                      status={r.status === "succeeded" ? "confirmed" : r.status === "failed" ? "cancelled" : "pending"}
                      label={r.status === "succeeded" ? "Effectué" : r.status === "failed" ? "Échoué" : "En cours"}
                    />
                  }
                />
              );
            })}
            {disputeRows
              .filter((d) => d.status === "lost")
              .map((d) => (
                <Move
                  key={d.id}
                  label="Litige perdu · repris par la banque"
                  date={d.closedAt ?? d.updatedAt}
                  amount={`− ${formatEuros(d.amount)}`}
                />
              ))}
          </ul>
        )}
        {money.refunded > 0 && (
          <Row label="Encaissé net" value={<span data-net-paid>{formatEuros(money.net)}</span>} />
        )}
        {money.refund > 0 && (
          <Row
            label="Trop-perçu"
            value={
              <span data-refund-due style={{ color: "#92400E" }}>
                {formatEuros(money.refund)}
              </span>
            }
          />
        )}
        {money.balance > 0 && (
          <Row
            label="Reste à payer"
            value={
              <span data-balance-due style={{ color: "#92400E" }}>
                {formatEuros(money.balance)}
              </span>
            }
          />
        )}
        <Row
          label="Règlement"
          value={
            allCancelled ? (
              money.refund > 0 ? (
                <StatusBadge status="cancelled" label="Payé, à rembourser" />
              ) : money.paidOnline > 0 ? (
                <StatusBadge status="completed" label="Remboursé" />
              ) : (
                <StatusBadge status="completed" label="Rien à régler" />
              )
            ) : money.settled ? (
              <span className="inline-flex items-center gap-2 flex-wrap justify-end">
                <StatusBadge status="confirmed" label="Réglé" />
                <form action={setDossierPaid.bind(null, dossier.id, false)}>
                  <button type="submit" className="text-[12px] underline underline-offset-2 py-1.5" style={{ color: "var(--admin-text-muted)" }}>
                    Pas encore réglé
                  </button>
                </form>
              </span>
            ) : money.paidOnline > 0 && money.balance === 0 ? (
              <StatusBadge status="confirmed" label="Payé en ligne" />
            ) : payment && payment.status !== "paid" && !isManual ? (
              <StatusBadge status="pending" label={payment.status === "pending" ? "Paiement en cours" : "Paiement non abouti"} />
            ) : (
              <span className="inline-flex items-center gap-2 flex-wrap justify-end">
                <StatusBadge status="pending" label={money.balance > 0 ? "Reste à régler sur place" : "À régler avec le client"} />
                <form action={setDossierPaid.bind(null, dossier.id, true)}>
                  <button
                    type="submit"
                    className="admin-btn"
                    style={{ padding: "5px 10px", fontSize: 12.5, color: "var(--admin-primary)", background: "var(--admin-primary-light)", border: "none" }}
                  >
                    Marquer réglé
                  </button>
                </form>
              </span>
            )
          }
        />
        {money.paidOnline > 0 && (
          <div className="flex items-center justify-end gap-2 flex-wrap px-4 sm:px-5 py-1.5" data-refund-actions>
            {canRefund || dispute ? (
              <RefundButton
                dossierId={dossier.id}
                refundable={refundable}
                guestEmail={dossier.guestEmail}
                disabledReason={dispute ? "Litige en cours, répondez-y d'abord." : undefined}
                defaultAmount={money.refund > 0 ? Math.min(cents(money.refund), refundable) : 0}
                shortcuts={uniqueShortcuts([
                  money.refund > 0 && { label: "Trop-perçu", amount: Math.min(cents(money.refund), refundable) },
                  ...bookings
                    .filter((b) => b.status === "cancelled")
                    .map((b) => ({ label: `Chambre annulée · ${b.room?.name ?? "Chambre"}`, amount: Math.min(cents(b.totalPrice), refundable) })),
                  refundSuggestion(level, dossier.checkIn, now, cents(money.paidOnline), refundable),
                  { label: "Tout le restant", amount: refundable },
                ])}
              />
            ) : (
              <span className="text-[12.5px]" style={{ color: "var(--admin-text-muted)" }}>
                {payment?.stripePaymentId ? "Paiement entièrement remboursé." : "Sans référence Stripe : remboursez depuis votre tableau de bord Stripe."}
              </span>
            )}
          </div>
        )}
        <Row label="Origine" value={<ChannelTag channel={isManual ? "manual" : "direct"} />} />
        {dossier.termsAcceptedAt && (
          // Preuve en cas de contestation : le texte exact accepté au paiement.
          <details className="px-4 sm:px-5 pt-1.5" data-testid="dossier-accepted-terms">
            <summary className="text-[13px] cursor-pointer min-h-[44px] flex items-center" style={{ color: "var(--admin-text-muted)" }}>
              Conditions acceptées au paiement le{" "}
              {new Date(dossier.termsAcceptedAt).toLocaleString("fr-FR", {
                day: "numeric",
                month: "long",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: HOTEL_TIME_ZONE,
              })}
              {dossier.cancellationLevel && ` (annulation ${CANCELLATION_LEVEL_INFO[dossier.cancellationLevel].label.toLowerCase()})`}
            </summary>
            {[
              { title: "Conditions d'annulation", text: dossier.acceptedCancellationText },
              { title: "Conditions générales de vente", text: dossier.acceptedCgvText },
            ].map((d) => (
              <div key={d.title} className="mt-2">
                <p className="text-[12px] font-bold uppercase" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
                  {d.title}
                </p>
                <p
                  tabIndex={0}
                  aria-label={d.title}
                  className="text-[12.5px] leading-[1.5] whitespace-pre-line overflow-y-auto mt-1 px-3 py-2 rounded-lg break-words"
                  style={{ maxHeight: 240, background: "var(--admin-surface-2)", color: "var(--admin-text)" }}
                >
                  {d.text}
                </p>
              </div>
            ))}
          </details>
        )}
      </Card>

      <Card label="Voyageur">
        <Row label="Nom" value={dossier.guestName} />
        <Row
          label="Email"
          value={
            <a href={`mailto:${dossier.guestEmail}`} className="underline underline-offset-2 break-all" style={{ color: "var(--admin-primary)" }}>
              {dossier.guestEmail}
            </a>
          }
        />
        {dossier.guestPhone && (
          <Row
            label="Téléphone"
            value={
              <a href={`tel:${dossier.guestPhone.replace(/[^\d+]/g, "")}`} className="underline underline-offset-2" style={{ color: "var(--admin-primary)" }}>
                {dossier.guestPhone}
              </a>
            }
          />
        )}
        {dossier.guestAddress && <Row label="Adresse" value={dossier.guestAddress} />}
        {dossier.guestCountry && <Row label="Pays" value={countryName(dossier.guestCountry)} />}
        <p className="px-4 sm:px-5 pt-1 text-[12px]" style={{ color: "var(--admin-text-subtle)" }}>
          Pour corriger le voyageur, modifiez l&apos;une des réservations : tout le Dossier suit.
          {dossier.createdAt &&
            ` Créé le ${new Date(dossier.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: HOTEL_TIME_ZONE })}.`}
        </p>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <ReservationPdfActions dossierId={dossier.id} />
        {active.length > 0 && (
          <ConfirmButton
            title={`Annuler tout le Dossier de ${dossier.guestName} ?`}
            message={
              <>
                {active.length > 1 ? `Les ${active.length} chambres encore réservées seront libérées` : "La chambre encore réservée sera libérée"} et un email d&apos;annulation sera envoyé à{" "}
                <strong style={{ color: "var(--admin-text)" }}>{dossier.guestEmail}</strong>. Cette action est définitive.
                {canRefund ? (
                  <CancelRefundFields
                    guestEmail={dossier.guestEmail}
                    refundable={refundable}
                    {...cancellationRefund({
                      level,
                      checkIn: dossier.checkIn,
                      now,
                      base: cents(money.paidOnline),
                      baseLabel: "Tout le paiement",
                      refundable,
                    })}
                  />
                ) : (
                  <span
                    data-refund-note
                    className="block mt-3 px-3 py-2 rounded-lg text-[12.5px] leading-[1.5]"
                    style={{ background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }}
                  >
                    {dispute
                      ? "Litige en cours sur le paiement : répondez-y d'abord, rien n'est remboursé."
                      : money.paidOnline > 0 && !payment?.stripePaymentId
                        ? "Paiement en ligne sans référence Stripe : remboursez-le depuis votre tableau de bord Stripe."
                        : money.paidOnline > 0
                        ? "Le paiement en ligne est déjà entièrement remboursé."
                        : "Aucun paiement en ligne à rembourser."}
                  </span>
                )}
              </>
            }
            cancelLabel="Garder"
            confirmLabel="Annuler le Dossier"
            onConfirm={cancelDossier.bind(null, dossier.id)}
            withForm
            style={dangerOutline}
          >
            Annuler tout le Dossier
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      className="py-4"
      style={{
        background: "var(--admin-surface)",
        border: "1px solid var(--admin-border)",
        borderRadius: "var(--admin-radius)",
      }}
    >
      <h2 className="text-[12px] font-bold uppercase px-4 sm:px-5 mb-2.5" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
        {label}
      </h2>
      {children}
    </section>
  );
}

function Move({
  label,
  date,
  amount,
  detail,
  badge,
  struck,
  refundId,
}: {
  label: string;
  date: Date | null;
  amount: string;
  detail?: string | null;
  badge?: React.ReactNode;
  struck?: boolean;
  refundId?: string;
}) {
  return (
    <li
      className="flex justify-between items-start gap-3 py-1.5"
      style={{ borderTop: "1px solid var(--admin-border-light)" }}
      data-refund-row={refundId}
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold break-words" style={{ color: "var(--admin-text)" }}>
          {label}
        </span>
        <span className="block text-[12px]" style={{ color: "var(--admin-text-muted)" }}>
          {date &&
            new Date(date).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: HOTEL_TIME_ZONE })}
        </span>
        {detail && (
          <span className="block text-[12px] break-words whitespace-pre-line" style={{ color: "var(--admin-text-muted)" }} data-refund-reason>
            {detail}
          </span>
        )}
      </span>
      <span className="flex flex-col items-end gap-1 flex-shrink-0">
        <span
          className="text-[13px] font-semibold tabular-nums whitespace-nowrap"
          style={{ color: "var(--admin-text)", textDecoration: struck ? "line-through" : undefined }}
        >
          {amount}
        </span>
        {badge}
      </span>
    </li>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-3 px-4 sm:px-5 py-1.5">
      <span className="text-[13px] flex-shrink-0" style={{ color: "var(--admin-text-muted)" }}>
        {label}
      </span>
      <span className="text-[13px] font-semibold text-right min-w-0 break-words" style={{ color: "var(--admin-text)" }}>
        {value}
      </span>
    </div>
  );
}
