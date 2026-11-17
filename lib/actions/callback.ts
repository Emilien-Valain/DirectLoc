"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { sendCallbackRequest } from "@/lib/email";
import { checkRateLimit } from "@/lib/rate-limit";
import { safeParseFormData } from "@/lib/validation";
import { browserDistinctId, captureServer, partnerCode } from "@/lib/analytics";

export type CallbackState = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> } | undefined;

const callbackSchema = z.object({
  name: z.string().trim().min(2, "Indiquez votre nom").max(100, "Nom trop long (100 caractères maximum)"),
  // Numéros français ou internationaux : chiffres, espaces, points, tirets, + initial.
  phone: z
    .string()
    .trim()
    .regex(/^\+?[\d\s.\-()]{10,20}$/, "Numéro de téléphone invalide (ex. 06 12 34 56 78)"),
  place: z.string().trim().max(120, "120 caractères maximum").optional().default(""),
  website: z.string().max(0).optional(), // champ piège anti-robots, laissé vide par un humain
  ref: z.string().optional().transform(partnerCode), // code partenaire (?ref=), ignoré s'il est malformé
});

export async function requestCallback(_prev: CallbackState, formData: FormData): Promise<CallbackState> {
  const parsed = safeParseFormData(callbackSchema, formData);
  if (!("data" in parsed)) {
    if (parsed.fieldErrors.website) return { ok: true }; // robot : on ne dit rien
    return parsed;
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? "unknown";
  if (checkRateLimit({ name: "callback", limit: 5, windowSec: 3600 }, ip).limited) {
    return { error: "Trop de demandes depuis votre connexion. Réessayez dans une heure ou appelez-nous." };
  }

  try {
    await sendCallbackRequest(parsed.data);
  } catch (e) {
    console.error("[callback] envoi impossible", e);
    return { error: "La demande n'a pas pu partir. Réessayez dans un instant." };
  }
  captureServer("callback_requested", { surface: "vitrine", tenant_id: null, partner_code: parsed.data.ref }, await browserDistinctId());
  return { ok: true };
}
