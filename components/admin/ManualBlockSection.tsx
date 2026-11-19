"use client";

import { ConfirmButton } from "@/components/admin/ConfirmButton";
import { useState } from "react";
import { useFormAction } from "@/components/admin/useFormAction";
import { createManualBlock, deleteManualBlock, updateManualBlock } from "@/lib/actions/rules";
import {
  DateInput,
  EmptyState,
  Field,
  SettingsSection,
  StatusBanner,
} from "@/components/admin/ui";
import { Icon } from "@/components/admin/icons";
import {
  AddToggle,
  DAY_SHORT_NAMES,
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
import type { ManualBlockRow } from "./RulesPageClient";

type Room = { id: string; name: string };

export default function ManualBlockSection({ rooms, blocks }: { rooms: Room[]; blocks: ManualBlockRow[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <SettingsSection
      title="Blocages manuels"
      desc="Rendez une, plusieurs ou toutes les chambres indisponibles sur une période (travaux, congés…). Elles apparaissent hachurées sur le calendrier."
      action={<AddToggle open={adding} onClick={() => { setAdding(!adding); setSaved(null); }} />}
    >
      {saved && !adding && <StatusBanner variant="success">{saved}</StatusBanner>}
      {adding && (
        <ManualBlockForm
          rooms={rooms}
          onDone={(ok) => {
            setAdding(false);
            if (ok) setSaved("Blocage ajouté.");
          }}
        />
      )}

      {blocks.length === 0 && !adding ? (
        <EmptyState
          compact
          title="Aucun blocage configuré"
          example="fermeture annuelle du 5 au 20 janvier, ou une chambre en travaux."
        >
          Bloquez des dates quand une chambre ne peut pas être louée : elles ne seront plus
          réservables sur votre site.
        </EmptyState>
      ) : (
        <div>
          {blocks.map((block, i) =>
            editing === block.id ? (
              <ManualBlockForm
                key={block.id}
                block={block}
                rooms={rooms}
                onDone={(ok) => {
                  setEditing(null);
                  if (ok) setSaved("Blocage modifié.");
                }}
              />
            ) : (
              <div
                key={block.id}
                data-testid="manual-block-row"
                className="flex items-center gap-3 py-3"
                style={{
                  borderBottom: i < blocks.length - 1 ? "1px solid var(--admin-border-light)" : "none",
                }}
              >
                <div
                  className="flex items-center justify-center flex-shrink-0"
                  style={{ width: 36, height: 36, borderRadius: 8, background: "#FEE2E2" }}
                >
                  <Icon.X size={16} style={{ color: "var(--admin-danger)" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-semibold" style={{ color: "var(--admin-text)" }}>
                    {roomsLabel(block.roomIds, rooms)}
                    {block.recurring && (
                      <span
                        className="ml-2 text-[12px] font-bold"
                        style={{ padding: "2px 8px", borderRadius: 12, background: "#FEF3C7", color: "#92400E" }}
                      >
                        Récurrent
                      </span>
                    )}
                  </p>
                  <p className="text-[12px]" style={{ color: "var(--admin-text-muted)" }}>
                    {block.recurring
                      ? `Chaque ${asDays(block.recurrenceDays)
                          .map((d) => DAY_SHORT_NAMES[d])
                          .join(", ")} — depuis le ${frDate(block.startDate)}${
                          block.recurrenceUntil ? ` jusqu'au ${frDate(block.recurrenceUntil)}` : " (indéfini)"
                        }`
                      : `${frDate(block.startDate)} → ${frDate(block.endDate)}`}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <EditButton
                    label={`Modifier le blocage ${roomsLabel(block.roomIds, rooms)}`}
                    onClick={() => { setEditing(block.id); setSaved(null); }}
                  />
                  <ConfirmButton
                    title={"Supprimer ce blocage ?"}
                    message="Ces dates redeviendront réservables sur le site, sauf si une autre réservation ou un autre blocage les occupe."
                    confirmLabel="Supprimer le blocage"
                    onConfirm={() => deleteManualBlock(block.id)}
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

function ManualBlockForm({
  block,
  rooms,
  onDone,
}: {
  block?: ManualBlockRow;
  rooms: Room[];
  onDone: (saved: boolean) => void;
}) {
  const [isRecurring, setIsRecurring] = useState(block?.recurring ?? false);
  const [selectedDays, setSelectedDays] = useState<number[]>(asDays(block?.recurrenceDays));
  const [roomIds, setRoomIds] = useState<string[]>(block?.roomIds ?? []);
  const form = useFormAction(block ? updateManualBlock.bind(null, block.id) : createManualBlock, {
    prepare: (fd) => {
      if (isRecurring) fd.set("recurrenceDays", selectedDays.join(","));
    },
    onSuccess: () => onDone(true),
  });

  return (
    <form onSubmit={form.onSubmit} data-testid="manual-block-form" className="my-3" style={formBoxStyle}>
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}
      {rooms.length > 1 && (
        <Field label="Chambres bloquées" error={form.fieldError("roomIds")}>
          <RoomPicker rooms={rooms} value={roomIds} onChange={setRoomIds} color="var(--admin-danger)" />
        </Field>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Date début" error={form.fieldError("startDate")}>
          <DateInput name="startDate" required defaultValue={isoDay(block?.startDate ?? null)} />
        </Field>
        <Field label="Date fin" error={form.fieldError("endDate")}>
          <DateInput name="endDate" required defaultValue={isoDay(block?.endDate ?? null)} />
        </Field>
      </div>

      <label className="flex items-center gap-2 mb-3">
        <input
          type="checkbox"
          name="recurring"
          checked={isRecurring}
          onChange={(e) => setIsRecurring(e.target.checked)}
          style={{ accentColor: "var(--admin-primary)" }}
        />
        <span className="text-[13px]" style={{ color: "var(--admin-text)" }}>
          Récurrent (chaque semaine)
        </span>
      </label>

      {isRecurring && (
        <>
          <input type="hidden" name="recurrenceType" value="weekly" />
          <Field label="Jours bloqués">
            <DayPicker value={selectedDays} onChange={setSelectedDays} color="var(--admin-danger)" />
          </Field>
          <div className="max-w-xs">
            <Field label="Fin de récurrence (optionnel)" error={form.fieldError("recurrenceUntil")}>
              <DateInput name="recurrenceUntil" defaultValue={isoDay(block?.recurrenceUntil ?? null)} />
            </Field>
          </div>
        </>
      )}

      <FormFooter pending={form.pending} editing={!!block} createLabel="Créer le blocage" onCancel={() => onDone(false)} />
    </form>
  );
}
