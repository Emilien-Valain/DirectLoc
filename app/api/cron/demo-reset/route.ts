import { NextRequest, NextResponse } from "next/server";
import { resetDemoTenant } from "@/lib/demo-seed";

/**
 * GET /api/cron/demo-reset
 *
 * Remet l'hôtel démo (DEMO_TENANT_SLUG) dans son état de référence.
 * Protégé par CRON_SECRET, comme /api/cron/ical-sync.
 *
 * Usage Coolify : cron nocturne
 *   curl -s -H "Authorization: Bearer $CRON_SECRET" https://domaine/api/cron/demo-reset
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error("[demo-reset cron] CRON_SECRET non configuré — endpoint désactivé");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await resetDemoTenant());
  } catch (err) {
    console.error("[demo-reset cron] Erreur:", err);
    return NextResponse.json({ error: "Reset failed" }, { status: 500 });
  }
}
