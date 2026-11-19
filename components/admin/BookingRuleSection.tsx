"use client";

import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useState } from "react";
import { useFormAction } from "@/components/admin/useFormAction";
import { createBookingRule, deleteBookingRule, updateBookingRule } from "@/lib/actions/rules";
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
  RoomPicker,
  asDays,
  formBoxStyle,
  frDate,
  isoDay,
  roomsLabel,
  rowActionStyle,
} from "./rule-form-parts";
import type { BookingRuleRow } from "./RulesPageClient";

type Room = { id: string; name: string };

export default function BookingRuleSection({ rooms, rules }: { rooms: Room[]; rules: BookingRuleRow[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <SettingsSection
      title="Règles de séjour"
      desc="Durée min/max, jours d'arrivée et de départ autorisés."
      action={<AddToggle open={adding} onClick={() => { setAdding(!adding); setSaved(null); }} />}
    >
      {saved && !adding && <StatusBanner variant="success">{saved}</StatusBanner>}
      {adding && (
        <BookingRuleForm
          rooms={rooms}
          onDone={(ok) => {
            setAdding(false);
            if (ok) setSaved("Règle de réservation ajoutée.");
          }}
        />
      )}

      {rules.length === 0 && !adding ? (
        <EmptyState
          compact
          title="Aucune règle configurée"
          example="en juillet-août, 7 nuits minimum avec arrivée et départ le samedi."
        >
          Sans règle, un client peut réserver une seule nuit, en arrivant n’importe quel jour.
        </EmptyState>
      ) : (
        <div>
          {rules.map((rule, i) =>
            editing === rule.id ? (
              <BookingRuleForm
                key={rule.id}
                rule={rule}
                rooms={rooms}
                onDone={(ok) => {
                  setEditing(null);
                  if (ok) setSaved("Règle de réservation modifiée.");
                }}
              />
            ) : (
              <div
                key={rule.id}
                data-testid="booking-rule-row"
                className="flex items-center justify-between gap-3 py-3"
                style={{
                  borderBottom: i < rules.length - 1 ? "1px solid var(--admin-border-light)" : "none",
                }}
              >
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold" style={{ color: "var(--admin-text)" }}>
                    {roomsLabel(rule.roomIds, rooms)}
                    {rule.validFrom && (
                      <span
                        className="ml-2 text-[12px] font-bold"
                        style={{
                          padding: "2px 8px",
                          borderRadius: 12,
                          background: "var(--admin-primary-light)",
                          color: "var(--admin-primary)",
                        }}
                      >
                        Saisonnier
                      </span>
                    )}
                  </p>
                  <p className="text-[12px] space-x-2" style={{ color: "var(--admin-text-muted)" }}>
                    {rule.minStay && <span>Min {rule.minStay} nuit(s)</span>}
                    {rule.maxStay && <span>Max {rule.maxStay} nuit(s)</span>}
                    {Array.isArray(rule.allowedCheckInDays) && (
                      <span>Arrivée : {asDays(rule.allowedCheckInDays).map((d) => DAY_NAMES_FR[d]).join(", ")}</span>
                    )}
                    {Array.isArray(rule.allowedCheckOutDays) && (
                      <span>Départ : {asDays(rule.allowedCheckOutDays).map((d) => DAY_NAMES_FR[d]).join(", ")}</span>
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
                    label={`Modifier la règle ${roomsLabel(rule.roomIds, rooms)}`}
                    onClick={() => { setEditing(rule.id); setSaved(null); }}
                  />
                  <ConfirmButton
                    title={"Supprimer cette règle de réservation ?"}
                    message="Ses contraintes (durée minimale, jours d’arrivée…) ne s’appliqueront plus aux nouvelles réservations du site."
                    confirmLabel="Supprimer la règle"
                    onConfirm={() => deleteBookingRule(rule.id)}
                    style={{ ...rowActionStyle, color: "var(--admin-danger)" }}
                  >
                    Supprimer
                  </ConfirmButton>
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </SettingsSection>
  );
}

function BookingRuleForm({
  rule,
  rooms,
  onDone,
}: {
  rule?: BookingRuleRow;
  rooms: Room[];
  onDone: (saved: boolean) => void;
}) {
  const [checkInDays, setCheckInDays] = useState<number[]>(asDays(rule?.allowedCheckInDays));
  const [checkOutDays, setCheckOutDays] = useState<number[]>(asDays(rule?.allowedCheckOutDays));
  const [roomIds, setRoomIds] = useState<string[]>(rule?.roomIds ?? []);
  const form = useFormAction(rule ? updateBookingRule.bind(null, rule.id) : createBookingRule, {
    prepare: (fd) => {
      fd.set("allowedCheckInDays", checkInDays.join(","));
      fd.set("allowedCheckOutDays", checkOutDays.join(","));
    },
    onSuccess: () => onDone(true),
  });

  return (
    <form onSubmit={form.onSubmit} data-testid="booking-rule-form" className="my-3" style={formBoxStyle}>
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}
      {rooms.length > 1 && (
        <Field label="Chambres concernées" error={form.fieldError("roomIds")}>
          <RoomPicker rooms={rooms} value={roomIds} onChange={setRoomIds} />
        </Field>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Saison — début (optionnel)" error={form.fieldError("validFrom")}>
          <DateInput name="validFrom" defaultValue={isoDay(rule?.validFrom ?? null)} />
        </Field>
        <Field label="Saison — fin (optionnel)" error={form.fieldError("validTo")}>
          <DateInput name="validTo" defaultValue={isoDay(rule?.validTo ?? null)} />
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Nuits minimum" error={form.fieldError("minStay")}>
          <AdminInput type="number" name="minStay" min="1" placeholder="ex: 2" defaultValue={rule?.minStay ?? ""} />
        </Field>
        <Field label="Nuits maximum" error={form.fieldError("maxStay")}>
          <AdminInput type="number" name="maxStay" min="1" placeholder="ex: 14" defaultValue={rule?.maxStay ?? ""} />
        </Field>
      </div>

      <Field label="Jours d'arrivée autorisés" hint="Aucun sélectionné = tous les jours autorisés">
        <DayPicker value={checkInDays} onChange={setCheckInDays} />
      </Field>

      <Field label="Jours de départ autorisés" hint="Aucun sélectionné = tous les jours autorisés">
        <DayPicker value={checkOutDays} onChange={setCheckOutDays} color="var(--admin-accent)" />
      </Field>

      <FormFooter pending={form.pending} editing={!!rule} createLabel="Créer la règle" onCancel={() => onDone(false)} />
    </form>
  );
}
