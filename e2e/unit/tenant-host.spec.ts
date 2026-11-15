import { test, expect } from "@playwright/test";
import { apexHost } from "../../lib/tenant-host";

/**
 * Régression `.scratch/launch-readiness/issues/04` : en prod, `proxy.ts`
 * cherche le tenant par `apexHost(host)` — `www.<domaine>` doit résoudre le
 * même tenant que `<domaine>` au lieu d'un 404.
 */
test.describe("Résolution tenant — host www.", () => {
  test("www.<domaine> → <domaine>", () => {
    expect(apexHost("www.hotelducoin.fr")).toBe("hotelducoin.fr");
    expect(apexHost("WWW.HotelDuCoin.fr")).toBe("hotelducoin.fr");
  });

  test("domaine apex inchangé", () => {
    expect(apexHost("hotelducoin.fr")).toBe("hotelducoin.fr");
  });

  test("seul un préfixe www. en tête est retiré", () => {
    expect(apexHost("www2.hotelducoin.fr")).toBe("www2.hotelducoin.fr");
    expect(apexHost("wwwhotel.fr")).toBe("wwwhotel.fr");
    expect(apexHost("shop.www.hotel.fr")).toBe("shop.www.hotel.fr");
    expect(apexHost("www.")).toBe("");
  });
});
