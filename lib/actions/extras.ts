"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { extras } from "@/db/schema";
import { ownedRoomIds } from "@/lib/room-scope";
import { extraSchema, isUuid, safeParseFormData, type FormResult } from "@/lib/validation";

// Catalogue d'Extras (ADR-0010). Modifier ou supprimer un Extra ne touche jamais
// les réservations existantes : elles en gardent une copie.

function revalidate() {
  revalidatePath("/admin/parametres");
  revalidatePath("/reserver", "layout");
}

function values(roomIds: string[], data: {
  label: string;
  description?: string;
  price: string;
  unit: (typeof extras.$inferInsert)["unit"];
  maxQuantity: number | null;
}) {
  return {
    label: data.label,
    description: data.description || null,
    price: parseFloat(data.price.replace(",", ".")).toFixed(2),
    unit: data.unit,
    // Seul « par séjour » a un maximum ; les autres unités sont bornées par le séjour.
    maxQuantity: data.unit === "per_stay" ? data.maxQuantity : null,
    roomIds,
  };
}

export async function createExtra(formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  const parsed = safeParseFormData(extraSchema, formData);
  if ("error" in parsed) return parsed;
  const roomIds = await ownedRoomIds(formData, tenantId);
  if ("error" in roomIds) return roomIds;
  await db.insert(extras).values({ tenantId, ...values(roomIds, parsed.data) });
  revalidate();
}

export async function updateExtra(id: string, formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return { error: "Option introuvable", fieldErrors: {} };
  const parsed = safeParseFormData(extraSchema, formData);
  if ("error" in parsed) return parsed;
  const roomIds = await ownedRoomIds(formData, tenantId);
  if ("error" in roomIds) return roomIds;
  await db
    .update(extras)
    .set({ ...values(roomIds, parsed.data), updatedAt: new Date() })
    .where(and(eq(extras.id, id), eq(extras.tenantId, tenantId)));
  revalidate();
}

export async function setExtraActive(id: string, active: boolean) {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return;
  await db
    .update(extras)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(extras.id, id), eq(extras.tenantId, tenantId)));
  revalidate();
}

export async function deleteExtra(id: string) {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return;
  // Les lignes des réservations passent à source_id NULL (copie conservée).
  await db.delete(extras).where(and(eq(extras.id, id), eq(extras.tenantId, tenantId)));
  revalidate();
}
