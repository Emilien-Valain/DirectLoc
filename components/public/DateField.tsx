"use client";

import { useRef, useState } from "react";
import { formatDateTyping, frToIso, isoToFr } from "@/components/admin/ui-inputs";
import { Icon } from "@/components/admin/icons";

/** JJ/MM/AAAA complet → ISO, seulement si la date existe (pas de 31/02). */
function toIso(text: string): string {
  const iso = frToIso(text);
  if (!iso) return "";
  return new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) === iso ? iso : "";
}

/**
 * Champ date des sites publics, toujours en JJ/MM/AAAA : le <input type="date"> natif
 * suit la langue du navigateur (MM/DD/YYYY en anglais) ; on ne garde que son calendrier.
 * Contrôlé en ISO (`value`/`onChange`) ; le formulaire reçoit l'ISO via un champ caché.
 */
export default function DateField({
  id,
  name,
  label,
  value,
  onChange,
  min,
  required,
}: {
  id: string;
  name?: string;
  label: string;
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  required?: boolean;
}) {
  const [text, setText] = useState(() => isoToFr(value));
  const [prev, setPrev] = useState(value);
  const picker = useRef<HTMLInputElement>(null);

  // Valeur changée par le parent (ex. départ avancé après l'arrivée) : le texte suit.
  if (value !== prev) {
    setPrev(value);
    if (toIso(text) !== value) setText(isoToFr(value));
  }

  function openPicker() {
    const p = picker.current;
    if (!p) return;
    p.value = value;
    try {
      p.showPicker();
    } catch {
      p.focus();
    }
  }

  const tooEarly = !!value && !!min && value < min;

  return (
    <div className="s-field">
      <label htmlFor={id}>{label}</label>
      <div className="s-date">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="jj/mm/aaaa"
          pattern="\d{2}/\d{2}/\d{4}"
          title="Date au format JJ/MM/AAAA"
          required={required}
          aria-invalid={tooEarly || undefined}
          value={text}
          onChange={(e) => {
            const t = formatDateTyping(e.target.value);
            setText(t);
            onChange(toIso(t));
          }}
        />
        <button type="button" className="s-date-pick" onClick={openPicker} aria-label={`${label} : ouvrir le calendrier`}>
          <Icon.Calendar size={20} />
        </button>
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          className="s-date-native"
          min={min}
          onChange={(e) => {
            if (!e.target.value) return;
            setText(isoToFr(e.target.value));
            onChange(e.target.value);
          }}
        />
      </div>
      {name && <input type="hidden" name={name} value={value} />}
    </div>
  );
}
