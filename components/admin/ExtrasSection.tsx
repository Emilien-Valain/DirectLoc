"use client";

import { useState } from "react";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useFormAction } from "@/components/admin/useFormAction";
import { createExtra, deleteExtra, setExtraActive, updateExtra } from "@/lib/actions/extras";
import { AdminInput, AdminSelect, EmptyState, Field, SettingsSection, StatusBanner } from "@/components/admin/ui";
import { CHOSEN_WORDS, EXTRA_UNITS, EXTRA_UNIT_LABELS, MAX_CHOSEN, type ExtraUnit } from "@/lib/extras";
import type { CatalogExtra } from "@/lib/queries/extras";
import { formatEuros } from "@/lib/utils";

/** Ce que le client choisit selon l'unité ; le maximum suit le séjour. */
const CHOICE_HINT: Record<Exclude<ExtraUnit, "per_stay">, string> = {
  per_night: "choisit pour combien de nuits, jusqu'à celles du séjour",
  per_guest: "choisit pour combien de personnes, jusqu'aux voyageurs du séjour",
  per_guest_night: "choisit pour combien de personnes, jusqu'aux voyageurs du séjour",
  per_bed: "choisit pour combien de lits, jusqu'à ceux de la chambre",
};

const smallBtn = {
  padding: "7px 14px",
  borderRadius: 7,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
} as const;

export default function ExtrasSection({ extras }: { extras: CatalogExtra[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <SettingsSection
      title="Options"
      desc="Petit-déjeuner, linge, paniers pique-nique… proposés à vos clients au moment de réserver. Le prix suit l'unité : le client choisit pour combien de nuits, de personnes ou de lits (petit-déjeuner pour 2 personnes sur 4, draps pour 1 lit sur 3), dans la limite de son séjour. Par séjour, vous fixez vous-même combien il peut en prendre (2 paniers). Modifier une option ne change pas les réservations déjà faites."
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
      {adding && <ExtraForm onDone={() => setAdding(false)} />}

      {extras.length === 0 && !adding ? (
        <EmptyState compact title="Aucune option proposée" example="Petit-déjeuner, 12 € par personne et par nuit.">
          Ajoutez ce que vous vendez en plus de la nuit : vos clients le cochent en réservant.
        </EmptyState>
      ) : (
        <ul className="space-y-2" data-testid="extras-list">
          {extras.map((x) =>
            editing === x.id ? (
              <li key={x.id}>
                <ExtraForm extra={x} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li
                key={x.id}
                data-testid="extra-row"
                data-extra-label={x.label}
                className="flex items-center justify-between gap-3"
                style={{
                  padding: "12px 14px",
                  background: "var(--admin-surface-2)",
                  border: "1px solid var(--admin-border-light)",
                  borderRadius: 8,
                  opacity: x.active ? 1 : 0.65,
                }}
              >
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold break-words" style={{ color: "var(--admin-text)" }}>
                    {x.label}
                    {!x.active && (
                      <span className="ml-2 text-[12px] font-semibold" style={{ color: "var(--admin-text-subtle)" }}>
                        Désactivée
                      </span>
                    )}
                  </p>
                  <p className="text-[12.5px]" style={{ color: "var(--admin-text-muted)" }}>
                    {x.price === 0 ? "Gratuit" : `${formatEuros(x.price)} ${EXTRA_UNIT_LABELS[x.unit]}`}
                    {x.unit === "per_stay"
                      ? x.maxQuantity && x.maxQuantity > 1 && ` · jusqu'à ${x.maxQuantity} au choix`
                      : ` · ${CHOSEN_WORDS[x.unit].many} au choix du client`}
                    {x.description && <> · {x.description}</>}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 text-[12px] font-semibold">
                  <button type="button" onClick={() => setEditing(x.id)} style={{ color: "var(--admin-primary)" }}>
                    Modifier
                  </button>
                  <button
                    type="button"
                    onClick={() => setExtraActive(x.id, !x.active)}
                    style={{ color: "var(--admin-text-muted)" }}
                  >
                    {x.active ? "Désactiver" : "Activer"}
                  </button>
                  <ConfirmButton
                    title={`Supprimer l'option « ${x.label} » ?`}
                    message="Elle ne sera plus proposée. Les réservations qui l'incluent déjà la gardent, au même prix."
                    confirmLabel="Supprimer l'option"
                    onConfirm={() => deleteExtra(x.id)}
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

function ExtraForm({ extra, onDone }: { extra?: CatalogExtra; onDone: () => void }) {
  const form = useFormAction(extra ? updateExtra.bind(null, extra.id) : createExtra, { onSuccess: onDone });
  const [unit, setUnit] = useState<ExtraUnit>(extra?.unit ?? "per_stay");
  return (
    <form
      onSubmit={form.onSubmit}
      data-testid="extra-form"
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
        <AdminInput name="label" required maxLength={500} defaultValue={extra?.label} placeholder="ex : Petit-déjeuner" />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Prix (€)" error={form.fieldError("price")} hint="0 pour une option gratuite (lit bébé…)">
          <AdminInput
            name="price"
            required
            inputMode="decimal"
            defaultValue={extra ? String(extra.price).replace(".", ",") : ""}
            placeholder="ex : 12"
          />
        </Field>
        <Field label="Unité" error={form.fieldError("unit")}>
          <AdminSelect name="unit" value={unit} onChange={(e) => setUnit(e.target.value as ExtraUnit)}>
            {EXTRA_UNITS.map((u) => (
              <option key={u} value={u}>
                {EXTRA_UNIT_LABELS[u]}
              </option>
            ))}
          </AdminSelect>
        </Field>
      </div>
      {unit !== "per_stay" ? (
        <p className="text-[12.5px] mb-3.5" style={{ color: "var(--admin-text-muted)" }} data-testid="extra-choice-hint">
          Le client {CHOICE_HINT[unit]}, tout le séjour par défaut.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="Quantité au choix, jusqu'à"
            error={form.fieldError("maxQuantity")}
            hint="1 = le client coche l'option, sans choisir de nombre. 4 = il en prend de 1 à 4."
          >
            <AdminInput
              name="maxQuantity"
              type="number"
              min={1}
              max={MAX_CHOSEN}
              inputMode="numeric"
              defaultValue={extra?.maxQuantity ?? 1}
            />
          </Field>
        </div>
      )}
      <Field label="Description (facultatif)" error={form.fieldError("description")}>
        <AdminInput name="description" maxLength={500} defaultValue={extra?.description ?? ""} placeholder="ex : Servi de 8 h à 10 h" />
      </Field>
      <div className="flex justify-end gap-3 mt-2">
        {extra && (
          <button type="button" onClick={onDone} style={{ ...smallBtn, color: "var(--admin-text-muted)" }}>
            Annuler
          </button>
        )}
        <button
          type="submit"
          disabled={form.pending}
          style={{ ...smallBtn, padding: "9px 18px", background: "var(--admin-primary)", color: "#fff", border: "none" }}
        >
          {form.pending ? "Enregistrement…" : extra ? "Enregistrer l'option" : "Ajouter l'option"}
        </button>
      </div>
    </form>
  );
}
