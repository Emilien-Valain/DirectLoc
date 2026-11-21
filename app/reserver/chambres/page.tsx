import type { Metadata } from "next";
import Link from "next/link";
import { tenantIcons } from "@/lib/seo";
import PublicLayout from "@/components/public/PublicLayout";
import DossierForm from "@/components/public/DossierForm";
import { Breadcrumb } from "@/components/public/Site";
import { requireTenant, type TenantConfig } from "@/lib/tenant-context";
import { getRoomsPublic } from "@/lib/queries/public";
import { getExtrasByTenant } from "@/lib/queries/extras";
import { getFeesByTenant } from "@/lib/queries/fees";
import { isDemoTenant } from "@/lib/demo";
import { parisToday } from "@/lib/date-windows";
import { isStayTooLong, MAX_PARTY } from "@/lib/validation";
import { loadRoomCandidates } from "@/lib/room-combination-candidates";
import { distributeGuests, ruleReasons, suggestCombination } from "@/lib/room-combination";
import { noCombinationMessage } from "@/lib/dossier-messages";

// Tunnel de réservation : rien à indexer.
export async function generateMetadata(): Promise<Metadata> {
  const icons = tenantIcons(((await requireTenant()).config ?? {}) as TenantConfig);
  return { robots: { index: false, follow: false }, ...(icons ? { icons } : {}) };
}

type Params = Record<string, string | string[] | undefined>;

const isoDate = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(v + "T00:00:00Z").toISOString().startsWith(v);

const count = (v: unknown, min: number) => {
  const n = typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min ? n : null;
};

/**
 * Réserver plusieurs chambres en une fois (Dossier, ADR-0012) — le voyageur y voit
 * « votre réservation », jamais le mot Dossier. Arrive depuis la recherche de l'accueil
 * avec dates, adultes, enfants et, éventuellement, les chambres proposées (`rooms`).
 * Paramètres absents ou invalides : on renvoie vers la recherche, jamais une 500.
 */
export default async function ReserverChambresPage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const tenant = await requireTenant();
  const config = (tenant.config ?? {}) as TenantConfig;

  const adults = count(sp.adults, 1);
  const minors = sp.minors === undefined ? 0 : count(sp.minors, 0);
  const checkIn = sp.checkIn;
  const checkOut = sp.checkOut;
  const datesOk =
    isoDate(checkIn) &&
    isoDate(checkOut) &&
    checkOut > checkIn &&
    checkIn >= parisToday() &&
    !isStayTooLong(new Date(checkIn + "T00:00:00Z"), new Date(checkOut + "T00:00:00Z"));
  const partyOk = adults !== null && minors !== null && adults + minors <= MAX_PARTY;

  if (!datesOk || !partyOk) {
    return (
      <Shell>
        <p className="s-alert is-bad" data-testid="dossier-invalid">
          {!datesOk
            ? "Choisissez vos dates d'arrivée et de départ pour voir les chambres libres."
            : `Indiquez le nombre de voyageurs : au moins un adulte, ${MAX_PARTY} personnes au plus.`}
        </p>
        <Link href="/#dates" className="s-btn">
          Choisir mes dates
        </Link>
      </Shell>
    );
  }

  const from = new Date(checkIn + "T00:00:00Z");
  const to = new Date(checkOut + "T00:00:00Z");
  const [candidates, allRooms, extras, fees, demo] = await Promise.all([
    loadRoomCandidates(tenant.id, from, to),
    getRoomsPublic(tenant.id),
    getExtrasByTenant(tenant.id, { activeOnly: true }),
    getFeesByTenant(tenant.id, { activeOnly: true }),
    isDemoTenant(tenant.id),
  ]);
  const usable = candidates.filter((c) => !c.excludedReason);
  const details = new Map(allRooms.map((r) => [r.id, r]));

  // Chambres demandées encore libres (doublons et chambres inconnues ignorés), sinon la suggestion.
  const asked = typeof sp.rooms === "string" ? [...new Set(sp.rooms.split(","))].slice(0, 30) : [];
  const kept = asked.flatMap((id) => usable.filter((c) => c.id === id));
  let initial = kept.length > 0 ? distributeGuests(kept, adults, minors) : [];
  if (initial.length === 0) {
    const suggestion = suggestCombination(candidates, adults, minors);
    if (!suggestion.ok) {
      return (
        <Shell>
          <p className="s-alert is-bad" data-testid="dossier-none">
            {noCombinationMessage(suggestion.reason, adults + minors, adults, suggestion.maxCapacity, ruleReasons(candidates))}
          </p>
          <Link href="/#dates" className="s-btn">
            Changer de dates
          </Link>
        </Shell>
      );
    }
    initial = suggestion.rooms;
  }

  const nights = Math.round((to.getTime() - from.getTime()) / 86_400_000);

  return (
    <Shell>
      <DossierForm
        checkIn={checkIn}
        checkOut={checkOut}
        nights={nights}
        adults={adults}
        minors={minors}
        rooms={usable.map((c) => {
          const d = details.get(c.id);
          return {
            id: c.id,
            name: c.name,
            capacity: c.capacity,
            beds: d?.beds ?? null,
            photos: d?.photos ?? null,
            totalPrice: c.totalPrice,
            nightPrices: c.nightPrices,
          };
        })}
        initial={initial.map((r) => ({ roomId: r.roomId, adults: r.adults, minors: r.minors }))}
        dropped={asked.length > kept.length}
        cancelled={sp.cancelled === "true"}
        extras={extras}
        fees={fees}
        touristTax={config.touristTax}
        host={{ phone: config.phone, checkInTime: config.checkInTime, checkOutTime: config.checkOutTime }}
        demo={demo}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <PublicLayout>
      <div className="s-page">
        <Breadcrumb items={[{ href: "/", label: "Accueil" }, { label: "Réserver" }]} />
        <h1 className="s-h1">Réserver vos chambres</h1>
        {children}
      </div>
    </PublicLayout>
  );
}
