import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { fees, tenants } from "@/db/schema";
import type { ExtraUnit } from "@/lib/extras";
import type { TenantConfig } from "@/lib/tenant-context";
import type { TouristTax } from "@/lib/tourist-tax";

export type CatalogFee = {
  id: string;
  label: string;
  price: number;
  unit: ExtraUnit;
  /** Vide = toutes les chambres. */
  roomIds: string[];
  active: boolean;
};

export async function getFeesByTenant(tenantId: string, { activeOnly = false } = {}): Promise<CatalogFee[]> {
  const rows = await db
    .select()
    .from(fees)
    .where(and(eq(fees.tenantId, tenantId), activeOnly ? eq(fees.active, true) : undefined))
    .orderBy(asc(fees.createdAt));
  return rows.map((f) => ({
    id: f.id,
    label: f.label,
    price: parseFloat(f.price),
    unit: f.unit,
    roomIds: f.roomIds,
    active: f.active,
  }));
}


/** Réglage de taxe de séjour du tenant ; undefined = désactivée. */
export async function getTouristTax(tenantId: string): Promise<TouristTax | undefined> {
  const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return ((t?.config ?? {}) as TenantConfig).touristTax;
}
