"use client";

import { useState } from "react";
import { useFormAction } from "@/components/admin/useFormAction";
import { updateContent } from "@/lib/actions/content";
import {
  AdminInput,
  AdminTextarea,
  Field,
  SettingsSection,
  StatusBanner,
  DemoLock,
} from "@/components/admin/ui";
import HeroPhotoUploader from "@/components/admin/HeroPhotoUploader";
import GalleryPhotosUploader from "@/components/admin/GalleryPhotosUploader";
import type { TenantConfig, StoryStat } from "@/lib/tenant-context";

const MAX_STATS = 4;

function emptyStat(): StoryStat {
  return { value: "", label: "", sub: "" };
}

export default function ContentSection({ config, demo }: { config: TenantConfig; demo: boolean }) {
  const form = useFormAction(updateContent, {
    prepare: (fd) => {
      // Filtre les stats vides avant envoi
      const cleanStats = stats
        .map((s) => {
          const value = s.value.trim();
          const label = s.label.trim();
          const sub = (s.sub ?? "").trim();
          return sub ? { value, label, sub } : { value, label };
        })
        .filter((s) => s.value && s.label);
      fd.set("storyStats", JSON.stringify(cleanStats));
    },
  });

  const initialStats: StoryStat[] =
    config.storyStats && config.storyStats.length > 0
      ? config.storyStats.slice(0, MAX_STATS)
      : [];

  const [stats, setStats] = useState<StoryStat[]>(initialStats);

  const updateStat = (i: number, field: keyof StoryStat, val: string) => {
    setStats((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: val } : s)));
  };

  const addStat = () => {
    if (stats.length < MAX_STATS) setStats([...stats, emptyStat()]);
  };

  const removeStat = (i: number) => {
    setStats((prev) => prev.filter((_, idx) => idx !== i));
  };

  return (
    <>
      {form.saved && (
        <StatusBanner variant="success">Contenu mis à jour avec succès.</StatusBanner>
      )}
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}

      <form
        onSubmit={form.onSubmit}
      >
        <SettingsSection
          title="Grande photo d'accueil"
          desc="L'image visible en première page. Sans image, un fond de couleur unie est utilisé."
        >
          <DemoLock demo={demo}>
            <HeroPhotoUploader initialPhoto={config.heroPhoto} />
          </DemoLock>
        </SettingsSection>

        <SettingsSection
          title="Galerie d'illustration"
          desc="De 0 à 6 photos affichées sur la page d'accueil. La mise en page s'adapte automatiquement au nombre de photos."
        >
          <DemoLock demo={demo}>
            <GalleryPhotosUploader initialPhotos={config.galleryPhotos ?? []} />
          </DemoLock>
        </SettingsSection>

        <SettingsSection
          title="Textes de la page d'accueil"
          desc="Ce que vos clients lisent en arrivant sur votre site. Un champ vide n'est pas affiché."
        >
          <Field label="Petite ligne au-dessus du titre" hint="Courte mention en petites lettres, par exemple le type de logement et le lieu.">
            <AdminInput
              name="heroEyebrow"
              defaultValue={config.heroEyebrow ?? ""}
              placeholder="ex : Gîte de charme · Vendée"
              maxLength={120}
            />
          </Field>

          <Field label="Titre principal">
            <AdminInput
              name="heroTitle"
              defaultValue={config.heroTitle ?? ""}
              placeholder="ex : Une longère au calme, au cœur du bocage"
              maxLength={200}
            />
          </Field>

          <Field label="Sous-titre">
            <AdminTextarea
              name="heroSubtitle"
              defaultValue={config.heroSubtitle ?? ""}
              rows={2}
              placeholder="ex : 3 chambres, un jardin clos et le petit-déjeuner maison."
              maxLength={500}
            />
          </Field>
        </SettingsSection>

        <SettingsSection
          title="Notre histoire"
          desc="Bloc affiché sous la grande image d'accueil. Laissez vide pour ne pas l'afficher."
        >
          <Field label="Petite ligne au-dessus du titre">
            <AdminInput
              name="storyEyebrow"
              defaultValue={config.storyEyebrow ?? ""}
              placeholder="ex : Notre histoire"
              maxLength={120}
            />
          </Field>
          <Field label="Titre">
            <AdminInput
              name="storyTitle"
              defaultValue={config.storyTitle ?? ""}
              placeholder="ex : Une ferme du XIXe siècle, restaurée pierre par pierre"
              maxLength={200}
            />
          </Field>
          <Field label="Description">
            <AdminTextarea
              name="storyText"
              defaultValue={config.storyText ?? ""}
              rows={5}
              placeholder="ex : Nous avons repris la ferme familiale en 2015…"
              maxLength={2000}
            />
          </Field>
        </SettingsSection>

        <SettingsSection
          title="Chiffres clés"
          desc={`Jusqu'à ${MAX_STATS} chiffres affichés à côté de votre histoire (ex : 3 chambres, 1 hectare de jardin).`}
        >
          <div className="space-y-2.5">
            {stats.map((stat, i) => (
              <div
                key={i}
                className="grid grid-cols-[80px_1fr_1.5fr_auto] gap-2 items-end"
              >
                <Field label={i === 0 ? "Valeur" : ""}>
                  <AdminInput
                    value={stat.value}
                    onChange={(e) => updateStat(i, "value", e.target.value)}
                    placeholder="ex : 3"
                    maxLength={20}
                    aria-label={`Valeur du chiffre ${i + 1}`}
                  />
                </Field>
                <Field label={i === 0 ? "Libellé" : ""}>
                  <AdminInput
                    value={stat.label}
                    onChange={(e) => updateStat(i, "label", e.target.value)}
                    placeholder="ex : chambres"
                    maxLength={60}
                    aria-label={`Libellé du chiffre ${i + 1}`}
                  />
                </Field>
                <Field label={i === 0 ? "Détail (optionnel)" : ""}>
                  <AdminInput
                    value={stat.sub ?? ""}
                    onChange={(e) => updateStat(i, "sub", e.target.value)}
                    placeholder="ex : avec salle de bain"
                    maxLength={80}
                    aria-label={`Détail du chiffre ${i + 1}`}
                  />
                </Field>
                <button
                  type="button"
                  onClick={() => removeStat(i)}
                  className="mb-[2px]"
                  style={{
                    padding: "8px 14px",
                    background: "transparent",
                    color: "var(--admin-text-muted)",
                    border: "1px solid var(--admin-border)",
                    borderRadius: 8,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                  aria-label={`Supprimer le chiffre ${i + 1}`}
                >
                  ✕
                </button>
              </div>
            ))}

            {stats.length < MAX_STATS && (
              <button
                type="button"
                onClick={addStat}
                style={{
                  padding: "8px 14px",
                  background: "transparent",
                  color: "var(--admin-primary)",
                  border: "1px dashed var(--admin-primary)",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                + Ajouter un chiffre
              </button>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          title="Pied de page"
          desc="Une courte phrase affichée tout en bas de chaque page de votre site."
        >
          <Field label="Phrase de pied de page">
            <AdminInput
              name="footerTagline"
              defaultValue={config.footerTagline ?? ""}
              placeholder="ex : L'accueil vendéen, en toute simplicité."
              maxLength={200}
            />
          </Field>
        </SettingsSection>

        <div className="flex justify-end mt-4">
          <button
            type="submit"
            disabled={form.pending}
            style={{
              padding: "10px 20px",
              background: "var(--admin-primary)",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              cursor: form.pending ? "wait" : "pointer",
              opacity: form.pending ? 0.7 : 1,
            }}
          >
            {form.pending ? "Enregistrement…" : "Enregistrer les textes"}
          </button>
        </div>
      </form>
    </>
  );
}
