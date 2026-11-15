import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";

// Hôtel de démonstration public (site vitrine → « Essayer »). Désigné par l'env, jamais
// par un réglage en base, pour qu'aucun visiteur de l'admin démo ne puisse le désactiver.
export const DEMO_TENANT_SLUG = process.env.DEMO_TENANT_SLUG || null;

export async function isDemoTenant(tenantId: string): Promise<boolean> {
  if (!DEMO_TENANT_SLUG) return false;
  const [row] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row?.slug === DEMO_TENANT_SLUG;
}

/** Compte admin de l'hôtel démo (seedé par lib/demo-seed.ts, connecté par /essayer). */
export function demoUserEmail(): string {
  return `demo@${process.env.DEMO_TENANT_DOMAIN || "demo.local"}`;
}
