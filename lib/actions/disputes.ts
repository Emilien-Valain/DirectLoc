"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { captureServer } from "@/lib/analytics";
import { DisputeActionError, acceptDispute, saveDisputeEvidence } from "@/lib/disputes";
import { EVIDENCE_FIELDS } from "@/lib/dispute-evidence";

export type DisputeFormState = { error: string } | { saved: true } | null;

/**
 * Formulaire « Répondre au litige » : `intent=draft` enregistre (Stripe `submit: false`) et reste
 * sur la page ; `intent=submit` envoie à la banque (définitif) puis retourne sur la fiche du Dossier.
 * Le tenant vient de la session : un litige d'un autre tenant est introuvable.
 */
export async function respondToDispute(
  dossierId: string,
  disputeId: string,
  _prev: DisputeFormState,
  formData: FormData,
): Promise<DisputeFormState> {
  const { session, tenantId } = await requireSession();
  const submit = formData.get("intent") === "submit";
  const input = Object.fromEntries(EVIDENCE_FIELDS.map(({ key }) => [key, formData.get(key) ?? ""]));
  try {
    await saveDisputeEvidence(tenantId, disputeId, input, submit);
  } catch (e) {
    if (e instanceof DisputeActionError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/admin/dossiers/${dossierId}`);
  revalidatePath(`/admin/dossiers/${dossierId}/litige`);
  if (!submit) return { saved: true };
  captureServer("dispute_submitted", { surface: "admin", tenant_id: tenantId }, session.user.id);
  redirect(`/admin/dossiers/${dossierId}?litige=envoye`);
}

/** « Accepter le litige » (après confirmation) : clôturé chez Stripe, l'argent reste au voyageur. */
export async function acceptDisputeAction(dossierId: string, disputeId: string) {
  const { session, tenantId } = await requireSession();
  try {
    await acceptDispute(tenantId, disputeId);
  } catch (e) {
    if (e instanceof DisputeActionError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/admin/dossiers/${dossierId}`);
  revalidatePath("/admin/reservations");
  captureServer("dispute_accepted", { surface: "admin", tenant_id: tenantId }, session.user.id);
  redirect(`/admin/dossiers/${dossierId}?litige=accepte`);
}
