"use client";

import { useEffect, useRef } from "react";

/** Vitesse commune des bandeaux du Défilant, celle du bandeau de pied (px/s). */
const SPEED = 48;

/**
 * Bandeau défilant : deux copies du texte, décoratif (le vrai titre est ailleurs).
 * La durée de la boucle suit la largeur réelle d'une copie, pour que tous les
 * bandeaux avancent à la même vitesse quelle que soit la taille du texte ou de l'écran.
 */
export default function DefilantTicker({ text, className }: { text: string; className: string }) {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const fit = () => {
      const half = track.scrollWidth / 2;
      if (half > 0) track.style.animationDuration = `${half / SPEED}s`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(track);
    return () => ro.disconnect();
  }, [text]);

  // Chaque moitié doit dépasser la largeur d'écran, sinon un trou apparaît en boucle.
  const half = Array.from({ length: Math.max(1, Math.ceil(90 / text.length)) }, () => text).join(" ");
  return (
    <div className={`d-ticker ${className}`} aria-hidden="true">
      <div className="d-ticker-track" ref={trackRef}>
        <span>{half}&nbsp;</span>
        <span>{half}&nbsp;</span>
      </div>
    </div>
  );
}
