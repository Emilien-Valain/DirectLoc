import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";
import { apexHost } from "@/lib/tenant-host";
import { tenants, userTenants } from "@/db/schema";
import { checkRateLimit, type RateLimitRule } from "@/lib/rate-limit";

// ── Rate limiting rules ───────────────────────────────────────────────────────

// Pas de règle "login" : le matcher exclut /api/auth, et Better Auth limite
// déjà /sign-in* lui-même en production (3 req / 10 s par IP).
const RATE_RULES: Record<string, RateLimitRule> = {
  api: { name: "api-public", limit: 60, windowSec: 60 },
  // /essayer crée une session en base à chaque visite.
  essayer: { name: "essayer", limit: 20, windowSec: 60 },
};

// ── Cache in-memory tenant (5 min) ──────────────────────────────────────────

type CachedTenant = {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  config: unknown;
  createdAt: Date | null;
  expiresAt: number;
};

const tenantCache = new Map<string, CachedTenant>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function resolveTenant(host: string): Promise<CachedTenant | null> {
  const now = Date.now();

  const cached = tenantCache.get(host);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  let tenant: Omit<CachedTenant, "expiresAt"> | undefined;

  if (host === "localhost" || host.endsWith(".localhost")) {
    // En dev local : lookup par slug
    // - localhost seul → PUBLIC_TENANT_SLUG dans .env.local
    // - <slug>.localhost → slug extrait du sous-domaine
    const slug = host === "localhost"
      ? process.env.PUBLIC_TENANT_SLUG
      : host.replace(/\.localhost$/, "");

    if (!slug) return null;

    const [row] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);

    tenant = row ?? undefined;
  } else {
    // En production : lookup par domain ; `www.<domaine>` sert le même tenant.
    // Le host brut reste candidat au cas où le domaine serait stocké avec `www.`.
    const [row] = await db
      .select()
      .from(tenants)
      .where(inArray(tenants.domain, [host, apexHost(host)]))
      .limit(1);

    tenant = row ?? undefined;
  }

  if (!tenant) {
    return null;
  }

  const cached2: CachedTenant = { ...tenant, expiresAt: now + CACHE_TTL_MS };
  tenantCache.set(host, cached2);
  return cached2;
}

// MARKETING_HOST : directloc.app en prod, directloc.localhost en dev.
function isMarketingHost(host: string): boolean {
  const marketing = process.env.MARKETING_HOST;
  return !!marketing && (host === marketing || host === `www.${marketing}`);
}

// Origine de l'hôtel démo vue depuis la vitrine : DEMO_TENANT_DOMAIN en prod,
// <slug>.localhost:<port> en dev/test (même logique de résolution que resolveTenant).
function demoOrigin(request: NextRequest, hostHeader: string): string | null {
  const slug = process.env.DEMO_TENANT_SLUG;
  if (!slug) return null;
  const [host, port] = hostHeader.split(":");
  if (host.endsWith(".localhost")) {
    return `${request.nextUrl.protocol}//${slug}.localhost${port ? `:${port}` : ""}`;
  }
  const domain = process.env.DEMO_TENANT_DOMAIN;
  return domain ? `https://${domain}` : null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Rate limiting ───────────────────────────────────────────────────────
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown";

  // Pas de limite sur les webhooks : la signature Stripe rejette déjà les faux appels,
  // et un 429 retarderait les confirmations (Stripe réessaie avec backoff).
  let rateRule: RateLimitRule | null = null;
  if (
    pathname.startsWith("/api/") &&
    !pathname.startsWith("/api/admin/") &&
    !pathname.startsWith("/api/cron/") &&
    !pathname.startsWith("/api/webhooks/")
  ) {
    rateRule = RATE_RULES.api;
  } else if (pathname === "/essayer") {
    rateRule = RATE_RULES.essayer;
  }

  if (rateRule) {
    const result = checkRateLimit(rateRule, ip);
    if (result.limited) {
      return new NextResponse("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(result.retryAfter) },
      });
    }
  }

  // ── Routes auth et API sans tenant d'hôte → passe-plat ─────────────────
  // Les autres API publiques (availability, pricing, rules, rooms/available)
  // passent par la résolution : x-tenant-id vient TOUJOURS de l'hôte, jamais du client.
  const isAuthPage = pathname.startsWith("/login") || pathname.startsWith("/forgot-password") || pathname.startsWith("/reset-password");
  const isHostlessApi = ["/api/webhooks/", "/api/cron/", "/api/health", "/api/ical/", "/api/uploads/"]
    .some((p) => pathname.startsWith(p));
  if (isAuthPage || isHostlessApi) {
    return NextResponse.next();
  }

  // ── Résolution tenant (nécessaire pour toutes les routes) ────────────────
  // x-forwarded-host d'abord : le rendu d'un redirect() de server action est un
  // fetch interne vers __NEXT_PRIVATE_ORIGIN (Host = localhost), qui ne garde le
  // domaine du tenant que dans x-forwarded-host (même ordre que Next lui-même).
  const hostHeader =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ??
    request.headers.get("host") ??
    "";
  const host = hostHeader.split(":")[0];

  // ── Site vitrine (directloc.app) : servi par réécriture vers app/vitrine ──
  // Les chemins /vitrine ne sont jamais accessibles directement depuis un domaine client.
  if (isMarketingHost(host)) {
    // Le webhook Stripe et le health check sont enregistrés sur le domaine plateforme.
    if (pathname.startsWith("/api/webhooks/") || pathname === "/api/health") {
      return NextResponse.next();
    }
    if (pathname.startsWith("/admin") || pathname.startsWith("/api/")) {
      return new NextResponse("Not Found", { status: 404 });
    }
    if (pathname === "/essayer") {
      const demo = demoOrigin(request, hostHeader);
      return demo
        ? NextResponse.redirect(`${demo}/essayer`, 302)
        : new NextResponse("Not Found", { status: 404 });
    }
    return NextResponse.rewrite(new URL(`/vitrine${pathname === "/" ? "" : pathname}`, request.url));
  }
  if (pathname === "/vitrine" || pathname.startsWith("/vitrine/")) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const tenant = await resolveTenant(host);

  if (!tenant) {
    return new NextResponse("Not Found", { status: 404 });
  }

  // ── Protection des routes /admin et /api/admin ───────────────────────────
  const isAdminRoute = pathname.startsWith("/admin") || pathname.startsWith("/api/admin/");
  if (isAdminRoute) {
    const isApiRoute = pathname.startsWith("/api/");
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session) {
      if (isApiRoute) return new NextResponse("Unauthorized", { status: 401 });
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }

    // Vérifier que l'utilisateur a accès au tenant courant (many-to-many)
    const membership = await db.query.userTenants.findFirst({
      where: and(
        eq(userTenants.userId, session.user.id),
        eq(userTenants.tenantId, tenant.id),
      ),
    });
    if (!membership) {
      if (isApiRoute) return new NextResponse("Forbidden", { status: 403 });
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  // ── Injecter x-tenant-id dans les headers de la requête ─────────────────
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-tenant-id", tenant.id);

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}

export const config = {
  matcher: [
    // Exclut les fichiers statiques et les routes auth
    "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
