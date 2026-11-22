import Link from "next/link";
import type { Metadata } from "next";
import PublicLayout from "@/components/public/PublicLayout";
import { Breadcrumb } from "@/components/public/Site";
import { requireTenant, type Tenant, type TenantConfig } from "@/lib/tenant-context";
import { tenantMetadata } from "@/lib/seo";
import { legalSettingsOf } from "@/lib/legal-settings";
import {
  LEGAL_DOC_KINDS,
  LEGAL_PAGES,
  PLATFORM_HOST_IDENTITY,
  parseLegalText,
  publishedText,
  type LegalDocKind,
} from "@/lib/legal-documents";

/**
 * Pages légales publiques (/conditions-annulation, /cgv, /mentions-legales, /confidentialite).
 * Publiées : le texte de l'hôte (ou le modèle rempli), rendu sans HTML. Pas encore publiées :
 * une page minimale (nom, adresse, contact, hébergeur), non indexée.
 */

export async function legalPageMetadata(kind: LegalDocKind): Promise<Metadata> {
  const tenant = await requireTenant();
  const page = LEGAL_PAGES[kind];
  const meta = await tenantMetadata(tenant, {
    title: `${page.title} — ${tenant.name}`,
    description: `${page.title} de ${tenant.name}.`,
    path: page.path,
  });
  return tenant.legalPublishedAt ? meta : { ...meta, robots: { index: false, follow: true } };
}

export default async function LegalPage({ kind }: { kind: LegalDocKind }) {
  const tenant = await requireTenant();
  const page = LEGAL_PAGES[kind];
  const published = Boolean(tenant.legalPublishedAt);

  return (
    <PublicLayout>
      <article className="s-page s-legal" data-testid="legal-page" data-published={published}>
        <Breadcrumb items={[{ href: "/", label: "Accueil" }, { label: page.title }]} />
        <h1 className="s-h1">{page.title}</h1>
        {published ? <LegalText text={publishedText(kind, legalSettingsOf(tenant))} /> : <MinimalLegal tenant={tenant} />}
        <nav className="s-legal-nav" aria-label="Autres informations légales">
          <ul>
            {LEGAL_DOC_KINDS.filter((k) => k !== kind).map((k) => (
              <li key={k}>
                <Link href={LEGAL_PAGES[k].path}>{LEGAL_PAGES[k].title}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </article>
    </PublicLayout>
  );
}

/** Texte simple → titres, paragraphes, listes. React échappe tout : aucun HTML possible. */
function LegalText({ text }: { text: string }) {
  return (
    <div className="s-legal-body" data-testid="legal-text">
      {parseLegalText(text).map((b, i) =>
        b.type === "heading" ? (
          <h2 key={i} className="s-h3">
            {b.text}
          </h2>
        ) : b.type === "list" ? (
          <ul key={i} className="s-legal-list">
            {b.items.map((it, j) => (
              <li key={j}>{it}</li>
            ))}
          </ul>
        ) : (
          <p key={i} className="s-prose">
            {b.text}
          </p>
        ),
      )}
    </div>
  );
}

/** Documents pas encore publiés : le strict nécessaire, sans rien inventer. */
function MinimalLegal({ tenant }: { tenant: Tenant }) {
  const config = (tenant.config ?? {}) as TenantConfig;
  return (
    <div className="s-legal-body" data-testid="legal-minimal">
      <p className="s-prose">
        Ce document n&apos;est pas encore en ligne. Pour toute question sur une réservation, contactez directement
        l&apos;établissement.
      </p>
      <h2 className="s-h3">Établissement</h2>
      <ul className="s-legal-list">
        <li>{tenant.name}</li>
        {config.address && <li>{config.address.replace(/\s*\n\s*/g, ", ")}</li>}
        {config.email && (
          <li>
            <a href={`mailto:${config.email}`}>{config.email}</a>
          </li>
        )}
        {config.phone && (
          <li>
            <a href={`tel:${config.phone}`}>{config.phone}</a>
          </li>
        )}
      </ul>
      <h2 className="s-h3">Hébergement</h2>
      <p className="s-prose">Le site est hébergé par DirectLoc : {PLATFORM_HOST_IDENTITY}.</p>
    </div>
  );
}
