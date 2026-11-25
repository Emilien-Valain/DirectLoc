import type { TouristTax } from "@/lib/tourist-tax";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";

/**
 * Récupère le tenant courant depuis le header x-tenant-id injecté par le proxy.
 * Utilise React cache() pour dédupliquer les appels dans un même rendu.
 * Appelle notFound() si le tenant est absent ou introuvable.
 */
export const requireTenant = cache(async () => {
  const headersList = await headers();
  const tenantId = headersList.get("x-tenant-id");

  if (!tenantId) {
    notFound();
  }

  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
  });

  if (!tenant) {
    notFound();
  }

  return tenant;
});

export type Tenant = Awaited<ReturnType<typeof requireTenant>>;

/**
 * Clés stockées en base. Les deux premières gardent leur nom historique :
 * classic = « La Plaque émaillée », boutique = « Le Linge de maison ».
 */
export const TEMPLATE_NAMES = ["classic", "boutique", "affiche", "standard"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export type HeroPhoto = {
  id: string;
  filename: string;
  url: string;
};

export type GalleryPhoto = {
  id: string;
  filename: string;
  url: string;
  caption?: string;
};

export type StoryStat = { value: string; label: string; sub?: string };

export type TenantConfig = {
  primaryColor?: string;
  secondaryColor?: string;
  heroTitle?: string;
  heroSubtitle?: string;
  heroEyebrow?: string;
  heroPhoto?: HeroPhoto | null;
  galleryPhotos?: GalleryPhoto[];
  storyEyebrow?: string;
  storyTitle?: string;
  storyText?: string;
  storyStats?: StoryStat[];
  keyStatsEyebrow?: string;
  keyStatsTitle?: string;
  locationEyebrow?: string;
  locationTitle?: string;
  locationSubtitle?: string;
  checkInTime?: string;
  checkOutTime?: string;
  accessLines?: string[];
  footerTagline?: string;
  address?: string;
  phone?: string;
  email?: string;
  logoUrl?: string;
  /** Icône d'onglet du site (PNG carré 512 px, généré à l'envoi). */
  favicon?: { filename: string; url: string } | null;
  template?: TemplateName;
  googleMapsUrl?: string;
  latitude?: number;
  longitude?: number;
  /** Commune affichée aux Voisins du réseau (ADR-0013). */
  city?: string;
  /** Réseau des Voisins : absent = activé ; `false` posé par l'opérateur uniquement (aucune UI hôte). */
  networkEnabled?: boolean;
  confirmationMessage?: string;
  postStayMessage?: string;
  /** Rappel avant l'arrivée : jours avant (absent = 2, 0 = désactivé) et message. */
  reminderDaysBefore?: number;
  reminderMessage?: string;
  reviewUrl?: string;
  /** Jeton de vérification Google Search Console (balise meta), posé par lib/google-search-console.ts. */
  googleSiteVerification?: string;
  /** Date d'inscription dans Search Console : le cron ne retraite plus ce site. */
  searchConsoleAddedAt?: string;
  /** GOOGLE_SEARCH_CONSOLE_OWNERS déjà ajoutés comme propriétaires : un nouvel email est ajouté au passage suivant. */
  searchConsoleOwners?: string[];
  /** Absente = taxe de séjour désactivée (ADR-0011). */
  touristTax?: TouristTax;
};
