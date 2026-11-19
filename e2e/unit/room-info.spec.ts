import { test, expect } from "@playwright/test";
import { asRoomInfo, infoKey, readRoomInfo, roomInfoVariables, MAX_CUSTOM_INFO } from "../../lib/room-info";
import { emailVariables, fillTemplate } from "../../lib/email-template";

/** Spécification : Tests de non-régression > Chambres — infos pratiques et variables d'email. */

const form = (fields: Record<string, string>, custom: [string, string][] = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  for (const [l, v] of custom) {
    fd.append("infoLabel", l);
    fd.append("infoValue", v);
  }
  return fd;
};

test.describe("Infos pratiques — variable d'une info", () => {
  test("nom → variable : accents, espaces, ponctuation, 30 caractères max", () => {
    expect(infoKey("Code du portail")).toBe("code_du_portail");
    expect(infoKey("  Clé : boîte à clés ! ")).toBe("cle_boite_a_cles");
    expect(infoKey("Parking n°2")).toBe("parking_n_2");
    expect(infoKey("a".repeat(40))).toHaveLength(30);
    expect(infoKey("Très long nom d'info qui dépasse")).not.toMatch(/_$/);
    expect(infoKey("!!!")).toBe("");
  });
});

test.describe("Infos pratiques — lecture du formulaire", () => {
  test("infos fixes et libres gardées dans l'ordre ; vides ignorées ; espaces retirés", () => {
    const r = readRoomInfo(
      form({ info_etage: " 2e étage ", info_code_acces: "", info_wifi: "Mas" }, [["Code du portail", " 1984 "], ["", ""]]),
    );
    expect(r).toEqual({
      info: [
        { key: "etage", label: "Étage", value: "2e étage" },
        { key: "wifi", label: "Réseau Wi-Fi", value: "Mas" },
        { key: "code_du_portail", label: "Code du portail", value: "1984" },
      ],
    });
  });

  test("erreurs par ligne : nom manquant, valeur manquante, variable réservée ou en double", () => {
    const err = (custom: [string, string][]) => {
      const r = readRoomInfo(form({}, custom));
      return "fieldErrors" in r ? r.fieldErrors : {};
    };
    expect(err([["", "1984"]])).toEqual({ infoLabel_0: "Donnez un nom à cette info (ex : Code du portail)" });
    expect(err([["Portail", ""]])).toEqual({ infoValue_0: "Indiquez la valeur, ou retirez cette info" });
    expect(err([["Client", "x"]]).infoLabel_0).toContain("{client} est déjà une variable");
    expect(err([["Prénom", "x"]]).infoLabel_0).toContain("{prenom} est déjà une variable");
    expect(err([["Étage", "x"]]).infoLabel_0).toBe("Une autre info donne déjà la variable {etage}");
    expect(err([["Portail", "1"], ["portail", "2"]]).infoLabel_1).toBe("Une autre info donne déjà la variable {portail}");
    expect(err([["???", "x"]]).infoLabel_0).toBe("Le nom doit contenir au moins une lettre ou un chiffre");
  });

  test("limites : nom 40, valeur 300, 20 infos libres", () => {
    expect("info" in readRoomInfo(form({ info_etage: "a".repeat(300) }, [["a".repeat(40), "b".repeat(300)]]))).toBe(true);
    const long = readRoomInfo(form({ info_etage: "a".repeat(301) }, [["a".repeat(41), "b".repeat(301)]]));
    expect("fieldErrors" in long && long.fieldErrors).toEqual({
      info_etage: "Étage : 300 caractères max",
      infoLabel_0: "Nom : 40 caractères max",
      infoValue_0: "Valeur : 300 caractères max",
    });
    const many = Array.from({ length: MAX_CUSTOM_INFO + 1 }, (_, i) => [`Info ${i}`, "x"] as [string, string]);
    const r = readRoomInfo(form({}, many));
    expect("fieldErrors" in r && r.fieldErrors[`infoLabel_${MAX_CUSTOM_INFO}`]).toBe("20 infos personnalisées maximum");
  });

  test("jsonb mal formé en base → ignoré", () => {
    expect(asRoomInfo(null)).toEqual([]);
    expect(asRoomInfo({ etage: "2" })).toEqual([]);
    expect(asRoomInfo([{ key: "etage", label: "Étage", value: "2" }, { key: 1 }, "x"])).toEqual([
      { key: "etage", label: "Étage", value: "2" },
    ]);
  });
});

test.describe("Infos pratiques — dans les emails", () => {
  const base = { guestName: "Marie Curie", roomName: "Lavande", checkIn: new Date("2027-07-01"), checkOut: new Date("2027-07-03"), nights: 2, hotelName: "Le Mas" };

  test("variables remplacées ; info d'une autre chambre ou fixe non remplie → vide, pas « {wifi} »", () => {
    const roomInfo = roomInfoVariables([{ key: "etage", label: "Étage", value: "2e" }, { key: "portail", label: "Portail", value: "1984" }], ["parking"]);
    const vars = emailVariables({ ...base, roomInfo });
    expect(fillTemplate("{Étage}/{portail}/[{wifi}]/[{parking}]/{inconnue}", vars)).toBe("2e/1984/[]/[]/{inconnue}");
  });

  test("une info ne peut pas écraser une variable de l'email", () => {
    const vars = emailVariables({ ...base, roomInfo: { client: "piratage", chambre: "x" } });
    expect(fillTemplate("{client} {chambre}", vars)).toBe("Marie Curie Lavande");
  });
});
