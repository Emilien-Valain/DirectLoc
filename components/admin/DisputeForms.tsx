"use client";

import { useActionState, useId, useRef, useState } from "react";
import { respondToDispute, type DisputeFormState } from "@/lib/actions/disputes";
import { EVIDENCE_FIELDS, EVIDENCE_MAX, type Evidence } from "@/lib/dispute-evidence";
import { AdminTextarea } from "@/components/admin/ui-inputs";

/**
 * « Répondre au litige » : preuves texte préremplies et modifiables. « Enregistrer le brouillon »
 * (Stripe `submit: false`, on reste sur la page) ; « Envoyer à la banque » ouvre une confirmation
 * (définitif). Les deux boutons soumettent le même formulaire (`intent`).
 */
export function DisputeResponseForm({
  dossierId,
  disputeId,
  evidence,
}: {
  dossierId: string;
  disputeId: string;
  evidence: Evidence;
}) {
  const formId = useId();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  // Champs contrôlés : React réinitialise un formulaire non contrôlé après l'action (brouillon).
  const [values, setValues] = useState<Evidence>(evidence);
  const [state, action, pending] = useActionState<DisputeFormState, FormData>(
    respondToDispute.bind(null, dossierId, disputeId),
    null,
  );
  return (
    <>
      <form id={formId} action={action} className="space-y-4" data-dispute-form>
        {EVIDENCE_FIELDS.map((f) => {
          const id = `${formId}-${f.key}`;
          const hint = "hint" in f ? f.hint : undefined;
          return (
            <div key={f.key} className="space-y-1.5">
              <label
                htmlFor={id}
                className="block text-[12px] font-bold uppercase"
                style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}
              >
                {f.label}
              </label>
              <AdminTextarea
                id={id}
                name={f.key}
                rows={f.rows}
                maxLength={EVIDENCE_MAX}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                aria-describedby={hint ? `${id}-hint` : undefined}
                data-evidence={f.key}
                style={{ width: "100%" }}
              />
              {hint && (
                <p id={`${id}-hint`} className="text-[12px]" style={{ color: "var(--admin-text-subtle)" }}>
                  {hint}
                </p>
              )}
            </div>
          );
        })}
        <div role="status" aria-live="polite">
          {state && "error" in state && (
            <p role="alert" className="text-[12.5px] font-semibold" style={{ color: "var(--admin-danger)" }} data-dispute-error>
              {state.error}
            </p>
          )}
          {state && "saved" in state && !pending && (
            <p className="text-[12.5px] font-semibold" style={{ color: "#15803D" }} data-dispute-saved>
              Brouillon enregistré, chez Stripe aussi. Rien n&apos;est encore envoyé à la banque.
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="submit"
            name="intent"
            value="draft"
            disabled={pending}
            className="admin-btn admin-btn--ghost"
            data-dispute-draft
          >
            {pending ? "Enregistrement…" : "Enregistrer le brouillon"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => dialog.current?.showModal()}
            className="admin-btn"
            style={{ background: "var(--admin-primary)", color: "#fff", border: "none" }}
            data-dispute-send
          >
            Envoyer à la banque
          </button>
        </div>
      </form>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="admin-dialog"
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="p-6">
          <h2 id={titleId} className="text-[15px] font-extrabold" style={{ color: "var(--admin-text)", letterSpacing: "-0.3px" }}>
            Envoyer la réponse à la banque ?
          </h2>
          <p className="text-[13.5px] leading-[1.55] mt-2" style={{ color: "var(--admin-text-muted)" }}>
            C&apos;est <strong style={{ color: "var(--admin-text)" }}>définitif</strong> : la réponse ne pourra plus être modifiée ni
            complétée. Ajoutez d&apos;abord vos fichiers (photos, échanges) sur Stripe si vous en avez.
          </p>
          <div className="flex flex-wrap justify-end gap-2 mt-6">
            <button type="button" autoFocus onClick={() => dialog.current?.close()} className="admin-btn admin-btn--ghost">
              Retour
            </button>
            <button
              type="submit"
              form={formId}
              name="intent"
              value="submit"
              disabled={pending}
              onClick={() => dialog.current?.close()}
              className="admin-btn"
              style={{ background: "var(--admin-primary)", color: "#fff", border: "none" }}
              data-dispute-confirm
            >
              Envoyer définitivement
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
