import { NextRequest, NextResponse } from "next/server";
import { allTenantPages, submitIndexNow } from "@/lib/indexnow";

/**
 * GET /api/cron/indexnow
 *
 * Envoie à IndexNow toutes les pages publiques de chaque hôtel ayant un domaine,
 * plus l'accueil de la vitrine. À lancer une fois après la mise en place de
 * INDEXNOW_KEY ; ensuite les modifications sont signalées au fil de l'eau.
 *   curl -s -H "Authorization: Bearer $CRON_SECRET" https://directloc.app/api/cron/indexnow
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.INDEXNOW_KEY) {
    return NextResponse.json({ error: "INDEXNOW_KEY not configured" }, { status: 500 });
  }

  const sites = await allTenantPages();
  if (process.env.MARKETING_HOST) sites.push({ host: process.env.MARKETING_HOST, paths: ["/"] });

  const results: Record<string, boolean> = {};
  for (const { host, paths } of sites) results[host] = await submitIndexNow(host, paths);
  return NextResponse.json({ submitted: results });
}
