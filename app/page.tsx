import PublicLayout, { hasLocation } from "@/components/public/PublicLayout";
import { HomeHero, HomeStory, HomeStats, HomeGallery, HomeLocation } from "@/components/public/Site";
import { requireTenant } from "@/lib/tenant-context";
import { getRoomsPublic } from "@/lib/queries/public";
import { getMinPricePerNight } from "@/lib/pricing";
import type { TenantConfig } from "@/lib/tenant-context";
import { metaDescription, tenantMetadata } from "@/lib/seo";

export async function generateMetadata() {
  const tenant = await requireTenant();
  const config = (tenant.config ?? {}) as TenantConfig;
  return tenantMetadata(tenant, {
    title: `${tenant.name} — réservation en direct`,
    description: metaDescription(config.heroSubtitle ?? config.storyText ?? `Réservez votre séjour chez ${tenant.name} directement auprès de l'hôte.`),
    path: "/",
    image: config.heroPhoto?.url,
  });
}

export default async function HomePage() {
  const tenant = await requireTenant();
  const config = (tenant.config ?? {}) as TenantConfig;

  const allRooms = await getRoomsPublic(tenant.id);
  const featuredRooms = await Promise.all(
    allRooms.slice(0, 4).map(async (room) => ({
      ...room,
      minPrice: await getMinPricePerNight(room.id, tenant.id),
    })),
  );

  return (
    <PublicLayout>
      <HomeHero tenant={tenant} config={config} rooms={featuredRooms} totalRooms={allRooms.length} />
      <HomeStory config={config} />
      <HomeStats config={config} />
      <HomeGallery config={config} />
      {hasLocation(config) && <HomeLocation tenant={tenant} config={config} />}
    </PublicLayout>
  );
}
