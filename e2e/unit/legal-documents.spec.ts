import { test, expect } from "@playwright/test";
import {
  MISSING,
  PLATFORM_HOST_IDENTITY,
  CGV_ANNEX_HEADING,
  acceptedTerms,
  cancellationTemplate,
  cgvTemplate,
  cgvWithAnnex,
  documentText,
  legalNoticeTemplate,
  missingLegalFields,
  parseLegalText,
  paymentTerms,
  privacyTemplate,
  suggestedRefund,
  type LegalInfo,
  type LegalSettings,
} from "../../lib/legal-documents";

/**
 * Spécification : Tests de non-régression > Documents légaux > Modèles et suggestion de remboursement
 * Référence : .scratch/remboursements-litiges/issues/01-legal-documents.md
 */

const FULL: LegalInfo = {
  name: "Le Mas des Oliviers",
  legalName: "SARL Les Oliviers",
  legalForm: "SARL au capital de 10 000 €",
  siret: "12345678900012",
  publicationDirector: "Claire Martin",
  mediator: "Médiation Tourisme et Voyage, www.mtv.travel",
  address: "Chemin des Oliviers\n84220 Gordes",
  email: "bonjour@mas.fr",
  phone: "04 90 00 12 34",
  checkInTime: "16:00",
  checkOutTime: "11:00",
};

const settings = (o: Partial<LegalSettings> = {}): LegalSettings => ({
  ...FULL,
  cancellationLevel: "moderate",
  ...o,
});

