import { EMAIL_VARIABLES } from "@/lib/email-template";
import { FIXED_ROOM_INFO } from "@/lib/room-info";

/** Liste repliable des variables utilisables dans les messages d'email. */
export default function EmailVariablesHelp() {
  return (
    <details
      className="mb-4 text-[12.5px]"
      style={{
        padding: "10px 12px",
        background: "var(--admin-surface-2)",
        border: "1px solid var(--admin-border-light)",
        borderRadius: 8,
        color: "var(--admin-text-muted)",
      }}
    >
      <summary className="cursor-pointer font-semibold" style={{ color: "var(--admin-text)" }}>
        Variables : personnaliser selon le client et la chambre
      </summary>
      <p className="mt-2 mb-1.5">
        {"Écrivez une variable entre accolades : elle est remplacée dans chaque email. Ex. « Bonjour {client}, votre chambre {chambre} compte {lits} lits. »"}
      </p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
        {EMAIL_VARIABLES.map(([name, label]) => (
          <li key={name}>
            <code style={{ color: "var(--admin-primary)", fontWeight: 600 }}>{`{${name}}`}</code> — {label}
          </li>
        ))}
      </ul>
      <p className="mt-2.5 mb-1 font-semibold" style={{ color: "var(--admin-text)" }}>
        Infos pratiques de la chambre (à remplir plus bas, chambre par chambre)
      </p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
        {FIXED_ROOM_INFO.map((f) => (
          <li key={f.key}>
            <code style={{ color: "var(--admin-primary)", fontWeight: 600 }}>{`{${f.key}}`}</code> — {f.label.toLowerCase()}
          </li>
        ))}
        <li>+ les infos que vous ajoutez vous-même, avec leur propre variable</li>
      </ul>
    </details>
  );
}
