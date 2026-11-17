import { cookies } from "next/headers";
import { after } from "next/server";

// Événements serveur PostHog (plan_action_directloc.md §9). Sans POSTHOG_KEY, rien n'est envoyé.

/** Montants en tranches : jamais le prix exact chez PostHog. */
export function amountBucket(amount: number): "<200" | "200-500" | ">500" {
  return amount < 200 ? "<200" : amount <= 500 ? "200-500" : ">500";
}

/** Code partenaire de `?ref=` : lettres, chiffres, - et _ ; sinon ignoré. */
export function partnerCode(raw: string | null | undefined): string | undefined {
  return raw && /^[\w-]{1,40}$/.test(raw) ? raw : undefined;
}

/** distinct_id du navigateur, présent seulement si le visiteur a accepté les cookies. */
export async function browserDistinctId(): Promise<string | undefined> {
  const key = process.env.POSTHOG_KEY;
  if (!key) return undefined;
  const raw = (await cookies()).get(`ph_${key}_posthog`)?.value;
  if (!raw) return undefined;
  try {
    const id = JSON.parse(decodeURIComponent(raw)).distinct_id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Envoie l'événement après la réponse (ne ralentit ni ne casse jamais l'action).
 * Sans distinct_id (refus des cookies, webhook, cron) : événement anonyme sans profil.
 */
export function captureServer(event: string, properties: Record<string, unknown>, distinctId?: string) {
  const key = process.env.POSTHOG_KEY;
  if (!key) return;
  const body = JSON.stringify({
    api_key: key,
    event,
    distinct_id: distinctId ?? crypto.randomUUID(),
    properties: distinctId ? properties : { ...properties, $process_person_profile: false },
  });
  after(async () => {
    try {
      // POSTHOG_HOST : faux PostHog local dans les tests (playwright.analytics.config.ts).
      const res = await fetch(`${process.env.POSTHOG_HOST ?? "https://eu.i.posthog.com"}/i/v0/e/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.error(`[posthog] ${event} refusé : HTTP ${res.status}`);
    } catch (e) {
      console.error(`[posthog] ${event} non envoyé`, e);
    }
  });
}