test.describe("Documents légaux — modèles", () => {
  test("infos complètes : aucun « à compléter », variables reprises", () => {
    const all = [cancellationTemplate("moderate", FULL), cgvTemplate(FULL), legalNoticeTemplate(FULL), privacyTemplate(FULL)];
    for (const t of all) expect(t).not.toContain(MISSING);
    expect(missingLegalFields(FULL)).toEqual([]);

    const notice = legalNoticeTemplate(FULL);
    expect(notice).toContain("SARL Les Oliviers");
    expect(notice).toContain("SIRET : 123 456 789 00012");
    expect(notice).toContain("Directeur de la publication : Claire Martin");
    expect(notice).toContain(PLATFORM_HOST_IDENTITY);
    // Adresse sur plusieurs lignes → une seule ligne.
    expect(notice).toContain("Chemin des Oliviers, 84220 Gordes");

    const cgv = cgvTemplate(FULL);
    expect(cgv).toContain("L221-28 12°");
    expect(cgv).toContain("Médiation Tourisme et Voyage");
    expect(cgv).toContain("Stripe");
    expect(cgv).toContain("taxe de séjour");
    expect(cgv).toContain("à partir de 16:00");

    const privacy = privacyTemplate(FULL);
    for (const s of ["Stripe", "PostHog", "CNIL", "bonjour@mas.fr", "10 ans"]) expect(privacy).toContain(s);
    expect(privacy).toContain("n'ont accès au numéro de votre carte");
  });

  test("raison sociale = nom commercial : pas de doublon « Nom (Nom) »", () => {
    const t = cgvTemplate({ ...FULL, legalName: FULL.name });
    expect(t).not.toContain(`${FULL.name} (${FULL.name})`);
    expect(cgvTemplate(FULL)).toContain("Le Mas des Oliviers (SARL Les Oliviers)");
  });

  test("champs manquants : signalés et laissés visibles « [à compléter] »", () => {
    const bare: LegalInfo = { name: "Gîte nu" };
    expect(missingLegalFields(bare)).toEqual([
      "Raison sociale",
      "Forme juridique",
      "SIRET",
      "Adresse",
      "Email",
      "Téléphone",
      "Directeur de la publication",
      "Médiateur de la consommation",
    ]);
    expect(legalNoticeTemplate(bare)).toContain(`SIRET : ${MISSING}`);
    expect(cgvTemplate(bare)).toContain(`médiateur de la consommation dont relève l'établissement : ${MISSING}`);
    // Pas d'horaires renseignés : pas de phrase d'horaires inventée.
    expect(cgvTemplate(bare)).not.toContain("à partir de");
    // Espaces seuls = manquant.
    expect(missingLegalFields({ ...FULL, siret: "   " })).toEqual(["SIRET"]);
  });

  test("niveaux d'annulation : règles, non-présentation, départ anticipé, remboursement, taxe de séjour", () => {
    expect(cancellationTemplate("flexible", FULL)).toContain("jusqu'à la veille de la date d'arrivée");
    expect(cancellationTemplate("moderate", FULL)).toContain("jusqu'à 7 jours avant");
    expect(cancellationTemplate("moderate", FULL)).toContain("50 %");
    expect(cancellationTemplate("strict", FULL)).toContain("jusqu'à 30 jours avant");
    for (const level of ["flexible", "moderate", "strict"] as const) {
      const t = cancellationTemplate(level, FULL);
      for (const s of ["## Non-présentation", "## Départ anticipé", "moyen de paiement", "## Taxe de séjour"]) expect(t).toContain(s);
    }
  });

  test("texte de l'hôte prioritaire ; vide → modèle ; Personnalisé sans texte → modèle modéré", () => {
    expect(documentText("cgv", settings({ cgvText: "## Mes CGV\nTexte" }))).toBe("## Mes CGV\nTexte");
    expect(documentText("cgv", settings({ cgvText: "   " }))).toBe(cgvTemplate(FULL));
    expect(documentText("cancellation", settings({ cancellationLevel: "custom", cancellationText: "Rien n'est remboursé." }))).toBe(
      "Rien n'est remboursé.",
    );
    expect(documentText("cancellation", settings({ cancellationLevel: "custom", cancellationText: null }))).toBe(
      cancellationTemplate("moderate", FULL),
    );
    // Un texte personnalisé n'est pas pris en compte si un niveau standard est choisi.
    expect(documentText("cancellation", settings({ cancellationLevel: "strict", cancellationText: "ignoré" }))).toBe(
      cancellationTemplate("strict", FULL),
    );
  });

  test("CGV : les conditions d'annulation en vigueur sont toujours en annexe", () => {
    const s = settings({ cgvText: "## Mes CGV", cancellationLevel: "flexible" });
    const full = cgvWithAnnex(s);
    expect(full.startsWith("## Mes CGV")).toBe(true);
    expect(full).toContain(`## ${CGV_ANNEX_HEADING}`);
    expect(full).toContain(cancellationTemplate("flexible", FULL));
  });

  test("acceptation au paiement : rien si non publiés ; sinon texte exact + date", () => {
    expect(acceptedTerms(settings())).toBeNull();
    const at = new Date("2026-11-22T10:00:00Z");
    const s = settings({ legalPublishedAt: new Date("2026-11-01"), cancellationLevel: "strict" });
    expect(acceptedTerms(s, at)).toEqual({
      cancellationLevel: "strict",
      acceptedCancellationText: cancellationTemplate("strict", FULL),
      acceptedCgvText: cgvWithAnnex(s),
      termsAcceptedAt: at,
    });
    expect(paymentTerms(settings())).toBeNull();
    expect(paymentTerms(s)?.summary).toContain("30 jours");
    expect(paymentTerms(settings({ legalPublishedAt: new Date(), cancellationLevel: "custom" }))).toEqual({ summary: null });
  });
});

test.describe("Documents légaux — rendu en texte simple", () => {
  test("titres, listes, paragraphes ; lignes vides et retours Windows", () => {
    expect(parseLegalText("## Titre\r\nUn paragraphe\nsur deux lignes\r\n\r\n- un\n- deux\nAprès la liste\n\n\n### Sous-titre")).toEqual([
      { type: "heading", text: "Titre" },
      { type: "paragraph", text: "Un paragraphe\nsur deux lignes" },
      { type: "list", items: ["un", "deux"] },
      { type: "paragraph", text: "Après la liste" },
      { type: "heading", text: "Sous-titre" },
    ]);
    expect(parseLegalText("")).toEqual([]);
    expect(parseLegalText("   \n\n  ")).toEqual([]);
  });

  test("HTML : gardé tel quel comme texte (React l'échappe au rendu)", () => {
    expect(parseLegalText("<script>alert(1)</script>")).toEqual([{ type: "paragraph", text: "<script>alert(1)</script>" }]);
    expect(parseLegalText("## <img src=x onerror=alert(1)>")).toEqual([{ type: "heading", text: "<img src=x onerror=alert(1)>" }]);
  });

  test("« #titre » sans espace ou « -mot » restent du texte", () => {
    expect(parseLegalText("#hashtag\n-5 %")).toEqual([{ type: "paragraph", text: "#hashtag\n-5 %" }]);
  });
});

