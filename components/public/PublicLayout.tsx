import Link from "next/link";
import { requireTenant } from "@/lib/tenant-context";
import type { Tenant, TenantConfig } from "@/lib/tenant-context";
import SiteMenu from "@/components/public/SiteMenu";
import { isDemoTenant } from "@/lib/demo";
import "@/components/public/site.css";
import "@/components/public/templates/plaque.css";
import "@/components/public/templates/linge.css";
import "@/components/public/templates/affiche.css";
import "@/components/public/templates/standard.css";

/**
 * Coque commune des sites publics. Le balisage est le même pour tous les
 * templates ; chaque univers vit dans sa feuille CSS, scopée par
 * `[data-tpl]`. Clés stockées en base → univers :
 *   "classic"  → plaque   (La Plaque émaillée)
 *   "boutique" → linge    (Le Linge de maison)
 *   "affiche"  → affiche  (L'Affiche touristique)
 *   "standard" → standard (Classique)
 */
const WORLDS = {
  classic: { tpl: "plaque", primary: "#1F3B7A", secondary: "#D8D3C6" },
  boutique: { tpl: "linge", primary: "#B23A3A", secondary: "#E2DED3" },
  affiche: { tpl: "affiche", primary: "#1F3B57", secondary: "#F2B33D" },
  standard: { tpl: "standard", primary: "#2A5C40", secondary: "#F4F1EC" },
} as const;

export function siteTemplate(config: TenantConfig) {
  return WORLDS[config.template ?? "classic"] ?? WORLDS.classic;
}

/** Initiales de la maison (monogramme / pastille) quand il n'y a pas de logo. */
export function initials(name: string) {
  const words = name
    .split(/[\s'’-]+/)
    .filter((w) => w.length > 2 || /^[A-ZÉ]/.test(w))
    .filter((w) => !/^(le|la|les|des|du|de|l)$/i.test(w));
  return (words.length ? words : [name])
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

/** Le bloc « Nous trouver » n'existe que si l'hôte a renseigné de quoi le remplir. */
export function hasLocation(config: TenantConfig) {
  return Boolean(
    config.address ||
      config.phone ||
      config.email ||
      (config.latitude != null && config.longitude != null) ||
      config.googleMapsUrl,
  );
}

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tenant = await requireTenant();
  const config = (tenant.config ?? {}) as TenantConfig;
  return (
    <SiteShell tenant={tenant} config={config} demo={await isDemoTenant(tenant.id)}>
      {children}
    </SiteShell>
  );
}

function SiteShell({
  tenant,
  config,
  demo,
  children,
}: {
  tenant: Tenant;
  config: TenantConfig;
  demo: boolean;
  children: React.ReactNode;
}) {
  const world = siteTemplate(config);
  const showLocation = hasLocation(config);
  const vars = {
    "--color-primary": config.primaryColor ?? world.primary,
    "--color-secondary": config.secondaryColor ?? world.secondary,
  } as React.CSSProperties;

  return (
    <div className="site" data-tpl={world.tpl} style={vars}>
      {demo && (
        <p className="s-demo" data-testid="demo-banner">
          Site de démonstration · {/* <a> : pas de prefetch, chaque clic ouvre une session */}
          <a href="/essayer">Voir l&apos;admin</a>
        </p>
      )}
      <header className="s-header">
        <Link href="/" className="s-brand">
          {config.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={config.logoUrl} alt="" height={44} className="s-brand-logo" />
          ) : (
            <span className="s-mark" aria-hidden="true">
              {initials(tenant.name)}
            </span>
          )}
          <span className="s-brand-name">{tenant.name}</span>
        </Link>
        <nav className="s-nav" aria-label="Navigation principale">
          <Link href="/chambres" className="s-nav-link">
            Chambres
          </Link>
          {showLocation && (
            <Link href="/#nous-trouver" className="s-nav-link">
              Nous trouver
            </Link>
          )}
          <Link href="/#dates" className="s-nav-link s-nav-cta">
            Réserver
          </Link>
        </nav>
        <SiteMenu showLocation={showLocation} />
      </header>

      <main className="s-main">{children}</main>

      <footer className="s-footer">
        <div className="s-footer-inner">
          <div>
            <p className="s-footer-name">{tenant.name}</p>
            {config.address && <p className="s-footer-line">{config.address}</p>}
            {config.footerTagline && <p className="s-footer-line">{config.footerTagline}</p>}
          </div>
          <div className="s-footer-contact">
            {config.phone && <a href={`tel:${config.phone}`}>{config.phone}</a>}
            {config.email && <a href={`mailto:${config.email}`}>{config.email}</a>}
          </div>
        </div>
        <p className="s-credit">
          © {new Date().getFullYear()} {tenant.name} · Réservation directe par{" "}
          <a href="https://directloc.app" target="_blank" rel="noopener noreferrer">
            DirectLoc
          </a>
        </p>
      </footer>
    </div>
  );
}
