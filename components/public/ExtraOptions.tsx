"use client";

import { formatEuros } from "@/lib/utils";
import {
  EXTRA_UNIT_LABELS,
  CHOSEN_WORDS,
  chosenLabel,
  chosenMax,
  resolveChosen,
  priceExtraLine,
  type StaySize,
} from "@/lib/extras";
import type { CatalogExtra } from "@/lib/queries/extras";

/**
 * Liste des options (Extras, ADR-0010) d'un séjour : case à cocher, prix calculé comme au
 * serveur, nombre choisi (nuits, personnes, lits, ou quantité par séjour).
 * `named` : champs `extraIds` / `extraQty_<id>` envoyés tels quels (formulaire d'une chambre).
 * `idPrefix` : ids uniques quand plusieurs chambres affichent la même option.
 */
export default function ExtraOptions({
  extras,
  chosen,
  counts,
  stay,
  onToggle,
  onCount,
  named = false,
  idPrefix = "",
}: {
  extras: CatalogExtra[];
  chosen: string[];
  /** Nombre choisi par option ; absent = tout le séjour. */
  counts: Record<string, number>;
  stay: StaySize;
  onToggle: (id: string) => void;
  onCount: (id: string, n: number) => void;
  named?: boolean;
  idPrefix?: string;
}) {
  const maxOf = (x: CatalogExtra) => chosenMax(x, stay);
  // null = tout le séjour (affiché comme le maximum) ; même règle que le serveur.
  const chosenOf = (x: CatalogExtra) => resolveChosen(x.unit, maxOf(x), counts[x.id]);
  const shownOf = (x: CatalogExtra) => chosenOf(x) ?? maxOf(x);

  return (
    <ul className="s-extras">
      {extras.map((x) => {
        const line = priceExtraLine({ sourceId: x.id, label: x.label, unit: x.unit, unitPrice: x.price }, stay, chosenOf(x));
        const checked = chosen.includes(x.id);
        return (
          <li key={x.id}>
            <label className="s-extra">
              <input
                type="checkbox"
                name={named ? "extraIds" : undefined}
                value={x.id}
                checked={checked}
                onChange={() => onToggle(x.id)}
              />
              <span className="s-extra-text">
                <span className="s-extra-label">{x.label}</span>
                <span className="s-hint">
                  {x.price === 0 ? "Offert, sur demande" : `${formatEuros(x.price)} ${EXTRA_UNIT_LABELS[x.unit]}`}
                  {x.description && <> · {x.description}</>}
                </span>
              </span>
              <span className="s-extra-price" data-testid="booking-extra-price">
                {line.total === 0 ? "Offert" : formatEuros(line.total)}
              </span>
            </label>
            {checked && maxOf(x) > 1 && (
              <div className="s-extra-qty">
                <label htmlFor={`extraQty-${idPrefix}${x.id}`}>{CHOSEN_WORDS[x.unit].question}</label>
                <select
                  id={`extraQty-${idPrefix}${x.id}`}
                  // Envoyé seulement si le client a choisi ; sinon tout le séjour.
                  name={named && counts[x.id] !== undefined ? `extraQty_${x.id}` : undefined}
                  value={shownOf(x)}
                  onChange={(e) => onCount(x.id, Number(e.target.value))}
                >
                  {Array.from({ length: maxOf(x) }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {chosenLabel(x.unit, n)}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
