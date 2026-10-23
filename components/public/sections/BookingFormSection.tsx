import type { TenantConfig } from "@/lib/tenant-context";
import ClassicBookingFormBlock from "@/components/public/templates/classic/BookingFormBlock";
import BoutiqueBookingFormBlock from "@/components/public/templates/boutique/BookingFormBlock";

type Room = {
  id: string;
  name: string;
  slug: string;
  pricePerNight: string;
  capacity: number;
  photos?: unknown;
};

export default function BookingFormSection({
  room,
  config,
  minPrice,
}: {
  room: Room;
  config: TenantConfig;
  minPrice: number;
}) {
  if (config.template === "boutique") {
    return (
      <BoutiqueBookingFormBlock
        room={room}
        config={config}
        minPrice={minPrice}
      />
    );
  }
  return (
    <ClassicBookingFormBlock
      room={room}
      minPrice={minPrice}
    />
  );
}
