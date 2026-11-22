/**
 * Réseau des Voisins (ADR-0013) — LA SEULE lecture entre tenants de l'application.
 *
 * Pour un séjour et un tenant d'origine, renvoie les Voisins et, pour chacun, s'il peut loger
 * tout le groupe ou sa capacité maximale. La réponse est un DRY RUN de l'admission du Voisin
 * (ses chambres libres + ses propres règles de réservation, puis le moteur de combinaison) :
 * rien n'est écrit, aucune réservation, aucun Dossier ni voyageur n'est lu en sortie.
 * Sortie volontairement réduite à des faits publics (type `Voisin`).
 */
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers, referrals, tenants } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { DEMO_TENANT_SLUG } from "@/lib/demo";
import { loadRoomCandidates } from "@/lib/room-combination-candidates";
import { suggestCombination } from "@/lib/room-combination";
import { gpsOf, isNetworkMember, planShare, selectNearbyTenants, type NetworkTenantRow, type SharePlan } from "@/lib/network-geo";
import type { TenantConfig } from "@/lib/tenant-context";

/** Tout ce qui traverse la frontière entre tenants. Ne rien ajouter sans réviser l'ADR-0013. */
export interface Voisin {
  name: string;
  city: string | null;
  distanceKm: number;
  photoUrl: string | null;
  phone: string | null;
  slug: string;
  domain: string;
  /** Le Voisin peut admettre tout le groupe aux dates demandées. */
  fitsWholeGroup: boolean;
  /** Personnes qu'il peut loger au maximum (≥ le groupe quand `fitsWholeGroup`). */
  maxCapacity: number;
}

export interface VoisinQuery {
  originTenantId: string;
  checkIn: Date;
  checkOut: Date;
  adults: number;
  minors: number;
}

const toRow = (t: { id: string; slug: string; name: string; domain: string | null; config: unknown }): NetworkTenantRow => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  domain: t.domain,
  config: (t.config ?? {}) as TenantConfig,
});

const COLUMNS = { id: tenants.id, slug: tenants.slug, name: tenants.name, domain: tenants.domain, config: tenants.config };

/** L'hôtel de démonstration n'est jamais dans le réseau : ni Voisin, ni origine. */
const notDemo = (t: { slug: string }) => !DEMO_TENANT_SLUG || t.slug !== DEMO_TENANT_SLUG;

/** Voisins possibles (sans dry run) de l'hôtel `originTenantId` ; vide si origine inconnue, démo ou hors réseau. */
async function nearbyOf(originTenantId: string) {
  const [originRow] = await db.select(COLUMNS).from(tenants).where(eq(tenants.id, originTenantId)).limit(1);
  if (!originRow || !notDemo(originRow)) return { origin: null, nearby: [] };
  const everyone = await db.select(COLUMNS).from(tenants);
  return { origin: toRow(originRow), nearby: selectNearbyTenants(toRow(originRow), everyone.filter(notDemo).map(toRow)) };
}

/**
 * Le Voisin `slug` de l'hôtel `originTenantId`, ou null (slug inconnu, hors réseau, démo, origine
 * hors réseau). C'est le garde de `/voisin/<slug>` et de `via`.
 */
export async function getVoisinTarget(originTenantId: string, slug: string) {
  const { origin, nearby } = await nearbyOf(originTenantId);
  const hit = nearby.find((n) => n.row.slug === slug);
  return origin && hit ? { origin, target: hit.row } : null;
}

/** `via=<slug>` d'une réservation chez `hostTenantId` : id du Voisin d'origine, ou null (ignoré). */
export async function resolveVia(via: unknown, hostTenantId: string): Promise<string | null> {
  if (typeof via !== "string" || !/^[a-z0-9-]{1,63}$/.test(via)) return null;
  // Réciproque : si `via` est dans le réseau de l'hôte, l'hôte est dans le sien.
  const hit = await getVoisinTarget(hostTenantId, via);
  return hit ? hit.target.id : null;
}

/**
 * Voisins membres de l'hôtel `tenantId`, du plus proche au plus lointain : la liste de la case
 * admin « Venu par le réseau ». Faits publics seulement (id interne pour le formulaire).
 */
export async function listNetworkVoisins(tenantId: string) {
  const { nearby } = await nearbyOf(tenantId);
  return nearby.map(({ row, distanceKm }) => ({ id: row.id, name: row.name, city: row.config?.city?.trim() || null, distanceKm }));
}

