import { formatEuros } from "@/lib/utils";
import Link from "next/link";
import { requireSession } from "@/lib/session";
import { completeFinishedStays } from "@/lib/queries/bookings";
import { getDashboardData, WEEK_DAYS } from "@/lib/queries/dashboard";
import { HOTEL_TIME_ZONE, parisToday, startOfMonth, todayStart } from "@/lib/date-windows";
import { networkCounts, networkStatus } from "@/lib/network";
import { cookies } from "next/headers";
import { Icon } from "@/components/admin/icons";
import { dismissIcalNudge } from "@/lib/actions/ical-sources";
import { confirmBooking } from "@/lib/actions/bookings";
import {
  Card,
  CHANNEL_CONFIG,
  GuestAvatar,
  PageHeader,
  PrimaryButton,
  SectionHeader,
  StatusBadge,
} from "@/components/admin/ui";

// Dates de séjour en UTC minuit (ADR-0005) : formatées en UTC pour ne jamais glisser d'un jour.
function formatDay(d: Date, opts: Intl.DateTimeFormatOptions) {
  return new Date(d).toLocaleDateString("fr-FR", { ...opts, timeZone: "UTC" });
}

function nightsBetween(a: Date, b: Date) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export default async function AdminDashboard() {
  const { tenantId } = await requireSession();
  await completeFinishedStays(tenantId);
  const { today: movements, week, pendingSoon, channels, occupancy, monthRevenue, setup } =
    await getDashboardData(tenantId);
  const [networkMonth, networkTotal, network] = await Promise.all([
    networkCounts(tenantId, startOfMonth(), null),
    networkCounts(tenantId, null, null),
    networkStatus(tenantId),
  ]);
  const showIcalNudge =
    setup.done && !setup.ical && (await cookies()).get("admin-ical-nudge")?.value !== "dismissed";

  const todayLabel = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: HOTEL_TIME_ZONE,
  });
  // Majuscule au jour seulement : en français, les mois restent en minuscules.
  const today = todayLabel.charAt(0).toUpperCase() + todayLabel.slice(1);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bonjour"
        subtitle={today}
        action={
          // Sans chambre, il n'y a rien à réserver : une seule action principale, celle de la checklist.
          setup.rooms && (
            <PrimaryButton href="/admin/reservations/new">
              Nouvelle réservation
            </PrimaryButton>
          )
        }
      />

      <NetworkCounter month={networkMonth} total={networkTotal} status={network} />

      {/* Tant que le site n'a ni chambre ni dates réelles, des KPI à zéro n'apprennent rien : on guide. */}
      {!setup.done ? (
        <SetupChecklist rooms={setup.rooms} ical={setup.ical} legal={setup.legal} />
      ) : (
        <>
          {/* Le planning d'abord (ce qui demande une action, aujourd'hui, la semaine) ; les chiffres en marge. */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-5 items-start">
            <div className="space-y-5 min-w-0">
              {pendingSoon.length > 0 && <ToHandle items={pendingSoon} />}

              {/* Aujourd'hui : la question du matin — qui arrive, qui part */}
              <Card style={{ padding: "20px 24px" }}>
                <SectionHeader title="Aujourd'hui" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
                  {movements.staying.length > 0 && (
                    <div className="sm:col-span-2">
                      <MovementList
                        label="Restent ce soir"
                        empty=""
                        items={movements.staying}
                        noteFor={(b) => leavesNote(b.checkOut)}
                      />
                    </div>
                  )}
                  <MovementList
                    label="Arrivées"
                    empty="Personne n'arrive aujourd'hui."
                    items={movements.arrivals}
                  />
                  <MovementList
                    label="Départs"
                    empty="Aucun départ aujourd'hui."
                    items={movements.departures}
                    note="Chambre à préparer"
                    departure
                  />
                </div>
              </Card>

              {/* Rappel de mise en route, pas une tâche du jour : après le planning du jour. */}
              {!setup.legal && <LegalNudge />}
              {showIcalNudge && <IcalNudge />}

              <WeekPlan items={week} />
            </div>

            <MonthFigures
              occupancy={occupancy}
              monthRevenue={monthRevenue}
              channels={channels}
            />
          </div>
        </>
      )}
    </div>
  );
}

