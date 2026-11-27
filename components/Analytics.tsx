"use client";

import posthog from "posthog-js";
import { useEffect, useState } from "react";
import "./consent.css";

type Surface = "vitrine" | "tenant_site" | "admin";
type Consent = "pending" | "granted" | "denied";

/** Réponse au bandeau (Accepter ou Refuser), distincte du refus posé d'office avant choix. */
const CHOICE_KEY = "dl_consent_answered";
function hasChosen(): boolean {
  try {
    return localStorage.getItem(CHOICE_KEY) === "1";
  } catch {
    return false;
  }
}

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
            // Après refus : comptage anonyme sans cookie. Avant choix : idem, voir loaded.
            cookieless_mode: "on_reject",
            session_recording: { maskAllInputs: true, sampleRate: 0.5 },
          }),
      before_send: (event) => {
        if (event) Object.assign(event.properties, { surface, tenant_id: tenantId });
        return event;
      },
      loaded: (ph) => {
        if (userId) ph.identify(userId, { tenant_id: tenantId });
        if (admin) return;
        const status = ph.get_explicit_consent_status();
        // Sans choix, on_reject n'enverrait rien : le visiteur est compté comme après un refus
        // (sans cookie), mais le bandeau reste affiché tant qu'il n'a pas répondu. Le refus
        // posé ici n'est pas un choix : seul CHOICE_KEY dit que le visiteur a répondu.
        if (status === "granted" || (status === "denied" && hasChosen())) return setConsent(status);
        if (status === "pending") {
          ph.opt_out_capturing();
          ph.capture("$pageview"); // celle du chargement a été écartée avant la bascule
        }
        setConsent("pending");
      },
    });
  }, [apiKey, surface, tenantId, userId]);

  // Boutons marqués data-cta : compté après Accepter, sinon anonymement (sans cookie). Envoyé tout de suite par sendBeacon pour survivre au changement de page.
  useEffect(() => {
    if (!apiKey) return;
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest<HTMLElement>("[data-cta]");
      if (!el) return;
      posthog.capture(
        "cta_clicked",
        { cta: el.dataset.cta, placement: el.dataset.placement },
        { send_instantly: true, transport: "sendBeacon" },
      );
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [apiKey]);

  if (consent !== "pending") return null;

  const choose = (accept: boolean) => {
    if (accept) posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
    try {
      localStorage.setItem(CHOICE_KEY, "1");
    } catch {
      // stockage bloqué : le bandeau reviendra à la prochaine visite
    }
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
