"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { captureServer } from "@/lib/analytics";
import { DossierActionError, refundDossierPayment } from "@/lib/dossier-admin";
import { notifyGuestRefund } from "@/lib/refunds";
import { parseRefundAmount } from "@/lib/refund-amounts";

export type RefundFormState = { error: string } | null;

/**
 * « Rembourser » depuis la fiche Dossier : montant libre (≤ restant remboursable, contrôlé
 * côté serveur sous verrou), motif facultatif. Succès → email au voyageur (jamais depuis la
 * démo) puis retour sur la fiche (`?rembourse=1|sans-email`). Refus → message dans le dialog.
 */
export async function refundDossier(dossierId: string, _prev: RefundFormState, formData: FormData): Promise<RefundFormState> {
  const { session, tenantId } = await requireSession();
  const amountCents = parseRefundAmount(formData.get("amount"));
  if (amountCents === null) return { error: "Saisissez un montant en euros supérieur à 0 (par exemple 45 ou 45,50)." };
  let result;
  try {
    result = await refundDossierPayment(tenantId, dossierId, {
      amountCents,
      requestId: String(formData.get("requestId") ?? ""),
      reason: String(formData.get("reason") ?? ""),
      userId: session.user.id,
    });
  } catch (e) {
    if (e instanceof DossierActionError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/admin/dossiers/${dossierId}`);
  revalidatePath("/admin/reservations");
  const emailed = result.created ? await notifyGuestRefund(tenantId, dossierId, result.amount) : true;
  if (result.created) captureServer("refund_created", { surface: "admin", tenant_id: tenantId, source: "dossier" }, session.user.id);
  redirect(`/admin/dossiers/${dossierId}?rembourse=${emailed ? "1" : "sans-email"}`);
}
