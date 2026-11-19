import { EMAIL_VARIABLES } from "@/lib/email-template";

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
        Écrivez une variable entre accolades : elle est remplacée dans chaque email. Ex. « Bonjour
        {" {client}"}, votre chambre {"{chambre}"} compte {"{lits}"} lits. »
      </p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
        {EMAIL_VARIABLES.map(([name, label]) => (
          <li key={name}>
            <code style={{ color: "var(--admin-primary)", fontWeight: 600 }}>{`{${name}}`}</code> — {label}
          </li>
        ))}
      </ul>
    </details>
  );
}
