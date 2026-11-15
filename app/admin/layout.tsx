import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { userTenants } from "@/db/schema";
import Sidebar from "@/components/admin/Sidebar";
import { isDemoTenant } from "@/lib/demo";

// Un onglet par page qui dit où l'on est (« Réservations · DirectLoc »), plus jamais « DirectLoc » partout.
export const metadata = {
  title: { template: "%s · DirectLoc", default: "Tableau de bord · DirectLoc" },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headersList = await headers();
  const session = await auth.api.getSession({ headers: headersList });

  if (!session) {
    redirect("/login");
  }

  const tenantId = headersList.get("x-tenant-id");

  const memberships = await db.query.userTenants.findMany({
    where: eq(userTenants.userId, session.user.id),
    with: { tenant: true },
  });

  const currentTenant = memberships.find((m) => m.tenantId === tenantId)?.tenant;
  const demo = tenantId ? await isDemoTenant(tenantId) : false;
  const isDev = process.env.NODE_ENV === "development";
  const port = isDev ? `:${process.env.PORT ?? "3000"}` : "";

  const accessibleTenants = memberships.map((m) => ({
    id: m.tenant.id,
    name: m.tenant.name,
    slug: m.tenant.slug,
    isCurrent: m.tenantId === tenantId,
    adminUrl: isDev
      ? `http://${m.tenant.slug}.localhost${port}/admin`
      : m.tenant.domain
        ? `https://${m.tenant.domain}/admin`
        : null,
  }));

  return (
    <div data-admin className="flex flex-col lg:flex-row h-dvh overflow-hidden">
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:px-4 focus:py-2.5 focus:rounded-lg focus:text-[13.5px] focus:font-semibold"
        style={{ background: "var(--admin-primary)", color: "#fff" }}
      >
        Aller au contenu
      </a>
      <Sidebar
        userEmail={session.user.email}
        userName={session.user.name ?? undefined}
        currentTenantName={currentTenant?.name ?? ""}
        initialCollapsed={(await cookies()).get("admin-sidebar-collapsed")?.value === "1"}
        accessibleTenants={accessibleTenants}
      />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {demo && (
          <div
            data-testid="demo-banner"
            className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-[12.5px] font-semibold"
            style={{ background: "var(--admin-primary-light)", color: "var(--admin-primary)", borderBottom: "1px solid var(--admin-border)" }}
          >
            <span>Démo — données remises à zéro chaque nuit</span>
            <a href="/" target="_blank" rel="noopener" className="underline underline-offset-2">
              Voir le site de réservation
            </a>
          </div>
        )}
        <main id="admin-main" tabIndex={-1} className="flex-1 overflow-y-auto focus:outline-none">
          <div className="px-5 sm:px-8 py-7 max-w-[1280px] mx-auto w-full admin-fade-in">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
