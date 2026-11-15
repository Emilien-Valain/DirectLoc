/**
 * Paysage de bocage en aplats (template « Affiche touristique »). Décoratif :
 * les couleurs viennent de la feuille du template, donc de l'hôte. Les autres
 * templates le masquent.
 */

/** PRNG déterministe : le dessin est identique à chaque rendu (pas de mismatch d'hydratation). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Haie : suite d'arcs de rayons irréguliers le long d'un segment, fermée par le bas. */
function hedge([x0, y0]: number[], [x1, y1]: number[], rMin: number, rMax: number, seed: number) {
  const rand = rng(seed);
  const len = Math.hypot(x1 - x0, y1 - y0);
  let d = `M${x0} ${y0}`;
  let t = 0;
  while (t < 1) {
    const r = rMin + rand() * (rMax - rMin);
    t = Math.min(1, t + (r * 1.5) / len);
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t + (rand() - 0.5) * r * 0.3;
    d += ` A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return `${d} L${x1} ${y1 + rMax} L${x0} ${y0 + rMax}Z`;
}

/** Peuplier : flamme effilée, côté soleil (droite) plus clair. */
function Poplar({ x, y, h }: { x: number; y: number; h: number }) {
  const w = h * 0.17;
  return (
    <g>
      <path className="a-tree" d={`M${x} ${y} C${x - w} ${y - h * 0.3} ${x - w * 0.7} ${y - h * 0.8} ${x} ${y - h} C${x + w * 0.7} ${y - h * 0.8} ${x + w} ${y - h * 0.3} ${x} ${y}Z`} />
      <path className="a-tree-lit" d={`M${x} ${y - h} C${x + w * 0.7} ${y - h * 0.8} ${x + w} ${y - h * 0.3} ${x + 1} ${y - 4} C${x + w * 0.3} ${y - h * 0.4} ${x + w * 0.3} ${y - h * 0.75} ${x} ${y - h}Z`} />
    </g>
  );
}

/** Chêne : grappe de boules sombres, rehauts clairs côté soleil, tronc court. */
function Oak({ x, y, s }: { x: number; y: number; s: number }) {
  const blobs = [[-22, -38, 22], [6, -50, 26], [28, -34, 20], [-4, -26, 20]];
  const lit = [[14, -56, 13], [32, -40, 11]];
  return (
    <g>
      <rect className="a-trunk" x={x - 3 * s} y={y - 22 * s} width={6 * s} height={22 * s} />
      {blobs.map(([dx, dy, r], i) => <circle key={i} className="a-tree" cx={x + dx * s} cy={y + dy * s} r={r * s} />)}
      {lit.map(([dx, dy, r], i) => <circle key={i} className="a-tree-lit" cx={x + dx * s} cy={y + dy * s} r={r * s} />)}
    </g>
  );
}

const TUFTS = [40, 170, 290, 470, 980, 1100];

export default function HeroArt() {
  return (
    <div className="s-hero-art" aria-hidden="true">
      <svg viewBox="0 60 1200 400" preserveAspectRatio="xMidYMax slice" role="presentation">
        <defs>
          <pattern id="a-furrows" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)">
            <rect width="14" height="5" className="a-furrow" />
          </pattern>
          <filter id="a-grain" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.9 0" />
          </filter>
          <clipPath id="a-land"><path d="M0 250 C 160 200 300 215 450 238 S 760 190 900 214 S 1110 236 1200 206 V460 H0Z" /></clipPath>
        </defs>

        {/* Soleil d'affiche : disque et halos concentriques. */}
        <circle className="a-halo" cx="930" cy="214" r="86" />
        <circle className="a-halo" cx="930" cy="214" r="72" />
        <circle className="a-sun" cx="930" cy="214" r="56" />
        <path className="a-bird" d="M486 142 q9 -9 18 0 q9 -9 18 0 M548 118 q7 -7 14 0 q7 -7 14 0 M430 168 q6 -6 12 0 q6 -6 12 0" />

        <path className="a-far" d="M0 250 C 160 200 300 215 450 238 S 760 190 900 214 S 1110 236 1200 206 V460 H0Z" />
        {/* Clocher du bourg, au loin. */}
        <path className="a-distant" d="M322 226 V204 L330 178 L338 204 V226Z M308 230 V214 H322 V230Z" />
        <path className="a-distant" d={hedge([0, 252], [300, 226], 5, 9, 1)} />
        <path className="a-distant" d={hedge([480, 236], [880, 216], 5, 9, 2)} />

        <path className="a-mid" d="M0 300 C 180 262 330 286 520 300 S 820 248 1010 276 S 1150 296 1200 288 V460 H0Z" />
        <path className="a-field" d="M90 296 L430 286 L520 316 L60 340Z" />
        <path fill="url(#a-furrows)" d="M90 296 L430 286 L520 316 L60 340Z" />
        <path className="a-field-lit" d="M700 272 L1010 270 L1060 300 L760 312Z" />

        <g className="a-hedge">
          <path d={hedge([0, 300], [430, 284], 10, 17, 3)} />
          <path d={hedge([430, 284], [560, 338], 9, 15, 4)} />
          <path d={hedge([680, 274], [1200, 280], 10, 16, 5)} />
        </g>
        <Poplar x={110} y={302} h={124} />
        <Poplar x={146} y={300} h={96} />
        <Poplar x={1086} y={284} h={136} />
        <Poplar x={1122} y={286} h={100} />
        <Oak x={560} y={334} s={0.8} />
        <Oak x={912} y={344} s={1.2} />

        <path className="a-near" d="M0 352 C 220 318 420 344 640 350 S 980 316 1200 334 V460 H0Z" />
        <path className="a-hedge" d={hedge([0, 364], [360, 346], 14, 22, 6)} />
        <Oak x={384} y={362} s={0.9} />

        {/* La longère, sa grange et son ombre portée (soleil à droite). */}
        <g className="a-house">
          <path className="a-shadow" d="M578 352 H876 L846 364 H552Z" />
          <rect className="a-chimney" x="692" y="238" width="14" height="26" />
          <rect className="a-chimney" x="816" y="238" width="14" height="26" />
          <path className="a-roof" d="M636 304 L676 256 H846 L884 304Z" />
          <path className="a-roof-lit" d="M846 256 L884 304 H864 L832 262Z" />
          <rect className="a-wall" x="650" y="300" width="220" height="52" />
          <path className="a-barn" d="M592 352 V320 H652 V352Z" />
          <path className="a-roof" d="M580 322 L606 298 H654 V322Z" />
          <rect className="a-door" x="748" y="316" width="22" height="36" />
          <rect className="a-door" x="606" y="330" width="30" height="22" />
          {[678, 806].map((x) => (
            <g key={x}>
              <rect className="a-window" x={x} y="314" width="20" height="20" />
              <rect className="a-shutter" x={x - 9} y="314" width="8" height="20" />
              <rect className="a-shutter" x={x + 21} y="314" width="8" height="20" />
            </g>
          ))}
        </g>
        <path className="a-path" d="M748 352 C 736 384 694 410 632 460 H728 C 756 420 774 388 772 352Z" />

        {/* Grain sur la terre seulement : ni le ciel ni le bandeau ne se décrochent des blocs voisins. */}
        <rect className="a-grain" x="0" y="60" width="1200" height="400" filter="url(#a-grain)" clipPath="url(#a-land)" />
        <path className="a-front" d="M0 404 C 260 380 520 410 760 400 S 1080 378 1200 392 V460 H0Z" />
        <g className="a-front">
          {TUFTS.map((x, i) => (
            <path key={x} d={`M${x} ${404 - (i % 2) * 4} l6 -22 l4 18 l6 -28 l5 26 l6 -16 l4 22Z`} />
          ))}
        </g>

      </svg>
    </div>
  );
}
