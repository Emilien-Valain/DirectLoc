"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { manualBlocks, bookingRules, pricingRules, rooms } from "@/db/schema";
import {
  manualBlockSchema,
  bookingRuleSchema,
  pricingRuleSchema,
  pricingValueSchema,
  isUuid,
  safeParseFormData,
  type FormResult,
} from "@/lib/validation";

const REVALIDATE_PATHS = ["/admin/regles", "/admin/calendrier"];

/** "0,6" → [0, 6] ; vide ou sans jour valide → null (tous les jours). */
function parseDays(s?: string) {
  if (!s) return null;
  const days = s.split(",").map(Number).filter((n) => n >= 0 && n <= 6);
  return days.length > 0 ? days : null;
}

function revalidateAll() {
  for (const path of REVALIDATE_PATHS) revalidatePath(path);
}

async function verifyRoomOwnership(roomId: string, tenantId: string) {
  const [room] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.id, roomId), eq(rooms.tenantId, tenantId)))
    .limit(1);
  if (!room) throw new Error("Chambre introuvable");
}

/** Chambres cochées (`roomIds`) qui appartiennent bien au tenant ; les autres sont ignorées. */
async function ownedRoomIds(formData: FormData, tenantId: string): Promise<string[]> {
  const asked = formData.getAll("roomIds").filter((v): v is string => typeof v === "string" && isUuid(v));
  if (asked.length === 0) return [];
  const owned = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(and(inArray(rooms.id, asked), eq(rooms.tenantId, tenantId)));
  return owned.map((r) => r.id);
}

const NOT_FOUND: FormResult = { error: "Règle introuvable", fieldErrors: {} };
const day = (s?: string) => (s ? new Date(s + "T00:00:00.000Z") : null);

// ── Manual Blocks ───────────────────────────────────────────────────────────

async function manualBlockValues(tenantId: string, formData: FormData) {
  const parsed = safeParseFormData(manualBlockSchema, formData);
  if ("error" in parsed) return parsed;
  const { data } = parsed;

  const roomId = data.roomId || null;
  if (roomId) await verifyRoomOwnership(roomId, tenantId);

  const isRecurring = data.recurring === "on";
  return {
    values: {
      roomId,
      startDate: day(data.startDate)!,
      endDate: day(data.endDate)!,
      recurring: isRecurring,
      recurrenceType: isRecurring ? "weekly" : null,
      recurrenceDays: isRecurring ? (parseDays(data.recurrenceDays) ?? []) : [],
      recurrenceUntil: isRecurring ? day(data.recurrenceUntil) : null,
    },
  };
}

export async function createManualBlock(formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  const v = await manualBlockValues(tenantId, formData);
  if ("error" in v) return v;
  await db.insert(manualBlocks).values({ tenantId, ...v.values });
  revalidateAll();
}

export async function updateManualBlock(id: string, formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return NOT_FOUND;
  const v = await manualBlockValues(tenantId, formData);
  if ("error" in v) return v;
  await db
    .update(manualBlocks)
    .set(v.values)
    .where(and(eq(manualBlocks.id, id), eq(manualBlocks.tenantId, tenantId)));
  revalidateAll();
}

export async function deleteManualBlock(id: string) {
  const { tenantId } = await requireSession();
  await db
    .delete(manualBlocks)
    .where(and(eq(manualBlocks.id, id), eq(manualBlocks.tenantId, tenantId)));
  revalidateAll();
}

// ── Booking Rules ───────────────────────────────────────────────────────────

async function bookingRuleValues(tenantId: string, formData: FormData) {
  const parsed = safeParseFormData(bookingRuleSchema, formData);
  if ("error" in parsed) return parsed;
  const { data } = parsed;

  const roomId = data.roomId || null;
  if (roomId) await verifyRoomOwnership(roomId, tenantId);

  return {
    values: {
      roomId,
      validFrom: day(data.validFrom),
      validTo: day(data.validTo),
      minStay: data.minStay ?? null,
      maxStay: data.maxStay ?? null,
      allowedCheckInDays: parseDays(data.allowedCheckInDays),
      allowedCheckOutDays: parseDays(data.allowedCheckOutDays),
    },
  };
}

export async function createBookingRule(formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  const v = await bookingRuleValues(tenantId, formData);
  if ("error" in v) return v;
  await db.insert(bookingRules).values({ tenantId, ...v.values });
  revalidateAll();
}

