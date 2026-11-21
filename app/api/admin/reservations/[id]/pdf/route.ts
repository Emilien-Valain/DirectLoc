import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { pdfResponse, renderReservationPdf } from "@/lib/reservation-pdf";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const headersList = await headers();

  // Le middleware proxy gère l'auth et injecte x-tenant-id
  const tenantId = headersList.get("x-tenant-id");
  if (!tenantId) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Un id non-UUID ferait planter Postgres → 404 comme une réservation inconnue
  if (!isUuid(id)) {
    return new Response("Not found", { status: 404 });
  }

  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.tenantId, tenantId)))
    .limit(1);

  if (!booking) {
    return new Response("Not found", { status: 404 });
  }

  return pdfResponse(
    await renderReservationPdf(tenantId, [booking], {
      ref: booking.id.slice(0, 8).toUpperCase(),
      filePrefix: `reservation-${booking.id.slice(0, 8)}`,
    }),
  );
}
