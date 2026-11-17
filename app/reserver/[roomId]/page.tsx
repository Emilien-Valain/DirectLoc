import { notFound } from "next/navigation";
import PublicLayout from "@/components/public/PublicLayout";
import BookingForm from "@/components/public/BookingForm";
import { Breadcrumb } from "@/components/public/Site";
import { requireTenant, type TenantConfig } from "@/lib/tenant-context";
import { getRoomByIdPublic } from "@/lib/queries/public";
import { getExtrasByTenant } from "@/lib/queries/extras";
import { getFeesByTenant } from "@/lib/queries/fees";
import { feeAppliesTo } from "@/lib/extras";
import { isDemoTenant } from "@/lib/demo";

// Tunnel de réservation : rien à indexer.
export const metadata = { robots: { index: false, follow: false } };

export default async function ReserverPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const tenant = await requireTenant();
  const [room, extras, fees, demo] = await Promise.all([
    getRoomByIdPublic(tenant.id, roomId),
    getExtrasByTenant(tenant.id, { activeOnly: true }),
    getFeesByTenant(tenant.id, { activeOnly: true }),
    isDemoTenant(tenant.id),
  ]);

  if (!room) {
    notFound();
  }
  const config = (tenant.config ?? {}) as TenantConfig;

  return (
    <PublicLayout>
      <div className="s-page">
        <Breadcrumb
          items={[
            { href: "/", label: "Accueil" },
            { href: "/chambres", label: "Chambres" },
            { href: `/chambres/${room.slug}`, label: room.name },
            { label: "Réserver" },
          ]}
        />
        <h1 className="s-h1">Réserver {room.name}</h1>
        <BookingForm
          room={{
            id: room.id,
            name: room.name,
            pricePerNight: room.pricePerNight,
            capacity: room.capacity,
            photos: room.photos,
          }}
          extras={extras}
          fees={fees.filter((f) => feeAppliesTo(f, room.id))}
          touristTax={config.touristTax}
          host={{ phone: config.phone, checkInTime: config.checkInTime, checkOutTime: config.checkOutTime }}
          demo={demo}
        />
      </div>
    </PublicLayout>
  );
}
