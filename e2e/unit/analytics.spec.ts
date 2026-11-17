import { test, expect } from "@playwright/test";
import { amountBucket, partnerCode } from "../../lib/analytics";

// Spécification : Tests de non-régression > Mesure d'audience (PostHog)

test("amountBucket : bornes des tranches", () => {
  expect(amountBucket(0)).toBe("<200");
  expect(amountBucket(199.99)).toBe("<200");
  expect(amountBucket(200)).toBe("200-500");
  expect(amountBucket(500)).toBe("200-500");
  expect(amountBucket(500.01)).toBe(">500");
});

test("partnerCode : n'accepte que [A-Za-z0-9_-], 1 à 40 caractères", () => {
  expect(partnerCode("agence-42")).toBe("agence-42");
  expect(partnerCode("a".repeat(40))).toBe("a".repeat(40));
  expect(partnerCode("a".repeat(41))).toBeUndefined();
  expect(partnerCode("")).toBeUndefined();
  expect(partnerCode(null)).toBeUndefined();
  expect(partnerCode("<script>alert(1)</script>")).toBeUndefined();
  expect(partnerCode("a b")).toBeUndefined();
});
