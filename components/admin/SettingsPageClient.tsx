"use client";

import { useState } from "react";
import { useFormAction } from "@/components/admin/useFormAction";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/admin/icons";
import {
  AdminInput,
  Field,
  SettingsSection,
  StatusBanner,
  Tabs,
} from "@/components/admin/ui";
import { updateGeneral } from "@/lib/actions/general";
import { updateTheme } from "@/lib/actions/theme";
import EmailSettingsSection from "@/components/admin/EmailSettingsSection";
import LocationSection from "@/components/admin/LocationSection";
import IcalSourcesSection from "@/components/admin/IcalSourcesSection";
import StripeConnectSection from "@/components/admin/StripeConnectSection";
import ContentSection from "@/components/admin/ContentSection";
import ExtrasSection from "@/components/admin/ExtrasSection";
import type { CatalogExtra } from "@/lib/queries/extras";
import FeesSection from "@/components/admin/FeesSection";
import TouristTaxSection from "@/components/admin/TouristTaxSection";
import type { CatalogFee } from "@/lib/queries/fees";
import type { TenantConfig, TemplateName } from "@/lib/tenant-context";

type TabId = "etablissement" | "site" | "calendriers" | "emails";

// 4 onglets au lieu de 7 (critique du 2026-10-24) : regroupés par ce que l'hôte gère.
const TABS: { id: TabId; label: string; short: string }[] = [
  { id: "etablissement", label: "Mon établissement", short: "Établissement" },
  { id: "site", label: "Mon site", short: "Site" },
  { id: "calendriers", label: "Calendriers et paiements", short: "Calendriers" },
  { id: "emails", label: "Emails", short: "Emails" },
];

// Anciens ?tab= (liens, favoris, tests) : chacun ouvre l'onglet qui contient désormais sa section.
const TAB_ALIASES: Record<string, TabId> = {
  general: "etablissement",
  location: "etablissement",
  localisation: "etablissement",
  theme: "site",
  apparence: "site",
  content: "site",
  contenu: "site",
  ical: "calendriers",
  stripe: "calendriers",
  paiements: "calendriers",
  email: "emails",
};

function resolveTab(raw: string | null, fromStripe: boolean): TabId {
  if (raw && TABS.some((t) => t.id === raw)) return raw as TabId;
  if (raw && TAB_ALIASES[raw]) return TAB_ALIASES[raw];
  // Retour de Stripe Connect (?stripe=success|refresh) : on montre le statut du compte.
  return fromStripe ? "calendriers" : "etablissement";
}

type Room = { id: string; name: string };

type IcalSource = {
  id: string;
  name: string;
  url: string;
  active: boolean;
  roomId: string;
  roomName: string;
  lastSyncAt: string | null;
};

export default function SettingsPageClient({
  tenant,
  config,
  baseUrl,
  rooms,
  icalSources,
  hasStripeAccount,
  extras,
  fees,
}: {
  tenant: { id: string; name: string; slug: string; domain: string | null };
  config: TenantConfig;
  baseUrl: string;
  rooms: Room[];
  icalSources: IcalSource[];
  hasStripeAccount: boolean;
  extras: CatalogExtra[];
  fees: CatalogFee[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTabState] = useState<TabId>(() =>
    resolveTab(searchParams.get("tab"), searchParams.has("stripe")),
  );

  const setTab = (next: TabId) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="admin-fade-in">
      <header className="mb-6">
        <h1
          className="text-[24px] font-extrabold leading-tight"
          style={{ color: "var(--admin-text)", letterSpacing: "-0.6px" }}
        >
          Paramètres
        </h1>
        <p
          className="text-[14px] mt-1"
          style={{ color: "var(--admin-text-muted)" }}
        >
          Votre établissement, son site, ses calendriers et ses paiements.
        </p>
      </header>

      <Tabs<TabId> tabs={TABS} active={tab} onChange={setTab} label="Sections des paramètres" />

      <div
        className="max-w-[760px]"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === "etablissement" && (
          <>
            <GeneralTab tenant={tenant} config={config} />
            <LocationSection
              googleMapsUrl={config.googleMapsUrl}
              latitude={config.latitude}
              longitude={config.longitude}
            />
            <ExtrasSection extras={extras} />
            <FeesSection fees={fees} rooms={rooms} />
            <TouristTaxSection tax={config.touristTax} />
          </>
        )}
        {tab === "site" && (
          <>
            <ThemeTab config={config} />
            <ContentSection config={config} />
          </>
        )}
        {tab === "emails" && (
          <EmailSettingsSection
            confirmationMessage={config.confirmationMessage}
            postStayMessage={config.postStayMessage}
            reviewUrl={config.reviewUrl}
          />
        )}
        {tab === "calendriers" && (
          <>
            <IcalSourcesSection
              baseUrl={baseUrl}
              rooms={rooms}
              sources={icalSources}
            />
            <StripeConnectSection hasAccount={hasStripeAccount} />
          </>
        )}
      </div>
    </div>
  );
}

