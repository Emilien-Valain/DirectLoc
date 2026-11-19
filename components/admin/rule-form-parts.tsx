"use client";

import type { CSSProperties } from "react";

/** Pièces communes aux formulaires de l'onglet Règles (réservation, tarification, blocages). */

const DAY_SHORT = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
// Indices JS (0 = dimanche), affichés dans l'ordre de la semaine française.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const DAY_NAMES_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
export const DAY_SHORT_NAMES = DAY_SHORT;

/** Jours stockés en JSON (`[0..6]` ou null) → tableau typé. */
export const asDays = (v: unknown): number[] => (Array.isArray(v) ? (v as number[]) : []);

/** ISO (stockage) → « 2027-07-01 » attendu par DateInput ; vide si absent. */
export const isoDay = (v: string | null) => (v ? v.slice(0, 10) : "");

export const frDate = (v: string) => new Date(v).toLocaleDateString("fr-FR", { timeZone: "UTC" });

export function DayPicker({
  value,
  onChange,
  color = "var(--admin-primary)",
}: {
  value: number[];
  onChange: (days: number[]) => void;
  color?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {WEEK_ORDER.map((i) => {
        const active = value.includes(i);
        return (
          <button
            key={i}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? value.filter((d) => d !== i) : [...value, i])}
            style={{
              width: 40,
              height: 40,
              borderRadius: 8,
              background: active ? color : "var(--admin-surface)",
              border: `1px solid ${active ? color : "var(--admin-border)"}`,
              color: active ? "#fff" : "var(--admin-text-muted)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              transition: "background 0.15s, border-color 0.15s",
            }}
          >
            {DAY_SHORT[i]}
          </button>
        );
      })}
    </div>
  );
}

export const formBoxStyle: CSSProperties = {
  padding: 14,
  background: "var(--admin-surface-2)",
  borderRadius: 10,
  border: "1px dashed var(--admin-border)",
};

/** Bouton « Ajouter » / « Annuler » de l'en-tête de section. */
export function AddToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "7px 14px",
        background: open ? "transparent" : "var(--admin-primary)",
        color: open ? "var(--admin-text-muted)" : "#fff",
        border: open ? "1px solid var(--admin-border)" : "none",
        borderRadius: 7,
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {open ? "Annuler" : "Ajouter"}
    </button>
  );
}

/** Pied de formulaire : « Annuler » (en modification) + bouton d'envoi. */
export function FormFooter({
  pending,
  editing,
  createLabel,
  onCancel,
}: {
  pending: boolean;
  editing: boolean;
  createLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex justify-end gap-3 mt-2">
      {editing && (
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: "9px 14px",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--admin-text-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          Annuler
        </button>
      )}
      <button
        type="submit"
        disabled={pending}
        style={{
          padding: "9px 18px",
          background: "var(--admin-primary)",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          cursor: pending ? "wait" : "pointer",
          opacity: pending ? 0.7 : 1,
        }}
      >
        {pending ? "Enregistrement…" : editing ? "Enregistrer" : createLabel}
      </button>
    </div>
  );
}

/** Actions texte d'une ligne de liste (Modifier, Désactiver, Supprimer…). */
export const rowActionStyle: CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};

export function EditButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      style={{ ...rowActionStyle, color: "var(--admin-primary)" }}
    >
      Modifier
    </button>
  );
}

