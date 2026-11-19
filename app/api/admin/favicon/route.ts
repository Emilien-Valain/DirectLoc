import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { isDemoTenant } from "@/lib/demo";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";
import { tenantPhotosDir, tenantPhotoFilePath, tenantPhotoPublicUrl, ensureDir } from "@/lib/uploads";
import { mergeTenantConfig } from "@/lib/tenant-config";
import type { TenantConfig } from "@/lib/tenant-context";

/**
 * Icône d'onglet du site de l'hôtel. L'image envoyée (PNG, JPEG, WebP — pas de SVG,
 * qui pourrait porter du script) est recadrée en carré 512 px PNG, fond transparent.
 */

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const SIZE = 512;

async function currentFavicon(tenantId: string) {
  const [t] = await db.select({ config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return ((t?.config ?? {}) as TenantConfig).favicon ?? null;
}

async function save(tenantId: string, favicon: TenantConfig["favicon"]) {
  await db.update(tenants).set({ config: mergeTenantConfig({ favicon }) }).where(eq(tenants.id, tenantId));
  revalidatePath("/admin/parametres");
  revalidatePath("/", "layout");
}

async function removeFile(tenantId: string, filename?: string) {
  if (!filename) return;
  try {
    await fs.unlink(tenantPhotoFilePath(tenantId, filename));
  } catch {
    // déjà absent
  }
}

export async function POST(request: NextRequest) {
  const { tenantId } = await requireSession();
  if (await isDemoTenant(tenantId)) {
    return NextResponse.json({ error: "Désactivé en démo" }, { status: 403 });
  }

  const formData = await request.formData();
  const file = formData.get("favicon");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Aucun fichier" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "Format non accepté : PNG, JPEG ou WebP" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "Fichier trop volumineux (2 Mo max)" }, { status: 400 });
  }

  let png: Buffer;
  try {
    png = await sharp(Buffer.from(await file.arrayBuffer()))
      .resize({ width: SIZE, height: SIZE, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch {
    // Type annoncé valide mais contenu illisible (fichier renommé, corrompu).
    return NextResponse.json({ error: "Image illisible" }, { status: 400 });
  }

  await ensureDir(tenantPhotosDir(tenantId));
  const filename = `favicon-${randomUUID()}.png`;
  await fs.writeFile(tenantPhotoFilePath(tenantId, filename), png);

  const previous = await currentFavicon(tenantId);
  const favicon = { filename, url: tenantPhotoPublicUrl(tenantId, filename) };
  await save(tenantId, favicon);
  await removeFile(tenantId, previous?.filename);

  return NextResponse.json({ favicon });
}

export async function DELETE() {
  const { tenantId } = await requireSession();
  if (await isDemoTenant(tenantId)) {
    return NextResponse.json({ error: "Désactivé en démo" }, { status: 403 });
  }
  const previous = await currentFavicon(tenantId);
  // undefined retire la clé du JSON (mergeTenantConfig).
  await save(tenantId, undefined);
  await removeFile(tenantId, previous?.filename);
  return NextResponse.json({ favicon: null });
}
