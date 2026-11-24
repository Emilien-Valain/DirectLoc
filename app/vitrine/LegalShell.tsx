import Link from "next/link";
import { DirectLocMark } from "@/components/brand/DirectLocMark";

/** Cadre commun des pages légales de la vitrine : bandeau de marque + feuille blanche lisible. */
export function LegalShell({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <>
      <header className="alm-legal-head">
        <Link href="/" className="alm-mark"><DirectLocMark size={44} onDark decorative />Direct<span>Loc</span></Link>
      </header>
      <main className="alm-sheet alm-legal">
        <h1>{title}</h1>
        <p className="alm-legal-date">Dernière mise à jour : {updated}</p>
        {children}
        <p className="alm-legal-back"><Link href="/">← Retour à l&apos;accueil</Link></p>
      </main>
    </>
  );
}
