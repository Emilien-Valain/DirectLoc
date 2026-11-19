"use client";

import { formatEuros } from "@/lib/utils";
import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useState } from "react";
import { useFormAction } from "@/components/admin/useFormAction";
import {
  createPricingRule,
  deletePricingRule,
  togglePricingRule,
  updatePricingRule,
} from "@/lib/actions/rules";
import {
  AdminInput,
  DateInput,
  EmptyState,
  Field,
  SettingsSection,
  StatusBanner,
} from "@/components/admin/ui";
import {
  AddToggle,
  DAY_NAMES_FR,
  DayPicker,
  EditButton,
  FormFooter,
  asDays,
  formBoxStyle,
  frDate,
  isoDay,
  rowActionStyle,
} from "./rule-form-parts";
import type { PricingRuleRow } from "./RulesPageClient";

type Room = { id: string; name: string };

/** « 12.50 » (stockage) → « 12,5 » pour la saisie. */
const frNumber = (v: string | null) => (v === null ? "" : String(parseFloat(v)).replace(".", ","));

export default function PricingRuleSection({ rooms, rules }: { rooms: Room[]; rules: PricingRuleRow[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const roomNames = (ids: string[]) =>
    ids.length === 0
      ? "Toutes les chambres"
      : rooms.filter((r) => ids.includes(r.id)).map((r) => r.name).join(", ") || "Chambre supprimée";

  return (
    <SettingsSection
      title="Tarification dynamique"
      desc="Prix saisonniers, majorations week-end, promotions. Une règle peut viser une, plusieurs ou toutes les chambres. Si deux règles visent la même nuit, la plus précise l'emporte : moins de chambres plutôt que plus, des jours choisis plutôt que tous, une période courte plutôt que longue."
      action={<AddToggle open={adding} onClick={() => { setAdding(!adding); setSaved(null); }} />}
    >
      {saved && !adding && <StatusBanner variant="success">{saved}</StatusBanner>}
      {adding && (
        <PricingRuleForm
          rooms={rooms}
          onDone={(ok) => {
            setAdding(false);
            if (ok) setSaved("Règle tarifaire ajoutée.");
          }}
        />
      )}

      {rules.length === 0 && !adding ? (
        <EmptyState
          compact
          title="Aucune règle tarifaire configurée"
          example="« Haute saison » à 120 € la nuit du 1er juillet au 31 août, ou −15 % en semaine de novembre à mars."
        >
          Toutes les nuits sont facturées au prix de base de chaque chambre.
        </EmptyState>
      ) : (
        <div>
          {rules.map((rule, i) => {
            if (editing === rule.id) {
              return (
                <PricingRuleForm
                  key={rule.id}
                  rule={rule}
                  rooms={rooms}
                  onDone={(ok) => {
                    setEditing(null);
                    if (ok) setSaved("Règle tarifaire modifiée.");
                  }}
                />
              );
            }
            const isAdjPositive = rule.percentageModifier ? parseFloat(rule.percentageModifier) > 0 : true;
            return (
              <div
                key={rule.id}
                data-testid="pricing-rule-row"
                data-rule-name={rule.name}
                className="flex items-center justify-between gap-3 py-3"
                style={{
                  borderBottom: i < rules.length - 1 ? "1px solid var(--admin-border-light)" : "none",
                }}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold" style={{ color: "var(--admin-text)" }}>
                    <span
                      style={{
                        textDecoration: rule.active ? "none" : "line-through",
                        color: rule.active ? "var(--admin-text)" : "var(--admin-text-subtle)",
                      }}
                    >
                      {rule.name}
                    </span>
                    {!rule.active && (
                      <span
                        className="ml-2 text-[12px] font-bold"
                        style={{
                          padding: "2px 8px",
                          borderRadius: 12,
                          background: "var(--admin-border-light)",
                          color: "var(--admin-text-muted)",
                        }}
                      >
                        Désactivée
                      </span>
                    )}
                    <span className="ml-2 text-[12px] font-normal" style={{ color: "var(--admin-text-muted)" }}>
                      {roomNames(rule.roomIds)}
                    </span>
                  </p>
                  <p className="text-[12px] space-x-2" style={{ color: "var(--admin-text-muted)" }}>
                    {rule.fixedPrice && <span>{formatEuros(rule.fixedPrice)}/nuit</span>}
                    {rule.percentageModifier && (
                      <span style={{ color: isAdjPositive ? "#15803D" : "var(--admin-danger)" }}>
                        {isAdjPositive ? "+" : ""}
                        {parseFloat(rule.percentageModifier).toFixed(0)}%
                      </span>
                    )}
                    {Array.isArray(rule.daysOfWeek) && (
                      <span>{asDays(rule.daysOfWeek).map((d) => DAY_NAMES_FR[d]).join(", ")}</span>
                    )}
                    {rule.validFrom && (
                      <span>
                        {frDate(rule.validFrom)} → {rule.validTo ? frDate(rule.validTo) : "…"}
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <EditButton
                    label={`Modifier la règle ${rule.name}`}
                    onClick={() => { setEditing(rule.id); setSaved(null); }}
                  />
                  <button
                    type="button"
                    onClick={() => togglePricingRule(rule.id)}
                    style={{ ...rowActionStyle, color: rule.active ? "var(--admin-text-muted)" : "#16A34A" }}
                  >
                    {rule.active ? "Désactiver" : "Activer"}
                  </button>
                  <ConfirmButton
                    title={"Supprimer cette règle de tarification ?"}
                    message="Les prochaines réservations seront calculées sans elle. Les réservations existantes gardent leur prix."
                    confirmLabel="Supprimer la règle"
                    onConfirm={() => deletePricingRule(rule.id)}
                    style={{ ...rowActionStyle, color: "var(--admin-danger)" }}
                  >
                    Supprimer
                  </ConfirmButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}

function PricingRuleForm({
  rule,
  rooms,
  onDone,
}: {
  rule?: PricingRuleRow;
  rooms: Room[];
  onDone: (saved: boolean) => void;
}) {
  const [priceType, setPriceType] = useState<"fixed" | "percentage">(
    rule?.percentageModifier ? "percentage" : "fixed",
  );
  const [selectedDays, setSelectedDays] = useState<number[]>(asDays(rule?.daysOfWeek));
  // Création seulement : une règle par chambre, chacune avec sa valeur.
  const [perRoom, setPerRoom] = useState(false);

  const form = useFormAction(rule ? updatePricingRule.bind(null, rule.id) : createPricingRule, {
    prepare: (fd) => {
      fd.set("daysOfWeek", selectedDays.join(","));
      fd.set("priceType", priceType);
    },
    onSuccess: () => onDone(true),
  });

  const unit = priceType === "fixed" ? "€/nuit" : "%";

  return (
    <form onSubmit={form.onSubmit} data-testid="pricing-rule-form" className="my-3" style={formBoxStyle}>
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}
      <Field label="Nom de la règle" error={form.fieldError("name")}>
        <AdminInput type="text" name="name" required maxLength={200} placeholder="ex: Haute saison" defaultValue={rule?.name} />
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Période — début (optionnel)" error={form.fieldError("validFrom")}>
          <DateInput name="validFrom" defaultValue={isoDay(rule?.validFrom ?? null)} />
        </Field>
        <Field label="Période — fin (optionnel)" error={form.fieldError("validTo")}>
          <DateInput name="validTo" defaultValue={isoDay(rule?.validTo ?? null)} />
        </Field>
      </div>

      <Field label="Jours de la semaine (optionnel)" hint="Aucun sélectionné = tous les jours">
        <DayPicker value={selectedDays} onChange={setSelectedDays} color="var(--admin-accent)" />
      </Field>

      <Field label="Type de tarification">
        <div className="flex flex-wrap gap-4">
          {(
            [
              ["fixed", "Prix fixe (€/nuit)"],
              ["percentage", "Hausse ou baisse en %"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-[13px]" style={{ color: "var(--admin-text)" }}>
              <input
                type="radio"
                checked={priceType === value}
                onChange={() => setPriceType(value)}
                style={{ accentColor: "var(--admin-primary)" }}
              />
              {label}
            </label>
          ))}
        </div>
      </Field>

      {!rule && rooms.length > 1 && (
        <label className="flex items-center gap-2 mb-3 text-[13px] cursor-pointer" style={{ color: "var(--admin-text)" }}>
          <input
            type="checkbox"
            name="perRoom"
            checked={perRoom}
            onChange={(e) => setPerRoom(e.target.checked)}
            style={{ accentColor: "var(--admin-primary)" }}
          />
          Une valeur différente pour chaque chambre
        </label>
      )}

      {perRoom ? (
        <fieldset className="mb-2">
          <legend className="text-[13px] font-semibold mb-1" style={{ color: "var(--admin-text)" }}>
            {priceType === "fixed" ? "Prix par chambre (€/nuit)" : "Hausse ou baisse par chambre (%)"}
          </legend>
          <p className="text-[12px] mb-2" style={{ color: "var(--admin-text-muted)" }}>
            Une règle est créée pour chaque chambre remplie, avec la même période et les mêmes jours. Laissez vide pour ne pas toucher une chambre.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
            {rooms.map((r) => (
              <Field key={r.id} label={`${r.name} (${unit})`} error={form.fieldError(`value_${r.id}`)}>
                <AdminInput
                  type="text"
                  name={`value_${r.id}`}
                  inputMode={priceType === "fixed" ? "decimal" : "text"}
                  placeholder={priceType === "fixed" ? "ex : 150" : "ex : 30 ou -15"}
                />
              </Field>
            ))}
          </div>
        </fieldset>
      ) : (
        <>
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
                  <label
                    key={r.id}
                    className="flex items-center gap-2 text-[13px] cursor-pointer"
                    style={{ color: "var(--admin-text)" }}
                  >
                    <input
                      type="checkbox"
                      name="roomIds"
                      value={r.id}
                      defaultChecked={rule?.roomIds.includes(r.id)}
                      style={{ accentColor: "var(--admin-primary)" }}
                    />
                    {r.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {rooms.length <= 1 &&
            rule?.roomIds.map((id) => <input key={id} type="hidden" name="roomIds" value={id} />)}
          <div className="max-w-xs">
            {priceType === "fixed" ? (
              <Field label="Prix fixe (€/nuit)" error={form.fieldError("fixedPrice")}>
                <AdminInput
                  type="text"
                  name="fixedPrice"
                  required
                  inputMode="decimal"
                  placeholder="ex : 150"
                  defaultValue={frNumber(rule?.fixedPrice ?? null)}
                />
              </Field>
            ) : (
              <Field
                label="Hausse ou baisse (%)"
                hint="30 = +30 % sur le prix de la nuit ; -15 = une promotion de 15 %"
                error={form.fieldError("percentageModifier")}
              >
                <AdminInput
                  type="text"
                  name="percentageModifier"
                  required
                  placeholder="ex : 30 ou -15"
                  defaultValue={frNumber(rule?.percentageModifier ?? null)}
                />
              </Field>
            )}
          </div>
        </>
      )}

      <FormFooter pending={form.pending} editing={!!rule} createLabel="Créer la règle" onCancel={() => onDone(false)} />
    </form>
  );
}