export async function updateBookingRule(id: string, formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return NOT_FOUND;
  const v = await bookingRuleValues(tenantId, formData);
  if ("error" in v) return v;
  await db
    .update(bookingRules)
    .set(v.values)
    .where(and(eq(bookingRules.id, id), eq(bookingRules.tenantId, tenantId)));
  revalidateAll();
}

export async function deleteBookingRule(id: string) {
  const { tenantId } = await requireSession();
  await db
    .delete(bookingRules)
    .where(and(eq(bookingRules.id, id), eq(bookingRules.tenantId, tenantId)));
  revalidateAll();
}

// ── Pricing Rules ───────────────────────────────────────────────────────────

const decimal = (v?: string) => (v ? v.replace(",", ".") : null);

async function pricingRuleValues(tenantId: string, formData: FormData) {
  const parsed = safeParseFormData(pricingRuleSchema, formData);
  if ("error" in parsed) return parsed;
  const { data } = parsed;
  return {
    values: {
      roomIds: await ownedRoomIds(formData, tenantId),
      name: data.name,
      validFrom: day(data.validFrom),
      validTo: day(data.validTo),
      daysOfWeek: parseDays(data.daysOfWeek),
      fixedPrice: decimal(data.fixedPrice),
      percentageModifier: decimal(data.percentageModifier),
    },
  };
}

/**
 * Crée une règle. Avec `perRoom=on`, crée une règle par chambre — même nom, même
 * saison, mêmes jours — chacune avec sa valeur (`value_<roomId>`, prix fixe ou %
 * selon `priceType`) ; une chambre laissée vide n'a pas de règle.
 */
export async function createPricingRule(formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  if (formData.get("perRoom") !== "on") {
    const v = await pricingRuleValues(tenantId, formData);
    if ("error" in v) return v;
    await db.insert(pricingRules).values({ tenantId, ...v.values });
    revalidateAll();
    return;
  }

  const kind = formData.get("priceType") === "percentage" ? "percentageModifier" : "fixedPrice";
  const tenantRooms = await db
    .select({ id: rooms.id, name: rooms.name })
    .from(rooms)
    .where(eq(rooms.tenantId, tenantId));
  const perRoom: { roomId: string; value: string }[] = [];
  for (const r of tenantRooms) {
    const raw = formData.get(`value_${r.id}`)?.toString().trim();
    if (!raw) continue;
    const check = pricingValueSchema[kind].safeParse(raw);
    if (!check.success) {
      const msg = `${r.name} : ${check.error.issues[0].message}`;
      return { error: msg, fieldErrors: { [`value_${r.id}`]: msg } };
    }
    perRoom.push({ roomId: r.id, value: raw.replace(",", ".") });
  }
  if (perRoom.length === 0) {
    return { error: "Indiquez une valeur pour au moins une chambre", fieldErrors: {} };
  }

  // Le schéma valide nom, dates et jours ; la valeur commune est remplacée chambre par chambre.
  const common = new FormData();
  for (const [k, v] of formData.entries()) if (!k.startsWith("value_") && k !== "roomIds") common.append(k, v);
  common.set(kind, perRoom[0].value);
  const v = await pricingRuleValues(tenantId, common);
  if ("error" in v) return v;

  await db.insert(pricingRules).values(
    perRoom.map((p) => ({
      tenantId,
      ...v.values,
      roomIds: [p.roomId],
      fixedPrice: kind === "fixedPrice" ? p.value : null,
      percentageModifier: kind === "percentageModifier" ? p.value : null,
    })),
  );
  revalidateAll();
}

export async function updatePricingRule(id: string, formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  if (!isUuid(id)) return NOT_FOUND;
  const v = await pricingRuleValues(tenantId, formData);
  if ("error" in v) return v;
  await db
    .update(pricingRules)
    .set(v.values)
    .where(and(eq(pricingRules.id, id), eq(pricingRules.tenantId, tenantId)));
  revalidateAll();
}

export async function deletePricingRule(id: string) {
  const { tenantId } = await requireSession();
  await db
    .delete(pricingRules)
    .where(and(eq(pricingRules.id, id), eq(pricingRules.tenantId, tenantId)));
  revalidateAll();
}

export async function togglePricingRule(id: string) {
  const { tenantId } = await requireSession();

  const [rule] = await db
    .select({ active: pricingRules.active })
    .from(pricingRules)
    .where(and(eq(pricingRules.id, id), eq(pricingRules.tenantId, tenantId)))
    .limit(1);

  if (!rule) throw new Error("Règle introuvable");

  await db
    .update(pricingRules)
    .set({ active: !rule.active })
    .where(and(eq(pricingRules.id, id), eq(pricingRules.tenantId, tenantId)));

  revalidateAll();
}
