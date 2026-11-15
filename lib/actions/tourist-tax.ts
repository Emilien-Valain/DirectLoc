"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";
import { safeParseFormData, touristTaxSchema, type FormResult } from "@/lib/validation";
import { mergeTenantConfig } from "@/lib/tenant-config";

/** Réglage de la taxe de séjour (ADR-0011). Les réservations déjà faites gardent leur ligne. */
export async function updateTouristTax(formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  const parsed = safeParseFormData(touristTaxSchema, formData);
  if ("error" in parsed) return parsed;
  const d = parsed.data;
  await db
    .update(tenants)
    .set({ config: mergeTenantConfig({ touristTax: d.mode === "off" ? undefined : d }) })
    .where(eq(tenants.id, tenantId));
  revalidatePath("/admin/parametres");
  revalidatePath("/", "layout");
}
