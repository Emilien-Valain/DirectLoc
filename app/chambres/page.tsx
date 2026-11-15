import PublicLayout from "@/components/public/PublicLayout";
import { Breadcrumb, RoomPrice, sortedPhotos } from "@/components/public/Site";
import Image from "next/image";
import Link from "next/link";
import { requireTenant } from "@/lib/tenant-context";
import { getRoomsPublic } from "@/lib/queries/public";
import { getMinPricePerNight } from "@/lib/pricing";

export default async function ChambresPage() {
  const tenant = await requireTenant();
  const rawRooms = await getRoomsPublic(tenant.id);
  const rooms = await Promise.all(
    rawRooms.map(async (room) => ({
      ...room,
      minPrice: await getMinPricePerNight(room.id, tenant.id),
    })),
  );

  return (
    <PublicLayout>
      <div className="s-page">
        <Breadcrumb items={[{ href: "/", label: "Accueil" }, { label: "Chambres" }]} />
        <h1 className="s-h1">Nos chambres</h1>
        {rooms.length === 0 ? (
          <p className="s-prose">Les chambres seront bientôt présentées ici.</p>
        ) : (
          <ol className="s-room-index">
            {rooms.map((room, i) => {
              const photo = sortedPhotos(room.photos)[0];
              return (
                <li key={room.id} className={`s-room-card${photo ? " has-photo" : ""}`}>
                  {photo && (
                    <div className="s-room-card-photo">
                      <Image src={photo.url} alt="" fill sizes="(max-width: 700px) 100vw, 40vw" />
                    </div>
                  )}
                  <div className="s-room-card-body">
                    <p className="s-room-num" aria-hidden="true">
                      <small>N°</small>
                      {i + 1}
                    </p>
                    <h2 className="s-h2">
                      <Link href={`/chambres/${room.slug}`}>{room.name}</Link>
                    </h2>
                    <p className="s-room-meta">{room.capacity} pers.</p>
                    {room.description && <p className="s-prose s-clamp">{room.description}</p>}
                    <div className="s-room-card-foot">
                      <RoomPrice room={room} />
                      <Link href={`/reserver/${room.id}`} className="s-btn">
                        Réserver
                      </Link>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </PublicLayout>
  );
}
