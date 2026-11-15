"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Carte « Nous trouver ». L'épingle est du HTML stylé par la feuille du
 * template (`.s-pin`), donc elle prend les couleurs de l'hôte.
 */
export default function LeafletMap({
  latitude,
  longitude,
  label,
}: {
  latitude: number;
  longitude: number;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
    }).setView([latitude, longitude], 14);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

    L.control
      .attribution({ position: "bottomright", prefix: false })
      .addAttribution(
        '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      )
      .addTo(map);
    L.control.zoom({ position: "topright" }).addTo(map);

    const safeLabel = label
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    // Wrapper 0×0 : la pointe de l'épingle tombe exactement sur les coordonnées.
    const icon = L.divIcon({
      html: `<div class="s-pin"><span class="s-pin-label">${safeLabel}</span><span class="s-pin-dot"></span></div>`,
      className: "",
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    L.marker([latitude, longitude], { icon, keyboard: false }).addTo(map);

    return () => {
      map.remove();
    };
  }, [latitude, longitude, label]);

  return <div ref={containerRef} className="s-map-canvas" aria-label={`Carte centrée sur ${label}`} />;
}
