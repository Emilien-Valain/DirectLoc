"use client";

import { useState } from "react";

const RATE = 0.17; // commission moyenne toutes plateformes (étude Toploc 2026 : 17,2 %)
const SUB_MIN = 39 * 12;
const SUB_MAX = 69 * 12;
const eur = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} €`;

/** Barème : le visiteur saisit son CA annuel via les plateformes, la commission se calcule en direct. */
export function Bareme() {
  const [raw, setRaw] = useState("20000");
  const ca = Math.min(Math.max(Number(raw.replace(/\s/g, "")) || 0, 0), 2_000_000);
  const commission = ca * RATE;
  const half = commission / 2;

  return (
    <div className="alm-bareme">
      <label htmlFor="alm-ca">Votre chiffre d&apos;affaires annuel via Booking, Airbnb…</label>
      <div className="alm-ca">
        <input id="alm-ca" inputMode="numeric" value={raw} maxLength={9}
          onChange={(e) => setRaw(e.target.value.replace(/[^\d\s]/g, ""))} />
        <span>€ / an</span>
      </div>
      <table>
        <tbody>
          <tr><th scope="row">Commissions versées aux plateformes (17 %)</th><td>{eur(commission)}</td></tr>
          <tr><th scope="row">Si la moitié de ces séjours passe en direct</th><td className="alm-good">{eur(half)} gardés</td></tr>
          <tr><th scope="row">Abonnement DirectLoc (Solo ou Petit)</th><td>{eur(SUB_MIN)} à {eur(SUB_MAX)}</td></tr>
        </tbody>
      </table>
      <p className="alm-note" aria-live="polite">
        {half > SUB_MAX
          ? `À ce rythme, l'abonnement est couvert ${Math.floor(half / SUB_MAX)} fois.`
          : half > 0
            ? "Pour vous, l'abonnement se rembourse surtout par les séjours qui passent en direct."
            : "Saisissez un montant pour voir le calcul."}
      </p>
    </div>
  );
}
