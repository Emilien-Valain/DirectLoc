import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/session";
import { connectedAccountStatus, getStripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";

/**
 * GET /api/admin/stripe/status
 * Statut du compte connecté (Accounts v2) : `chargesEnabled` = capacité `card_payments` de la
 * config `merchant` active. Sinon l'UI propose de reprendre l'onboarding.
 */
export async function GET() {
  const { tenantId } = await requireSession();

  const [tenant] = await db
    .select({ stripeAccountId: tenants.stripeAccountId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant?.stripeAccountId) {
    return NextResponse.json({ connected: false });
  }

  try {
    const account = await getStripe().v2.core.accounts.retrieve(tenant.stripeAccountId, {
      include: ["configuration.merchant"],
    });

    return NextResponse.json({
      connected: true,
      accountId: account.id,
      ...connectedAccountStatus(account),
    });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
