"use client";

import Link from "next/link";
import { formatEuros } from "@/lib/utils";
import { AdminSelect } from "@/components/admin/ui";
import { EXTRA_UNIT_LABELS, CHOSEN_WORDS, chosenLabel, chosenMax, resolveChosen, type ExtraUnit } from "@/lib/extras";
import type { ManualBookingState } from "@/lib/actions/bookings";

/**
 * Morceaux de la saisie manuelle partagés par le formulaire de réservation et la fiche
 * Dossier (ajout d'une chambre, nouvelles dates) : cases Frais / Options et panneau « Forcer ».
 */

export type FrozenLine = { id: string; sourceId: string | null; label: string; unit: ExtraUnit; unitPrice: number; chosen?: number | null };

/** Une case : ligne figée de la réservation (prix d'origine) ou élément du catalogue. */
export type Choice = { value: string; label: string; unit: ExtraUnit; price: number; frozen: boolean; chosen?: number | null; maxQuantity?: number | null };

/** Cases à cocher : lignes figées de la réservation puis catalogue pas encore pris. */
export function choices(
  frozen: FrozenLine[],
  catalog: { id: string; label: string; unit: ExtraUnit; price: number; maxQuantity?: number | null }[],
): Choice[] {
  return [
    // Ligne figée « par séjour » : maximum actuel de l'option d'origine, jamais sous le nombre déjà pris (comme le serveur).
    ...frozen.map((l) => ({
      value: l.id,
      label: l.label,
      unit: l.unit,
      price: l.unitPrice,
      frozen: true,
      chosen: l.chosen,
      maxQuantity: l.unit === "per_stay" ? Math.max(l.chosen ?? 1, catalog.find((x) => x.id === l.sourceId)?.maxQuantity ?? 1) : null,
    })),
    ...catalog
      .filter((x) => !frozen.some((l) => l.sourceId === x.id))
      .map((x) => ({ value: x.id, label: x.label, unit: x.unit, price: x.price, frozen: false, maxQuantity: x.maxQuantity })),
  ];
}

type Ids = [string[], (update: (ids: string[]) => string[]) => void];

/**
 * Cases « Frais » puis « Options » (nombre au choix borné par le séjour, comme le serveur).
 * État tenu par le parent : il survit au remontage du formulaire après une erreur.
 */
export function StayChoicesFields({
  feeChoices,
  extraChoices,
  fees: [chosenFees, setChosenFees],
  extras: [chosenExtras, setChosenExtras],
  counts: [counts, setCounts],
  stay,
}: {
  feeChoices: Choice[];
  extraChoices: Choice[];
  fees: Ids;
  extras: Ids;
  counts: [Record<string, number>, (update: (c: Record<string, number>) => Record<string, number>) => void];
  stay: { nights: number; guests: number; beds: number };
}) {
  const toggle = (set: Ids[1], value: string, checked: boolean) =>
    set((ids) => (checked ? ids.filter((id) => id !== value) : [...ids, value]));
  return (
    <>
      {feeChoices.length > 0 && (
        <fieldset className="mb-3.5" data-testid="manual-fees">
          <legend className="text-[13px] font-semibold mb-1.5" style={{ color: "var(--admin-text)" }}>
            Frais
          </legend>
          {feeChoices.map((x) => {
            const checked = chosenFees.includes(x.value);
            return (
              <label key={x.value} className="flex items-start gap-2.5 py-1 cursor-pointer" style={{ color: "var(--admin-text)" }}>
                <input
                  type="checkbox"
                  name="feeIds"
                  value={x.value}
                  checked={checked}
                  className="mt-0.5"
                  style={{ accentColor: "var(--admin-primary)" }}
                  onChange={() => toggle(setChosenFees, x.value, checked)}
                />
                <ChoiceLabel choice={x} />
              </label>
            );
          })}
        </fieldset>
      )}

      {extraChoices.length > 0 && (
        <fieldset className="mb-3.5" data-testid="manual-extras">
          <legend className="text-[13px] font-semibold mb-1.5" style={{ color: "var(--admin-text)" }}>
            Options
          </legend>
          {extraChoices.map((x) => {
            const checked = chosenExtras.includes(x.value);
            const max = chosenMax(x, stay);
            const pick = checked && max > 1;
            // Choix en cours > nombre enregistré > tout le séjour (affiché comme le maximum).
            const shown = resolveChosen(x.unit, max, counts[x.value], x.chosen) ?? max;
            return (
              <div key={x.value}>
                <label className="flex items-start gap-2.5 py-1 cursor-pointer" style={{ color: "var(--admin-text)" }}>
                  <input
                    type="checkbox"
                    name="extraIds"
                    value={x.value}
                    checked={checked}
                    className="mt-0.5"
                    style={{ accentColor: "var(--admin-primary)" }}
                    onChange={() => toggle(setChosenExtras, x.value, checked)}
                  />
                  <ChoiceLabel choice={x} />
                </label>
                {pick && (
                  <label className="flex items-center gap-2 pl-7 pb-1.5 text-[12.5px]" style={{ color: "var(--admin-text-muted)" }}>
                    {CHOSEN_WORDS[x.unit].question}
                    <AdminSelect
                      // Envoyé seulement si l'hôte a choisi : sinon le serveur garde le nombre enregistré
                      // ou tout le séjour (pas d'ancien maximum envoyé avant le recalcul du devis).
                      name={counts[x.value] !== undefined ? `extraQty_${x.value}` : undefined}
                      data-testid={`extraQty-${x.value}`}
                      value={shown}
                      onChange={(e) => setCounts((c) => ({ ...c, [x.value]: Number(e.target.value) }))}
                      style={{ width: 130 }}
                    >
                      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {chosenLabel(x.unit, n)}
                        </option>
                      ))}
                    </AdminSelect>
                  </label>
                )}
              </div>
            );
          })}
        </fieldset>
      )}
    </>
  );
}

