import { formatEuros } from "@/lib/utils";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { getBookingsByTenant, completeFinishedStays } from "@/lib/queries/bookings";
import { getRoomsByTenant } from "@/lib/queries/rooms";
import { dossierSizes } from "@/lib/queries/dossiers";
import { STATUS_LABELS } from "@/lib/calendar";
import { viewOfStatus, type BookingStatus, type BookingView } from "@/lib/queries/bookings";
import {
  Card,
  ChannelTag,
  EmptyState,
  GhostButton,
  GroupTag,
  GuestAvatar,
  PageHeader,
  PrimaryButton,
  StatusBadge,
} from "@/components/admin/ui";

function fmtDate(d: Date) {
  // Dates de séjour en UTC minuit (ADR-0005)
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
}

// Table cell on xl+, plain grid item in the mobile card.
const CELL = "xl:table-cell xl:px-4 xl:py-[13px]";

export const metadata = { title: "Réservations" };

export default async function ReservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ vue?: string; status?: string; roomId?: string; q?: string; page?: string }>;
}) {
  const { tenantId } = await requireSession();
  await completeFinishedStays(tenantId);
  const params = await searchParams;

  const status = (Object.keys(STATUS_LABELS) as BookingStatus[]).includes(params.status as BookingStatus)
    ? (params.status as BookingStatus)
    : undefined;
  // Un statut « terminée/annulée » vit dans « Anciennes » : le filtre suffit à ouvrir la bonne vue.
  const view: BookingView = viewOfStatus(status) ?? (params.vue === "anciennes" ? "anciennes" : "a-venir");
  const q = params.q?.trim().slice(0, 100) || undefined;
  const page = Number.parseInt(params.page ?? "1", 10) || 1;

  const [{ rows: reservations, total, pages }, chambres] = await Promise.all([
    getBookingsByTenant(tenantId, { view, status, roomId: params.roomId, q, page }),
    getRoomsByTenant(tenantId),
  ]);

  // Dossiers de plusieurs chambres (ADR-0012) : chaque ligne mène aussi à la fiche du Dossier.
  const groups = await dossierSizes(tenantId, reservations.map((r) => r.dossierId));

  // Liens de filtre : on garde le reste, on revient en page 1.
  const href = (over: Partial<Record<"vue" | "status" | "roomId" | "q" | "page", string | undefined>>) => {
    const next = { vue: view === "anciennes" ? "anciennes" : undefined, status, roomId: params.roomId, q, ...over };
    const qs = new URLSearchParams();
    for (const [k, val] of Object.entries(next)) if (val) qs.set(k, val);
    const str = qs.toString();
    return `/admin/reservations${str ? `?${str}` : ""}`;
  };

  const statusFilters: (BookingStatus | "all")[] =
    view === "anciennes" ? ["all", "completed", "cancelled"] : ["all", "confirmed", "pending"];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Réservations"
        subtitle={`${total} ${view === "anciennes" ? "ancienne" : "à venir"}${view === "anciennes" && total > 1 ? "s" : ""}${q ? ` pour « ${q} »` : ""}`}
        action={
          <PrimaryButton href="/admin/reservations/new">Nouvelle</PrimaryButton>
        }
      />

      {/* Vue + recherche */}
      <div className="flex gap-3 flex-wrap items-center justify-between">
        <nav aria-label="Période" className="flex gap-1.5">
          {(["a-venir", "anciennes"] as const).map((vue) => (
            <GhostButton
              key={vue}
              href={href({ vue: vue === "anciennes" ? vue : undefined, status: undefined })}
              active={view === vue}
              ariaCurrent={view === vue ? "page" : undefined}
            >
              {vue === "anciennes" ? "Anciennes" : "À venir"}
            </GhostButton>
          ))}
        </nav>
        <form role="search" action="/admin/reservations" className="flex gap-2 items-center w-full sm:w-auto">
          {view === "anciennes" && <input type="hidden" name="vue" value="anciennes" />}
          {status && <input type="hidden" name="status" value={status} />}
          {params.roomId && <input type="hidden" name="roomId" value={params.roomId} />}
          <label className="sr-only" htmlFor="booking-search">
            Rechercher un client
          </label>
          <input
            id="booking-search"
            type="search"
            name="q"
            defaultValue={q}
            maxLength={100}
            placeholder="Nom, email ou téléphone"
            className="admin-field flex-1 sm:w-[260px]"
          />
          <button type="submit" className="admin-btn admin-btn--ghost">
            Rechercher
          </button>
        </form>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <div className="flex gap-1.5 overflow-x-auto md:flex-wrap -mx-5 px-5 sm:-mx-8 sm:px-8 md:mx-0 md:px-0 pb-1 md:pb-0 admin-scroll-cue">
          {statusFilters.map((s) => {
            const active = s === "all" ? !status : status === s;
            return (
              <GhostButton
                key={s}
                href={href({ status: s === "all" ? undefined : s })}
                active={active}
                ariaCurrent={active ? "true" : undefined}
              >
                {s === "all" ? "Toutes" : STATUS_LABELS[s as BookingStatus]}
              </GhostButton>
            );
          })}
        </div>
      </div>

      {/* Room chips */}
      {chambres.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto md:flex-wrap -mx-5 px-5 sm:-mx-8 sm:px-8 md:mx-0 md:px-0 pb-1 md:pb-0 admin-scroll-cue">
          <Link
            href={href({ roomId: undefined })}
            aria-current={!params.roomId ? "true" : undefined}
            className="text-[12px] font-semibold rounded-md px-2.5 py-[5px] transition-colors whitespace-nowrap flex-shrink-0"
            style={{
              background: !params.roomId
                ? "var(--admin-primary-light)"
                : "transparent",
              color: !params.roomId
                ? "var(--admin-primary)"
                : "var(--admin-text-muted)",
              border: `1px solid ${!params.roomId ? "var(--admin-primary-light)" : "var(--admin-border)"}`,
            }}
          >
            Toutes les chambres
          </Link>
          {chambres.map((c) => {
            const active = params.roomId === c.id;
            return (
              <Link
                key={c.id}
                href={href({ roomId: c.id })}
                aria-current={active ? "true" : undefined}
                className="text-[12px] font-semibold rounded-md px-2.5 py-[5px] transition-colors whitespace-nowrap flex-shrink-0"
                style={{
                  background: active ? "var(--admin-primary-light)" : "transparent",
                  color: active
                    ? "var(--admin-primary)"
                    : "var(--admin-text-muted)",
                  border: `1px solid ${active ? "var(--admin-primary-light)" : "var(--admin-border)"}`,
                }}
              >
                {c.name}
              </Link>
            );
          })}
        </div>
      )}

      {/* Table */}
      {reservations.length === 0 ? (
        <Card>
          {q ? (
            <EmptyState
              title={`Aucune réservation pour « ${q} »`}
              action={<GhostButton href={href({ q: undefined })}>Effacer la recherche</GhostButton>}
            >
              Vérifiez l&apos;orthographe, ou cherchez par email ou téléphone.
              {view === "a-venir" && " Un séjour passé ou annulé se trouve dans « Anciennes »."}
            </EmptyState>
          ) : status || params.roomId ? (
            <EmptyState
              title="Aucune réservation ne correspond à ce filtre"
              action={
                <GhostButton href="/admin/reservations">Voir toutes les réservations</GhostButton>
              }
            >
              Essayez un autre statut ou une autre chambre.
            </EmptyState>
          ) : view === "anciennes" ? (
            <EmptyState title="Aucune ancienne réservation" compact>
              Les séjours terminés et les réservations annulées apparaîtront ici.
            </EmptyState>
          ) : (
            <EmptyState
              title="Aucune réservation pour l’instant"
              example="un client vous appelle pour 2 nuits la semaine prochaine : saisissez-le ici pour bloquer les dates sur votre site."
              action={
                <PrimaryButton href="/admin/reservations/new">Saisir une réservation</PrimaryButton>
              }
            >
              Les réservations faites sur votre site arrivent ici automatiquement. Vous pouvez aussi
              saisir celles prises par téléphone ou sur une autre plateforme.
            </EmptyState>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {/* One DOM for both layouts: a table from xl up, stacked cards below. */}
          <div className="xl:overflow-x-auto">
            <table className="w-full border-collapse block xl:table">
              <thead className="hidden xl:table-header-group">
                <tr style={{ borderBottom: "1px solid var(--admin-border)" }}>
                  {[
                    "Client",
                    "Chambre",
                    "Arrivée",
                    "Départ",
                    "Montant",
                    "Canal",
                    "Statut",
                  ].map((h) => (
                    <th
                      key={h}
                      className="text-left text-[12px] font-bold uppercase tracking-[0.06em] whitespace-nowrap"
                      style={{
                        padding: "12px 16px",
                        color: "var(--admin-text-muted)",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="block xl:table-row-group">
                {reservations.map((r, i) => (
                  <tr
                    key={r.id}
                    className={`relative grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3.5 xl:table-row xl:p-0 hover:bg-[var(--admin-surface-2)]/60 transition-colors ${
                      i % 2 === 0 ? "" : "xl:bg-[var(--admin-surface-2)]"
                    }`}
                    style={{ borderBottom: "1px solid var(--admin-border-light)" }}
                  >
                    <td className={`${CELL} block min-w-0`}>
                      <Link
                        href={`/admin/reservations/${r.id}`}
                        className="flex items-center gap-2.5 hover:opacity-80 after:absolute after:inset-0"
                      >
                        <GuestAvatar name={r.guestName} size={30} />
                        <span
                          className="text-[14px] xl:text-[13.5px] font-semibold min-w-0 break-words xl:max-w-[200px]"
                          style={{ color: "var(--admin-text)" }}
                        >
                          {r.guestName}
                        </span>
                      </Link>
                    </td>
                    <td
                      className={`${CELL} block col-span-2 text-[13px] xl:whitespace-nowrap`}
                      style={{ color: "var(--admin-text)" }}
                    >
                      {r.room?.name ?? "—"}
                      {(groups.get(r.dossierId) ?? 1) > 1 && (
                        <Link
                          href={`/admin/dossiers/${r.dossierId}`}
                          data-dossier-link
                          aria-label={`Dossier de ${groups.get(r.dossierId)} chambres de ${r.guestName}`}
                          // Au-dessus du lien de la ligne entière (after:inset-0).
                          className="relative z-10 ml-2 inline-flex align-middle hover:opacity-80"
                        >
                          <GroupTag rooms={groups.get(r.dossierId)!} />
                        </Link>
                      )}
                      <span
                        className="xl:hidden tabular-nums"
                        style={{ color: "var(--admin-text-muted)" }}
                      >
                        {" · "}
                        {fmtDate(new Date(r.checkIn))} → {fmtDate(new Date(r.checkOut))}
                      </span>
                    </td>
                    <td
                      className={`${CELL} hidden text-[13px] whitespace-nowrap tabular-nums`}
                      style={{ color: "var(--admin-text)" }}
                    >
                      {fmtDate(new Date(r.checkIn))}
                    </td>
                    <td
                      className={`${CELL} hidden text-[13px] whitespace-nowrap tabular-nums`}
                      style={{ color: "var(--admin-text)" }}
                    >
                      {fmtDate(new Date(r.checkOut))}
                    </td>
                    <td
                      className={`${CELL} block text-[13.5px] font-bold whitespace-nowrap tabular-nums`}
                      style={{ color: "var(--admin-text)" }}
                    >
                      {formatEuros(r.totalPrice)}
                    </td>
                    <td className={`${CELL} block justify-self-end whitespace-nowrap`}>
                      <ChannelTag channel={r.source ?? "manual"} />
                    </td>
                    <td className={`${CELL} block col-start-2 row-start-1 justify-self-end`}>
                      <StatusBadge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between gap-3">
          {page > 1 ? (
            <GhostButton href={href({ page: page > 2 ? String(page - 1) : undefined })}>← Plus récentes</GhostButton>
          ) : (
            <span />
          )}
          <span className="text-[12.5px] tabular-nums" style={{ color: "var(--admin-text-muted)" }}>
            Page {page} sur {pages}
          </span>
          {page < pages ? (
            <GhostButton href={href({ page: String(page + 1) })}>Plus anciennes →</GhostButton>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
