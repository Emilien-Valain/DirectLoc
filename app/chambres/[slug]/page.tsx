import { parisToday } from "@/lib/date-windows";
import { notFound } from "next/navigation";
import PublicLayout from "@/components/public/PublicLayout";
import RoomGallery from "@/components/public/RoomGallery";
import RoomDates from "@/components/public/RoomDates";
import { Breadcrumb, RoomItem, RoomPrice, sortedPhotos } from "@/components/public/Site";
import { requireTenant, type TenantConfig } from "@/lib/tenant-context";
import { getRoomBySlugPublic, getRoomsPublic } from "@/lib/queries/public";
import { getMinPricePerNight } from "@/lib/pricing";
import { getFeesByTenant } from "@/lib/queries/fees";
import { feeAppliesTo } from "@/lib/extras";
import { metaDescription, tenantMetadata } from "@/lib/seo";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await requireTenant();
  const room = await getRoomBySlugPublic(tenant.id, slug);
  if (!room) return {};
  return tenantMetadata(tenant, {
    title: `${room.name} — ${tenant.name}`,
    description: metaDescription(room.description ?? `${room.name}, jusqu'à ${room.capacity} personne${room.capacity > 1 ? "s" : ""}, chez ${tenant.name}. Réservation en direct.`),
    path: `/chambres/${room.slug}`,
    image: sortedPhotos(room.photos)[0]?.url,
  });
}

export default async function ChambreDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await requireTenant();
  const room = await getRoomBySlugPublic(tenant.id, slug);

  if (!room) {
    notFound();
  }

  const [minPrice, fees] = await Promise.all([
    getMinPricePerNight(room.id, tenant.id),
    getFeesByTenant(tenant.id, { activeOnly: true }),
  ]);
  const today = parisToday();
  const config = (tenant.config ?? {}) as TenantConfig;
  // Ce que le voyageur doit savoir avant de choisir ses dates, tiré des réglages de l'hôte.
  const facts = [
    ["Capacité", `Jusqu'à ${room.capacity} personne${room.capacity > 1 ? "s" : ""}`],
    config.checkInTime && ["Arrivée", config.checkInTime],
    config.checkOutTime && ["Départ", config.checkOutTime],
  ].filter(Boolean) as [string, string][];
  // « À partir de » = hébergement seul : annoncer ce qui s'y ajoute d'office (ADR-0011).
  const charges = [
    ...fees.filter((f) => f.price > 0 && feeAppliesTo(f, room.id)).map((f) => f.label.toLocaleLowerCase("fr")),
    ...(config.touristTax ? ["taxe de séjour"] : []),
  ];
  const chargesNote = charges.length
    ? `+ ${charges.length > 1 ? `${charges.slice(0, -1).join(", ")} et ${charges.at(-1)}` : charges[0]}`
    : null;
  const hasPhotos = sortedPhotos(room.photos).length > 0;
  const allRooms = await getRoomsPublic(tenant.id);
  const others = await Promise.all(
    allRooms
      .map((r, index) => ({ ...r, index }))
      .filter((r) => r.id !== room.id)
      .slice(0, 3)
      .map(async (r) => ({ ...r, minPrice: await getMinPricePerNight(r.id, tenant.id) })),
  );

  return (
    <PublicLayout>
      <div className="s-page">
        <Breadcrumb
          items={[
            { href: "/", label: "Accueil" },
            { href: "/chambres", label: "Chambres" },
            { label: room.name },
          ]}
        />
        <article className={`s-room-detail${hasPhotos ? " has-photo" : ""}`}>
          {hasPhotos && (
            <div className="s-room-detail-gallery">
              <RoomGallery photos={room.photos} alt={room.name} />
            </div>
          )}
          <div className="s-room-detail-text">
            <h1 className="s-h1">{room.name}</h1>
            <dl className="s-facts s-room-facts" data-testid="room-facts">
              {facts.map(([k, v]) => (
                <div key={k} className="s-fact">
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {room.description && <p className="s-prose">{room.description}</p>}
          </div>
          <div className="s-room-detail-book">
            <RoomPrice room={{ ...room, minPrice }} />
            {chargesNote && (
              <p className="s-hint" data-testid="room-charges-note">
                {chargesNote}
              </p>
            )}
            <RoomDates roomId={room.id} today={today} />
          </div>
        </article>
        {others.length > 0 && (
          <section className="s-other-rooms" aria-labelledby="autres-chambres">
            <h2 id="autres-chambres" className="s-h3">
              Les autres chambres
            </h2>
            <div className="s-room-list">
              {others.map((r) => (
                <RoomItem key={r.id} room={r} index={r.index} />
              ))}
            </div>
          </section>
        )}
      </div>
    </PublicLayout>
  );
}
