"use client";

import { useRef, useState } from "react";
import { SettingsSection, StatusBanner } from "@/components/admin/ui";
import type { TenantConfig } from "@/lib/tenant-context";

type Favicon = NonNullable<TenantConfig["favicon"]>;

const btn = {
  padding: "8px 16px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
} as const;

/** Icône d'onglet du site : aperçu dans un faux onglet de navigateur, envoi, retrait. */
export default function FaviconSection({
  initial,
  siteName,
  demo,
}: {
  initial: TenantConfig["favicon"];
  siteName: string;
  demo: boolean;
}) {
  const [favicon, setFavicon] = useState<Favicon | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function send(method: "POST" | "DELETE", file?: File) {
    setError(null);
    setSaved(null);
    setBusy(true);
    try {
      const body = file ? new FormData() : undefined;
      if (file) body!.append("favicon", file);
      const res = await fetch("/api/admin/favicon", { method, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "L'enregistrement n'a pas abouti. Réessayez.");
        return;
      }
      setFavicon(data.favicon ?? null);
      setSaved(file ? "Icône enregistrée. Rechargez votre site pour la voir dans l'onglet." : "Icône retirée.");
    } catch {
      setError("Erreur réseau");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection
      title="Icône d'onglet"
      desc="La petite image affichée dans l'onglet du navigateur et les favoris, à côté du nom de votre site. Un logo simple et carré se lit le mieux."
    >
      {saved && <StatusBanner variant="success">{saved}</StatusBanner>}
      {error && <StatusBanner variant="error">{error}</StatusBanner>}

      <div className="flex flex-wrap items-center gap-5">
        {/* Faux onglet : l'hôte voit l'icône à sa taille réelle, à côté du nom du site. */}
        <div
          data-testid="favicon-preview"
          aria-label="Aperçu de l'onglet"
          className="flex items-center gap-2 min-w-0"
          style={{
            width: 220,
            padding: "8px 12px",
            background: "var(--admin-surface)",
            border: "1px solid var(--admin-border)",
            borderBottom: "none",
            borderRadius: "10px 10px 0 0",
            boxShadow: "0 -1px 0 var(--admin-border-light) inset",
          }}
        >
          {favicon ? (
            // eslint-disable-next-line @next/next/no-img-element -- 16 px, fichier déjà optimisé
            <img src={favicon.url} alt="" width={16} height={16} style={{ flex: "none" }} />
          ) : (
            <span
              aria-hidden="true"
              style={{ width: 16, height: 16, borderRadius: 4, background: "var(--admin-border)", flex: "none" }}
            />
          )}
          <span className="text-[12.5px] truncate" style={{ color: "var(--admin-text)" }}>
            {siteName}
          </span>
        </div>

        {favicon && (
          // eslint-disable-next-line @next/next/no-img-element -- aperçu agrandi
          <img
            src={favicon.url}
            alt="Icône actuelle"
            width={56}
            height={56}
            style={{ borderRadius: 10, border: "1px solid var(--admin-border-light)", background: "var(--admin-surface-2)" }}
          />
        )}

        <div className="space-y-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            data-testid="favicon-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) send("POST", f);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || demo}
              onClick={() => input.current?.click()}
              style={{
                ...btn,
                background: "var(--admin-primary)",
                color: "#fff",
                border: "none",
                cursor: busy || demo ? "not-allowed" : "pointer",
                opacity: busy || demo ? 0.6 : 1,
              }}
            >
              {busy ? "Envoi…" : favicon ? "Remplacer l'icône" : "Choisir une icône"}
            </button>
            {favicon && (
              <button
                type="button"
                disabled={busy || demo}
                onClick={() => send("DELETE")}
                style={{
                  ...btn,
                  background: "transparent",
                  color: "var(--admin-text-muted)",
                  border: "1px solid var(--admin-border)",
                  cursor: busy || demo ? "not-allowed" : "pointer",
                }}
              >
                Retirer
              </button>
            )}
          </div>
          <p className="text-[12px]" style={{ color: "var(--admin-text-subtle)" }}>
            PNG, JPEG ou WebP · 2 Mo max · recadrée en carré 512 × 512
            {demo && " · désactivé en démo"}
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
