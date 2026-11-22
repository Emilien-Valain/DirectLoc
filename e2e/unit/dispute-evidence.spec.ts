import { test, expect } from "@playwright/test";
import {
  EVIDENCE_MAX,
  canRespond,
  cleanEvidence,
  defaultEvidence,
  disputeReasonFr,
  nextDisputeStatus,
} from "../../lib/dispute-evidence";
import { disputeBanner, disputeStripeUrl } from "../../lib/dispute-display";

/**
 * Litiges, logique pure (`lib/dispute-evidence.ts`, `lib/dispute-display.ts`) : ordre des statuts,
 * fenêtre de réponse, nettoyage des preuves, préremplissage, bandeaux.
 */

const day = 86_400_000;

test("un statut ne recule jamais : réponse → examen → clos ; deux clos se remplacent", () => {
  expect(nextDisputeStatus("needs_response", "under_review")).toBe("under_review");
  expect(nextDisputeStatus("under_review", "needs_response")).toBe("under_review");
  expect(nextDisputeStatus("lost", "needs_response")).toBe("lost");
  expect(nextDisputeStatus("won", "under_review")).toBe("won");
  expect(nextDisputeStatus("needs_response", "won")).toBe("won");
  expect(nextDisputeStatus("warning_needs_response", "needs_response")).toBe("needs_response");
});

test("répondre : seulement en attente de réponse, rien envoyé, avant la date limite", () => {
  const now = new Date("2036-05-10T12:00:00Z");
  const base = { status: "needs_response", submittedAt: null, evidenceDueBy: new Date(now.getTime() + day) };
  expect(canRespond(base, now)).toBe(true);
  expect(canRespond({ ...base, evidenceDueBy: null }, now)).toBe(true);
  expect(canRespond({ ...base, evidenceDueBy: new Date(now.getTime() - 1) }, now)).toBe(false);
  expect(canRespond({ ...base, evidenceDueBy: now }, now)).toBe(false);
  expect(canRespond({ ...base, submittedAt: now }, now)).toBe(false);
  expect(canRespond({ ...base, status: "under_review" }, now)).toBe(false);
  expect(canRespond({ ...base, status: "lost" }, now)).toBe(false);
  expect(canRespond({ ...base, status: "warning_needs_response" }, now)).toBe(true);
});

test("preuves : champs inconnus et non textuels ignorés, vides retirés, longueurs plafonnées", () => {
  const out = cleanEvidence({
    product_description: "x".repeat(EVIDENCE_MAX + 50),
    customer_name: "n".repeat(900),
    customer_signature: "file_123",
    receipt: "file_456",
    uncategorized_text: "   ",
    service_date: 42,
    access_activity_log: "ligne 1\r\nligne 2",
  });
  expect(Object.keys(out).sort()).toEqual(["access_activity_log", "customer_name", "product_description"]);
  expect(out.product_description).toHaveLength(EVIDENCE_MAX);
  expect(out.customer_name).toHaveLength(500);
  expect(out.access_activity_log).toBe("ligne 1\nligne 2");
});

test("préremplissage : séjour, chambres, voyageur, conditions acceptées, historique sans les remboursements échoués", () => {
  const e = defaultEvidence({
    hotelName: "Les Tilleuls",
    guestName: "Jeanne Martin",
    guestEmail: "jeanne@example.com",
    checkIn: new Date("2036-07-10T00:00:00Z"),
    checkOut: new Date("2036-07-13T00:00:00Z"),
    bookedAt: new Date("2036-05-02T08:30:00Z"),
    rooms: [
      { name: "Chambre Lilas", total: 300, cancelled: false },
      { name: "Chambre Rose", total: 150.5, cancelled: true },
    ],
    paidAmount: 450.5,
    paidAt: new Date("2036-05-02T08:31:00Z"),
    confirmed: true,
    termsAcceptedAt: new Date("2036-05-02T08:31:00Z"),
    cancellationText: "Annulation gratuite jusqu'à 7 jours avant l'arrivée.",
    cgvText: "CGV",
    refunds: [
      { amount: 150.5, at: new Date("2036-05-03T10:00:00Z"), status: "succeeded" },
      { amount: 20, at: new Date("2036-05-04T10:00:00Z"), status: "failed" },
    ],
  });
  expect(e.product_description).toContain("Séjour à Les Tilleuls du 10 juillet 2036 au 13 juillet 2036 (3 nuits)");
  expect(e.product_description).toContain("- Chambre Lilas : 300 €");
  expect(e.product_description).toContain("- Chambre Rose : 150,50 € (chambre annulée)");
  expect(e.customer_name).toBe("Jeanne Martin");
  expect(e.customer_email_address).toBe("jeanne@example.com");
  expect(e.service_date).toBe("10 juillet 2036 – 13 juillet 2036");
  expect(e.cancellation_policy_disclosure).toContain("acceptées par le voyageur au paiement le 2 mai 2036 à 10:31");
  expect(e.cancellation_policy_disclosure).toContain("Annulation gratuite jusqu'à 7 jours");
  expect(e.access_activity_log).toContain("Réservation faite en ligne le 2 mai 2036 à 10:30");
  expect(e.access_activity_log).toContain("Confirmation de réservation envoyée par email à jeanne@example.com");
  expect(e.access_activity_log).toContain("Remboursement de 150,50 € le 3 mai 2036.");
  expect(e.access_activity_log).not.toContain("20 €");
  expect(e.refund_refusal_explanation).toBeUndefined();
});

