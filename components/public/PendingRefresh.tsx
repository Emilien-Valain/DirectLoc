"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 3000;
const MAX_TRIES = 20; // ~60 s : au-delà, le webhook Stripe est en retard, on passe la main à l'email.

/** Paiement pas encore confirmé par le webhook : relit la page jusqu'à confirmation, puis rassure. */
export default function PendingRefresh({ guestEmail, phone }: { guestEmail: string; phone?: string }) {
  const router = useRouter();
  const [tries, setTries] = useState(0);
  const gaveUp = tries >= MAX_TRIES;

  useEffect(() => {
    if (gaveUp) return;
    const t = setTimeout(() => {
      router.refresh();
      setTries((n) => n + 1);
    }, INTERVAL_MS);
    return () => clearTimeout(t);
  }, [tries, gaveUp, router]);

  return (
    <p className="s-prose" aria-live="polite" data-testid="pending-message">
      {gaveUp ? (
        <>
          La vérification prend plus de temps que prévu. Votre paiement est enregistré : la confirmation
          arrivera par email à <strong>{guestEmail}</strong>
          {phone ? (
            <>
              . Sans nouvelles d&apos;ici une heure, appelez-nous au <a href={`tel:${phone}`}>{phone}</a>.
            </>
          ) : (
            "."
          )}
        </>
      ) : (
        <>Votre paiement est en cours de vérification. Cette page se met à jour toute seule.</>
      )}
    </p>
  );
}
