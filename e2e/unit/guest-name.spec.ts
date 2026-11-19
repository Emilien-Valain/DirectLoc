import { test, expect } from "@playwright/test";
import { fullName, splitName } from "../../lib/guest-name";
import { COUNTRIES, countryName, isCountryCode } from "../../lib/countries";

test.describe("Nom du client — prénom et nom séparés", () => {
  test("nom affiché = prénom + nom ; prénom facultatif ; espaces nettoyés", () => {
    expect(fullName("Marie", "Dupont")).toBe("Marie Dupont");
    expect(fullName("", "Dupont")).toBe("Dupont");
    expect(fullName("  Jean-Pierre ", " de La Tour ")).toBe("Jean-Pierre de La Tour");
    expect(fullName(null, undefined)).toBe("");
  });

  test("découpage d'un nom existant : premier mot = prénom, un seul mot = nom", () => {
    expect(splitName("Marie Dupont")).toEqual({ first: "Marie", last: "Dupont" });
    expect(splitName("Jean-Pierre de La Tour")).toEqual({ first: "Jean-Pierre", last: "de La Tour" });
    expect(splitName("  Dupont  ")).toEqual({ first: "", last: "Dupont" });
    expect(splitName("")).toEqual({ first: "", last: "" });
  });

  test("aller-retour : découper puis recomposer redonne le nom", () => {
    for (const n of ["Marie Dupont", "Famille Moreau Lefèvre", "Dupont"]) {
      const { first, last } = splitName(n);
      expect(fullName(first, last)).toBe(n);
    }
  });
});

test.describe("Pays de résidence", () => {
  test("France en tête, puis ordre alphabétique, codes uniques", () => {
    expect(COUNTRIES[0]).toEqual(["FR", "France"]);
    const rest = COUNTRIES.slice(1).map(([, n]) => n);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "fr")));
    expect(new Set(COUNTRIES.map(([c]) => c)).size).toBe(COUNTRIES.length);
  });

  test("code connu → nom ; inconnu ou vide refusé / rendu tel quel", () => {
    expect(countryName("DE")).toBe("Allemagne");
    expect(isCountryCode("BE")).toBe(true);
    expect(isCountryCode("ZZ")).toBe(false);
    expect(isCountryCode("fr")).toBe(false);
    expect(countryName("ZZ")).toBe("ZZ");
    expect(countryName(null)).toBe("");
  });
});
