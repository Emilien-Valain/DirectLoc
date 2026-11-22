import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { requireSession } from "@/lib/session";
import { isDemoTenant } from "@/lib/demo";
import { connectedAccountParams, getStripe, onboardingLinkParams } from "@/lib/stripe";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";

/**
 * POST /api/admin/stripe/connect
 * Crée le compte connecté de l'hôtel en Accounts v2 (si pas déjà fait) et retourne l'URL
 * d'onboarding (account link v2). Stripe refuse désormais `POST /v1/accounts` pour la plateforme.
 */
export async function POST(request: NextRequest) {
  const { tenantId } = await requireSession();
  if (await isDemoTenant(tenantId)) {
    return NextResponse.json({ error: "Désactivé en démo" }, { status: 403 });
  }

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant) {
    return NextResponse.json({ error: "Tenant introuvable" }, { status: 404 });
  }

  let accountId = tenant.stripeAccountId;

  try {
    // Créer un compte Connect si le tenant n'en a pas encore
    if (!accountId) {
      const account = await getStripe().v2.core.accounts.create(
        connectedAccountParams(),
      );

      accountId = account.id;

      await db
        .update(tenants)
        .set({ stripeAccountId: accountId })
        .where(eq(tenants.id, tenantId));
    }

    // Générer le lien d'onboarding — utiliser le domaine du tenant, pas le header origin
    const proto = request.headers.get("x-forwarded-proto") ?? "https";
    const host = request.headers.get("host") ?? "localhost:3000";
    const origin = `${proto}://${host}`;

    const accountLink = await getStripe().v2.core.accountLinks.create(onboardingLinkParams(accountId, origin));

    return NextResponse.json({ url: accountLink.url });
  } catch (e) {
    console.error("Stripe Connect : création du compte ou du lien d'onboarding impossible:", e);
    return NextResponse.json(
      { error: "Stripe n'a pas pu ouvrir la configuration de votre compte. Réessayez dans quelques minutes." },
      { status: 502 },
    );
  }
}

/**
 * DELETE /api/admin/stripe/connect
 * Déconnecte le compte Stripe Connect du tenant.
 */
export async function DELETE() {
  const { tenantId } = await requireSession();
  if (await isDemoTenant(tenantId)) {
    return NextResponse.json({ error: "Désactivé en démo" }, { status: 403 });
  }

  await db
    .update(tenants)
    .set({ stripeAccountId: null })
    .where(eq(tenants.id, tenantId));

  return NextResponse.json({ ok: true });
}
