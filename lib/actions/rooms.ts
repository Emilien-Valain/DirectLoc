"use server";

import { readRoomInfo } from "@/lib/room-info";
import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { notifyIndexNow } from "@/lib/indexnow";
import { rooms, properties, tenants } from "@/db/schema";
import { isUuid, roomEmailSchema, roomSchema, roomUpdateSchema, safeParseFormData, type FormResult } from "@/lib/validation";

async function requireTenantId(): Promise<string> {
  const { tenantId } = await requireSession();
  return tenantId;
}

function slugify(str: string) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Slug unique par tenant : si vide (nom sans lettres latines) ou déjà pris par une autre chambre,
// on suffixe avec les 6 premiers caractères de l'id de la chambre.
async function uniqueRoomSlug(tenantId: string, roomId: string, name: string): Promise<string> {
  const base = slugify(name);
  if (base) {
    const taken = await db.query.rooms.findFirst({
      where: and(eq(rooms.tenantId, tenantId), eq(rooms.slug, base), ne(rooms.id, roomId)),
      columns: { id: true },
    });
    if (!taken) return base;
  }
  return `${base || "chambre"}-${roomId.slice(0, 6)}`;
}

export async function createRoom(formData: FormData): Promise<FormResult> {
  const tenantId = await requireTenantId();

  const parsed = safeParseFormData(roomSchema, formData);
  if ("error" in parsed) return parsed;
  const { data } = parsed;
  const name = data.nom;
  const description = data.description || null;
  const pricePerNight = data.prix.replace(",", ".");
  const capacity = data.capacite;
  const beds = data.lits;
  // 1 tenant = 1 property dans ce modèle — on auto-crée si absente
  let property = await db.query.properties.findFirst({
    where: eq(properties.tenantId, tenantId),
  });

  if (!property) {
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { name: true },
    });
    [property] = await db
      .insert(properties)
      .values({ tenantId, name: tenant?.name ?? "Propriété" })
      .returning();
  }

  const id = crypto.randomUUID();
  const slug = await uniqueRoomSlug(tenantId, id, name);
  await db.insert(rooms).values({
    id,
    tenantId,
    propertyId: property.id,
    name,
    slug,
    description,
    pricePerNight,
    capacity,
    beds,
  });

  notifyIndexNow(tenantId, ["/", "/chambres", `/chambres/${slug}`]);
  revalidatePath("/admin/chambres");
  redirect("/admin/chambres");
}

export async function updateRoom(id: string, formData: FormData): Promise<FormResult> {
  const tenantId = await requireTenantId();

  const parsed = safeParseFormData(roomUpdateSchema, formData);
  if ("error" in parsed) return parsed;
  const { data } = parsed;
  const name = data.nom;
  const description = data.description || null;
  const pricePerNight = data.prix.replace(",", ".");
  const capacity = data.capacite;
  const beds = data.lits;
  const active = data.actif === "on";

  const old = await db.query.rooms.findFirst({
    where: and(eq(rooms.id, id), eq(rooms.tenantId, tenantId)),
    columns: { slug: true },
  });
  const slug = await uniqueRoomSlug(tenantId, id, name);
  await db
    .update(rooms)
    .set({ name, slug, description, pricePerNight, capacity, beds, active })
    .where(and(eq(rooms.id, id), eq(rooms.tenantId, tenantId)));

  // Ancienne URL incluse : un renommage ou une désactivation la rend 404, à désindexer.
  if (old) notifyIndexNow(tenantId, ["/", "/chambres", `/chambres/${slug}`, `/chambres/${old.slug}`]);
  revalidatePath("/admin/chambres");
  redirect("/admin/chambres");
}

export async function deleteRoom(id: string): Promise<{ error?: string }> {
  const tenantId = await requireTenantId();

  try {
    const [deleted] = await db
      .delete(rooms)
      .where(and(eq(rooms.id, id), eq(rooms.tenantId, tenantId)))
      .returning({ slug: rooms.slug });
    if (deleted) notifyIndexNow(tenantId, ["/", "/chambres", `/chambres/${deleted.slug}`]);
  } catch (e) {
    // 23503 = clé étrangère : la chambre a encore des réservations, blocages ou calendriers liés.
    const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === "23503") {
      return {
        error:
          "Cette chambre a des réservations ou des calendriers liés : elle ne peut pas être supprimée. Désactivez-la plutôt depuis « Modifier ».",
      };
    }
    throw e;
  }

  revalidatePath("/admin/chambres");
  return {};
}

/**
 * Paramètres → Emails, bloc d'une chambre : infos pratiques ({etage}…) et message
 * ajouté aux emails de ses réservations. Seul endroit où ils se modifient.
 */
export async function updateRoomEmail(id: string, formData: FormData): Promise<FormResult> {
  const tenantId = await requireTenantId();
  if (!isUuid(id)) return { error: "Chambre introuvable", fieldErrors: {} };
  const parsed = safeParseFormData(roomEmailSchema, formData);
  if ("error" in parsed) return parsed;
  const read = readRoomInfo(formData);
  if ("error" in read) return read;

  const updated = await db
    .update(rooms)
    .set({ emailMessage: parsed.data.messageEmail?.trim() || null, info: read.info })
    .where(and(eq(rooms.id, id), eq(rooms.tenantId, tenantId)))
    .returning({ id: rooms.id });
  if (updated.length === 0) return { error: "Chambre introuvable", fieldErrors: {} };
  revalidatePath("/admin/parametres");
}
