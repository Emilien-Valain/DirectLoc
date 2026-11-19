"use client";

import { useState } from "react";
import { AdminInput, Field } from "@/components/admin/ui";
import { FIXED_ROOM_INFO, INFO_LABEL_MAX, INFO_VALUE_MAX, MAX_CUSTOM_INFO, infoKey, type RoomInfo } from "@/lib/room-info";

/** La variable à recopier dans un message : visible à côté de chaque info. */
function VariableChip({ name }: { name: string }) {
  return (
    <code
      data-testid="info-variable"
      className="text-[11.5px] font-semibold"
      style={{
        padding: "1px 7px",
        borderRadius: 6,
        background: "var(--admin-surface-2)",
        border: "1px solid var(--admin-border-light)",
        color: "var(--admin-primary)",
        whiteSpace: "nowrap",
      }}
    >
      {`{${name}}`}
    </code>
  );
}

type Row = { id: number; label: string; value: string };

/**
 * Infos pratiques de la chambre : 4 champs proposés (étage, code, wifi) puis les infos
 * de l'hôte (« Code du portail »…). Chacune affiche sa variable d'email.
 */
export default function RoomInfoFields({
  initial,
  fieldError,
}: {
  initial: RoomInfo[];
  fieldError: (name: string) => string | undefined;
}) {
  const fixedKeys = new Set<string>(FIXED_ROOM_INFO.map((f) => f.key));
  const fixedValue = (key: string) => initial.find((i) => i.key === key)?.value ?? "";
  const [rows, setRows] = useState<Row[]>(() =>
    initial.filter((i) => !fixedKeys.has(i.key)).map((i, n) => ({ id: n, label: i.label, value: i.value })),
  );
  const [nextId, setNextId] = useState(rows.length);
  const update = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <fieldset
      className="mb-4"
      style={{ padding: "14px 16px 4px", border: "1px solid var(--admin-border-light)", borderRadius: 10 }}
    >
      <legend className="px-1.5 text-[13px] font-bold" style={{ color: "var(--admin-text)" }}>
        Infos pratiques
      </legend>
      <p className="text-[12.5px] mb-3" style={{ color: "var(--admin-text-muted)" }}>
        Remplissez ce qui sert à vos clients. Écrivez ensuite la variable dans un message d&apos;email
        (ici ou dans Paramètres → Emails) : elle est remplacée par l&apos;info de la chambre réservée.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3.5">
        {FIXED_ROOM_INFO.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            hint={<>Variable : <VariableChip name={f.key} /></>}
            error={fieldError(`info_${f.key}`)}
          >
            <AdminInput
              name={`info_${f.key}`}
              type="text"
              maxLength={INFO_VALUE_MAX}
              autoComplete="off"
              placeholder={f.placeholder}
              defaultValue={fixedValue(f.key)}
            />
          </Field>
        ))}
      </div>

      {rows.length > 0 && (
        <p className="text-[12px] font-bold uppercase mt-1 mb-2" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
          Vos infos
        </p>
      )}
      {rows.map((r, i) => {
        const key = infoKey(r.label);
        return (
          <div
            key={r.id}
            data-testid="custom-info-row"
            className="grid grid-cols-[1fr_1fr_auto] gap-x-2.5 items-start"
          >
            <Field
              label="Nom de l'info"
              hint={key ? <>Variable : <VariableChip name={key} /></> : "ex : Code du portail"}
              error={fieldError(`infoLabel_${i}`)}
            >
              <AdminInput
                name="infoLabel"
                type="text"
                maxLength={INFO_LABEL_MAX}
                autoComplete="off"
                placeholder="ex : Code du portail"
                value={r.label}
                onChange={(e) => update(r.id, { label: e.target.value })}
              />
            </Field>
            <Field label="Valeur" error={fieldError(`infoValue_${i}`)}>
              <AdminInput
                name="infoValue"
                type="text"
                maxLength={INFO_VALUE_MAX}
                autoComplete="off"
                placeholder="ex : 1984"
                value={r.value}
                onChange={(e) => update(r.id, { value: e.target.value })}
              />
            </Field>
            <button
              type="button"
              aria-label={`Retirer l'info ${r.label || i + 1}`}
              onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
              className="mt-[26px] text-[18px] leading-none"
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: "1px solid var(--admin-border)",
                background: "transparent",
                color: "var(--admin-text-muted)",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      {rows.length < MAX_CUSTOM_INFO && (
        <button
          type="button"
          onClick={() => {
            setRows((rs) => [...rs, { id: nextId, label: "", value: "" }]);
            setNextId(nextId + 1);
          }}
          className="mb-3.5 text-[13px] font-semibold"
          style={{
            padding: "7px 12px",
            borderRadius: 8,
            border: "1px dashed var(--admin-border)",
            background: "transparent",
            color: "var(--admin-primary)",
            cursor: "pointer",
          }}
        >
          + Ajouter une info
        </button>
      )}
    </fieldset>
  );
}
