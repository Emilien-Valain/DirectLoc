"use client";

import { useActionState } from "react";
import { requestCallback, type CallbackState } from "@/lib/actions/callback";

/** Coupon détachable « Être rappelé » : le seul appel à l'action du site. */
export function CallbackForm({ id, title }: { id: string; title: React.ReactNode }) {
  const [state, action, pending] = useActionState<CallbackState, FormData>(requestCallback, undefined);
  const err = state?.fieldErrors ?? {};

  return (
    // Le code partenaire (?ref=) est lu à l'envoi : la page reste statique.
    <form action={(fd) => { fd.set("ref", new URLSearchParams(location.search).get("ref") ?? ""); action(fd); }} className="alm-coupon" aria-labelledby={`${id}-t`} noValidate>
      <svg className="alm-scissors" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
        <path d="M8.1 8.1 20 20M8.1 15.9 20 4" />
      </svg>
      <h2 id={`${id}-t`}>{title}</h2>
      {state?.ok ? (
        <p className="alm-coupon-ok" role="status">
          C&apos;est noté. Un conseiller du bocage vous rappelle dans les jours qui viennent, en journée.
        </p>
      ) : (
        <>
          <label htmlFor={`${id}-name`}>Nom</label>
          <input id={`${id}-name`} name="name" autoComplete="name" required maxLength={100}
            aria-invalid={!!err.name} aria-describedby={err.name ? `${id}-name-e` : undefined} />
          {err.name && <span className="alm-err" id={`${id}-name-e`}>{err.name}</span>}

          <label htmlFor={`${id}-phone`}>Téléphone</label>
          <input id={`${id}-phone`} name="phone" type="tel" autoComplete="tel" required inputMode="tel"
            aria-invalid={!!err.phone} aria-describedby={err.phone ? `${id}-phone-e` : undefined} />
          {err.phone && <span className="alm-err" id={`${id}-phone-e`}>{err.phone}</span>}

          <label htmlFor={`${id}-place`}>Votre hébergement <span>(facultatif)</span></label>
          <input id={`${id}-place`} name="place" maxLength={120} placeholder="Gîte, 2 chambres d'hôtes… et la commune"
            aria-invalid={!!err.place} />
          {err.place && <span className="alm-err">{err.place}</span>}

          <input className="alm-hp" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
          {state?.error && !Object.keys(err).length && <p className="alm-err" role="alert">{state.error}</p>}
          <button type="submit" disabled={pending}>{pending ? "Envoi…" : "Être rappelé"}</button>
        </>
      )}
    </form>
  );
}