test("préremplissage sans conditions publiées ni paiement daté : pas de texte de conditions inventé", () => {
  const e = defaultEvidence({
    hotelName: "H",
    guestName: "A",
    guestEmail: "a@example.com",
    checkIn: new Date("2036-01-01T00:00:00Z"),
    checkOut: new Date("2036-01-02T00:00:00Z"),
    bookedAt: null,
    rooms: [{ name: "C", total: 0, cancelled: false }],
    paidAmount: 0,
    paidAt: null,
    confirmed: false,
    termsAcceptedAt: null,
    cancellationText: null,
    cgvText: null,
    refunds: [],
  });
  expect(e.cancellation_policy_disclosure).toBeUndefined();
  expect(e.refund_policy_disclosure).toBeUndefined();
  expect(e.access_activity_log).toBeUndefined();
  expect(e.product_description).toContain("(1 nuit)");
});

test("motifs traduits ; motif inconnu → « motif non précisé »", () => {
  expect(disputeReasonFr("fraudulent")).toMatch(/^fraude/);
  expect(disputeReasonFr("product_not_received")).toBe("séjour non fourni");
  expect(disputeReasonFr("<script>")).toBe("motif non précisé");
});

test("bandeaux : en cours (date JJ/MM), envoyé, date dépassée, perdu, gagné 30 jours puis disparu", () => {
  const now = new Date("2036-05-10T12:00:00Z");
  const b = (x: Parameters<typeof disputeBanner>[0]) => {
    const r = disputeBanner(x, now);
    return r && { ...r, text: r.text.replace(/[\u00a0\u202f]/g, " ") };
  };
  const d = { amount: "150.00", status: "needs_response", submittedAt: null, evidenceDueBy: new Date("2036-05-20T23:59:59Z"), closedAt: null };
  expect(b(d)).toEqual({ variant: "error", text: "Litige en cours : 150 €, réponse avant le 21/05.", open: true });
  expect(b({ ...d, status: "under_review", submittedAt: new Date("2036-05-11T10:00:00Z") })?.text).toBe(
    "Litige en cours : 150 €, réponse envoyée le 11/05 ; la banque décide.",
  );
  expect(b({ ...d, evidenceDueBy: new Date("2036-05-09T10:00:00Z") })?.text).toBe(
    "Litige en cours : 150 €, date limite de réponse dépassée (09/05).",
  );
  expect(b({ ...d, status: "lost", closedAt: new Date("2035-01-01") })).toEqual({
    variant: "error",
    text: "Litige perdu : 150 € repris par la banque.",
    open: false,
  });
  expect(b({ ...d, status: "won", closedAt: new Date(now.getTime() - 29 * day) })?.text).toBe("Litige gagné : 150 € vous restent acquis.");
  expect(b({ ...d, status: "won", closedAt: new Date(now.getTime() - 31 * day) })).toBeNull();
});

test("lien Stripe : litige du compte de l'hôte ; démo en mode test ; id encodé", () => {
  expect(disputeStripeUrl("dp_123", false)).toBe("https://dashboard.stripe.com/disputes/dp_123");
  expect(disputeStripeUrl("dp_123", true)).toBe("https://dashboard.stripe.com/test/disputes/dp_123");
  expect(disputeStripeUrl("dp/../x", false)).toBe("https://dashboard.stripe.com/disputes/dp%2F..%2Fx");
});
