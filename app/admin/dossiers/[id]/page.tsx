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
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { tenantId } = await requireSession();
  await completeFinishedStays(tenantId);
  const found = await getDossierForAdmin(id, tenantId);
  if (!found || found.bookings.length === 0) notFound();
  const { dossier, bookings, payment } = found;

  const money = dossierMoney(bookings, payment);
  const active = bookings.filter((b) => b.status === "pending" || b.status === "confirmed");
  const nights = Math.round((new Date(dossier.checkOut).getTime() - new Date(dossier.checkIn).getTime()) / 86_400_000);
  const guests = bookings.filter((b) => b.status !== "cancelled").reduce((n, b) => n + b.guestCount, 0);
  const children = bookings.filter((b) => b.status !== "cancelled").reduce((n, b) => n + b.childCount, 0);
  const allCancelled = bookings.every((b) => b.status === "cancelled");
  const isManual = bookings.every((b) => b.source === "manual");
  const paidLabel = payment?.stripePaymentId ? ` (paiement ${payment.stripePaymentId})` : "";
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

      {/* L'argent encaissé dépasse ce que le séjour coûte : jamais rendu automatiquement. */}
      {money.refund > 0 && (
        <StatusBanner variant="error">
          <span data-refund-due>
            {allCancelled
              ? `${dossier.guestName} a payé ${formatEuros(money.paidOnline)} en ligne et tout le Dossier est annulé : `
              : `${dossier.guestName} a payé ${formatEuros(money.paidOnline)} en ligne pour un séjour qui coûte maintenant ${formatEuros(money.due)} : `}
            remboursez {formatEuros(money.refund)} depuis votre tableau de bord Stripe{paidLabel}. Rien n&apos;est rendu
            automatiquement.
          </span>
        </StatusBanner>
      )}

      <div role="status">
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
                              <span
                                className="block mt-3 px-3 py-2 rounded-lg text-[12.5px] leading-[1.5]"
                                style={
                                  money.paidOnline > 0
                                    ? { background: "#FEF3C7", color: "#92400E" }
                                    : { background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }
                                }
                              >
                                {money.paidOnline > 0
                                  ? `Payé en ligne : l'annulation ne rembourse rien. La fiche du Dossier indiquera le montant à rendre depuis Stripe.`
                                  : "Aucun paiement en ligne à rembourser."}
                              </span>
                            </>
                          }
                          cancelLabel="Garder"
                          confirmLabel="Annuler cette chambre"
                          onConfirm={cancelDossierBooking.bind(null, dossier.id, b.id)}
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

      <Card label="Paiement">
        <Row label="Total du séjour" value={formatEuros(money.due)} />
        {money.paidOnline > 0 && <Row label="Payé en ligne" value={formatEuros(money.paidOnline)} />}
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
              money.paidOnline > 0 ? (
                <StatusBadge status="cancelled" label="Payé, à rembourser" />
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
        <Row label="Origine" value={<ChannelTag channel={isManual ? "manual" : "direct"} />} />
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
                Les {active.length} chambre{active.length > 1 ? "s" : ""} encore réservée{active.length > 1 ? "s" : ""}{" "}
                {active.length > 1 ? "seront libérées" : "sera libérée"} et un email d&apos;annulation sera envoyé à{" "}
                <strong style={{ color: "var(--admin-text)" }}>{dossier.guestEmail}</strong>. Cette action est définitive.
                <span
                  data-refund-note
                  className="block mt-3 px-3 py-2 rounded-lg text-[12.5px] leading-[1.5]"
                  style={
                    money.paidOnline > 0
                      ? { background: "#FEF3C7", color: "#92400E" }
                      : { background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }
                  }
                >
                  {money.paidOnline > 0
                    ? `${dossier.guestName} a payé ${formatEuros(money.paidOnline)} en ligne. L'annulation ne le rembourse pas : faites-le depuis votre tableau de bord Stripe.`
                    : "Aucun paiement en ligne à rembourser."}
                </span>
              </>
            }
            cancelLabel="Garder"
            confirmLabel="Annuler le Dossier"
            onConfirm={cancelDossier.bind(null, dossier.id)}
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
