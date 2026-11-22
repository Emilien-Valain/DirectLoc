"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { formatEuros } from "@/lib/utils";
import { amountField, parseRefundAmount, type RefundShortcut } from "@/lib/refund-amounts";
import { refundDossier, type RefundFormState } from "@/lib/actions/refunds";
import { AdminInput, AdminTextarea } from "@/components/admin/ui-inputs";

/**
 * Remboursements depuis l'admin (PRD Remboursements) : la case « Rembourser X € » des dialogs
 * d'annulation, et le bouton « Rembourser » de la fiche Dossier. Le plafond affiché n'est qu'une
 * aide : le serveur le recalcule sous verrou et ignore tout ce que le formulaire prétend.
 */

/** Une soumission = un uuid (idempotency key Stripe) : un double clic ne rembourse pas deux fois. */
const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (Math.floor(Math.random() * 16) >> (Number(c) / 4))).toString(16),
      );

const euros = (c: number) => formatEuros(c / 100);

/** Montant + raccourcis ; renvoie la valeur saisie en centimes (null si invalide). */
function AmountField({
  value,
  onChange,
  refundable,
  shortcuts,
  label = "Montant à rembourser",
}: {
  value: string;
  onChange: (v: string) => void;
  refundable: number;
  shortcuts: RefundShortcut[];
  label?: string;
}) {
  const id = useId();
  const parsed = parseRefundAmount(value);
  const tooMuch = parsed !== null && parsed > refundable;
  const note = shortcuts.find((s) => s.note && parsed === s.amount)?.note;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-[12px] font-bold uppercase" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <AdminInput
          id={id}
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-cap`}
          aria-invalid={tooMuch || (value.trim() !== "" && parsed === null) ? true : undefined}
          className="tabular-nums"
          style={{ maxWidth: 140 }}
        />
        <span className="text-[13.5px] font-semibold" style={{ color: "var(--admin-text)" }}>
          €
        </span>
      </div>
      <p id={`${id}-cap`} className="text-[12px]" style={{ color: tooMuch ? "var(--admin-danger)" : "var(--admin-text-muted)" }} data-refund-cap>
        {tooMuch
          ? `C'est plus que ce qui reste remboursable : ${euros(refundable)} au plus.`
          : value.trim() !== "" && parsed === null
            ? "Montant invalide : un nombre supérieur à 0, par exemple 45 ou 45,50."
            : `Au plus ${euros(refundable)}.`}
      </p>
      {shortcuts.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Raccourcis de montant">
          {shortcuts.map((s) => (
            <button
              key={s.label}
              type="button"
              data-refund-shortcut={s.label}
              onClick={() => onChange(amountField(s.amount))}
              aria-pressed={parsed === s.amount}
              className="text-left text-[12.5px] leading-snug rounded-lg px-2.5 py-1.5 min-h-[40px] transition-colors"
              style={{
                border: `1px solid ${parsed === s.amount ? "var(--admin-primary)" : "var(--admin-border)"}`,
                background: parsed === s.amount ? "var(--admin-primary-light)" : "var(--admin-surface)",
                color: "var(--admin-text)",
              }}
            >
              <span className="font-semibold tabular-nums">{euros(s.amount)}</span>
              <span style={{ color: "var(--admin-text-muted)" }}> · {s.label}</span>
            </button>
          ))}
        </div>
      )}
      {note && (
        <p data-refund-note-custom className="text-[12px] font-semibold" style={{ color: "#92400E" }}>
          {note}
        </p>
      )}
    </div>
  );
}

function FeesLine() {
  return (
    <p className="text-[12px]" style={{ color: "var(--admin-text-subtle)" }} data-refund-fees>
      Les frais Stripe du paiement ne vous sont pas rendus.
    </p>
  );
}

/**
 * Dans un dialog d'annulation (`ConfirmButton withForm`) : case « Rembourser X € » cochée par
 * défaut (sauf suggestion à 0 €), montant modifiable. Décochée → l'annulation ne rembourse rien.
 */
export function CancelRefundFields({
  defaultAmount,
  refundable,
  shortcuts,
  guestEmail,
}: {
  /** Centimes. */
  defaultAmount: number;
  refundable: number;
  shortcuts: RefundShortcut[];
  guestEmail: string;
}) {
  const [requestId] = useState(newRequestId);
  const [checked, setChecked] = useState(defaultAmount > 0);
  const [value, setValue] = useState(defaultAmount > 0 ? amountField(defaultAmount) : "");
  const parsed = parseRefundAmount(value);
  return (
    <span
      data-refund-fields
      className="block mt-3 px-3 py-3 rounded-lg space-y-3"
      style={{ background: "var(--admin-surface-2)", border: "1px solid var(--admin-border)" }}
    >
      <input type="hidden" name="requestId" value={requestId} />
      <label className="flex items-start gap-2.5 cursor-pointer min-h-[40px]" style={{ color: "var(--admin-text)" }}>
        <input
          type="checkbox"
          name="refund"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 w-[18px] h-[18px] flex-shrink-0"
          style={{ accentColor: "var(--admin-primary)" }}
        />
        <span className="text-[13.5px] leading-snug">
          <strong data-refund-label>Rembourser {parsed ? euros(parsed) : "…"}</strong>
          <span className="block text-[12px]" style={{ color: "var(--admin-text-muted)" }}>
            Sur la carte du voyageur, via Stripe ; {guestEmail} est prévenu par email.
          </span>
        </span>
      </label>
      {checked ? (
        <>
          <AmountField value={value} onChange={setValue} refundable={refundable} shortcuts={shortcuts} />
          <FeesLine />
        </>
      ) : (
        <span className="block text-[12px]" style={{ color: "var(--admin-text-muted)" }}>
          Rien ne sera remboursé ; vous pourrez le faire plus tard avec « Rembourser » sur la fiche du Dossier.
        </span>
      )}
    </span>
  );
}

