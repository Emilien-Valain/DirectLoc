import { test, expect } from "@playwright/test";
import { prodTrustedOrigins } from "../../lib/trusted-origins";

/**
 * Régression `.scratch/launch-readiness/issues/01` : en prod, Better Auth refusait
 * les POST avec cookie (signOut…) sur les domaines tenants. La liste des origines de
 * confiance = BETTER_AUTH_URL + `https://<domain>` de chaque tenant ayant un domaine.
 */

test.describe("Origines de confiance Better Auth (prod)", () => {
  const origins = prodTrustedOrigins(["hotelducoin.fr", null], "https://directloc.app/api/auth");

  test("BETTER_AUTH_URL est inclus (origine seule, sans chemin)", () => {
    expect(origins).toContain("https://directloc.app");
  });

  test("un domaine tenant est inclus, avec son www.", () => {
    expect(origins).toContain("https://hotelducoin.fr");
    expect(origins).toContain("https://www.hotelducoin.fr");
  });

  test("un domaine absent de la table est exclu", () => {
    expect(origins).not.toContain("https://pirate.example");
    expect(origins.some((o) => o.includes("pirate"))).toBe(false);
  });

  test("une ligne domain = null est ignorée", () => {
    expect(origins).toHaveLength(3);
    expect(origins.some((o) => o.includes("null") || o === "https://")).toBe(false);
    expect(prodTrustedOrigins([null, ""], "https://directloc.app")).toEqual(["https://directloc.app"]);
  });
});
