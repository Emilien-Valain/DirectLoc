import type { Metadata } from "next";
import { headers } from "next/headers";
import type { Tenant, TenantConfig } from "@/lib/tenant-context";
import { isDemoTenant } from "@/lib/demo";
import { sortedPhotos } from "@/components/public/photos";

/** Texte libre → description meta (~160 caractères, coupée sur un mot). */
export function metaDescription(text: string | null | undefined): string | undefined {
  const clean = text?.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  if (clean.length <= 160) return clean;
  return `${clean.slice(0, 157).replace(/\s+\S*$/, "")}…`;
}

/**
 * Icône d'onglet de l'hôtel. Définie au niveau de la page, elle remplace celle
 * de DirectLoc (app/favicon.ico) ; absente → icône par défaut.
 */
export function tenantIcons(config: TenantConfig): Metadata["icons"] | undefined {
  const url = config.favicon?.url;
  if (!url) return undefined;
  return { icon: [{ url, type: "image/png", sizes: "512x512" }], apple: [{ url }], shortcut: [{ url }] };
}

/** Domaine déclaré en base = URL canonique ; sinon (dev, tests) l'hôte de la requête. */
export async function tenantBaseUrl(tenant: Tenant): Promise<string> {
  if (tenant.domain) return `https://${tenant.domain}`;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost"}`;
}

/**
 * Métadonnées d'une page publique d'un hôtel : titre, description, canonical
 * sur le domaine de l'hôtel (www → apex), Open Graph.
 */
export async function tenantMetadata(
  tenant: Tenant,
  { title, description, path, image }: { title: string; description?: string; path: string; image?: string },
): Promise<Metadata> {
  const base = await tenantBaseUrl(tenant);
  const config = (tenant.config ?? {}) as TenantConfig;
  const verification = config.googleSiteVerification;
  const icons = tenantIcons(config);

  return {
    metadataBase: new URL(base),
    ...(icons ? { icons } : {}),
    ...(verification ? { verification: { google: verification } } : {}),
    // Hôtel démo : contenu fictif remis à zéro chaque nuit, à ne pas indexer.
    ...((await isDemoTenant(tenant.id)) ? { robots: { index: false, follow: false } } : {}),
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

/** schema.org LodgingBusiness de l'accueil : uniquement des champs affichés sur le site. */
export function lodgingJsonLd(tenant: Tenant, base: string) {
  const config = (tenant.config ?? {}) as TenantConfig;
  const images = [config.heroPhoto?.url, ...(config.galleryPhotos ?? []).map((p) => p.url)].filter(Boolean) as string[];
  return {
    "@context": "https://schema.org",
    "@type": "LodgingBusiness",
    "@id": `${base}/#lodging`,
    name: tenant.name,
    url: `${base}/`,
    description: config.heroSubtitle ?? config.storyText,
    image: images.length ? images.map((u) => `${base}${u}`) : undefined,
    address: config.address,
    telephone: config.phone,
    email: config.email,
    geo:
      config.latitude != null && config.longitude != null
        ? { "@type": "GeoCoordinates", latitude: config.latitude, longitude: config.longitude }
        : undefined,
    hasMap: config.googleMapsUrl,
    checkinTime: config.checkInTime,
    checkoutTime: config.checkOutTime,
  };
}

type RoomForJsonLd = { name: string; slug: string; description: string | null; capacity: number; photos: unknown };

/** schema.org HotelRoom d'une page chambre, rattachée au LodgingBusiness de l'accueil. */
export function roomJsonLd(tenant: Tenant, base: string, room: RoomForJsonLd) {
  const photos = sortedPhotos(room.photos);
  return {
    "@context": "https://schema.org",
    "@type": "HotelRoom",
    name: room.name,
    url: `${base}/chambres/${room.slug}`,
    description: room.description ?? undefined,
    image: photos.length ? photos.map((p) => `${base}${p.url}`) : undefined,
    occupancy: { "@type": "QuantitativeValue", maxValue: room.capacity, unitCode: "C62" },
    containedInPlace: { "@type": "LodgingBusiness", "@id": `${base}/#lodging`, name: tenant.name, url: `${base}/` },
  };
}
