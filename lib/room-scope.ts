import { or, sql, type Column } from "drizzle-orm";

/**
 * Règle, blocage ou frais visant cette chambre : sa liste `room_ids` la contient,
 * ou est vide (= toutes les chambres). Un id de chambre supprimée ne matche plus rien.
 */
export function appliesToRoom(roomIds: Column, roomId: string) {
  return or(sql`${roomId}::uuid = ANY(${roomIds})`, sql`cardinality(${roomIds}) = 0`);
}
