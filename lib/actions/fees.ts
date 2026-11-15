"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { fees, rooms } from "@/db/schema";
import { feeSchema, isUuid, safeParseFormData, type FormResult } from "@/lib/validation";

// Fees (ADR-0011). Modifier ou supprimer un Fee ne touche jamais les réservations
// existantes : elles en gardent une copie.

function revalidate() {
  revalidatePath("/admin/parametres");
  revalidatePath("/chambres", "layout");
}

async function values(tenantId: string, formData: FormData) {
  const parsed = safeParseFormData(feeSchema, formData);
  if ("error" in parsed) return parsed;
  const asked = formData.getAll("roomIds").filter((v): v is string => typeof v === "string" && isUuid(v));
  // Seules les chambres du tenant sont retenues.
  const owned = asked.length
    ? await db.select({ id: rooms.id }).from(rooms).where(and(inArray(rooms.id, asked), eq(rooms.tenantId, tenantId)))
    : [];
  return {
    data: {
      label: parsed.data.label,
      price: parseFloat(parsed.data.price.replace(",", ".")).toFixed(2),
      unit: parsed.data.unit,
      roomIds: owned.map((r) => r.id),
    },
  };
}

export async function createFee(formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  const v = await values(tenantId, formData);
  if ("error" in v) return v;
  await db.insert(fees).values({ tenantId, ...v.data });
  revalidate();
}

export async function updateFee(id: string, formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return { error: "Frais introuvable", fieldErrors: {} };
  const v = await values(tenantId, formData);
  if ("error" in v) return v;
  await db
    .update(fees)
    .set({ ...v.data, updatedAt: new Date() })
    .where(and(eq(fees.id, id), eq(fees.tenantId, tenantId)));
  revalidate();
}

export async function setFeeActive(id: string, active: boolean) {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return;
  await db
    .update(fees)
    .set({ active, updatedAt: new Date() })
    .where(and(eq(fees.id, id), eq(fees.tenantId, tenantId)));
  revalidate();
}

export async function deleteFee(id: string) {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return;
  await db.delete(fees).where(and(eq(fees.id, id), eq(fees.tenantId, tenantId)));
  revalidate();
}