function ChoiceLabel({ choice: x }: { choice: Choice }) {
  return (
    <span className="text-[13px] leading-snug">
      {x.label}{" "}
      <span style={{ color: "var(--admin-text-muted)" }}>
        {x.price === 0 ? "· gratuit" : `· ${formatEuros(x.price)} ${EXTRA_UNIT_LABELS[x.unit]}`}
        {x.frozen && " · prix de la réservation"}
      </span>
    </span>
  );
}

/** Lien du conflit : le mois de l'arrivée saisie (JJ/MM/AAAA ou AAAA-MM-JJ ; mois 0-indexé, comme le calendrier). */
export function calendarHrefFor(checkIn?: string) {
  const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(checkIn ?? "");
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(checkIn ?? "");
  const [year, month] = fr ? [fr[3], fr[2]] : iso ? [iso[1], iso[2]] : [];
  return year ? `/admin/calendrier?year=${year}&month=${Number(month) - 1}` : "/admin/calendrier";
}

/**
 * « Forcer » n'apparaît qu'après un vrai conflit, collé au bouton : la décision et son effet
 * au même endroit. Envoie la case `force`.
 */
export function ForcePanel({ state, calendarHref }: { state: NonNullable<ManualBookingState>; calendarHref: string }) {
  return (
    <div
      role="alert"
      data-force-panel
      className="mt-1 mb-1 px-3.5 py-3 rounded-lg"
      style={{ background: "#FEF3C7", border: "1px solid #FCD34D", color: "#92400E" }}
    >
      <p className="text-[13px] font-bold leading-snug">
        {state.error}{" "}
        <Link href={calendarHref} className="font-semibold underline underline-offset-2">
          Voir le calendrier
        </Link>
      </p>
      <p className="text-[12.5px] leading-[1.5] mt-1">
        {state.clash?.kind === "booking"
          ? `${state.clash.guestName} occupe déjà la chambre : enregistrer quand même y mettra deux clients en même temps. À faire seulement si vous déplacez l'un des deux ensuite.`
          : state.clash?.kind === "ical"
            ? "Si c'est la même réservation, recopiée ici, vous pouvez enregistrer. Sinon, deux clients arriveront le même soir."
            : "Enregistrez quand même si ce blocage n'a plus lieu d'être."}
      </p>
      <label className="flex items-start gap-2.5 mt-2.5 cursor-pointer" style={{ color: "var(--admin-text)" }}>
        <input type="checkbox" name="force" className="mt-0.5" style={{ accentColor: "var(--admin-primary)" }} />
        <span className="text-[13px] font-semibold leading-snug">Enregistrer quand même</span>
      </label>
    </div>
  );
}
