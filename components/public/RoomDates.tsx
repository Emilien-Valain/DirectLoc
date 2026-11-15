"use client";

import { useState } from "react";
import DateField from "@/components/public/DateField";

const addDay = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Dates sur la page chambre : GET simple vers /reserver, qui lit ?checkIn&checkOut et vérifie la dispo. */
export default function RoomDates({ roomId, today }: { roomId: string; today: string }) {
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");

  return (
    <form action={`/reserver/${roomId}`} method="get" className="s-room-dates" aria-label="Choisir vos dates">
      <DateField
        id="room-checkin"
        name="checkIn"
        label="Arrivée"
        min={today}
        value={checkIn}
        onChange={(v) => {
          setCheckIn(v);
          if (v && (!checkOut || v >= checkOut)) setCheckOut(addDay(v));
        }}
      />
      <DateField
        id="room-checkout"
        name="checkOut"
        label="Départ"
        min={checkIn ? addDay(checkIn) : today}
        value={checkOut}
        onChange={setCheckOut}
      />
      <button type="submit" className="s-btn s-btn-block">
        Voir le tarif et réserver
      </button>
    </form>
  );
}
