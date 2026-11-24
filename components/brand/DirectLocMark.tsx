"use client";

import { useSyncExternalStore } from "react";

// Symbole DirectLoc : la maison-almanach. Le jour réservé (rouge) change de
// case à chaque chargement de page. Version statique : public/brand/directloc-mark.svg.

const BLUE = "#23408e";
const GOLD = "#d9b443";
const RED = "#c41f27";

const XS = [37.3, 45.7, 54, 62.3];
const YS = [56.3, 63.5, 70.6, 77.7];
// Le mois commence en milieu de semaine : 3 jours sur la 1re ligne, puis 3 semaines pleines.
const DAYS: [number, number][] = [
  [1, 0], [2, 0], [3, 0],
  ...[1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c): [number, number] => [c, r])),
];

// Tiré une fois par chargement de page, et seulement côté client : le HTML
// serveur affiche la dernière case, puis l'hydratation déplace le jour rouge.
const LAST_DAY = DAYS.length - 1;
let pageDay: number | null = null;
const subscribe = () => () => {};
const getDay = () => (pageDay ??= Math.floor(Math.random() * DAYS.length));
const getServerDay = () => LAST_DAY;

const ROOF = "M12.5 45 L42.5 18.5 Q50 12 57.5 18.5 L87.5 45";
const RINGS = [40.3, 59.3].map((x) => `M${(x - 3.6).toFixed(1)} 41 A3.6 3.6 0 1 1 ${(x + 1.1).toFixed(1)} 44.6`);

const BODY = "M21.5 92 a1.5 1.5 0 0 1 -1.5 -1.5 V44 L50 19 L80 44 V90.5 a1.5 1.5 0 0 1 -1.5 1.5 Z";

/** `onDark` : liseré blanc autour de la maison, pour les fonds bleus ou sombres. */
export function DirectLocMark({
  size = 40,
  day,
  onDark = false,
  decorative = false,
  className,
}: {
  size?: number;
  day?: number;
  onDark?: boolean;
  /** À côté du nom écrit en toutes lettres : masqué aux lecteurs d'écran. */
  decorative?: boolean;
  className?: string;
}) {
  const randomDay = useSyncExternalStore(subscribe, getDay, getServerDay);
  const booked = day ?? randomDay;
  return (
    <svg viewBox={onDark ? "-1 1 102 98" : "2 4 96 92"} width={size} height={onDark ? (size * 98) / 102 : (size * 92) / 96} className={className} {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "DirectLoc" })}>
      {onDark && (
        <g fill="none" stroke="#fff" strokeLinejoin="round">
          <path d={BODY} strokeWidth={6} />
          <path d={ROOF} strokeWidth={17} strokeLinecap="square" />
        </g>
      )}
      <path d={BODY} fill={BLUE} />
      <path d={ROOF} fill="none" stroke={BLUE} strokeWidth={11} strokeLinejoin="round" strokeLinecap="square" />
      <path d="M9.8 47.4 L42.5 18.5 Q50 12 57.5 18.5 L90.2 47.4" fill="none" stroke={GOLD} strokeWidth={6.6} strokeLinejoin="round" />
      <rect x={30.5} y={43} width={39} height={41} rx={1.5} fill="#fff" />
      {RINGS.map((d) => (
        <g key={d}>
          <path d={d} fill="none" stroke={BLUE} strokeWidth={3.6} strokeLinecap="round" />
          <path d={d} fill="none" stroke={GOLD} strokeWidth={1.9} strokeLinecap="round" />
        </g>
      ))}
      {DAYS.map(([c, r], i) => (
        <rect key={i} x={XS[c] - 1.4} y={YS[r] - 1.4} width={2.8} height={2.8} rx={0.5} fill={i === booked ? RED : BLUE} />
      ))}
    </svg>
  );
}