test.describe("suggestedRefund — bornes (date de Paris)", () => {
  const checkIn = new Date("2027-03-10T00:00:00.000Z");
  const at = (iso: string) => new Date(iso);
  const pct = (level: "flexible" | "moderate" | "strict", iso: string) => suggestedRefund(level, checkIn, at(iso), 20000)!.percent;

  test("flexible : J-1 → 100 %, le jour même → 0, après l'arrivée → 0", () => {
    expect(pct("flexible", "2027-02-01T12:00:00Z")).toBe(100);
    expect(pct("flexible", "2027-03-09T12:00:00Z")).toBe(100);
    // 23:30 UTC le 9 = 00:30 à Paris le 10 : déjà le jour de l'arrivée.
    expect(pct("flexible", "2027-03-09T23:30:00Z")).toBe(0);
    expect(pct("flexible", "2027-03-10T08:00:00Z")).toBe(0);
    expect(pct("flexible", "2027-03-12T08:00:00Z")).toBe(0);
    expect(suggestedRefund("flexible", checkIn, at("2027-03-10T08:00:00Z"), 20000)!.label).toBe(
      "0 % selon vos conditions (flexible, le jour de l'arrivée)",
    );
  });

  test("modérée : J-7 → 100 %, J-6 → 50 %, le jour même → 50 %, après l'arrivée → 0", () => {
    expect(pct("moderate", "2027-03-03T12:00:00Z")).toBe(100);
    // 23:30 UTC le 2 mars = 00:30 à Paris le 3 (UTC+1) : J-7.
    expect(pct("moderate", "2027-03-02T23:30:00Z")).toBe(100);
    expect(pct("moderate", "2027-03-04T00:30:00Z")).toBe(50);
    expect(pct("moderate", "2027-03-10T09:00:00Z")).toBe(50);
    expect(pct("moderate", "2027-03-11T09:00:00Z")).toBe(0);
    const s = suggestedRefund("moderate", checkIn, at("2027-03-05T09:00:00Z"), 20000)!;
    expect(s).toEqual({ amount: 10000, percent: 50, daysBefore: 5, label: "50 % selon vos conditions (modérée, moins de 7 jours)" });
    expect(suggestedRefund("moderate", checkIn, at("2027-01-01T09:00:00Z"), 20000)!.label).toBe(
      "100 % selon vos conditions (modérée, 7 jours ou plus avant l'arrivée)",
    );
    expect(suggestedRefund("moderate", checkIn, at("2027-03-15T09:00:00Z"), 20000)!.label).toBe(
      "0 % selon vos conditions (modérée, après l'arrivée)",
    );
  });

  test("stricte : J-30 → 50 %, J-29 → 0, longtemps avant → 50 %", () => {
    expect(pct("strict", "2027-02-08T12:00:00Z")).toBe(50);
    expect(pct("strict", "2027-02-09T12:00:00Z")).toBe(0);
    expect(pct("strict", "2026-06-01T12:00:00Z")).toBe(50);
    expect(pct("strict", "2027-03-10T12:00:00Z")).toBe(0);
  });

  test("personnalisé → null ; montant en centimes arrondi ; montant 0", () => {
    expect(suggestedRefund("custom", checkIn, at("2027-01-01T00:00:00Z"), 20000)).toBeNull();
    expect(suggestedRefund("moderate", checkIn, at("2027-03-05T00:00:00Z"), 10001)!.amount).toBe(5001);
    expect(suggestedRefund("moderate", checkIn, at("2027-03-05T00:00:00Z"), 0)!.amount).toBe(0);
  });

  test("passage à l'heure d'été (UTC+2) : 22:30 UTC = minuit et demi à Paris le lendemain", () => {
    const summer = new Date("2027-07-10T00:00:00.000Z");
    // 22:30 UTC le 2 juillet = 00:30 à Paris le 3 : J-7 → 100 %.
    expect(suggestedRefund("moderate", summer, at("2027-07-02T22:30:00Z"), 100)!.percent).toBe(100);
    expect(suggestedRefund("moderate", summer, at("2027-07-02T21:30:00Z"), 100)!.daysBefore).toBe(8);
  });
});
