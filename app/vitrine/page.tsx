import Link from "next/link";
import { CallbackForm } from "./CallbackForm";
import { Bareme } from "./Bareme";

// ── Feuille du mois de démonstration (gîte fictif) ───────────────────────────

const YEAR = 2027;
const MONTH = 6; // juillet
const SAINTS = [
  "s. Thierry", "s. Martinien", "s. Thomas", "s. Florent", "s. Antoine", "ste Mariette", "s. Raoul",
  "s. Thibaut", "ste Amandine", "s. Ulrich", "s. Benoît", "s. Olivier", "s. Henri", "Fête nationale",
  "s. Donald", "N.-D. du Carmel", "ste Charlotte", "s. Frédéric", "s. Arsène", "ste Marina", "s. Victor",
  "ste Marie-Madeleine", "ste Brigitte", "ste Christine", "s. Jacques", "ste Anne", "ste Nathalie", "s. Samson",
  "ste Marthe", "ste Juliette", "s. Ignace",
];
const HOLIDAYS = new Set([14]);

type Stay = { from: number; to: number; label: string; direct: boolean };
// `to` = jour de départ : la barre s'arrête ce jour-là.
const STAYS: Stay[] = [
  { from: 1, to: 4, label: "Direct · Famille Morel · 666 € · 0 € de commission", direct: true },
  { from: 5, to: 9, label: "Booking (iCal) · bloqué", direct: false },
  { from: 10, to: 17, label: "Direct · Famille Guérin · 1 380 € · 0 €", direct: true },
  { from: 18, to: 21, label: "Airbnb (iCal) · bloqué", direct: false },
  { from: 23, to: 30, label: "Direct · M. et Mme Rabiller · 0 €", direct: true },
];

const WEEKDAYS = ["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."];

