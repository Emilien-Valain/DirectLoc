import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import PublicLayout from "@/components/public/PublicLayout";
import Confirmation from "@/components/public/Confirmation";
import { requireTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { bookings, payments, rooms } from "@/db/schema";
import type { TenantConfig } from "@/lib/tenant-context";
import { getBookingLines } from "@/lib/queries/extras";

export default async function ConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;

  const headersList = await headers();
  const tenantId = headersList.get("x-tenant-id");

  if (!tenantId) {
    notFound();
  }

  const tenant = await requireTenant();
  const config = (tenant.config ?? {}) as TenantConfig;

  let booking;

  if (session_id) {
    const [payment] = await db
      .select({ bookingId: payments.bookingId })
      .from(payments)
      .where(
        and(eq(payments.stripeSessionId, session_id), eq(payments.tenantId, tenantId)),
      )
      .limit(1);

    if (!payment) {
      notFound();
    }

    [booking] = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, payment.bookingId), eq(bookings.tenantId, tenantId)))
      .limit(1);
  }

  if (!booking) {
    notFound();
  }

  const extraLines = await getBookingLines(booking.id);

  const [room] = await db
    .select({ name: rooms.name })
    .from(rooms)
    .where(eq(rooms.id, booking.roomId))
    .limit(1);

  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);

  const nights = Math.round(
    (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24),
  );

  const isPaid = booking.status === "confirmed";

  // Référence courte basée sur l'id du booking (6 derniers caractères hex)
  const reference = `${tenant.slug.slice(0, 2).toUpperCase()}-${booking.id.slice(-6).toUpperCase()}`;

  return (
    <PublicLayout>
      <Confirmation
        isPaid={isPaid}
        guestName={booking.guestName}
        guestEmail={booking.guestEmail}
        roomName={room?.name ?? null}
        checkIn={checkIn}
        checkOut={checkOut}
        nights={nights}
        totalPrice={booking.totalPrice}
        extras={extraLines}
        reference={reference}
        config={config}
      />
    </PublicLayout>
  );
}
