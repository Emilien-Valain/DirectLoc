"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

// Leaflet a besoin de `window` : import dynamique SSR-off.
const LeafletMap = dynamic(() => import("@/components/public/LeafletMap"), {
  ssr: false,
  loading: () => <div className="s-map-canvas s-map-loading" />,
});

/** La carte est en bas de page : Leaflet et les tuiles ne se chargent qu'à l'approche. */
export default function LocationMap(props: { latitude: number; longitude: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return near ? <LeafletMap {...props} /> : <div ref={ref} className="s-map-canvas s-map-loading" />;
}
