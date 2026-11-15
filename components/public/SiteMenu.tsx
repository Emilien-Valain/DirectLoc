"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/** Menu mobile commun aux templates (stylé par la feuille du template). */
export default function SiteMenu({ showLocation }: { showLocation: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  // Échap referme et rend le focus au bouton ; un clic hors du menu le referme.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btnRef.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="s-menu" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="s-menu-btn"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="s-menu-panel"
        aria-label={open ? "Fermer le menu" : "Ouvrir le menu"}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {open ? (
            <path d="M18 6 6 18M6 6l12 12" />
          ) : (
            <path d="M4 7h16M4 12h16M4 17h16" />
          )}
        </svg>
      </button>
      {open && (
        <nav id="s-menu-panel" className="s-menu-panel" aria-label="Menu">
          <Link href="/chambres" onClick={close} className="s-nav-link">
            Chambres
          </Link>
          {showLocation && (
            <Link href="/#nous-trouver" onClick={close} className="s-nav-link">
              Nous trouver
            </Link>
          )}
          <Link href="/#dates" onClick={close} className="s-nav-link s-nav-cta">
            Réserver
          </Link>
        </nav>
      )}
    </div>
  );
}