/** Bouton « Rembourser » de la fiche Dossier et son dialog (montant, raccourcis, motif). */
export function RefundButton({
  dossierId,
  refundable,
  shortcuts,
  defaultAmount,
  guestEmail,
  disabledReason,
}: {
  dossierId: string;
  /** Centimes. */
  refundable: number;
  shortcuts: RefundShortcut[];
  defaultAmount: number;
  guestEmail: string;
  /** Litige en cours : bouton désactivé avec cette explication. */
  disabledReason?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) ref.current?.showModal();
  }, [open]);

  return (
    <>
      <button
        type="button"
        data-refund-open
        disabled={!!disabledReason}
        title={disabledReason}
        onClick={() => setOpen(true)}
        className="admin-btn"
        style={{ padding: "7px 14px", fontSize: 13, background: "var(--admin-primary)", color: "#fff", border: "none" }}
      >
        Rembourser
      </button>
      {disabledReason && (
        <span className="text-[12px]" style={{ color: "var(--admin-danger)" }}>
          {disabledReason}
        </span>
      )}
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        className="admin-dialog"
        data-refund-dialog
        onClose={() => setOpen(false)}
      >
        {open && (
          <RefundDialogBody
            titleId={titleId}
            dossierId={dossierId}
            refundable={refundable}
            shortcuts={shortcuts}
            defaultAmount={defaultAmount}
            guestEmail={guestEmail}
            onCancel={() => ref.current?.close()}
          />
        )}
      </dialog>
    </>
  );
}

function RefundDialogBody({
  titleId,
  dossierId,
  refundable,
  shortcuts,
  defaultAmount,
  guestEmail,
  onCancel,
}: {
  titleId: string;
  dossierId: string;
  refundable: number;
  shortcuts: RefundShortcut[];
  defaultAmount: number;
  guestEmail: string;
  onCancel: () => void;
}) {
  const [requestId, setRequestId] = useState(newRequestId);
  const [state, action, pending] = useActionState<RefundFormState, FormData>(refundDossier.bind(null, dossierId), null);
  // Refus (Stripe compris) : nouvelle clé, sinon Stripe rejouerait l'erreur mémorisée pour l'ancienne.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.error) setRequestId(newRequestId());
  }
  const [value, setValue] = useState(defaultAmount > 0 ? amountField(defaultAmount) : "");
  const reasonId = useId();
  const parsed = parseRefundAmount(value);
  const blocked = parsed === null || parsed > refundable;
  return (
    <form action={action} className="p-6 space-y-4">
      <div>
        <h2 id={titleId} className="text-[15px] font-extrabold" style={{ color: "var(--admin-text)", letterSpacing: "-0.3px" }}>
          Rembourser le voyageur
        </h2>
        <p className="text-[13px] leading-[1.5] mt-1" style={{ color: "var(--admin-text-muted)" }}>
          Rendu sur sa carte via Stripe. {guestEmail} reçoit un email ; le délai bancaire est de 5 à 10 jours.
        </p>
      </div>
      <input type="hidden" name="requestId" value={requestId} />
      <AmountField value={value} onChange={setValue} refundable={refundable} shortcuts={shortcuts} />
      <div className="space-y-1.5">
        <label htmlFor={reasonId} className="block text-[12px] font-bold uppercase" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
          Motif (facultatif)
        </label>
        <AdminTextarea id={reasonId} name="reason" rows={2} maxLength={500} placeholder="Ex. annulation à J-10, geste commercial" />
      </div>
      <FeesLine />
      {state?.error && (
        <p role="alert" className="text-[12.5px] font-semibold" style={{ color: "var(--admin-danger)" }}>
          {state.error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button type="button" autoFocus disabled={pending} onClick={onCancel} className="admin-btn admin-btn--ghost">
          Retour
        </button>
        <button
          type="submit"
          data-refund-submit
          disabled={pending || blocked}
          className="admin-btn"
          style={{ background: "var(--admin-primary)", color: "#fff", border: "none" }}
        >
          {pending ? "Remboursement…" : parsed && !blocked ? `Rembourser ${euros(parsed)}` : "Rembourser"}
        </button>
      </div>
    </form>
  );
}
