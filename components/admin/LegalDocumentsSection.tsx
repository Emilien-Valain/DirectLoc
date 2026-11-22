"use client";

import { useRef, useState, type CSSProperties } from "react";
import { useFormAction } from "@/components/admin/useFormAction";
import { AdminInput, AdminTextarea, Field, SettingsSection, StatusBanner } from "@/components/admin/ui";
import { saveLegalDocuments } from "@/lib/actions/legal";
import {
  CANCELLATION_LEVEL_INFO,
  CANCELLATION_LEVELS,
  LEGAL_PAGES,
  MISSING,
  cancellationTemplate,
  missingLegalFields,
  templateFor,
  type CancellationLevel,
  type LegalInfo,
} from "@/lib/legal-documents";

export type LegalDocumentsProps = {
  /** Nom, adresse, email, téléphone, horaires : gérés dans « Mon établissement ». */
  base: Pick<LegalInfo, "name" | "address" | "email" | "phone" | "checkInTime" | "checkOutTime">;
  legalName: string | null;
  legalForm: string | null;
  siret: string | null;
  publicationDirector: string | null;
  mediator: string | null;
  cancellationLevel: CancellationLevel;
  cancellationText: string | null;
  cgvText: string | null;
  legalNoticeText: string | null;
  privacyText: string | null;
  /** ISO, ou null tant que l'hôte n'a pas publié. */
  publishedAt: string | null;
};

type FreeDoc = "cgv" | "legalNotice" | "privacy";
const FREE_DOCS: { kind: FreeDoc; name: `${FreeDoc}Text`; desc: string }[] = [
  {
    kind: "cgv",
    name: "cgvText",
    desc: "Les règles de vente de vos séjours. Vos conditions d'annulation y sont ajoutées automatiquement, en annexe.",
  },
  {
    kind: "legalNotice",
    name: "legalNoticeText",
    desc: "Obligatoires sur tout site professionnel : qui édite le site, qui l'héberge.",
  },
  {
    kind: "privacy",
    name: "privacyText",
    desc: "Ce que vous faites des données de vos voyageurs, combien de temps vous les gardez, et leurs droits.",
  },
];

const buttonBase: CSSProperties = {
  padding: "10px 18px",
  borderRadius: 10,
  fontSize: 13.5,
  fontWeight: 600,
  minHeight: 44,
};

const dateFr = (iso: string) =>
  new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });

/** Paramètres → Documents légaux (PRD remboursements-litiges § Documents légaux). */
export default function LegalDocumentsSection(props: LegalDocumentsProps) {
  const [identity, setIdentity] = useState({
    legalName: props.legalName ?? "",
    legalForm: props.legalForm ?? "",
    siret: props.siret ?? "",
    publicationDirector: props.publicationDirector ?? "",
    mediator: props.mediator ?? "",
  });
  const [level, setLevel] = useState<CancellationLevel>(props.cancellationLevel);
  const [customCancellation, setCustomCancellation] = useState(props.cancellationText ?? "");
  // Un texte non modifié suit le modèle (et donc la saisie ci-dessus) ; modifié, il est à l'hôte.
  const [texts, setTexts] = useState<Record<FreeDoc, string | null>>({
    cgv: props.cgvText,
    legalNotice: props.legalNoticeText,
    privacy: props.privacyText,
  });
  const [published, setPublished] = useState(Boolean(props.publishedAt));
  // Ref pour `prepare` (lu dans l'événement submit), état pour les libellés des boutons.
  const intent = useRef<"save" | "publish">("save");
  const [clicked, setClicked] = useState<"save" | "publish">("save");
  const [justPublished, setJustPublished] = useState(false);
  const form = useFormAction(saveLegalDocuments, {
    prepare: (fd) => fd.set("intent", intent.current),
    onSuccess: () => {
      if (intent.current === "publish") {
        setPublished(true);
        setJustPublished(true);
      } else setJustPublished(false);
    },
  });

  // Mêmes valeurs que celles que le serveur enregistre (rognées) : un modèle non touché reste « le modèle ».
  const info: LegalInfo = {
    ...props.base,
    ...Object.fromEntries(Object.entries(identity).map(([k, v]) => [k, v.trim()])),
  };
  const missing = missingLegalFields(info);
  const shown = (kind: FreeDoc) => texts[kind] ?? templateFor(kind, info);

  const chooseLevel = (next: CancellationLevel) => {
    // Passer en « Personnalisé » part du texte du niveau affiché, à adapter.
    if (next === "custom" && !customCancellation.trim()) {
      setCustomCancellation(cancellationTemplate(level === "custom" ? "moderate" : level, info));
    }
    setLevel(next);
  };

  return (
    <form onSubmit={form.onSubmit} data-testid="legal-form">
      <div
        className="mb-5 px-4 py-3 rounded-[10px] text-[13px] leading-[1.55]"
        data-testid="legal-template-notice"
        style={{ background: "var(--admin-surface-2)", border: "1px solid var(--admin-border)", color: "var(--admin-text)" }}
      >
        <strong>Modèle fourni à titre indicatif, à vérifier et adapter.</strong>{" "}
        <span style={{ color: "var(--admin-text-muted)" }}>
          Ces textes sont préremplis avec les informations de votre établissement. Relisez-les, adaptez-les à votre
          activité et, en cas de doute, faites-les vérifier par un juriste. Cette mention n&apos;apparaît pas sur votre
          site.
        </span>
      </div>

      <div role="status">
        {published ? (
          <StatusBanner variant="success">
            <span data-testid="legal-status-published">
              {justPublished
                ? "Documents publiés : ils sont en ligne sur votre site et vos voyageurs les acceptent en payant."
                : `Documents publiés${props.publishedAt ? ` depuis le ${dateFr(props.publishedAt)}` : ""} : chaque enregistrement est mis en ligne aussitôt.`}
            </span>
          </StatusBanner>
        ) : (
          <StatusBanner variant="warning">
            <span data-testid="legal-status-draft">
              Vos documents ne sont pas encore publiés. Votre site affiche des pages minimales (nom, adresse,
              hébergeur) et vos voyageurs n&apos;acceptent aucune condition en payant.
            </span>
          </StatusBanner>
        )}
        {form.saved && !justPublished && <StatusBanner variant="success">Documents enregistrés.</StatusBanner>}
        {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}
      </div>

      {missing.length > 0 && (
        <StatusBanner variant="warning">
          <span data-testid="legal-missing">
            À compléter : {missing.join(", ")}. Ces informations apparaissent « {MISSING} » dans vos documents.
          </span>
        </StatusBanner>
      )}

      <SettingsSection
        title="Identité légale"
        desc="Reprise dans vos mentions légales, CGV et politique de confidentialité. Le nom, l'adresse, l'email et le téléphone viennent de l'onglet « Mon établissement »."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3.5">
          <Field label="Raison sociale" error={form.fieldError("legalName")} hint="Le nom officiel de votre entreprise, ou vos nom et prénom en entreprise individuelle.">
            <AdminInput
              name="legalName"
              value={identity.legalName}
              onChange={(e) => setIdentity({ ...identity, legalName: e.target.value })}
              maxLength={200}
              placeholder="ex : SARL Les Oliviers"
            />
          </Field>
          <Field label="Forme juridique" error={form.fieldError("legalForm")}>
            <AdminInput
              name="legalForm"
              value={identity.legalForm}
              onChange={(e) => setIdentity({ ...identity, legalForm: e.target.value })}
              maxLength={120}
              placeholder="ex : SARL au capital de 10 000 €, micro-entreprise"
            />
          </Field>
          <Field label="SIRET" error={form.fieldError("siret")} hint="14 chiffres.">
            <AdminInput
              name="siret"
              value={identity.siret}
              onChange={(e) => setIdentity({ ...identity, siret: e.target.value })}
              inputMode="numeric"
              maxLength={20}
              placeholder="ex : 123 456 789 00012"
            />
          </Field>
          <Field label="Directeur de la publication" error={form.fieldError("publicationDirector")} hint="La personne responsable du contenu du site.">
            <AdminInput
              name="publicationDirector"
              value={identity.publicationDirector}
              onChange={(e) => setIdentity({ ...identity, publicationDirector: e.target.value })}
              maxLength={200}
              placeholder="ex : Marie Durand"
            />
          </Field>
        </div>
        <Field
          label="Médiateur de la consommation"
          error={form.fieldError("mediator")}
          hint="Obligatoire : le médiateur auquel vous adhérez, avec son site ou son adresse. Votre fédération ou votre assureur peut vous en indiquer un."
        >
          <AdminInput
            name="mediator"
            value={identity.mediator}
            onChange={(e) => setIdentity({ ...identity, mediator: e.target.value })}
            maxLength={500}
            placeholder="ex : Médiation Tourisme et Voyage, www.mtv.travel"
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Conditions d'annulation"
        desc="Vos voyageurs les acceptent en payant. En cas de contestation auprès de leur banque, ce sont elles qui vous protègent."
      >
        <div role="radiogroup" aria-label="Niveau d'annulation" className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-4">
          {CANCELLATION_LEVELS.map((l) => {
            const selected = level === l;
            return (
              <label
                key={l}
                className="flex gap-2.5 items-start cursor-pointer"
                data-testid={`cancellation-level-${l}`}
                style={{
                  padding: 14,
                  borderRadius: 10,
                  border: `2px solid ${selected ? "var(--admin-primary)" : "var(--admin-border)"}`,
                  background: selected ? "var(--admin-primary-light)" : "var(--admin-surface)",
                  transition: "border-color 0.15s, background-color 0.15s",
                }}
              >
                <input
                  type="radio"
                  name="cancellationLevel"
                  value={l}
                  checked={selected}
                  onChange={() => chooseLevel(l)}
                  className="mt-0.5"
                  style={{ accentColor: "var(--admin-primary)" }}
                />
                <span>
                  <span className="block text-[13.5px] font-bold" style={{ color: "var(--admin-text)" }}>
                    {CANCELLATION_LEVEL_INFO[l].label}
                  </span>
                  <span className="block text-[12.5px] leading-[1.45] mt-0.5" style={{ color: "var(--admin-text-muted)" }}>
                    {CANCELLATION_LEVEL_INFO[l].summary}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {level === "custom" ? (
          <Field
            label="Vos conditions d'annulation"
            error={form.fieldError("cancellationText")}
            hint="Sans niveau standard, DirectLoc ne pourra pas vous suggérer de montant à rembourser : vous le déciderez vous-même."
          >
            <AdminTextarea
              name="cancellationText"
              value={customCancellation}
              onChange={(e) => setCustomCancellation(e.target.value)}
              rows={14}
              maxLength={30000}
            />
          </Field>
        ) : (
          <div>
            <p className="text-[12px] font-bold uppercase mb-1.5" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
              Texte publié
            </p>
            <div
              data-testid="cancellation-preview"
              // Zone qui défile : atteignable au clavier (axe scrollable-region-focusable).
              tabIndex={0}
              role="region"
              aria-label="Texte publié des conditions d'annulation"
              className="text-[13px] leading-[1.55] whitespace-pre-line overflow-y-auto px-3 py-2.5 rounded-lg"
              style={{ maxHeight: 280, background: "var(--admin-surface-2)", color: "var(--admin-text)" }}
            >
              {cancellationTemplate(level, info)}
            </div>
            <p className="text-[12px] mt-1.5" style={{ color: "var(--admin-text-subtle)" }}>
              Pour rédiger vos propres conditions, choisissez « Personnalisé ».
            </p>
          </div>
        )}
      </SettingsSection>

      {FREE_DOCS.map(({ kind, name, desc }) => (
        <SettingsSection
          key={kind}
          title={LEGAL_PAGES[kind].title}
          desc={desc}
          action={
            texts[kind] !== null ? (
              <button
                type="button"
                onClick={() => setTexts({ ...texts, [kind]: null })}
                className="text-[12.5px] font-semibold whitespace-nowrap underline underline-offset-2"
                style={{ color: "var(--admin-primary)", minHeight: 44, background: "none", border: "none", cursor: "pointer" }}
              >
                Revenir au modèle
              </button>
            ) : (
              <span
                className="text-[12px] font-semibold whitespace-nowrap px-2 py-1 rounded-md"
                style={{ background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }}
              >
                Modèle
              </span>
            )
          }
        >
          <Field
            label={`Texte — ${LEGAL_PAGES[kind].short}`}
            error={form.fieldError(name)}
            hint="Mise en forme : une ligne qui commence par « ## » devient un titre, une ligne qui commence par « - » un élément de liste. Pas de HTML."
          >
            <AdminTextarea
              name={name}
              value={shown(kind)}
              onChange={(e) => setTexts({ ...texts, [kind]: e.target.value })}
              rows={14}
              maxLength={30000}
            />
          </Field>
        </SettingsSection>
      ))}

      <SettingsSection title="Sur votre site" desc="Liées en pied de page de toutes vos pages, et sous le bouton de paiement une fois publiées.">
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {Object.values(LEGAL_PAGES).map((p) => (
            <li key={p.path}>
              <a
                href={p.path}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center min-h-[44px] text-[13px] font-semibold underline underline-offset-2"
                style={{ color: "var(--admin-primary)" }}
              >
                {p.title} <span className="sr-only">(nouvel onglet)</span>
                <span aria-hidden="true">&nbsp;↗</span>
              </a>
            </li>
          ))}
        </ul>
      </SettingsSection>

      <div className="flex flex-wrap justify-end gap-2.5 mt-4">
        <button
          type="submit"
          onClick={() => {
            intent.current = "save";
            setClicked("save");
          }}
          disabled={form.pending}
          style={{
            ...buttonBase,
            background: published ? "var(--admin-primary)" : "var(--admin-surface)",
            color: published ? "#fff" : "var(--admin-text)",
            border: published ? "none" : "1px solid var(--admin-border)",
            cursor: form.pending ? "wait" : "pointer",
            opacity: form.pending ? 0.7 : 1,
          }}
        >
          {form.pending && clicked === "save"
            ? "Enregistrement…"
            : published
              ? "Enregistrer et mettre en ligne"
              : "Enregistrer le brouillon"}
        </button>
        {!published && (
          <button
            type="submit"
            onClick={() => {
              intent.current = "publish";
              setClicked("publish");
            }}
            disabled={form.pending}
            style={{
              ...buttonBase,
              background: "var(--admin-primary)",
              color: "#fff",
              border: "none",
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              cursor: form.pending ? "wait" : "pointer",
              opacity: form.pending ? 0.7 : 1,
            }}
          >
            {form.pending && clicked === "publish" ? "Publication…" : "Publier mes documents"}
          </button>
        )}
      </div>
    </form>
  );
}
