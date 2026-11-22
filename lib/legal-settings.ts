import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";
import type { Tx } from "@/lib/booking-intake";
import type { TenantConfig } from "@/lib/tenant-context";
import { acceptedTerms, type LegalSettings } from "@/lib/legal-documents";

/** Colonnes d'un tenant lues par les documents légaux. */
type LegalRow = {
  name: string;
  config: unknown;
  legalName: string | null;
  legalForm: string | null;
  siret: string | null;
  publicationDirector: string | null;
  mediator: string | null;
  cancellationLevel: LegalSettings["cancellationLevel"];
  cancellationText: string | null;
  cgvText: string | null;
  legalNoticeText: string | null;
  privacyText: string | null;
  legalPublishedAt: Date | null;
};

const legalColumns = {
  name: tenants.name,
  config: tenants.config,
  legalName: tenants.legalName,
  legalForm: tenants.legalForm,
  siret: tenants.siret,
  publicationDirector: tenants.publicationDirector,
  mediator: tenants.mediator,
  cancellationLevel: tenants.cancellationLevel,
  cancellationText: tenants.cancellationText,
  cgvText: tenants.cgvText,
  legalNoticeText: tenants.legalNoticeText,
  privacyText: tenants.privacyText,
  legalPublishedAt: tenants.legalPublishedAt,
};

/** Un tenant (ligne complète ou colonnes légales) → réglages des documents légaux. */
export function legalSettingsOf(row: LegalRow): LegalSettings {
  const config = (row.config ?? {}) as TenantConfig;
  return {
    name: row.name,
    legalName: row.legalName,
    legalForm: row.legalForm,
    siret: row.siret,
    publicationDirector: row.publicationDirector,
    mediator: row.mediator,
    address: config.address,
    email: config.email,
    phone: config.phone,
    checkInTime: config.checkInTime,
    checkOutTime: config.checkOutTime,
    cancellationLevel: row.cancellationLevel,
    cancellationText: row.cancellationText,
    cgvText: row.cgvText,
    legalNoticeText: row.legalNoticeText,
    privacyText: row.privacyText,
    legalPublishedAt: row.legalPublishedAt,
  };
}

export async function getLegalSettings(tenantId: string, conn: Tx | typeof db = db): Promise<LegalSettings | null> {
  const [row] = await conn.select(legalColumns).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return row ? legalSettingsOf(row) : null;
}

/**
 * Preuve d'acceptation à poser sur le Dossier créé au paiement (dans la transaction
 * d'admission) : texte exact des conditions d'annulation et des CGV publiées, et la date.
 * Rien si l'établissement n'a pas publié ses documents.
 */
export async function acceptedTermsFor(conn: Tx, tenantId: string) {
  const settings = await getLegalSettings(tenantId, conn);
  return (settings && acceptedTerms(settings)) ?? {};
}
