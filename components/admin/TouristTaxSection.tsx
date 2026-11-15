"use client";

import { useState } from "react";
import { useFormAction } from "@/components/admin/useFormAction";
import { updateTouristTax } from "@/lib/actions/tourist-tax";
import { AdminInput, AdminSelect, Field, SettingsSection, StatusBanner } from "@/components/admin/ui";
import type { TouristTax } from "@/lib/tourist-tax";

const fr = (n: number | undefined) => (n === undefined ? "" : String(n).replace(".", ","));

export default function TouristTaxSection({ tax }: { tax?: TouristTax }) {
  const [mode, setMode] = useState<"off" | TouristTax["mode"]>(tax?.mode ?? "off");
  const form = useFormAction(updateTouristTax);
  const pct = tax?.mode === "percentage" ? tax : undefined;

  return (
    <SettingsSection
      title="Taxe de séjour"
      desc="Collectée en ligne avec le séjour, au réel, pour votre commune. Les enfants de moins de 18 ans en sont exonérés : le client indique leur nombre en réservant. Le tarif est voté par votre commune ; vérifiez-le chaque année."
    >
      {form.saved && <StatusBanner variant="success">Taxe de séjour enregistrée.</StatusBanner>}
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}
      <form onSubmit={form.onSubmit} data-testid="tourist-tax-form">
        <Field label="Mode de calcul" error={form.fieldError("mode")}>
          <AdminSelect name="mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="off">Désactivée (forfait ou non concerné)</option>
            <option value="fixed">Montant fixe par adulte et par nuit (hébergement classé)</option>
            <option value="percentage">Pourcentage du prix de la nuit (hébergement non classé)</option>
          </AdminSelect>
        </Field>

        {mode === "fixed" && (
          <Field
            label="Montant par adulte et par nuit (€)"
            error={form.fieldError("amount")}
            hint="Le tarif de votre catégorie, taxes additionnelles comprises, tel que publié par votre commune."
          >
            <AdminInput
              name="amount"
              required
              inputMode="decimal"
              defaultValue={tax?.mode === "fixed" ? fr(tax.amount) : ""}
              placeholder="ex : 1,65"
            />
          </Field>
        )}

        {mode === "percentage" && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Taux (%)" error={form.fieldError("rate")} hint="Entre 1 et 5 %, voté par la commune.">
                <AdminInput name="rate" required inputMode="decimal" defaultValue={fr(pct?.rate)} placeholder="ex : 5" />
              </Field>
              <Field
                label="Plafond par adulte et par nuit (€)"
                error={form.fieldError("cap")}
                hint="Hors taxes additionnelles."
              >
                <AdminInput name="cap" required inputMode="decimal" defaultValue={fr(pct?.cap)} placeholder="ex : 4,90" />
              </Field>
              <Field
                label="Taxes additionnelles (%)"
                error={form.fieldError("additional")}
                hint="Départementale (10 %), régionale… cumulées. 0 si aucune."
              >
                <AdminInput
                  name="additional"
                  required
                  inputMode="decimal"
                  defaultValue={fr(pct?.additional ?? 10)}
                  placeholder="ex : 10"
                />
              </Field>
              <Field
                label="TVA sur l'hébergement (%)"
                error={form.fieldError("vat")}
                hint="Le calcul se fait sur le prix hors taxes. 0 si vous n'êtes pas assujetti."
              >
                <AdminInput name="vat" required inputMode="decimal" defaultValue={fr(pct?.vat ?? 10)} placeholder="ex : 10" />
              </Field>
            </div>
            <p className="text-[12px] mb-3" style={{ color: "var(--admin-text-muted)" }}>
              Par nuit : taux × prix HT de la nuit ÷ nombre d&apos;occupants (enfants compris), plafonné, × nombre
              d&apos;adultes, puis taxes additionnelles.
            </p>
          </>
        )}

        <div className="flex justify-end">
          <button type="submit" disabled={form.pending} className="admin-btn" style={{ background: "var(--admin-primary)", color: "#fff", border: "none" }}>
            {form.pending ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </form>

      <TaxExport />
    </SettingsSection>
  );
}

/** Mois précédent, pour la déclaration : [1er, dernier jour]. */
function lastMonth(): [string, string] {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)];
}

function TaxExport() {
  const [from, to] = lastMonth();
  return (
    <form
      method="get"
      action="/api/admin/tourist-tax"
      data-testid="tourist-tax-export"
      className="mt-5 pt-4"
      style={{ borderTop: "1px solid var(--admin-border)" }}
    >
      <p className="text-[13px] font-semibold mb-1" style={{ color: "var(--admin-text)" }}>
        Exporter pour la déclaration
      </p>
      <p className="text-[12px] mb-3" style={{ color: "var(--admin-text-muted)" }}>
        Une ligne par séjour confirmé ou terminé dont le départ tombe dans la période. Fichier CSV lisible par Excel.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <Field label="Départs du">
          <AdminInput name="from" type="date" required defaultValue={from} />
        </Field>
        <Field label="au">
          <AdminInput name="to" type="date" required defaultValue={to} />
        </Field>
        <button
          type="submit"
          className="admin-btn mb-3.5"
          style={{ background: "transparent", color: "var(--admin-primary)", border: "1px solid var(--admin-border)" }}
        >
          Exporter (CSV)
        </button>
      </div>
    </form>
  );
}
