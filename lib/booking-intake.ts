import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { appliesToRoom } from "@/lib/room-scope";
import { db } from "@/lib/db";
import { bookingLines, extras, fees, rooms, tenants } from "@/db/schema";
import { isRoomAvailable } from "@/lib/availability";
import { validateBookingRules } from "@/lib/booking-rules";
import { calculatePrice, type PriceBreakdown } from "@/lib/pricing";
import {
  bedLimit,
  chosenMax,
  grandTotal,
  resolveChosen,
  priceExtraLine,
  type ExtraLine,
  type StayLine,
} from "@/lib/extras";
import { touristTaxLine } from "@/lib/tourist-tax";
import type { TenantConfig } from "@/lib/tenant-context";
import { isUuid } from "@/lib/validation";

/**
 * Seam d'admission des réservations — voir ADR-0008.
 *
 * Toute création de booking (publique ou manuelle) passe par `admitBooking`.
 * Le gate résout et autorise la chambre, contrôle la disponibilité contre les
 * Holds (lib/holds.ts), valide optionnellement les booking-rules, et calcule le
 * prix. Les appelants ne divergent qu'APRÈS l'admission (public → pending +
 * Stripe ; manuel → confirmed). Lève une erreur explicite (message FR) au rejet.
 *
 * L'insertion (`persist`) se fait DANS la transaction de l'admission, sous un
 * verrou par chambre : deux demandes simultanées sur les mêmes nuits ne peuvent
 * plus passer toutes deux le contrôle de dispo avant que l'une ait écrit.
 */

export type AdmitInput = {
  roomId: string;
  tenantId: string;
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  /** Dont mineurs, exonérés de taxe de séjour (≤ guestCount). */
  childCount?: number;
  /**
   * Extras choisis : id du catalogue, ou id d'une ligne `extra` déjà sur la réservation
   * modifiée (`excludeBookingId`), qui garde alors son prix figé (ADR-0010).
   */
  extraIds?: string[];
  /**
   * Quantité choisie des Extras « par lit », par id (même clé que `extraIds`).
   * Bornée à [1, lits de la chambre] ; absente = tous les lits (ou la quantité déjà enregistrée).
   */
  extraQuantities?: Record<string, number>;
  /**
   * Fees retenus, même convention que `extraIds`. Absent = tous les Fees actifs de la
   * chambre (public) ; l'hôte, lui, envoie ses cases cochées (ADR-0011).
   */
  feeIds?: string[];
  /** Exonération de taxe posée par l'hôte : ligne gardée à 0 €, marquée `exempt`. */
  waiveTax?: boolean;
  /** Hébergement imposé (prix convenu ou ancien prix gardé) ; base de la taxe en %. */
  accommodation?: number;
};

export type AdmitOptions = {
  /** Valide les booking-rules (minStay, jours d'arrivée…). Public: true, manuel: false. */
  enforceRules?: boolean;
  /**
   * Autorise l'admission par-dessus un Hold existant — l'override admin du
   * thread #1. Réservé à l'intake manuel (case « Forcer »). Jamais en public.
   */
  allowOverlap?: boolean;
  /** Modification d'un séjour existant : ses propres nuits ne comptent pas comme un Hold. */
  excludeBookingId?: string;
};

type Room = typeof rooms.$inferSelect;

/**
 * `breakdown` = prix calculé des nuits ; `accommodation` = hébergement facturé
 * (calculé ou imposé) ; `lines` = Extras, Fees, taxe ; `total` = ce qui est encaissé.
 */
export type StayPrice = { breakdown: PriceBreakdown; accommodation: number; lines: StayLine[]; total: number };
export type Admission = StayPrice & { room: Room };

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Les dates chevauchent un Hold existant : l'intake manuel peut alors proposer « Forcer ». */
export class RoomUnavailableError extends Error {
  constructor() {
    super("Chambre non disponible pour ces dates");
    this.name = "RoomUnavailableError";
  }
}

/** Plus de voyageurs que la capacité de la chambre. */
export class CapacityError extends Error {
  constructor(capacity: number) {
    super(`Cette chambre accueille ${capacity} personne${capacity > 1 ? "s" : ""} maximum`);
    this.name = "CapacityError";
  }
}

