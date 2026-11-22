"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";
import { safeParseFormData, type FormResult } from "@/lib/validation";
import { getLegalSettings } from "@/lib/legal-settings";
import { CANCELLATION_LEVELS, templateFor, type LegalDocKind, type LegalInfo } from "@/lib/legal-documents";

const MAX_DOC = 30_000;

const optional = (max: number) => z.string().trim().max(max, `Trop long (${max} caractères max)`).optional();
const doc = z
  .string()
  .max(MAX_DOC, `Texte trop long (${MAX_DOC} caractères max)`)
  .optional()
  .transform((v) => v?.replace(/\r\n?/g, "\n").trim() || null);

const legalSchema = z.object({
  legalName: optional(200),
  legalForm: optional(120),
  siret: z
    .string()
    .optional()
    .transform((v) => v?.replace(/\s+/g, "") ?? "")
    .refine((v) => v === "" || /^\d{14}$/.test(v), "Le SIRET compte 14 chiffres"),
  publicationDirector: optional(200),
  mediator: optional(500),
  cancellationLevel: z.enum(CANCELLATION_LEVELS, { message: "Choisissez un niveau d'annulation" }),
  cancellationText: doc,
  cgvText: doc,
  legalNoticeText: doc,
  privacyText: doc,
  intent: z.enum(["save", "publish"]).optional(),
});

/**
 * Paramètres → Documents légaux : identité de l'exploitant, niveau d'annulation et textes.
 * Un texte identique au modèle est stocké NULL : il suit alors les infos du tenant.
 * `intent=publish` publie les documents (pages publiques complètes, acceptation au paiement).
 */
export async function saveLegalDocuments(formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();

  const parsed = safeParseFormData(legalSchema, formData);
  if ("error" in parsed) return parsed;
  const { data } = parsed;

  if (data.cancellationLevel === "custom" && !data.cancellationText) {
    return {
      error: "Rédigez vos conditions d'annulation, ou choisissez un des niveaux proposés.",
      fieldErrors: { cancellationText: "Texte requis" },
    };
  }

  const current = await getLegalSettings(tenantId);
  if (!current) return { error: "Établissement introuvable.", fieldErrors: {} };

  const info: LegalInfo = {
    ...current,
    legalName: data.legalName || null,
    legalForm: data.legalForm || null,
    siret: data.siret || null,
    publicationDirector: data.publicationDirector || null,
    mediator: data.mediator || null,
  };
  // Le modèle tel quel n'est pas « modifié » : il continue de suivre les infos de l'établissement.
  const keep = (kind: Exclude<LegalDocKind, "cancellation">, text: string | null) =>
    text && text !== templateFor(kind, info).trim() ? text : null;

  await db
    .update(tenants)
    .set({
      legalName: info.legalName,
      legalForm: info.legalForm,
      siret: info.siret,
      publicationDirector: info.publicationDirector,
      mediator: info.mediator,
      cancellationLevel: data.cancellationLevel,
      cancellationText: data.cancellationLevel === "custom" ? data.cancellationText : null,
      cgvText: keep("cgv", data.cgvText),
      legalNoticeText: keep("legalNotice", data.legalNoticeText),
      privacyText: keep("privacy", data.privacyText),
      ...(data.intent === "publish" && !current.legalPublishedAt ? { legalPublishedAt: new Date() } : {}),
    })
    .where(eq(tenants.id, tenantId));

  // Pages légales, pied de page de tout le site et mention au paiement.
  revalidatePath("/", "layout");
}