/* ── Général ─────────────────────────────────────────────────────────── */

function GeneralTab({
  tenant,
  config,
}: {
  tenant: { id: string; name: string; slug: string; domain: string | null };
  config: TenantConfig;
}) {
  const form = useFormAction(updateGeneral);

  return (
    <>
      {form.saved && (
        <StatusBanner variant="success">Informations mises à jour.</StatusBanner>
      )}
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}

      <form
        onSubmit={form.onSubmit}
      >
        <SettingsSection
          title="Votre établissement"
          desc="Le nom affiché sur votre site et dans les emails envoyés à vos clients."
        >
          <Field label="Nom de l'établissement" error={form.fieldError("name")}>
            <AdminInput
              name="name"
              defaultValue={tenant.name}
              required
              maxLength={120}
            />
          </Field>
        </SettingsSection>

        <SettingsSection
          title="Adresse de votre site"
          desc="Gérée par l'équipe DirectLoc. Contactez-nous pour la modifier."
        >
          {tenant.domain ? (
            <a
              href={`https://${tenant.domain}`}
              target="_blank"
              rel="noreferrer"
              className="text-[14px] font-semibold underline underline-offset-2 break-all"
              style={{ color: "var(--admin-primary)" }}
            >
              {tenant.domain}
            </a>
          ) : (
            <p className="text-[13.5px]" style={{ color: "var(--admin-text)" }}>
              Pas encore de nom de domaine : l&apos;équipe DirectLoc le branche pour vous.
            </p>
          )}
          <p className="text-[12.5px] mt-2" style={{ color: "var(--admin-text-subtle)" }}>
            Identifiant à donner au support : <strong>{tenant.slug}</strong>
          </p>
        </SettingsSection>

        <SettingsSection
          title="Contact"
          desc="Affiché en pied de page et sur la page de réservation."
        >
          <div className="grid grid-cols-2 gap-3.5">
            <Field label="Email" error={form.fieldError("email")}>
              <AdminInput
                name="email"
                defaultValue={config.email ?? ""}
                type="email"
                placeholder="ex : contact@gite-du-bocage.fr"
                maxLength={120}
              />
            </Field>
            <Field label="Téléphone" error={form.fieldError("phone")}>
              <AdminInput
                name="phone"
                defaultValue={config.phone ?? ""}
                type="tel"
                placeholder="ex : 02 51 12 34 56"
                maxLength={40}
              />
            </Field>
          </div>
          <Field label="Adresse" error={form.fieldError("address")}>
            <AdminInput
              name="address"
              defaultValue={config.address ?? ""}
              placeholder="ex : 3 chemin de la Grange, 85590 Les Épesses"
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
            {form.pending ? "Enregistrement…" : "Enregistrer les coordonnées"}
          </button>
        </div>
      </form>
    </>
  );
}

/* ── Apparence ──────────────────────────────────────────────────────── */