/** Les dates violent une booking-rule (minStay, jour d'arrivée…) ; le message est prêt à afficher. */
export class BookingRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingRulesError";
  }
}

/** Un Extra demandé est inactif, supprimé ou d'un autre tenant : rien n'est enregistré. */
export class ExtraUnavailableError extends Error {
  constructor() {
    super("Une option choisie n'est plus proposée. Rechargez la page et vérifiez votre sélection.");
    this.name = "ExtraUnavailableError";
  }
}

/** Un Fee coché est inactif, supprimé, d'un autre tenant ou ne concerne pas cette chambre. */
export class FeeUnavailableError extends Error {
  constructor() {
    super("Un frais coché n'est plus appliqué à cette chambre. Rechargez la page.");
    this.name = "FeeUnavailableError";
  }
}

const MAX_EXTRAS = 50;

/**
 * Lignes d'Extras d'un séjour. Une ligne déjà sur la réservation (`bookingId`)
 * garde libellé et prix figés, quantité recalculée — même si l'Extra a été
 * désactivé ou supprimé depuis, ou réservé à d'autres chambres. Tout autre id doit être
 * un Extra actif du tenant, proposé pour cette chambre.
 * Nombre choisi (`quantities`) borné par `chosenMax` : nuits, personnes ou lits du séjour,
 * ou le maximum de l'option « par séjour ». Absent → celui enregistré, sinon tout le séjour.
 */
export async function resolveExtraLines(
  conn: Tx | typeof db,
  { tenantId, roomId, extraIds, nights, guests, bookingId, quantities = {}, maxBeds }: {
    tenantId: string;
    roomId: string;
    extraIds: string[];
    nights: number;
    guests: number;
    bookingId?: string;
    quantities?: Record<string, number>;
    maxBeds: number;
  },
): Promise<ExtraLine[]> {
  const ids = [...new Set(extraIds)];
  if (ids.length === 0) return [];
  if (ids.length > MAX_EXTRAS || !ids.every(isUuid)) throw new ExtraUnavailableError();

  const existing = bookingId
    ? await conn
        .select()
        .from(bookingLines)
        .where(and(eq(bookingLines.bookingId, bookingId), eq(bookingLines.kind, "extra")))
    : [];
  const kept = existing.filter((l) => ids.includes(l.id) || (l.sourceId && ids.includes(l.sourceId)));
  const keptIds = new Set(kept.flatMap((l) => [l.id, l.sourceId]));
  const fromCatalog = ids.filter((id) => !keptIds.has(id));

  const catalog = fromCatalog.length
    ? await conn
        .select()
        .from(extras)
        .where(
          and(
            inArray(extras.id, fromCatalog),
            eq(extras.tenantId, tenantId),
            eq(extras.active, true),
            appliesToRoom(extras.roomIds, roomId),
          ),
        )
    : [];
  if (catalog.length !== fromCatalog.length) throw new ExtraUnavailableError();

  const stay = { nights, guests, beds: maxBeds };
  // Par séjour : maximum actuel de l'option d'origine (supprimée → le nombre déjà enregistré).
  const keptSources = kept.flatMap((l) => (l.unit === "per_stay" && l.sourceId ? [l.sourceId] : []));
  const sourceMax = new Map(
    keptSources.length
      ? (
          await conn
            .select({ id: extras.id, maxQuantity: extras.maxQuantity })
            .from(extras)
            .where(and(inArray(extras.id, keptSources), eq(extras.tenantId, tenantId)))
        ).map((x) => [x.id, x.maxQuantity])
      : [],
  );
  const keptChosen = (l: (typeof existing)[number]) => {
    // Nuits, personnes, lits : bornés par le séjour (il a pu raccourcir). Par séjour : jamais
    // sous le nombre déjà pris, même si l'hôte a baissé le maximum depuis.
    const max = chosenMax({ unit: l.unit, maxQuantity: l.sourceId ? sourceMax.get(l.sourceId) : null }, stay);
    const bound = l.unit === "per_stay" ? Math.max(max, l.chosen ?? 1) : max;
    return resolveChosen(l.unit, bound, quantities[l.id] ?? (l.sourceId ? quantities[l.sourceId] : undefined), l.chosen);
  };
  const newChosen = (x: (typeof catalog)[number]) => resolveChosen(x.unit, chosenMax(x, stay), quantities[x.id]);

  return [
    ...kept.map((l) =>
      priceExtraLine(
        { sourceId: l.sourceId, label: l.label, unit: l.unit, unitPrice: parseFloat(l.unitPrice) },
        stay,
        keptChosen(l),
      ),
    ),
    ...catalog.map((x) =>
      priceExtraLine({ sourceId: x.id, label: x.label, unit: x.unit, unitPrice: parseFloat(x.price) }, stay, newChosen(x)),
    ),
  ];
}

