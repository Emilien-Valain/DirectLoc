/**
 * Infos pratiques d'une chambre (étage, code d'accès, wifi… + infos libres de l'hôte),
 * utilisables comme variables dans les messages d'email : {etage}, {code_portail}…
 * Pur : partagé par le formulaire de la chambre, l'action serveur et l'envoi des emails.
 */

import { EMAIL_VARIABLES } from "@/lib/email-template";

export type RoomInfo = { key: string; label: string; value: string };

/** Infos proposées d'office (toujours affichées dans le formulaire, variables toujours connues). */
export const FIXED_ROOM_INFO = [
  { key: "etage", label: "Étage", placeholder: "ex : 2e étage, porte de gauche" },
  { key: "code_acces", label: "Code d'accès", placeholder: "ex : 4521B" },
  { key: "wifi", label: "Réseau Wi-Fi", placeholder: "ex : MasDesLilas" },
  { key: "wifi_mdp", label: "Mot de passe Wi-Fi", placeholder: "ex : soleil2027" },
] as const;

export const MAX_CUSTOM_INFO = 20;
export const INFO_LABEL_MAX = 40;
export const INFO_VALUE_MAX = 300;

/** Variables du message réservées par l'email lui-même ({client}, {chambre}…). */
const RESERVED = new Set<string>(EMAIL_VARIABLES.map(([name]) => name));

/** « Code du portail » → « code_du_portail » (accents retirés, 30 caractères max comme `fillTemplate`). */
export function infoKey(label: string): string {
  return label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30)
    .replace(/_+$/, "");
}

export type InfoErrors = Record<string, string>;

/**
 * Lit le formulaire : `info_<clé>` pour les infos fixes, `infoLabel` / `infoValue`
 * (répétés, dans l'ordre) pour les infos libres. Une info sans valeur n'est pas gardée.
 * Erreurs indexées par nom de champ (`infoLabel_2`…).
 */
export function readRoomInfo(formData: FormData): { info: RoomInfo[] } | { error: string; fieldErrors: InfoErrors } {
  const info: RoomInfo[] = [];
  const errors: InfoErrors = {};

  for (const f of FIXED_ROOM_INFO) {
    const value = formData.get(`info_${f.key}`)?.toString().trim() ?? "";
    if (value.length > INFO_VALUE_MAX) errors[`info_${f.key}`] = `${f.label} : ${INFO_VALUE_MAX} caractères max`;
    else if (value) info.push({ key: f.key, label: f.label, value });
  }

  const labels = formData.getAll("infoLabel").map((v) => v.toString().trim());
  const values = formData.getAll("infoValue").map((v) => v.toString().trim());
  const seen = new Set<string>(FIXED_ROOM_INFO.map((f) => f.key));
  let custom = 0;
  for (let i = 0; i < Math.max(labels.length, values.length); i++) {
    const label = labels[i] ?? "";
    const value = values[i] ?? "";
    if (!label && !value) continue;
    const key = infoKey(label);
    if (!label) errors[`infoLabel_${i}`] = "Donnez un nom à cette info (ex : Code du portail)";
    else if (label.length > INFO_LABEL_MAX) errors[`infoLabel_${i}`] = `Nom : ${INFO_LABEL_MAX} caractères max`;
    else if (!key) errors[`infoLabel_${i}`] = "Le nom doit contenir au moins une lettre ou un chiffre";
    else if (RESERVED.has(key)) errors[`infoLabel_${i}`] = `{${key}} est déjà une variable des emails : choisissez un autre nom`;
    else if (seen.has(key)) errors[`infoLabel_${i}`] = `Une autre info donne déjà la variable {${key}}`;
    if (value.length > INFO_VALUE_MAX) errors[`infoValue_${i}`] = `Valeur : ${INFO_VALUE_MAX} caractères max`;
    else if (!value && label) errors[`infoValue_${i}`] = "Indiquez la valeur, ou retirez cette info";
    if (errors[`infoLabel_${i}`] || errors[`infoValue_${i}`]) continue;
    seen.add(key);
    if (++custom > MAX_CUSTOM_INFO) {
      errors[`infoLabel_${i}`] = `${MAX_CUSTOM_INFO} infos personnalisées maximum`;
      continue;
    }
    info.push({ key, label, value });
  }

  const first = Object.values(errors)[0];
  return first ? { error: first, fieldErrors: errors } : { info };
}

/** Normalise ce qui est lu en base (jsonb) : ignore tout ce qui n'a pas la bonne forme. */
export function asRoomInfo(raw: unknown): RoomInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (x): x is RoomInfo =>
      !!x && typeof x === "object" && typeof x.key === "string" && typeof x.label === "string" && typeof x.value === "string",
  );
}

/**
 * Variables des infos pour un email : celles de la chambre réservée ; toute info connue
 * ailleurs (fixe ou définie sur une autre chambre) vaut "" plutôt que de rester « {wifi} ».
 */
export function roomInfoVariables(info: RoomInfo[], otherKeys: Iterable<string> = []): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const f of FIXED_ROOM_INFO) vars[f.key] = "";
  for (const k of otherKeys) vars[k] = "";
  for (const i of info) vars[i.key] = i.value;
  return vars;
}
