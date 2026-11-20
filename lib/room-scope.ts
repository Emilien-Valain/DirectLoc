import { and, eq, inArray, or, sql, type Column } from "drizzle-orm";
import { db } from "@/lib/db";
import { rooms } from "@/db/schema";
import { isUuid } from "@/lib/validation";

/**
 * Règle, blocage ou frais visant cette chambre : sa liste `room_ids` la contient,
 * ou est vide (= toutes les chambres). Un id de chambre supprimée ne matche plus rien.
 */
export function appliesToRoom(roomIds: Column, roomId: string) {
  return or(sql`${roomId}::uuid = ANY(${roomIds})`, sql`cardinality(${roomIds}) = 0`);
}

export const ROOMS_NOT_FOUND = {
  error: "Les chambres choisies n'existent plus. Rechargez la page.",
  fieldErrors: { roomIds: "Les chambres choisies n'existent plus. Rechargez la page." },
};

/**
 * Chambres choisies dans le `RoomPicker` (champs `roomIds`) qui appartiennent bien au tenant ;
 * les autres sont ignorées. Aucune demandée = toutes ([]). Demandées mais aucune à lui :
 * refus — jamais « toutes » par erreur. Partagé par les Règles, les Options et les Frais.
 */
export async function ownedRoomIds(formData: FormData, tenantId: string): Promise<string[] | typeof ROOMS_NOT_FOUND> {
  const asked = formData.getAll("roomIds").filter((v): v is string => typeof v === "string" && v !== "");
  if (asked.length === 0) return [];
  const valid = asked.filter(isUuid);
  const owned = valid.length
    ? await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(inArray(rooms.id, valid), eq(rooms.tenantId, tenantId)))
    : [];
  return owned.length === 0 ? ROOMS_NOT_FOUND : owned.map((r) => r.id);
}
