import { NextRequest, NextResponse } from "next/server";
import { registerSearchConsoleSites } from "@/lib/google-search-console";

/**
 * GET /api/cron/search-console
 *
 * Inscrit dans Google Search Console chaque hôtel avec domaine pas encore inscrit
 * (vérification META, ajout du site, envoi du sitemap). Idempotent. Usage Coolify : chaque jour.
 *   curl -s -H "Authorization: Bearer $CRON_SECRET" https://directloc.app/api/cron/search-console
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ sites: await registerSearchConsoleSites() });
  } catch (err) {
    console.error("[search-console cron]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
