import { test, expect } from "@playwright/test";
import { renderQuestionLine } from "@/lib/email";

// Les emails partent d'une adresse noreply : jamais « répondez à cet email », toujours le contact de l'hôte.
test.describe("Ligne « Une question ? » des emails", () => {
  test("email de l'hôte → lien mailto, pas d'invitation à répondre", () => {
    const html = renderQuestionLine({ email: "contact@hotel.fr", phone: "05 00 00 00 00" });
    expect(html).toContain('href="mailto:contact@hotel.fr"');
    expect(html).not.toMatch(/R&eacute;pondez|Répondez/);
  });

  test("sans email → téléphone", () => {
    expect(renderQuestionLine({ phone: "05 53 00 00 00" })).toContain("05 53 00 00 00");
  });

  test("aucun contact → rien", () => {
    expect(renderQuestionLine({})).toBe("");
    expect(renderQuestionLine(undefined)).toBe("");
  });

  test("XSS : email saisi par l'hôte échappé", () => {
    const html = renderQuestionLine({ email: '"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
