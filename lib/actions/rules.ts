"use server";

import { randomUUID } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { ownedRoomIds } from "@/lib/room-scope";
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

const NOT_FOUND: FormResult = { error: "Règle introuvable", fieldErrors: {} };
const day = (s?: string) => (s ? new Date(s + "T00:00:00.000Z") : null);

// ── Manual Blocks ───────────────────────────────────────────────────────────

async function manualBlockValues(tenantId: string, formData: FormData) {
  const parsed = safeParseFormData(manualBlockSchema, formData);
  if ("error" in parsed) return parsed;
  const { data } = parsed;

  const roomIds = await ownedRoomIds(formData, tenantId);
  if ("error" in roomIds) return roomIds;

  const isRecurring = data.recurring === "on";
  return {
    values: {
      roomIds,
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

  const roomIds = await ownedRoomIds(formData, tenantId);
  if ("error" in roomIds) return roomIds;

  return {
    values: {
      roomIds,
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
  const roomIds = await ownedRoomIds(formData, tenantId);
  if ("error" in roomIds) return roomIds;
  return {
    values: {
      roomIds,
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
 * Valeurs « une par chambre » (`value_<roomId>`, prix fixe ou % selon `priceType`) +
 * champs communs (nom, période, jours). Une chambre laissée vide n'a pas de règle.
 */
async function perRoomValues(tenantId: string, formData: FormData) {
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
  const rowFor = (p: { roomId: string; value: string }) => ({
    ...v.values,
    roomIds: [p.roomId],
    fixedPrice: kind === "fixedPrice" ? p.value : null,
    percentageModifier: kind === "percentageModifier" ? p.value : null,
  });
  return { perRoom, rowFor };
}

/**
 * Crée une règle. Avec `perRoom=on`, crée un groupe : une règle par chambre remplie,
 * même nom, même saison, mêmes jours, chacune avec sa valeur.
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

  const g = await perRoomValues(tenantId, formData);
  if ("error" in g) return g;
  const groupId = randomUUID();
  await db.insert(pricingRules).values(g.perRoom.map((p) => ({ tenantId, groupId, ...g.rowFor(p) })));
  revalidateAll();
}

const inGroup = (tenantId: string, groupId: string) =>
  and(eq(pricingRules.groupId, groupId), eq(pricingRules.tenantId, tenantId));

/**
 * Modifie tout un groupe : nom, période, jours et type communs ; une valeur par chambre.
 * Chambre vidée → sa règle est supprimée ; chambre nouvellement remplie → règle ajoutée
 * au groupe (active si le groupe l'est).
 */
export async function updatePricingRuleGroup(groupId: string, formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();
  if (!isUuid(groupId)) return NOT_FOUND;
  const existing = await db
    .select({ id: pricingRules.id, roomIds: pricingRules.roomIds, active: pricingRules.active })
    .from(pricingRules)
    .where(inGroup(tenantId, groupId));
  if (existing.length === 0) return NOT_FOUND;

  const g = await perRoomValues(tenantId, formData);
  if ("error" in g) return g;
  const active = existing.some((r) => r.active);
  const byRoom = new Map(existing.map((r) => [r.roomIds[0], r.id]));

  await db.transaction(async (tx) => {
    for (const p of g.perRoom) {
      const id = byRoom.get(p.roomId);
      if (id) {
        await tx.update(pricingRules).set(g.rowFor(p)).where(and(eq(pricingRules.id, id), eq(pricingRules.tenantId, tenantId)));
        byRoom.delete(p.roomId);
      } else {
        await tx.insert(pricingRules).values({ tenantId, groupId, active, ...g.rowFor(p) });
      }
    }
    const removed = [...byRoom.values()];
    if (removed.length > 0) {
      await tx.delete(pricingRules).where(and(inGroup(tenantId, groupId), inArray(pricingRules.id, removed)));
    }
  });
  revalidateAll();
}

export async function deletePricingRuleGroup(groupId: string) {
  const { tenantId } = await requireSession();
  if (!isUuid(groupId)) return;
  await db.delete(pricingRules).where(inGroup(tenantId, groupId));
  revalidateAll();
}

/** Active ou désactive tout le groupe d'un coup (désactivé seulement si aucune n'est active). */
export async function togglePricingRuleGroup(groupId: string) {
  const { tenantId } = await requireSession();
  if (!isUuid(groupId)) return;
  const rows = await db.select({ active: pricingRules.active }).from(pricingRules).where(inGroup(tenantId, groupId));
  if (rows.length === 0) throw new Error("Règle introuvable");
  await db
    .update(pricingRules)
    .set({ active: !rows.some((r) => r.active) })
    .where(inGroup(tenantId, groupId));
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
