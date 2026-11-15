import Image from "next/image";
import { sortedPhotos } from "@/components/public/photos";

/** Photo principale d'une chambre ; rien si la chambre n'a pas de photo. */
export default function RoomPhoto({
  photos,
  alt,
  className = "",
  sizes = "(max-width: 640px) 100vw, 400px",
}: {
  photos: unknown;
  alt: string;
  className?: string;
  sizes?: string;
}) {
  const main = sortedPhotos(photos)[0];
  if (!main) return null;
  return (
    <div className={`relative overflow-hidden ${className}`}>
      <Image src={main.url} alt={alt} fill className="object-cover" sizes={sizes} />
    </div>
  );
}
