import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { rooms } from "@/db/schema";
import { blockedDates } from "@/lib/holds";
import { validateBookingRules } from "@/lib/booking-rules";
import { calculatePrice } from "@/lib/pricing";
import type { RoomCandidate } from "@/lib/room-combination";

/**
 * Adaptateur serveur : construit les candidats du moteur (lib/room-combination.ts) pour un
 * tenant. Ne garde que les chambres actives libres sur [checkIn, checkOut) (Holds, ADR-0007) ;
 * une chambre libre mais refusée par une règle (nuits min, jours d'arrivée…) est renvoyée
 * avec `excludedReason`. N'ajoute aucune logique : tout vient des fonctions existantes.
 */
/** Candidat + ce qu'affiche le formulaire public : nom et prix de chaque nuit (base de la taxe en %). */
export type LoadedCandidate = RoomCandidate & { name: string; nightPrices: number[] };

export async function loadRoomCandidates(
  tenantId: string,
  checkIn: Date,
  checkOut: Date,
): Promise<LoadedCandidate[]> {
  const all = await db
    .select({ id: rooms.id, name: rooms.name, capacity: rooms.capacity })
    .from(rooms)
    .where(and(eq(rooms.tenantId, tenantId), eq(rooms.active, true)))
    .orderBy(asc(rooms.createdAt));
  const window = { start: checkIn, end: checkOut };

  const out = await Promise.all(
    all.map(async (room): Promise<LoadedCandidate | null> => {
      const held = await blockedDates(room.id, tenantId, window);
      if (held.size > 0) return null;
      const [violations, price] = await Promise.all([
        validateBookingRules(room.id, tenantId, checkIn, checkOut),
        calculatePrice(room.id, tenantId, checkIn, checkOut),
      ]);
      return {
        id: room.id,
        name: room.name,
        capacity: room.capacity,
        totalPrice: price.totalPrice,
        nightPrices: price.nights.map((n) => n.price),
        excludedReason: violations[0]?.message,
      };
    }),
  );
  return out.filter((r): r is LoadedCandidate => r !== null);
}
