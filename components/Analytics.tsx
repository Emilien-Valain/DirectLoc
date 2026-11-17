"use client";

import posthog from "posthog-js";
import { useEffect, useState } from "react";
import "./consent.css";

type Surface = "vitrine" | "tenant_site" | "admin";
type Consent = "pending" | "granted" | "denied";

/**
 * PostHog + bandeau de consentement (décisions : plan_action_directloc.md §9).
 * Sans clé (tests, dev sans .env), rien n'est chargé ni affiché.
 * Le bandeau hérite des jetons du thème parent (.site / .alm) via consent.css.
 */
export default function Analytics({
  apiKey,
  surface,
  tenantId,
  userId,
}: {
  apiKey: string | undefined;
  surface: Surface;
  tenantId: string | null;
  userId?: string;
}) {
  const [consent, setConsent] = useState<Consent | null>(null);

  useEffect(() => {
    if (!apiKey) return;
    const admin = surface === "admin";
    posthog.init(apiKey, {
      api_host: "https://eu.i.posthog.com",
      defaults: "2026-08-30", // pageviews sur changement d'URL (navigation client comprise)
      // Admin : hébergeurs identifiés sans cookie (mémoire seule), donc sans bandeau ; pas de replay.
      ...(admin
        ? { persistence: "memory", disable_session_recording: true }
        : {
            // Avant choix et après refus : comptage anonyme sans cookie.
            cookieless_mode: "on_reject",
            session_recording: { maskAllInputs: true, sampleRate: 0.5 },
          }),
      before_send: (event) => {
        if (event) Object.assign(event.properties, { surface, tenant_id: tenantId });
        return event;
      },
      loaded: (ph) => {
        if (userId) ph.identify(userId, { tenant_id: tenantId });
        if (!admin) setConsent(ph.get_explicit_consent_status());
      },
    });
  }, [apiKey, surface, tenantId, userId]);

  if (consent !== "pending") return null;

  const choose = (accept: boolean) => {
    if (accept) posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
    setConsent(accept ? "granted" : "denied");
  };

  return (
    <section className="consent" role="region" aria-label="Mesure d'audience" data-testid="consent-banner">
      <p className="consent-text">
        <strong>Mesure d&apos;audience.</strong> Avec votre accord, ce site dépose des cookies pour comprendre
        comment il est utilisé. Si vous refusez, les visites sont comptées de façon anonyme, sans cookie.{" "}
        <a href="/confidentialite">En savoir plus</a>
      </p>
      <div className="consent-actions">
        <button type="button" className="consent-btn" onClick={() => choose(false)}>
          Refuser
        </button>
        <button type="button" className="consent-btn" onClick={() => choose(true)}>
          Accepter
        </button>
      </div>
    </section>
  );
}
