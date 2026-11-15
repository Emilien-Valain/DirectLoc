"use client";

import { useState } from "react";
import Image from "next/image";
import { sortedPhotos } from "@/components/public/photos";

/** Galerie d'une chambre. Ne rend rien sans photo : la page passe en mise en page texte. */
export default function RoomGallery({ photos, alt }: { photos: unknown; alt: string }) {
  const sorted = sortedPhotos(photos);
  const [activeIdx, setActiveIdx] = useState(0);

  if (sorted.length === 0) return null;

  return (
    <div>
      <div className="s-gallery-main">
        <Image
          src={sorted[activeIdx].url}
          alt={`${alt} — photo ${activeIdx + 1}`}
          fill
          sizes="(max-width: 900px) 100vw, 1240px"
          priority
        />
      </div>
      {sorted.length > 1 && (
        <div className="s-thumbs">
          {sorted.map((photo, idx) => (
            <button
              key={photo.id}
              type="button"
              className="s-thumb"
              onClick={() => setActiveIdx(idx)}
              aria-current={idx === activeIdx}
              aria-label={`Voir la photo ${idx + 1}`}
            >
              <Image src={photo.url} alt="" fill sizes="72px" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