/** Lignes `fee` d'un séjour : Fees actifs de la chambre, ou le choix de l'hôte (voir `AdmitInput.feeIds`). */
async function resolveFeeLines(
  conn: Tx | typeof db,
  { tenantId, roomId, feeIds, nights, guests, bookingId }: {
    tenantId: string;
    roomId: string;
    feeIds?: string[];
    nights: number;
    guests: number;
    bookingId?: string;
  },
): Promise<ExtraLine[]> {
  const catalog = await conn
    .select()
    .from(fees)
    .where(
      and(
        eq(fees.tenantId, tenantId),
        eq(fees.active, true),
        sql`(cardinality(${fees.roomIds}) = 0 or ${roomId}::uuid = any(${fees.roomIds}))`,
      ),
    )
    .orderBy(asc(fees.createdAt));
  const fromCatalog = (f: (typeof catalog)[number]) =>
    priceExtraLine({ sourceId: f.id, label: f.label, unit: f.unit, unitPrice: parseFloat(f.price) }, { nights, guests, beds: 1 });
  if (feeIds === undefined) return catalog.map(fromCatalog);

  const ids = [...new Set(feeIds)];
  if (ids.length > MAX_EXTRAS || !ids.every(isUuid)) throw new FeeUnavailableError();
  const existing = bookingId
    ? await conn
        .select()
        .from(bookingLines)
        .where(and(eq(bookingLines.bookingId, bookingId), eq(bookingLines.kind, "fee")))
    : [];
  const kept = existing.filter((l) => ids.includes(l.id) || (l.sourceId && ids.includes(l.sourceId)));
  const keptIds = new Set(kept.flatMap((l) => [l.id, l.sourceId]));
  const picked = catalog.filter((f) => ids.includes(f.id) && !keptIds.has(f.id));
  if (kept.length + picked.length !== ids.length) throw new FeeUnavailableError();
  return [
    ...kept.map((l) =>
      priceExtraLine({ sourceId: l.sourceId, label: l.label, unit: l.unit, unitPrice: parseFloat(l.unitPrice) }, { nights, guests, beds: 1 }),
    ),
    ...picked.map(fromCatalog),
  ];
}

/**
 * Prix complet d'un séjour : hébergement, Extras, Fees, taxe de séjour. Même calcul
 * pour l'admission et pour le devis du formulaire manuel (affiché == enregistré).
 * La taxe est recalculée avec le réglage actuel du tenant à chaque modification.
 */
export async function priceStay(
  conn: Tx | typeof db,
  input: Omit<AdmitInput, "accommodation"> & { accommodation?: number; bookingId?: string },
): Promise<StayPrice> {
  const { roomId, tenantId, checkIn, checkOut, guestCount, childCount = 0, extraIds = [], bookingId } = input;
  // Séquentiel : `conn` peut être une transaction (une seule connexion, pas de requêtes parallèles).
  const breakdown = await calculatePrice(roomId, tenantId, checkIn, checkOut, conn);
  const [tenant] = await conn.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [room] = await conn
    .select({ beds: rooms.beds, capacity: rooms.capacity })
    .from(rooms)
    .where(and(eq(rooms.id, roomId), eq(rooms.tenantId, tenantId)))
    .limit(1);
  const nights = breakdown.nights.length;
  const stay = { tenantId, nights, guests: guestCount, bookingId };
  const extraLines = await resolveExtraLines(conn, {
    ...stay,
    roomId,
    extraIds,
    quantities: input.extraQuantities,
    maxBeds: room ? bedLimit(room) : 1,
  });
  const feeLines = await resolveFeeLines(conn, { ...stay, roomId, feeIds: input.feeIds });
  const accommodation = input.accommodation ?? breakdown.totalPrice;
  // Prix imposé : réparti également sur les nuits pour la base de la taxe en %.
  const nightPrices = input.accommodation === undefined
    ? breakdown.nights.map((n) => n.price)
    : breakdown.nights.map(() => accommodation / nights);
  const tax = touristTaxLine(
    ((tenant?.config ?? {}) as TenantConfig).touristTax,
    nightPrices,
    guestCount,
    childCount,
    input.waiveTax,
  );
  const lines: StayLine[] = [
    ...extraLines.map((l) => ({ ...l, kind: "extra" as const, exempt: false })),
    ...feeLines.map((l) => ({ ...l, kind: "fee" as const, exempt: false })),
    ...(tax ? [{ ...tax, kind: "tax" as const }] : []),
  ];
  return { breakdown, accommodation, lines, total: grandTotal(accommodation, lines) };
}