/** Id de Voisin choisi par l'admin de `hostTenantId` : le même id s'il est membre de son réseau, sinon null. */
export async function resolveVoisinId(id: unknown, hostTenantId: string): Promise<string | null> {
  if (typeof id !== "string" || !isUuid(id)) return null;
  const { nearby } = await nearbyOf(hostTenantId);
  return nearby.some((n) => n.row.id === id) ? id : null;
}

/**
 * Enregistre un Renvoi : aucune donnée voyageur, seulement le séjour cherché. Partage d'un groupe :
 * `fromDossierId` = le Dossier de l'hôte qui envoie, gardé seulement s'il est bien à lui et aux
 * mêmes dates (il sert à prévenir les deux hôtes quand les deux Dossiers sont confirmés).
 */
export async function recordReferral(r: {
  fromTenantId: string;
  toTenantId: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  kind: "full" | "shared";
  fromDossierId?: string | null;
}) {
  let fromDossierId: string | null = null;
  if (r.kind === "shared" && r.fromDossierId && isUuid(r.fromDossierId)) {
    const [own] = await db
      .select({ id: dossiers.id })
      .from(dossiers)
      .where(
        and(
          eq(dossiers.id, r.fromDossierId),
          eq(dossiers.tenantId, r.fromTenantId),
          eq(dossiers.checkIn, r.checkIn),
          eq(dossiers.checkOut, r.checkOut),
        ),
      )
      .limit(1);
    fromDossierId = own?.id ?? null;
  }
  await db.insert(referrals).values({ ...r, fromDossierId });
}

function toVoisin(row: NetworkTenantRow, distanceKm: number, result: ReturnType<typeof suggestCombination>): Voisin {
  const config = row.config ?? {};
  return {
    name: row.name,
    city: config.city?.trim() || null,
    distanceKm,
    photoUrl: config.heroPhoto?.url ?? config.galleryPhotos?.[0]?.url ?? null,
    phone: config.phone?.trim() || null,
    slug: row.slug,
    domain: row.domain!,
    fitsWholeGroup: result.ok,
    maxCapacity: result.ok ? result.totalCapacity : result.maxCapacity,
  };
}

export async function findVoisins(q: VoisinQuery): Promise<Voisin[]> {
  const { nearby } = await nearbyOf(q.originTenantId);

  return Promise.all(
    nearby.map(async ({ row, distanceKm }) =>
      toVoisin(row, distanceKm, suggestCombination(await loadRoomCandidates(row.id, q.checkIn, q.checkOut), q.adults, q.minors)),
    ),
  );
}

export interface ShareProposal {
  voisin: Voisin;
  plan: SharePlan;
}

/**
 * Partage : l'hôte loge N personnes (son maximum aux dates, moteur de combinaison), UN seul Voisin
 * les M autres. Le Voisin le plus proche qui peut loger le reste ; null s'il n'y en a aucun
 * (aucune proposition de partage). Dry run, rien n'est écrit.
 */
export async function findShareProposal(q: VoisinQuery): Promise<ShareProposal | null> {
  const { nearby } = await nearbyOf(q.originTenantId);
  if (nearby.length === 0) return null;
  const hostCandidates = await loadRoomCandidates(q.originTenantId, q.checkIn, q.checkOut);
  const hostResult = suggestCombination(hostCandidates, q.adults, q.minors);
  if (hostResult.ok) return null; // l'hôte loge tout le groupe : pas de partage
  const hostMax = hostResult.maxCapacity;
  if (hostMax < 1) return null;
  const hostFits = (a: number, m: number) => suggestCombination(hostCandidates, a, m).ok;
  for (const { row, distanceKm } of nearby) {
    const candidates = await loadRoomCandidates(row.id, q.checkIn, q.checkOut);
    const plan = planShare(q.adults, q.minors, hostMax, hostFits, (a, m) => suggestCombination(candidates, a, m).ok);
    if (plan) return { plan, voisin: toVoisin(row, distanceKm, suggestCombination(candidates, plan.rest.adults, plan.rest.minors)) };
  }
  return null;
}

export interface ShareFollowUp {
  /** Voisin à qui renvoyer le reste du groupe (revérifié à l'instant), sinon null. */
  voisin: Voisin | null;
  /** Vrai si ce n'est pas le Voisin proposé au départ. */
  other: boolean;
}

/**
 * Page de confirmation : revérifie en direct si le Voisin proposé loge encore le reste ; sinon le
 * Voisin le plus proche qui le peut ; sinon null (l'appelant montre le téléphone de l'hôte).
 */
