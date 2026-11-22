/**
 * Bilan mensuel du réseau des Voisins (issue reseau-voisins/05) : appelé par le cron du 1er du mois.
 * Un email par administrateur du tenant, seulement s'il y a eu ≥ 1 Renvoi envoyé ou reçu le mois précédent.
 * Idempotent : la ligne `network_reports (tenant, mois)` est réservée avant l'envoi, un rejeu du cron n'envoie rien.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { networkReports, tenants } from "@/db/schema";
import { networkCounts } from "@/lib/network";
import { sendNetworkMonthlyReport } from "@/lib/email";
import { tenantAdminEmails } from "@/lib/refund-sync";
import { DEMO_TENANT_SLUG } from "@/lib/demo";
import { startOfMonth } from "@/lib/date-windows";
import type { TenantConfig } from "@/lib/tenant-context";

/** Fenêtre UTC du mois précédent `now` : [1er minuit, 1er du mois courant minuit[ et son code « YYYY-MM ». */
export function previousMonthWindow(now: Date = new Date()) {
  const to = startOfMonth(now);
  const from = new Date(to);
  from.setUTCMonth(from.getUTCMonth() - 1);
  const month = from.toISOString().slice(0, 7);
  const monthLabel = from.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  return { from, to, month, monthLabel };
}

export async function sendMonthlyNetworkReports(now: Date = new Date()) {
  const { from, to, month, monthLabel } = previousMonthWindow(now);
  const out = { month, reported: 0, skipped: 0, errors: 0 };
  const all = await db.select({ id: tenants.id, slug: tenants.slug, name: tenants.name, config: tenants.config }).from(tenants);
  for (const t of all) {
    if (DEMO_TENANT_SLUG && t.slug === DEMO_TENANT_SLUG) continue;
    try {
      const c = await networkCounts(t.id, from, to);
      if (c.sent + c.received === 0) {
        out.skipped++;
        continue;
      }
      const [claimed] = await db.insert(networkReports).values({ tenantId: t.id, month }).onConflictDoNothing().returning({ id: networkReports.id });
      if (!claimed) {
        out.skipped++;
        continue;
      }
      try {
        for (const adminEmail of await tenantAdminEmails(t.id)) {
          await sendNetworkMonthlyReport({ adminEmail, tenantId: t.id, hotelName: t.name, config: (t.config ?? {}) as TenantConfig, monthLabel, ...c });
        }
        out.reported++;
      } catch (e) {
        // Envoi raté : on libère la réservation pour que le prochain passage réessaie.
        await db.delete(networkReports).where(eq(networkReports.id, claimed.id));
        throw e;
      }
    } catch (e) {
      console.error(`[network-report] Bilan du tenant ${t.id} en erreur`, e);
      out.errors++;
    }
  }
  return out;
}