/** Remplace toutes les lignes d'une réservation (dans la transaction d'admission). */
export async function saveLines(tx: Tx, bookingId: string, lines: StayLine[]) {
  await tx.delete(bookingLines).where(eq(bookingLines.bookingId, bookingId));
  if (lines.length === 0) return;
  await tx.insert(bookingLines).values(
    lines.map((l) => ({
      bookingId,
      kind: l.kind,
      sourceId: l.sourceId,
      label: l.label,
      unit: l.unit,
      unitPrice: l.unitPrice.toFixed(2),
      chosen: l.chosen ?? null,
      quantity: l.quantity,
      total: l.total.toFixed(2),
      exempt: l.exempt,
    })),
  );
}

export async function admitBooking<T>(
  input: AdmitInput,
  options: AdmitOptions,
  persist: (tx: Tx, admission: Admission) => Promise<T>,
): Promise<T> {
  // Tout passe par `tx` : une admission ne doit jamais réclamer une 2e connexion
  // du pool en tenant déjà la sienne (sinon N admissions simultanées = deadlock).
  return db.transaction(async (tx) => persist(tx, await admitInTx(tx, input, options)));
}

/**
 * Le gate d'admission dans une transaction fournie par l'appelant : un Dossier de plusieurs
 * chambres (ADR-0012) admet chacune dans LA MÊME transaction, tout ou rien. Le verrou de
 * chaque chambre est tenu jusqu'au commit ; l'appelant admet les chambres dans un ordre
 * stable (id croissant) pour que deux Dossiers concurrents ne s'interbloquent pas.
 */
export async function admitInTx(
  tx: Tx,
  input: AdmitInput,
  { enforceRules = false, allowOverlap = false, excludeBookingId }: AdmitOptions,
): Promise<Admission> {
  const { roomId, tenantId, checkIn, checkOut, guestCount } = input;
  // Verrou relâché au commit, donc après l'insertion : l'admission suivante
  // de la même chambre lit la réservation qu'on vient d'écrire.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${roomId}))`);

  // 1. La chambre doit appartenir au tenant et être active (isolation multi-tenant).
  //    Donne à l'intake manuel le contrôle d'ownership qui lui manquait.
  const [room] = await tx
    .select()
    .from(rooms)
    .where(and(eq(rooms.id, roomId), eq(rooms.tenantId, tenantId), eq(rooms.active, true)))
    .limit(1);

  if (!room) {
    throw new Error("Chambre introuvable");
  }
  if (guestCount > room.capacity) {
    throw new CapacityError(room.capacity);
  }

  // 2. Disponibilité (Holds) — sauf override admin explicite.
  if (!allowOverlap) {
    const available = await isRoomAvailable(roomId, tenantId, checkIn, checkOut, tx, excludeBookingId);
    if (!available) {
      throw new RoomUnavailableError();
    }
  }

  // 3. Règles de réservation — public uniquement.
  if (enforceRules) {
    const violations = await validateBookingRules(roomId, tenantId, checkIn, checkOut, tx);
    if (violations.length > 0) {
      throw new BookingRulesError(violations.map((v) => v.message).join(", "));
    }
  }

  // 4. Prix complet (le serveur recalcule tout, aucun montant du formulaire hors prix convenu).
  const price = await priceStay(tx, { ...input, bookingId: excludeBookingId });
  return { room, ...price };
}