export async function recheckShare(q: VoisinQuery, preferredSlug: string): Promise<ShareFollowUp> {
  const fits = (await findVoisins(q)).filter((v) => v.fitsWholeGroup);
  const preferred = fits.find((v) => v.slug === preferredSlug);
  const voisin = preferred ?? fits[0] ?? null;
  return { voisin, other: !!voisin && !preferred };
}

/** Au plus 3 Voisins qui logent tout le groupe, du plus proche au plus lointain (≤ 30 km d'abord, complétés au-delà). */
export function pickVoisins(voisins: Voisin[], max = 3): Voisin[] {
  return voisins.filter((v) => v.fitsWholeGroup).slice(0, max);
}

export interface NearbySlot {
  checkIn: string;
  checkOut: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Jusqu'à 3 créneaux de même durée, arrivée à ±7 jours des dates demandées, où l'hôtel `tenantId`
 * loge tout le groupe (ses propres règles incluses). Les plus proches des dates demandées d'abord ;
 * jamais dans le passé (`today` = AAAA-MM-JJ à Paris).
 */
export async function findNearbySlots(q: Omit<VoisinQuery, "originTenantId"> & { tenantId: string; today: string }, max = 3): Promise<NearbySlot[]> {
  const nights = Math.round((q.checkOut.getTime() - q.checkIn.getTime()) / 86_400_000);
  const shifts = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7];
  const tries = shifts
    .map((d) => {
      const checkIn = new Date(q.checkIn.getTime() + d * 86_400_000);
      return { checkIn, checkOut: new Date(checkIn.getTime() + nights * 86_400_000) };
    })
    .filter((t) => iso(t.checkIn) >= q.today);
  const ok = await Promise.all(
    tries.map(async (t) => suggestCombination(await loadRoomCandidates(q.tenantId, t.checkIn, t.checkOut), q.adults, q.minors).ok),
  );
  return tries.filter((_, i) => ok[i]).slice(0, max).map((t) => ({ checkIn: iso(t.checkIn), checkOut: iso(t.checkOut) }));
}

// ─── Compteur et Bilan (issue 05) ────────────────────────────────────────────

export interface NetworkCounts {
  /** Renvois dont le tenant est l'envoyeur (referrals.from_tenant_id). */
  sent: number;
  /** Renvois dont le tenant est le Voisin receveur (referrals.to_tenant_id). */
  received: number;
  /** Dossiers confirmés/terminés attribués au réseau dans lesquels le tenant est l'envoyeur OU le receveur. */
  bookings: number;
}

/**
 * Chiffres du tenant sur [from, to[ (dates UTC, `createdAt` du Renvoi / du Dossier), `null` = sans borne.
 * Seulement SES chiffres : jamais un total du réseau, jamais un détail d'un autre tenant (des comptes).
 */
export async function networkCounts(tenantId: string, from: Date | null, to: Date | null): Promise<NetworkCounts> {
  const win = (col: typeof referrals.createdAt | typeof dossiers.createdAt) => [from ? gte(col, from) : undefined, to ? lt(col, to) : undefined];
  const [r] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${referrals.fromTenantId} = ${tenantId})::int`,
      received: sql<number>`count(*) filter (where ${referrals.toTenantId} = ${tenantId})::int`,
    })
    .from(referrals)
    .where(and(or(eq(referrals.fromTenantId, tenantId), eq(referrals.toTenantId, tenantId)), ...win(referrals.createdAt)));
  const [d] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dossiers)
    .where(
      and(
        or(eq(dossiers.tenantId, tenantId), eq(dossiers.referredByTenantId, tenantId)),
        sql`${dossiers.referredByTenantId} is not null`,
        sql`exists (select 1 from ${bookings} where ${bookings.dossierId} = ${dossiers.id} and ${inArray(bookings.status, ["confirmed", "completed"])})`,
        ...win(dossiers.createdAt),
      ),
    );
  return { sent: r?.sent ?? 0, received: r?.received ?? 0, bookings: d?.n ?? 0 };
}

/** Le tenant est-il dans le réseau, et sinon pourquoi (sans GPS / désactivé par l'opérateur). */
export async function networkStatus(tenantId: string): Promise<{ member: boolean; missingGps: boolean; disabled: boolean }> {
  const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const config = (t?.config ?? {}) as TenantConfig;
  return { member: isNetworkMember(config), missingGps: gpsOf(config) === null, disabled: config.networkEnabled === false };
}