const TEMPLATES: {
  id: TemplateName;
  name: string;
  desc: string;
  bg: string;
  accent: string;
}[] = [
  {
    id: "classic",
    name: "Plaque émaillée",
    desc: "Plaques d'émail sur mur de pierre",
    bg: "#1F3B7A",
    accent: "#B5342B",
  },
  {
    id: "boutique",
    name: "Linge de maison",
    desc: "Lin et rayures tissées",
    bg: "#B23A3A",
    accent: "#E6E0D2",
  },
  {
    id: "affiche",
    name: "Affiche touristique",
    desc: "Affiche d'époque, aplats de couleur",
    bg: "#1F3B57",
    accent: "#F2B33D",
  },
  {
    id: "standard",
    name: "Classique",
    desc: "Sobre et efficace, façon plateforme",
    bg: "#2A5C40",
    accent: "#FFFFFF",
  },
];

function ThemeTab({ config }: { config: TenantConfig }) {
  const [template, setTemplate] = useState<TemplateName>(
    config.template ?? "classic",
  );
  const [primary, setPrimary] = useState(config.primaryColor ?? "#1C3A2C");
  const [accent, setAccent] = useState(config.secondaryColor ?? "#D4784A");
  const form = useFormAction(updateTheme);

  return (
    <>
      {form.saved && <StatusBanner variant="success">Apparence mise à jour.</StatusBanner>}
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}

      <form
        onSubmit={form.onSubmit}
      >
      <SettingsSection
        title="Modèle de site"
        desc="L'allure de votre site. Vous pouvez changer de modèle quand vous voulez : vos textes et photos sont conservés."
      >
        <input type="hidden" name="template" value={template} />
        <div className="grid grid-cols-2 gap-3.5">
          {TEMPLATES.map((t) => {
            const selected = template === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t.id)}
                aria-label={`Modèle ${t.name}`}
                aria-pressed={selected}
                className="text-left relative"
                style={{
                  background: "var(--admin-surface)",
                  border: `2px solid ${
                    selected ? "var(--admin-primary)" : "var(--admin-border)"
                  }`,
                  borderRadius: 10,
                  padding: 16,
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                <div
                  style={{
                    height: 60,
                    borderRadius: 6,
                    background: t.bg,
                    marginBottom: 12,
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      bottom: 8,
                      left: 8,
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      background: t.accent,
                    }}
                  />
                </div>
                <div
                  className="text-[14px] font-bold mb-0.5"
                  style={{ color: "var(--admin-text)" }}
                >
                  {t.name}
                </div>
                <div
                  className="text-[12px]"
                  style={{ color: "var(--admin-text-muted)" }}
                >
                  {t.desc}
                </div>
                {selected && (
                  <span
                    className="absolute flex items-center justify-center"
                    style={{
                      top: 10,
                      right: 10,
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      background: "var(--admin-primary)",
                    }}
                  >
                    <Icon.Check size={11} style={{ color: "#fff" }} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Couleurs"
        desc="Personnalisez les couleurs du modèle choisi. Elles apparaissent sur votre site après enregistrement."
      >
        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Couleur principale" error={form.fieldError("primaryColor")}>
            <ColorRow
              name="primaryColor"
              value={primary}
              onChange={setPrimary}
            />
          </Field>
          <Field label="Couleur d'accent" error={form.fieldError("secondaryColor")}>
            <ColorRow
              name="secondaryColor"
              value={accent}
              onChange={setAccent}
            />
          </Field>
        </div>
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
            {form.pending ? "Enregistrement…" : "Enregistrer l'apparence"}
          </button>
        </div>
      </form>
    </>
  );
}

function ColorRow({
  name,
  value,
  onChange,
}: {
  name?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label
        className="relative shrink-0 cursor-pointer"
        style={{
          width: 38,
          height: 38,
          borderRadius: 8,
          background: value,
          border: "1px solid var(--admin-border)",
          overflow: "hidden",
        }}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
          aria-label="Choisir la couleur"
        />
      </label>
      <AdminInput
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={7}
        aria-label="Code hexadécimal"
        pattern="^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"
      />
    </div>
  );
}

