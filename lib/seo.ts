import type { Metadata } from "next";
import { headers } from "next/headers";
import type { Tenant } from "@/lib/tenant-context";

/** Texte libre → description meta (~160 caractères, coupée sur un mot). */
export function metaDescription(text: string | null | undefined): string | undefined {
  const clean = text?.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  if (clean.length <= 160) return clean;
  return `${clean.slice(0, 157).replace(/\s+\S*$/, "")}…`;
}

/**
 * Métadonnées d'une page publique d'un hôtel : titre, description, canonical
 * sur le domaine de l'hôtel (www → apex), Open Graph.
 */
export async function tenantMetadata(
  tenant: Tenant,
  { title, description, path, image }: { title: string; description?: string; path: string; image?: string },
): Promise<Metadata> {
  const h = await headers();
  // Domaine déclaré en base = URL canonique ; sinon (dev, tests) l'hôte de la requête.
  const base = tenant.domain
    ? `https://${tenant.domain}`
    : `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost"}`;

  return {
    metadataBase: new URL(base),
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      locale: "fr_FR",
      siteName: tenant.name,
      title,
      description,
      url: path,
      ...(image ? { images: [image] } : {}),
    },
  };
}