// Réseau des Voisins : SES chiffres seulement (envoyés / reçus / réservations), ce mois-ci et au total.
function NetworkCounter({
  month,
  total,
  status,
}: {
  month: { sent: number; received: number; bookings: number };
  total: { sent: number; received: number; bookings: number };
  status: { member: boolean; missingGps: boolean; disabled: boolean };
}) {
  const line = (c: typeof month) =>
    `${c.sent} voyageur${c.sent > 1 ? "s" : ""} envoyé${c.sent > 1 ? "s" : ""} · ${c.received} reçu${c.received > 1 ? "s" : ""} · ${c.bookings} réservation${c.bookings > 1 ? "s" : ""}`;
  return (
    <section
      aria-label="Réseau des voisins"
      data-network-counter
      className="px-5 py-3.5 rounded-[var(--admin-radius)] space-y-1"
      style={{ background: "var(--admin-surface, #fff)", border: "1px solid var(--admin-border-light)" }}
    >
      <p className="text-[13.5px]" style={{ color: "var(--admin-text)" }}>
        <strong>Réseau</strong> : <span data-network-month>{line(month)}</span> <span style={{ color: "var(--admin-text-muted)" }}>ce mois-ci</span>
      </p>
      <p className="text-[12.5px]" style={{ color: "var(--admin-text-muted)" }}>
        Au total : <span data-network-total>{line(total)}</span>
      </p>
      {status.missingGps && (
        <p data-testid="network-counter-gps-warning" className="text-[12.5px] font-semibold" style={{ color: "var(--admin-primary)" }}>
          Sans position GPS, votre établissement n&apos;apparaît pas dans le réseau.{" "}
          <Link href="/admin/parametres?tab=localisation" className="underline underline-offset-4">
            Renseigner ma position
          </Link>
        </p>
      )}
      {status.disabled && (
        <p data-network-disabled className="text-[12.5px]" style={{ color: "var(--admin-text-muted)" }}>
          Votre établissement est actuellement hors du réseau.
        </p>
      )}
    </section>
  );
}

// Site en service sans documents légaux publiés : paiements acceptés sans conditions d'annulation.
function LegalNudge() {
  return (
    <section
      aria-labelledby="legal-nudge-title"
      data-legal-nudge
      className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4 rounded-[var(--admin-radius)]"
      style={{
        background: "var(--admin-primary-light)",
        border: "1px solid color-mix(in srgb, var(--admin-primary) 25%, transparent)",
      }}
    >
      <div className="flex-1 min-w-[240px]">
        <h2 id="legal-nudge-title" className="text-[13.5px] font-bold" style={{ color: "var(--admin-text)" }}>
          Vos conditions d&apos;annulation ne sont pas publiées
        </h2>
        <p className="text-[12.5px] leading-[1.5] mt-0.5" style={{ color: "var(--admin-text-muted)" }}>
          Sans elles, vos clients paient sans conditions acceptées : en cas de litige bancaire, vous le perdrez presque toujours.
        </p>
      </div>
      <Link
        href="/admin/parametres?tab=documents"
        className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold underline-offset-4 hover:underline"
        style={{ color: "var(--admin-primary)" }}
      >
        Préparer mes documents
        <Icon.ArrowRight size={14} />
      </Link>
    </section>
  );
}

// Site en service sans iCal : un hôte encore sur Airbnb/Booking risque la double réservation.
function IcalNudge() {
  return (
    <section
      aria-labelledby="ical-nudge-title"
      data-ical-nudge
      className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4 rounded-[var(--admin-radius)]"
      style={{
        background: "var(--admin-primary-light)",
        border: "1px solid color-mix(in srgb, var(--admin-primary) 25%, transparent)",
      }}
    >
      <div className="flex-1 min-w-[240px]">
        <h2 id="ical-nudge-title" className="text-[13.5px] font-bold" style={{ color: "var(--admin-text)" }}>
          Vous êtes aussi sur Airbnb ou Booking ?
        </h2>
        <p className="text-[12.5px] leading-[1.5] mt-0.5" style={{ color: "var(--admin-text-muted)" }}>
          Synchronisez leurs calendriers : les nuits vendues là-bas se bloquent ici, sans double réservation.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href="/admin/parametres?tab=calendriers"
          className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold underline-offset-4 hover:underline"
          style={{ color: "var(--admin-primary)" }}
        >
          Synchroniser mes calendriers
          <Icon.ArrowRight size={14} />
        </Link>
        <form action={dismissIcalNudge}>
          <button
            type="submit"
            className="text-[12.5px] underline underline-offset-2 py-1.5"
            style={{ color: "var(--admin-text-muted)" }}
          >
            Je ne suis pas sur ces plateformes
          </button>
        </form>
      </div>
    </section>
  );
}

