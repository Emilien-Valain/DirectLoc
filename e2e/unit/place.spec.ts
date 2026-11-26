import { test, expect } from "@playwright/test";
import { greeting, postcodeOf } from "../../lib/place";

// Spécification : Tests de non-régression > Templates publics > La Carte postale

test("greeting : la préposition suit l'article du lieu", () => {
  expect(greeting("Les Epesses")).toEqual(["Bons baisers des", "Epesses"]);
  expect(greeting("Le Puy-du-Fou")).toEqual(["Bons baisers du", "Puy-du-Fou"]);
  expect(greeting("La Roche-sur-Yon")).toEqual(["Bons baisers de", "La Roche-sur-Yon"]);
  expect(greeting("Angers")).toEqual(["Bons baisers d’", "Angers"]);
  expect(greeting("Écouflant")).toEqual(["Bons baisers d’", "Écouflant"]);
  expect(greeting("  Cholet ")).toEqual(["Bons baisers de", "Cholet"]);
  // « Le » seul ou collé à un mot n'est pas un article.
  expect(greeting("Lens")).toEqual(["Bons baisers de", "Lens"]);
});

test("postcodeOf : code postal à 5 chiffres, sinon null", () => {
  expect(postcodeOf("12 chemin de la Brosse, 85590 Les Epesses")).toBe("85590");
  expect(postcodeOf("2 rue de la bachellerie, Saint Laurent sur Sèvre")).toBeNull();
  expect(postcodeOf("BP 123456 Cholet")).toBeNull();
  expect(postcodeOf(undefined)).toBeNull();
  expect(postcodeOf("")).toBeNull();
});
