import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/db/schema";
import { sendBookingCancellation, sendPartialCancellation } from "@/lib/email";
import { loadDossierEmailContext } from "@/lib/queries/bookings";

/**
 * Point d'appel UNIQUE des emails client après une annulation par l'hôte (ADR-0012) :
 * une chambre seule (fiche réservation ou fiche Dossier) ou tout le Dossier.
 *
 * `scope` dit ce qui reste : « partial » = d'autres chambres du Dossier restent
 * actives → un email « annulation partielle » (chambres annulées, maintenues, nouveau
 * total) ; « total » = plus rien d'actif → UN email d'annulation pour les chambres
 * annulées. Retourne `true` si le client a bien été prévenu.
 */
export async function notifyHostCancellation(
  tenantId: string,
  dossierId: string,
  cancelledBookingIds: string[],
): Promise<boolean> {
  if (cancelledBookingIds.length === 0) return true;
  try {
    const stillActive = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.dossierId, dossierId),
          eq(bookings.tenantId, tenantId),
          inArray(bookings.status, ["pending", "confirmed"]),
        ),
      );
    const cancelled = await loadDossierEmailContext(cancelledBookingIds, tenantId);
    if (!cancelled) return false;
    const { rooms, ...stay } = cancelled.emailData;

    if (stillActive.length === 0) {
      await sendBookingCancellation({ ...stay, roomNames: rooms.map((r) => r.roomName), reason: "admin" });
      return true;
    }

    const kept = await loadDossierEmailContext(
      stillActive.map((b) => b.id),
      tenantId,
    );
    if (!kept) return false;
    await sendPartialCancellation({
      ...stay,
      cancelledRooms: rooms.map((r) => ({ name: r.roomName, total: r.totalPrice })),
      keptRooms: kept.emailData.rooms.map((r) => ({ name: r.roomName, total: r.totalPrice })),
      newTotal: kept.emailData.totalPrice,
    });
    return true;
  } catch (emailError) {
    console.error("Erreur envoi email annulation:", emailError);
    return false;
  }
}
