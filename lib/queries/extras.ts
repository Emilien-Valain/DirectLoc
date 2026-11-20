import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookingLines, extras } from "@/db/schema";
import type { ExtraUnit } from "@/lib/extras";

/** Extra du catalogue tel que l'affichent les formulaires (prix en nombre). */
export type CatalogExtra = {
  id: string;
  label: string;
  description: string | null;
  price: number;
  unit: ExtraUnit;
  /** Nombre au choix du client ; null = pas de choix (voir `chosenMax`). */
  maxQuantity: number | null;
  /** Chambres qui la proposent ; vide = toutes (`matchesRoom`). */
  roomIds: string[];
  active: boolean;
};

/** Catalogue d'un tenant ; `activeOnly` pour ce qu'un client ou l'hôte peut encore choisir. */
export async function getExtrasByTenant(tenantId: string, { activeOnly = false } = {}): Promise<CatalogExtra[]> {
  const rows = await db
    .select()
    .from(extras)
    .where(and(eq(extras.tenantId, tenantId), activeOnly ? eq(extras.active, true) : undefined))
    .orderBy(asc(extras.createdAt));
  return rows.map((x) => ({
    id: x.id,
    label: x.label,
    description: x.description,
    price: parseFloat(x.price),
    unit: x.unit,
    maxQuantity: x.maxQuantity,
    roomIds: x.roomIds,
    active: x.active,
  }));
}

/**
 * Toutes les lignes d'une réservation — Extras, Fees, taxe (ADR-0011) : ce que
 * récap, emails, PDF et reste à payer affichent. L'appelant a déjà vérifié le tenant.
 */
export async function getBookingLines(bookingId: string) {
  const rows = await db
    .select()
    .from(bookingLines)
    .where(eq(bookingLines.bookingId, bookingId))
    .orderBy(asc(bookingLines.createdAt), asc(bookingLines.label));
  return rows.map((l) => ({
    id: l.id,
    kind: l.kind,
    sourceId: l.sourceId,
    label: l.label,
    unit: l.unit,
    unitPrice: parseFloat(l.unitPrice),
    chosen: l.chosen,
    quantity: l.quantity,
    total: parseFloat(l.total),
    exempt: l.exempt,
  }));
}