function weeks(): (number | null)[][] {
  const first = (new Date(Date.UTC(YEAR, MONTH, 1)).getUTCDay() + 6) % 7; // lundi = 0
  const days = new Date(Date.UTC(YEAR, MONTH + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

function MonthLeaf() {
  return (
    <figure className="alm-leaf" aria-labelledby="alm-leaf-cap">
      <div className="alm-leaf-head">
        <span className="alm-month">Juillet</span>
      </div>
      <div className="alm-weekdays" aria-hidden="true">{WEEKDAYS.map((d) => <span key={d}>{d}</span>)}</div>
      {weeks().map((week, w) => {
        const days = week.filter((d): d is number => d !== null);
        const lo = days[0];
        const hi = days[days.length - 1];
        return (
          <div className="alm-week" key={w} style={{ "--i": w } as React.CSSProperties}>
            {week.map((d, i) => (
              <div key={i} className={`alm-day${i === 6 || (d && HOLIDAYS.has(d)) ? " alm-red" : ""}${d ? "" : " alm-empty"}`}
                style={{ gridColumn: i + 1 }}>
                {d && <><b>{d}</b><span>{SAINTS[d - 1]}</span></>}
              </div>
            ))}
            {STAYS.filter((s) => s.from <= hi && s.to >= lo).map((s) => {
              const start = Math.max(s.from, lo);
              const end = Math.min(s.to, hi);
              const col = week.indexOf(start) + 1;
              return (
                <span key={s.from} className={`alm-stay ${s.direct ? "alm-direct" : "alm-ical"}`}
                  style={{ gridColumn: `${col} / ${week.indexOf(end) + 2}` }}>
                  {start === s.from ? s.label : "suite"}
                </span>
              );
            })}
          </div>
        );
      })}
      <figcaption id="alm-leaf-cap">Gîte de la Vergnaie : calendrier de démonstration, établissement et voyageurs fictifs.</figcaption>
      <p className="alm-stamp" aria-hidden="true">Gardé : 113 € par séjour<small>666 € × 17 % de commission évitée</small></p>
    </figure>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const FAQ: { q: string; a: string }[] = [
  {
    q: "Je n'ai pas le temps de m'occuper d'un site en plus.",
    a: "On le met en place avec vous : textes, photos, chambres, tarifs, calendriers. Ensuite le site prend les réservations tout seul et vous les retrouvez dans un tableau de bord simple. Un conseiller du coin reste joignable.",
  },
  {
    q: "Booking m'apporte de la visibilité, je ne veux pas le quitter.",
    a: "Vous n'avez rien à quitter. Gardez Booking et Airbnb pour être vu ; votre site capte les voyageurs qui vous connaissent déjà : bouche-à-oreille, habitués, réseaux sociaux, recherche de votre nom. Les calendriers sont synchronisés, donc pas de double réservation.",
  },
  {
    q: "C'est plus cher qu'elloha ou Amenitiz.",
    a: "Le prix comprend l'installation par quelqu'un du bocage, un site à votre nom de domaine et le réseau des hébergeurs voisins. Si vous préférez ne pas payer chaque mois, la licence s'achète une fois.",
  },
  {
    q: "Est-ce un channel manager ?",
    a: "Non. DirectLoc synchronise vos calendriers Airbnb et Booking par iCal : les dates prises d'un côté sont bloquées de l'autre. Les tarifs ne sont pas synchronisés, vous les gérez sur chaque plateforme.",
  },
  {
    q: "Je suis déjà sur l'Open System de Vendée Expansion.",
    a: "Les deux peuvent coexister. L'Open System est un moteur mutualisé ; DirectLoc vous donne votre propre site, votre nom de domaine, votre décor et un suivi dédié.",
  },
  {
    q: "Comment les voyageurs paient-ils ?",
    a: "Par carte, sur votre site, via Stripe. L'argent arrive sur votre compte ; DirectLoc ne prend rien sur les réservations.",
  },
];

export default function VitrinePage() {
  return (
    <>
      <a className="alm-skip" href="#rappel">Aller au formulaire de rappel</a>
      <header className="alm-cover">
        <nav className="alm-nav" aria-label="Navigation principale">
          <Link href="/" className="alm-mark">Direct<span>Loc</span></Link>
          <ul>
            <li><a href="#sejour">Le calcul</a></li>
            <li><a href="#travaux">Comment ça marche</a></li>
            <li><a href="#reseau">Le réseau</a></li>
            <li><a href="#tarifs">Tarifs</a></li>
            <li><a className="alm-nav-cta" href="#rappel">Être rappelé</a></li>
          </ul>
        </nav>
        <h1>Votre site à vous.<br /><span>Zéro commission</span><br />sur vos dates.</h1>
        <p className="alm-lede">
          Un site de réservation à votre nom de domaine pour votre gîte ou vos chambres d&apos;hôtes,
          synchronisé avec Airbnb et Booking, installé par quelqu&apos;un du bocage.
          Remboursé dès la première réservation directe.
        </p>
      </header>

      <section className="alm-first" aria-label="Votre été en direct">
        <MonthLeaf />
        <aside className="alm-side" id="rappel">
          <CallbackForm id="cb-top" title={<>On vous<br />rappelle</>} />
          <Link href="/essayer" className="alm-try">Essayer l&apos;admin avec un compte de démonstration</Link>
        </aside>
      </section>

      <section className="alm-sheet" id="sejour" aria-labelledby="sejour-t">
        <h2 id="sejour-t">Un séjour, euro par euro</h2>
        <p className="alm-intro">Le séjour moyen dans un meublé du bocage : 3 nuits, 666 €. Même séjour, deux chemins.</p>
        <div className="alm-ephem">
          <article className="alm-day-sheet">
            <header><span>Par une plateforme</span><b>3</b><small>samedi · juillet</small></header>
            <dl>
              <div><dt>Le voyageur paie</dt><dd>666 €</dd></div>
              <div><dt>Commission (17 %)</dt><dd className="alm-minus">− 113 €</dd></div>
              <div className="alm-total"><dt>Il vous reste</dt><dd>553 €</dd></div>
            </dl>
          </article>
          <article className="alm-day-sheet alm-day-direct">
            <header><span>Sur votre site</span><b>3</b><small>samedi · juillet</small></header>
            <dl>
              <div><dt>Le voyageur paie</dt><dd>666 €</dd></div>
              <div><dt>Commission</dt><dd>0 €</dd></div>
              <div className="alm-total"><dt>Il vous reste</dt><dd>666 €</dd></div>
            </dl>
          </article>
        </div>
        <p className="alm-source">
          Panier moyen meublé Vendée Bocage (Open System, 2024). Commission moyenne toutes plateformes : 17,2 % (étude Toploc 2026) ;
          Booking : 15 à 18 %. Les frais de carte bancaire (Stripe) s&apos;appliquent dans les deux cas.
        </p>
        <h3 className="alm-h3">Le barème de votre maison</h3>
        <Bareme />
      </section>

      <section className="alm-sheet alm-works" id="travaux" aria-labelledby="travaux-t">
        <h2 id="travaux-t">Les travaux de la saison</h2>
        <ol>
          <li><b>Première semaine</b><span>On se rencontre</span><p>Chez vous ou au téléphone. On regarde vos chambres, vos prix, vos calendriers Airbnb et Booking, votre nom de domaine.</p></li>
          <li><b>Deuxième semaine</b><span>On installe</span><p>On monte votre site, on importe vos photos, on branche le paiement en ligne et la synchronisation des calendriers. Vous relisez.</p></li>
          <li><b>Ensuite</b><span>Les réservations arrivent</span><p>Les voyageurs réservent et paient sur votre site. Vous recevez un e-mail et retrouvez tout dans votre tableau de bord.</p></li>
        </ol>
        <Link href="/essayer" className="alm-link">Voir le tableau de bord d&apos;un hôte de démonstration</Link>
      </section>

      <section className="alm-sheet" id="calendriers" aria-labelledby="cal-t">
        <h2 id="cal-t">Trois calendriers, une seule feuille</h2>
        <p className="alm-intro">
          Synchronisation iCal avec vos calendriers Airbnb et Booking : une date prise ailleurs est bloquée sur votre site,
          une réservation directe est bloquée chez eux. Pas de double réservation.
        </p>
        <div className="alm-merge" role="img" aria-label="Les dates Airbnb, Booking et directes se rejoignent dans un seul calendrier">
          {[
            ["Airbnb", [[2, 5]]],
            ["Booking", [[9, 13]]],
            ["Votre site", [[15, 20], [24, 28]]],
          ].map(([name, spans]) => (
            <div className="alm-lane" key={name as string}>
              <span>{name as string}</span>
              <div>{(spans as number[][]).map(([a, b]) => <i key={a} style={{ left: `${(a / 31) * 100}%`, width: `${((b - a) / 31) * 100}%` }} />)}</div>
            </div>
          ))}
          <div className="alm-lane alm-lane-all">
            <span>Votre calendrier</span>
            <div>{[[2, 5], [9, 13], [15, 20], [24, 28]].map(([a, b]) => <i key={a} style={{ left: `${(a / 31) * 100}%`, width: `${((b - a) / 31) * 100}%` }} />)}</div>
          </div>
        </div>
      </section>

      <section className="alm-sheet" id="modeles" aria-labelledby="modeles-t">
        <h2 id="modeles-t">Quatre couvertures, votre nom dessus</h2>
        <p className="alm-intro">Choisissez le décor de votre site et vos couleurs. Vos voyageurs voient votre maison, pas DirectLoc.</p>
        <ul className="alm-covers">
          <li className="alm-cv alm-cv-plaque"><b>Gîte de la Vergnaie</b><span>La Plaque émaillée</span></li>
          <li className="alm-cv alm-cv-linge"><b>Gîte de la Vergnaie</b><span>Le Linge de maison</span></li>
          <li className="alm-cv alm-cv-affiche"><b>Gîte de la Vergnaie</b><span>L&apos;Affiche touristique</span></li>
          <li className="alm-cv alm-cv-standard"><b>Gîte de la Vergnaie</b><span>Classique</span></li>
        </ul>
      </section>

      <section className="alm-sheet alm-network" id="reseau" aria-labelledby="reseau-t">
        <h2 id="reseau-t">Complet ? Le voisin prend le relais</h2>
        <div className="alm-net-grid">
          <div>
            <p className="alm-intro">
              Quand votre gîte est complet aux dates demandées, votre site propose au voyageur les hébergements DirectLoc
              les plus proches qui sont libres. Il reste dans le bocage au lieu de repartir sur une plateforme, et vos voisins
              vous renvoient leurs voyageurs de la même façon.
            </p>
            <p className="alm-intro">
              Les articles du réseau, publiés sur directloc.app (« Où dormir près du Puy du Fou », « Gîte de groupe en Vendée »…),
              renvoient vers le site de chaque hébergeur, à son propre nom de domaine.
            </p>
          </div>
          <div className="alm-slip" aria-label="Exemple : message affiché au voyageur quand le gîte est complet">
            <p className="alm-slip-full">Complet du 10 au 17 juillet</p>
            <p>Ces hébergements voisins sont libres à vos dates :</p>
            <ul>
              <li><b>La Grange du Bois Joly</b><span>Les Epesses · 4 km</span></li>
              <li><b>Chambres d&apos;hôtes Le Pressoir</b><span>Mortagne-sur-Sèvre · 11 km</span></li>
            </ul>
            <small>Exemple fictif</small>
          </div>
        </div>
      </section>

      <section className="alm-sheet" id="tarifs" aria-labelledby="tarifs-t">
        <h2 id="tarifs-t">Les tarifs, sans petits caractères</h2>
        <div className="alm-prices">
          <table>
            <caption>Abonnement mensuel</caption>
            <thead><tr><th scope="col">Formule</th><th scope="col">Gîtes / meublés</th><th scope="col">Chambres</th><th scope="col">Prix</th></tr></thead>
            <tbody>
              <tr><th scope="row">Solo</th><td>1 gîte</td><td>1 à 3</td><td>39 € / mois</td></tr>
              <tr><th scope="row">Petit</th><td>2 à 5 gîtes</td><td>4 à 8</td><td>69 € / mois</td></tr>
              <tr><th scope="row">Grand</th><td>6 gîtes et plus</td><td>9 et plus</td><td>119 € / mois + 8 € par chambre au-delà</td></tr>
            </tbody>
          </table>
          <table>
            <caption>Licence achetée une fois</caption>
            <thead><tr><th scope="col">Formule</th><th scope="col">Licence</th><th scope="col">Maintenance et hébergement</th></tr></thead>
            <tbody>
              <tr><th scope="row">Solo</th><td>1 250 €</td><td>19 € / mois</td></tr>
              <tr><th scope="row">Petit</th><td>1 490 €</td><td>25 € / mois</td></tr>
              <tr><th scope="row">Grand</th><td>1 990 €</td><td>35 € / mois</td></tr>
            </tbody>
          </table>
        </div>
        <p className="alm-source">
          Abonnement : 2 mois offerts sur un engagement d&apos;un an. Licence : vous l&apos;achetez, vous ne la louez pas ; la maintenance
          (serveur, mises à jour de sécurité, assistance) reste obligatoire. Aucune commission sur les réservations dans les deux cas.
        </p>
      </section>

      <section className="alm-sheet" id="questions" aria-labelledby="faq-t">
        <h2 id="faq-t">Le courrier des hébergeurs</h2>
        <div className="alm-faq">
          {FAQ.map((f) => (
            <details key={f.q}><summary>{f.q}</summary><p>{f.a}</p></details>
          ))}
        </div>
      </section>

      <footer className="alm-back">
        <div className="alm-back-copy">
          <h2>Votre prochain été, en direct.</h2>
          <p>Laissez votre numéro : on vous rappelle, on vient vous montrer votre futur site, on installe tout avec vous.</p>
          <Link href="/essayer" className="alm-try">Essayer l&apos;admin avec un compte de démonstration</Link>
        </div>
        <CallbackForm id="cb-end" title="Être rappelé" />
        <p className="alm-colophon">DirectLoc · réservation directe pour les hébergeurs de Vendée Bocage et du Puy du Fou · directloc.app</p>
      </footer>
    </>
  );
}
