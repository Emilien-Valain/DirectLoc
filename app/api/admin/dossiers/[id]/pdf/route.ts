import { headers } from "next/headers";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { pdfResponse, renderReservationPdf } from "@/lib/reservation-pdf";

/** PDF du Dossier entier (ADR-0012) : toutes ses chambres, annulées comprises (marquées). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Le proxy gère l'auth et injecte x-tenant-id.
  const tenantId = (await headers()).get("x-tenant-id");
  if (!tenantId) return new Response("Unauthorized", { status: 401 });
  if (!isUuid(id)) return new Response("Not found", { status: 404 });

  const list = await db
    .select({ booking: bookings })
    .from(bookings)
    .innerJoin(dossiers, eq(dossiers.id, bookings.dossierId))
    .where(and(eq(bookings.dossierId, id), eq(bookings.tenantId, tenantId), eq(dossiers.tenantId, tenantId)))
    .orderBy(asc(bookings.createdAt), asc(bookings.id));
  if (list.length === 0) return new Response("Not found", { status: 404 });

  return pdfResponse(
    await renderReservationPdf(tenantId, list.map((r) => r.booking), {
      ref: id.slice(0, 8).toUpperCase(),
      filePrefix: `dossier-${id.slice(0, 8)}`,
    }),
  );
}