function SetupChecklist({ rooms, ical, legal }: { rooms: boolean; ical: boolean; legal: boolean }) {
  const steps = [
    {
      title: "Ajoutez votre première chambre",
      desc: "Nom, capacité et prix par nuit : c'est ce que vos clients verront sur votre site.",
      done: rooms,
      action: { label: "Ajouter une chambre", href: "/admin/chambres/new" },
    },
    {
      title: "Synchronisez vos calendriers Airbnb et Booking",
      desc: "Collez le lien iCal de chaque annonce : les nuits vendues ailleurs se bloquent sur votre site. Pas d'annonce ailleurs ? Passez cette étape.",
      done: ical,
      action: { label: "Ajouter un calendrier", href: "/admin/parametres?tab=calendriers" },
    },
    {
      title: "Publiez vos conditions d'annulation et documents légaux",
      desc: "Choisissez votre niveau d'annulation, complétez SIRET et raison sociale, puis publiez : vos clients les acceptent en payant, et ils vous protègent en cas de litige.",
      done: legal,
      action: { label: "Préparer mes documents", href: "/admin/parametres?tab=documents" },
    },
    {
      title: "Regardez votre site comme vos clients",
      desc: "Cherchez une date et vérifiez que votre chambre s'affiche avec le bon prix.",
      done: false,
      action: { label: "Ouvrir mon site", href: "/", external: true },
    },
  ];
  // Une seule étape mise en avant : la première non faite. Sans chambre, la suite n'a rien à montrer.
  const current = steps.findIndex((s) => !s.done);

  return (
    <Card style={{ padding: "24px 28px" }} className="max-w-[720px]">
      <section aria-labelledby="setup-title" data-setup-checklist>
        <h2
          id="setup-title"
          className="text-[15px] font-extrabold"
          style={{ color: "var(--admin-text)", letterSpacing: "-0.3px" }}
        >
          Mettez votre site en route
        </h2>
        <p className="text-[13.5px] mt-1" style={{ color: "var(--admin-text-muted)" }}>
          Quatre étapes, une vingtaine de minutes. Votre tableau de bord se remplira avec vos premières réservations.
        </p>
        <ol className="mt-6">
          {steps.map((step, i) => {
            const isCurrent = i === current;
            const locked = !rooms && i > 0;
            return (
              <li
                key={step.title}
                className="relative flex gap-4 pb-6 last:pb-0"
                aria-current={isCurrent ? "step" : undefined}
              >
                {i < steps.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute left-[14px] top-8 bottom-1 w-px"
                    style={{ background: step.done ? "var(--admin-primary)" : "var(--admin-border)" }}
                  />
                )}
                <span
                  aria-hidden
                  className="relative flex-shrink-0 w-[29px] h-[29px] rounded-full flex items-center justify-center text-[13px] font-bold tabular-nums"
                  style={
                    step.done
                      ? { background: "var(--admin-primary)", color: "#fff" }
                      : isCurrent
                        ? { background: "var(--admin-primary-light)", color: "var(--admin-primary)", boxShadow: "inset 0 0 0 1.5px var(--admin-primary)" }
                        : { background: "var(--admin-surface)", color: "var(--admin-text-subtle)", boxShadow: "inset 0 0 0 1.5px var(--admin-border)" }
                  }
                >
                  {step.done ? <Icon.Check size={15} /> : i + 1}
                </span>
                <div className="flex-1 min-w-0 pt-[3px]">
                  <p
                    className="text-[13.5px] font-bold leading-snug"
                    style={{ color: locked ? "var(--admin-text-muted)" : "var(--admin-text)" }}
                  >
                    {step.title}
                    {step.done && (
                      <span className="sr-only"> — fait</span>
                    )}
                  </p>
                  {step.done ? (
                    <p className="text-[12.5px] mt-0.5 font-semibold" style={{ color: "var(--admin-primary)" }}>
                      Fait
                    </p>
                  ) : (
                    <>
                      <p className="text-[12.5px] leading-[1.5] mt-0.5 max-w-[60ch]" style={{ color: "var(--admin-text-muted)" }}>
                        {locked ? "Possible dès que votre première chambre existe." : step.desc}
                      </p>
                      {!locked && (
                        <div className="mt-3">
                          {isCurrent && !step.action.external ? (
                            <PrimaryButton href={step.action.href} icon={null}>
                              {step.action.label}
                            </PrimaryButton>
                          ) : (
                            <a
                              href={step.action.href}
                              {...(step.action.external ? { target: "_blank", rel: "noreferrer" } : {})}
                              className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold underline-offset-4 hover:underline"
                              style={{ color: "var(--admin-primary)" }}
                            >
                              {step.action.label}
                              <Icon.ArrowRight size={14} />
                            </a>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </Card>
  );
}

type Movement = {
  id: string;
  guestName: string;
  guestPhone: string | null;
  guestCount: number;
  status: string;
  checkIn: Date;
  checkOut: Date;
  room: { name: string } | null;
};

/** Une ligne de planning : client → détail, badge si non confirmé, appel direct si téléphone. */
function MovementRow({
  b,
  note,
  departure = false,
  showStatus = true,
  showNumber = true,
  noteTone,
  action,
}: {
  b: Movement;
  note?: string;
  departure?: boolean;
  /** Faux dans « À traiter » : la section dit déjà que rien n'est confirmé. */
  showStatus?: boolean;
  /** Faux dans les colonnes étroites : l'icône suffit, le numéro reste dans le libellé accessible. */
  showNumber?: boolean;
  /** Ton de la ligne d'info : « danger » pour un séjour déjà commencé sans confirmation. */
  noteTone?: "danger";
  /** Action en un geste au bout de la ligne (ex. « Confirmer » dans « À traiter »). */
  action?: React.ReactNode;
}) {
  return (
    <li
      className="flex items-center gap-2 -mx-2"
      style={{ borderBottom: "1px solid var(--admin-border-light)" }}
    >
      <Link
        href={`/admin/reservations/${b.id}`}
        className="flex flex-1 min-w-0 items-center gap-3 py-2 px-2 rounded-lg transition-colors hover:bg-[var(--admin-surface-2)]"
      >
        <GuestAvatar
          name={b.guestName}
          size={32}
          {...(departure
            ? { bg: "var(--admin-accent-light)", color: "var(--admin-accent-text)" }
            : {})}
        />
        <div className="flex-1 min-w-0">
          {/* Deux lignes plutôt que « séjour c… » : sur téléphone, l'info utile est en fin de ligne. */}
          <div
            className="text-[13.5px] font-semibold line-clamp-2 break-words"
            style={{ color: "var(--admin-text)" }}
          >
            {b.guestName}
          </div>
          <div
            className="text-[12px]"
            style={{ color: "var(--admin-text-muted)" }}
          >
            {b.room?.name}
            {note && (
              <>
                {" · "}
                <span
                  style={noteTone === "danger" ? { color: "var(--admin-danger)", fontWeight: 600 } : undefined}
                >
                  {note}
                </span>
              </>
            )}
          </div>
        </div>
        {/* Seul un séjour non confirmé mérite l'attention : « Confirmée » sur chaque ligne serait du bruit. */}
        {showStatus && b.status === "pending" && <StatusBadge status="pending" />}
      </Link>
      {b.guestPhone && (
        <a
          href={`tel:${b.guestPhone.replace(/[^\d+]/g, "")}`}
          aria-label={`Appeler ${b.guestName} au ${b.guestPhone}`}
          title={b.guestPhone}
          className="flex-shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12.5px] font-semibold tabular-nums transition-colors hover:bg-[var(--admin-primary-light)]"
          style={{ color: "var(--admin-primary)" }}
        >
          <Icon.Phone size={15} />
          {showNumber && <span className="hidden sm:inline">{b.guestPhone}</span>}
        </a>
      )}
      {action}
    </li>
  );
}

/** « part demain », « part jeudi 30 octobre » : quand la chambre se libère. */
function leavesNote(checkOut: Date) {
  const tomorrow = todayStart();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return new Date(checkOut).toISOString().slice(0, 10) === tomorrow.toISOString().slice(0, 10)
    ? "part demain"
    : `part ${formatDay(checkOut, { weekday: "long", day: "numeric", month: "long" })}`;
}

const stayNote = (b: Movement) => {
  const n = nightsBetween(b.checkIn, b.checkOut);
  return `${n} nuit${n > 1 ? "s" : ""} · ${b.guestCount} pers.`;
};

/** Non confirmées qui arrivent d'ici après-demain (ou déjà arrivées) : la file d'actions du jour. */
function ToHandle({ items }: { items: Movement[] }) {
  const today = parisToday();
  const iso = (d: Date) => new Date(d).toISOString().slice(0, 10);
  return (
    <section
      aria-labelledby="to-handle-title"
      data-to-handle
      className="rounded-[var(--admin-radius)] px-6 py-5"
      style={{ background: "#FEF3C7", border: "1px solid #FCD34D" }}
    >
      <h2 id="to-handle-title" className="text-[15px] font-extrabold" style={{ color: "#92400E", letterSpacing: "-0.3px" }}>
        À traiter · <span className="tabular-nums">{items.length}</span>
      </h2>
      <p className="text-[12.5px] mt-0.5 mb-3" style={{ color: "#92400E" }}>
        Pas encore confirmées ni payées en ligne. Confirmez si le règlement est convenu, sinon appelez le client.
      </p>
      <ul>
        {items.map((b) => {
          const arrival = iso(b.checkIn);
          const departure = iso(b.checkOut);
          const day = (d: Date) => formatDay(d, { day: "numeric", month: "short" });
          // Le passé dit ce qui s'est passé (et alerte) ; seul l'avenir est « prévu ».
          const [when, overdue] =
            departure < today
              ? [`séjour terminé le ${day(b.checkOut)}, jamais confirmé`, true]
              : departure === today
                ? ["départ aujourd'hui, toujours non confirmé", true]
                : arrival < today
                  ? [`séjour commencé le ${day(b.checkIn)}, toujours non confirmé`, true]
                  : arrival === today
                    ? ["arrivée aujourd'hui", false]
                    : [`arrivée ${formatDay(b.checkIn, { weekday: "long", day: "numeric", month: "long" })}`, false];
          return (
            <MovementRow
              key={b.id}
              b={b}
              note={when}
              noteTone={overdue ? "danger" : undefined}
              showStatus={false}
              showNumber={false}
              action={
                <form action={confirmBooking.bind(null, b.id)} className="flex-shrink-0">
                  <button
                    type="submit"
                    aria-label={`Confirmer la réservation de ${b.guestName}`}
                    className="admin-btn"
                    style={{
                      minHeight: 34,
                      padding: "6px 12px",
                      fontSize: 12.5,
                      background: "var(--admin-primary)",
                      color: "#fff",
                      border: "none",
                    }}
                  >
                    Confirmer
                  </button>
                </form>
              }
            />
          );
        })}
      </ul>
    </section>
  );
}

/** Demain → J+7, jour par jour ; seuls les jours avec un mouvement sont listés. */
function WeekPlan({ items }: { items: Movement[] }) {
  // « Aujourd'hui » = la date à Paris, en UTC minuit comme les dates de séjour.
  const first = todayStart();
  const days = Array.from({ length: WEEK_DAYS }, (_, i) => {
    const d = new Date(first);
    d.setUTCDate(d.getUTCDate() + 1 + i);
    return d.toISOString().slice(0, 10);
  });
  const iso = (d: Date) => new Date(d).toISOString().slice(0, 10);
  const plan = days
    .map((day, i) => ({
      day,
      label:
        i === 0
          ? `Demain, ${formatDay(new Date(day), { weekday: "long", day: "numeric", month: "long" })}`
          : formatDay(new Date(day), { weekday: "long", day: "numeric", month: "long" }),
      arrivals: items.filter((b) => iso(b.checkIn) === day),
      departures: items.filter((b) => iso(b.checkOut) === day),
    }))
    .filter((d) => d.arrivals.length + d.departures.length > 0);

  return (
    <Card style={{ padding: "20px 24px" }}>
      <section aria-labelledby="week-title" data-week-plan>
        <h2
          id="week-title"
          className="text-[15px] font-extrabold mb-4"
          style={{ color: "var(--admin-text)", letterSpacing: "-0.3px" }}
        >
          7 prochains jours
        </h2>
        {plan.length === 0 ? (
          <p className="text-[13px] py-2" style={{ color: "var(--admin-text-muted)" }}>
            Aucune arrivée ni aucun départ d&apos;ici une semaine.
          </p>
        ) : (
          <div className="space-y-5">
            {plan.map((d) => (
              <section key={d.day} aria-label={d.label} data-day={d.day}>
                <h3
                  className="text-[12px] font-semibold uppercase tracking-[0.06em] mb-1"
                  style={{ color: "var(--admin-text-muted)" }}
                >
                  {d.label}
                </h3>
                <ul>
                  {d.arrivals.map((b) => (
                    <MovementRow key={`a-${b.id}`} b={b} note={`Arrivée · ${stayNote(b)}`} />
                  ))}
                  {d.departures.map((b) => (
                    <MovementRow key={`d-${b.id}`} b={b} note="Départ · chambre à préparer" departure />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>
    </Card>
  );
}

/** Les chiffres du mois, en marge du planning : utiles, jamais urgents. */
function MonthFigures({
  occupancy,
  monthRevenue,
  channels,
}: {
  occupancy: { occupied: number; total: number; rate: number };
  monthRevenue: number;
  channels: { source: string; count: number }[];
}) {
  const total = channels.reduce((acc, c) => acc + c.count, 0);
  const figures = [
    {
      label: "Occupation ce soir",
      value: `${occupancy.rate} %`,
      sub: `${occupancy.occupied} chambre${occupancy.occupied > 1 ? "s" : ""} sur ${occupancy.total}`,
    },
    { label: "Réservé ce mois", value: formatEuros(monthRevenue), sub: "Réservations confirmées depuis le 1er" },
    { label: "Réservations ce mois", value: String(total), sub: "Tous canaux, hors annulations" },
  ];
  return (
    <Card style={{ padding: "20px 22px" }}>
      <section aria-labelledby="figures-title" data-month-figures>
        <h2
          id="figures-title"
          className="text-[15px] font-extrabold"
          style={{ color: "var(--admin-text)", letterSpacing: "-0.3px" }}
        >
          En chiffres
        </h2>
        <dl className="mt-3">
          {figures.map((f) => (
            <div
              key={f.label}
              className="py-2.5 flex items-baseline justify-between gap-3"
              style={{ borderBottom: "1px solid var(--admin-border-light)" }}
            >
              <dt className="min-w-0">
                <span className="block text-[12.5px] font-semibold" style={{ color: "var(--admin-text)" }}>
                  {f.label}
                </span>
                <span className="block text-[12px]" style={{ color: "var(--admin-text-muted)" }}>
                  {f.sub}
                </span>
              </dt>
              <dd className="text-[15px] font-extrabold tabular-nums whitespace-nowrap" style={{ color: "var(--admin-text)" }}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>

        <h3
          className="text-[12px] font-semibold uppercase tracking-[0.06em] mt-5 mb-2.5"
          style={{ color: "var(--admin-text-muted)" }}
        >
          Réservations par canal
        </h3>
        {channels.length === 0 ? (
          <p className="text-[12.5px]" style={{ color: "var(--admin-text-muted)" }}>
            Aucune réservation ce mois.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {channels.map((ch) => {
              const cfg = CHANNEL_CONFIG[ch.source] ?? CHANNEL_CONFIG.manual;
              const pct = total > 0 ? Math.round((ch.count / total) * 100) : 0;
              return (
                <div key={ch.source}>
                  <div className="flex justify-between text-[12.5px] mb-1">
                    <span className="font-semibold" style={{ color: "var(--admin-text)" }}>
                      {cfg.label}
                    </span>
                    <span className="tabular-nums" style={{ color: "var(--admin-text-muted)" }}>
                      {ch.count} · {pct} %
                    </span>
                  </div>
                  <div className="h-1.5 rounded overflow-hidden" style={{ background: "var(--admin-surface-2)" }}>
                    <div className="h-full rounded" style={{ width: `${pct}%`, background: cfg.color }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </Card>
  );
}

function MovementList({
  label,
  empty,
  items,
  note,
  noteFor,
  departure = false,
}: {
  label: string;
  empty: string;
  items: Movement[];
  note?: string;
  noteFor?: (b: Movement) => string;
  departure?: boolean;
}) {
  return (
    <section aria-label={label}>
      <h2
        className="text-[12px] font-semibold uppercase tracking-[0.06em] mb-2"
        style={{ color: "var(--admin-text-muted)" }}
      >
        {label} · <span className="tabular-nums">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="text-[13px] py-2" style={{ color: "var(--admin-text-muted)" }}>
          {empty}
        </p>
      ) : (
        <ul>
          {items.map((b) => (
            <MovementRow key={b.id} b={b} note={noteFor ? noteFor(b) : note} departure={departure} showNumber={false} />
          ))}
        </ul>
      )}
    </section>
  );
}
