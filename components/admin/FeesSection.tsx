"use client";

import { useState } from "react";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useFormAction } from "@/components/admin/useFormAction";
import { createFee, deleteFee, setFeeActive, updateFee } from "@/lib/actions/fees";
import { AdminInput, AdminSelect, EmptyState, Field, SettingsSection, StatusBanner } from "@/components/admin/ui";
import { FEE_UNITS, EXTRA_UNIT_LABELS } from "@/lib/extras";
import type { CatalogFee } from "@/lib/queries/fees";
import { formatEuros } from "@/lib/utils";

const smallBtn = {
  padding: "7px 14px",
  borderRadius: 7,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
} as const;

type Room = { id: string; name: string };

export default function FeesSection({ fees, rooms }: { fees: CatalogFee[]; rooms: Room[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const roomNames = (ids: string[]) =>
    ids.length === 0 ? "toutes les chambres" : rooms.filter((r) => ids.includes(r.id)).map((r) => r.name).join(", ");

  return (
    <SettingsSection
      title="Frais"
      desc="Ménage, frais de dossier… ajoutés d'office à chaque réservation et payés en ligne avec le séjour. Vous pouvez en retirer un sur une réservation que vous saisissez. Modifier un frais ne change pas les réservations déjà faites."
      action={
        <button
          type="button"
          onClick={() => setAdding(!adding)}
          style={{
            ...smallBtn,
            background: adding ? "transparent" : "var(--admin-primary)",
            color: adding ? "var(--admin-text-muted)" : "#fff",
            border: adding ? "1px solid var(--admin-border)" : "none",
          }}
        >
          {adding ? "Annuler" : "Ajouter"}
        </button>
      }
    >
      {adding && <FeeForm rooms={rooms} onDone={() => setAdding(false)} />}

      {fees.length === 0 && !adding ? (
        <EmptyState compact title="Aucun frais" example="Ménage, 40 € par séjour.">
          Ajoutez ce que chaque client paie en plus de la nuit, sans le choisir.
        </EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="fees-list">
          {fees.map((f) =>
            editing === f.id ? (
              <li key={f.id}>
                <FeeForm fee={f} rooms={rooms} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li
                key={f.id}
                data-testid="fee-row"
                data-fee-label={f.label}
                className="flex items-center justify-between gap-3"
                style={{
                  padding: "12px 14px",
                  background: "var(--admin-surface-2)",
                  border: "1px solid var(--admin-border-light)",
                  borderRadius: 8,
                  opacity: f.active ? 1 : 0.65,
                }}
              >
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold break-words" style={{ color: "var(--admin-text)" }}>
                    {f.label}
                    {!f.active && (
                      <span className="ml-2 text-[12px] font-semibold" style={{ color: "var(--admin-text-subtle)" }}>
                        Désactivé
                      </span>
                    )}
                  </p>
                  <p className="text-[12.5px]" style={{ color: "var(--admin-text-muted)" }}>
                    {f.price === 0 ? "Gratuit" : `${formatEuros(f.price)} ${EXTRA_UNIT_LABELS[f.unit]}`} · {roomNames(f.roomIds)}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 text-[12px] font-semibold">
                  <button type="button" onClick={() => setEditing(f.id)} style={{ color: "var(--admin-primary)" }}>
                    Modifier
                  </button>
                  <button type="button" onClick={() => setFeeActive(f.id, !f.active)} style={{ color: "var(--admin-text-muted)" }}>
                    {f.active ? "Désactiver" : "Activer"}
                  </button>
                  <ConfirmButton
                    title={`Supprimer le frais « ${f.label} » ?`}
                    message="Il ne sera plus ajouté aux nouvelles réservations. Celles qui l'incluent déjà le gardent, au même prix."
                    confirmLabel="Supprimer le frais"
                    onConfirm={() => deleteFee(f.id)}
                    style={{ color: "#B91C1C", background: "none", border: "none", cursor: "pointer" }}
                  >
                    Supprimer
                  </ConfirmButton>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </SettingsSection>
  );
}

function FeeForm({ fee, rooms, onDone }: { fee?: CatalogFee; rooms: Room[]; onDone: () => void }) {
  const form = useFormAction(fee ? updateFee.bind(null, fee.id) : createFee, { onSuccess: onDone });
  return (
    <form
      onSubmit={form.onSubmit}
      data-testid="fee-form"
      className="mb-3"
      style={{
        padding: 14,
        background: "var(--admin-surface-2)",
        borderRadius: 10,
        border: "1px dashed var(--admin-border)",
      }}
    >
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}
      <Field label="Libellé" error={form.fieldError("label")}>
        <AdminInput name="label" required maxLength={500} defaultValue={fee?.label} placeholder="ex : Ménage" />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Prix (€)" error={form.fieldError("price")}>
          <AdminInput
            name="price"
            required
            inputMode="decimal"
            defaultValue={fee ? String(fee.price).replace(".", ",") : ""}
            placeholder="ex : 40"
          />
        </Field>
        <Field label="Unité" error={form.fieldError("unit")}>
          <AdminSelect name="unit" defaultValue={fee?.unit ?? "per_stay"}>
            {FEE_UNITS.map((u) => (
              <option key={u} value={u}>
                {EXTRA_UNIT_LABELS[u]}
              </option>
            ))}
          </AdminSelect>
        </Field>
      </div>
      {rooms.length > 1 && (
        <fieldset className="mb-2">
          <legend className="text-[13px] font-semibold mb-1" style={{ color: "var(--admin-text)" }}>
            Chambres concernées
          </legend>
          <p className="text-[12px] mb-1.5" style={{ color: "var(--admin-text-muted)" }}>
            Aucune cochée = toutes les chambres.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {rooms.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-[13px] cursor-pointer" style={{ color: "var(--admin-text)" }}>
                <input
                  type="checkbox"
                  name="roomIds"
                  value={r.id}
                  defaultChecked={fee?.roomIds.includes(r.id)}
                  style={{ accentColor: "var(--admin-primary)" }}
                />
                {r.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex justify-end gap-3 mt-2">
        {fee && (
          <button type="button" onClick={onDone} style={{ ...smallBtn, color: "var(--admin-text-muted)" }}>
            Annuler
          </button>
        )}
        <button
          type="submit"
          disabled={form.pending}
          style={{ ...smallBtn, padding: "9px 18px", background: "var(--admin-primary)", color: "#fff", border: "none" }}
        >
          {form.pending ? "Enregistrement…" : fee ? "Enregistrer le frais" : "Ajouter le frais"}
        </button>
      </div>
    </form>
  );
}
