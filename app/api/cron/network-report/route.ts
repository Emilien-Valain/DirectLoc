import { NextRequest, NextResponse } from "next/server";
import { sendMonthlyNetworkReports } from "@/lib/network-report";

/**
 * GET /api/cron/network-report
 *
 * Bilan mensuel du réseau des Voisins (mois précédent), un email par hôtel ayant eu ≥ 1 Renvoi envoyé
 * ou reçu. Idempotent par hôtel et par mois (table network_reports).
 *
 * Protégé par CRON_SECRET. Usage Coolify : le 1er de chaque mois à 9h
 *   wget -qO- --header="Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/network-report
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[network-report cron] CRON_SECRET non configuré");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await sendMonthlyNetworkReports());
  } catch (err) {
    console.error("[network-report cron] Erreur:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
