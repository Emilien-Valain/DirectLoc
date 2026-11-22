import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers } from "@/db/schema";
import { admitInTx, type Admission, type AdmitInput, type AdmitOptions, type Tx } from "@/lib/booking-intake";

/**
 * Dossier (ADR-0012) : un séjour réservé en une fois, une réservation par chambre,
 * mêmes dates, même voyageur, un seul paiement. Le voyageur et les dates sont aussi
 * recopiés sur chaque réservation (lus par listes, emails, PDF, iCal).
 */

type Conn = Tx | typeof db;

export type DossierValues = {
  tenantId: string;
  checkIn: Date;
  checkOut: Date;
  guestName: string;
  guestFirstName?: string;
  guestLastName?: string;
  guestEmail: string;
  guestPhone?: string | null;
  guestAddress?: string | null;
  guestCountry?: string | null;
  /** Preuve d'acceptation des conditions au paiement (lib/legal-settings.ts `acceptedTermsFor`). */
  cancellationLevel?: "flexible" | "moderate" | "strict" | "custom" | null;
  acceptedCancellationText?: string | null;
  acceptedCgvText?: string | null;
  termsAcceptedAt?: Date | null;
  /** Voisin qui a renvoyé le voyageur (déjà vérifié par `resolveVia`), sinon null. */
  referredByTenantId?: string | null;
};

/** Crée le Dossier (à appeler dans la transaction d'admission, avant d'insérer ses réservations). */
export async function createDossier(conn: Conn, values: DossierValues): Promise<string> {
  const [row] = await conn.insert(dossiers).values(values).returning({ id: dossiers.id });
  return row.id;
}

/** Réservations d'un Dossier du tenant, dans l'ordre de création (vide si le Dossier est d'un autre tenant). */
export async function getDossierBookingIds(dossierId: string, tenantId: string, conn: Conn = db) {
  const rows = await conn
    .select({ id: bookings.id })
    .from(bookings)
    .innerJoin(dossiers, eq(dossiers.id, bookings.dossierId))
    .where(and(eq(bookings.dossierId, dossierId), eq(dossiers.tenantId, tenantId), eq(bookings.tenantId, tenantId)))
    .orderBy(asc(bookings.createdAt), asc(bookings.id));
  return rows.map((r) => r.id);
}

/**
 * Paiement abouti : toutes les réservations `pending` du Dossier passent `confirmed`
 * (transition gardée, ADR-0003 : une chambre annulée entre-temps le reste).
 * Retourne les réservations réellement transitionnées.
 */
export async function confirmDossier(dossierId: string, tenantId: string) {
  return transitionPending(dossierId, tenantId, "confirmed");
}

/** Paiement expiré : toutes les réservations `pending` du Dossier passent `cancelled`. */
export async function cancelPendingDossier(dossierId: string, tenantId: string) {
  return transitionPending(dossierId, tenantId, "cancelled");
}

async function transitionPending(dossierId: string, tenantId: string, status: "confirmed" | "cancelled") {
  const rows = await db
    .update(bookings)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId), eq(bookings.status, "pending")))
    .returning({ id: bookings.id });
  return rows.map((r) => r.id);
}

/** Une chambre refusée à l'admission d'un Dossier : laquelle, et pourquoi (l'erreur du gate). */
export class RoomRefused extends Error {
  constructor(
    readonly roomId: string,
    readonly reason: unknown,
  ) {
    super("Chambre refusée");
    this.name = "RoomRefused";
  }
}

/**
 * Admission de toutes les chambres d'un Dossier dans la transaction `tx` (ADR-0012, tout ou
 * rien). Ordre stable (id croissant) : deux Dossiers concurrents prennent les verrous de
 * chambre dans le même ordre, sans s'interbloquer. Une chambre refusée → `RoomRefused`
 * (l'appelant laisse la transaction échouer : rien n'est créé). Résultat indexé par chambre.
 * `options` par chambre : un changement de dates exclut la propre réservation de chaque chambre.
 */
export async function admitRoomsInTx<R extends { roomId: string }>(
  tx: Tx,
  rooms: R[],
  input: (room: R) => AdmitInput,
  options: AdmitOptions | ((room: R) => AdmitOptions),
): Promise<Map<string, Admission>> {
  const byRoom = new Map<string, Admission>();
  for (const r of [...rooms].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0))) {
    try {
      byRoom.set(r.roomId, await admitInTx(tx, input(r), typeof options === "function" ? options(r) : options));
    } catch (e) {
      throw new RoomRefused(r.roomId, e);
    }
  }
  return byRoom;
}
