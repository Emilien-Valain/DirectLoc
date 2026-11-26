import PublicLayout, { hasLocation } from "@/components/public/PublicLayout";
import { HomeHero, HomeStory, HomeStats, HomeGallery, HomeLocation } from "@/components/public/Site";
import { requireTenant } from "@/lib/tenant-context";
import { getRoomsPublic } from "@/lib/queries/public";
import { getMinPricePerNight } from "@/lib/pricing";
import type { TenantConfig } from "@/lib/tenant-context";
import { lodgingJsonLd, metaDescription, tenantBaseUrl, tenantMetadata } from "@/lib/seo";
import JsonLd from "@/components/public/JsonLd";
import { CarnetHome } from "@/components/public/templates/Carnet";
import { GuideHome } from "@/components/public/templates/Guide";
import { DefilantHome } from "@/components/public/templates/Defilant";
import { PostaleHome } from "@/components/public/templates/Postale";

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
      <JsonLd data={lodgingJsonLd(tenant, await tenantBaseUrl(tenant))} />
      {config.template === "carnet" ? (
        <CarnetHome
          tenant={tenant}
          config={config}
          rooms={featuredRooms}
          totalRooms={allRooms.length}
          showLocation={hasLocation(config)}
        />
      ) : config.template === "guide" ? (
        <GuideHome
          tenant={tenant}
          config={config}
          rooms={featuredRooms}
          totalRooms={allRooms.length}
          showLocation={hasLocation(config)}
        />
      ) : config.template === "defilant" ? (
        <DefilantHome
          tenant={tenant}
          config={config}
          rooms={featuredRooms}
          totalRooms={allRooms.length}
          showLocation={hasLocation(config)}
        />
      ) : config.template === "postale" ? (
        <PostaleHome
          tenant={tenant}
          config={config}
          rooms={featuredRooms}
          totalRooms={allRooms.length}
          showLocation={hasLocation(config)}
        />
      ) : (
        <>
          <HomeHero
            tenant={tenant}
            config={config}
            rooms={featuredRooms}
            totalRooms={allRooms.length}
          />
          <HomeStory config={config} />
          <HomeStats config={config} />
          <HomeGallery config={config} />
          {hasLocation(config) && <HomeLocation tenant={tenant} config={config} />}
        </>
      )}
    </PublicLayout>
  );
}
