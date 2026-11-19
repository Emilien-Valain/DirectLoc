"use client";

import { AdminTextarea, Field, SettingsSection, StatusBanner } from "@/components/admin/ui";
import { useFormAction } from "@/components/admin/useFormAction";
import RoomInfoFields from "@/components/admin/RoomInfoFields";
import { updateRoomEmail } from "@/lib/actions/rooms";
import { asRoomInfo } from "@/lib/room-info";

type Room = { id: string; name: string; emailMessage?: string | null; info?: unknown };

/**
 * Paramètres → Emails, « Par chambre » : infos pratiques et message ajouté aux emails
 * des réservations de chaque chambre. Un bloc repliable par chambre, enregistré à part.
 */
export default function RoomEmailsSection({ rooms }: { rooms: Room[] }) {
  return (
    <SettingsSection
      title="Par chambre"
      desc="Étage, code d'accès, wifi… et un message ajouté aux emails de confirmation et de rappel des réservations de cette chambre."
    >
      {rooms.length === 0 ? (
        <p className="text-[13px]" style={{ color: "var(--admin-text-muted)" }}>
          Aucune chambre pour l&apos;instant.
        </p>
      ) : (
        <div className="space-y-2.5">
          {rooms.map((r) => (
            <RoomEmailCard key={r.id} room={r} />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

function RoomEmailCard({ room }: { room: Room }) {
  const form = useFormAction(updateRoomEmail.bind(null, room.id));
  const filled = asRoomInfo(room.info).length + (room.emailMessage ? 1 : 0);
  return (
    <details
      data-testid="room-email-card"
      data-room-name={room.name}
      style={{ border: "1px solid var(--admin-border-light)", borderRadius: 10, background: "var(--admin-surface-2)" }}
    >
      <summary
        className="cursor-pointer flex items-center justify-between gap-3 text-[13.5px] font-semibold"
        style={{ padding: "12px 14px", color: "var(--admin-text)" }}
      >
        <span className="min-w-0 truncate">{room.name}</span>
        <span className="text-[12px] font-normal flex-shrink-0" style={{ color: "var(--admin-text-muted)" }}>
          {filled === 0 ? "Rien de renseigné" : `${filled} élément${filled > 1 ? "s" : ""} renseigné${filled > 1 ? "s" : ""}`}
        </span>
      </summary>
      <form onSubmit={form.onSubmit} style={{ padding: "4px 14px 14px" }}>
        {form.saved && <StatusBanner variant="success">Enregistré pour {room.name}.</StatusBanner>}
        {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}
        <RoomInfoFields initial={asRoomInfo(room.info)} fieldError={form.fieldError} />
        <Field
          label="Message dans les emails"
          hint="Ajouté aux emails de confirmation et de rappel des réservations de cette chambre."
          error={form.fieldError("messageEmail")}
        >
          <AdminTextarea
            name="messageEmail"
            rows={3}
            defaultValue={room.emailMessage ?? ""}
            placeholder="ex : Votre chambre {chambre} est au {etage}. Code de la porte : {code_acces}. Wi-Fi {wifi}, mot de passe {wifi_mdp}."
          />
        </Field>
        <button
          type="submit"
          disabled={form.pending}
          style={{
            padding: "9px 18px",
            background: "var(--admin-primary)",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            cursor: form.pending ? "wait" : "pointer",
            opacity: form.pending ? 0.7 : 1,
          }}
        >
          {form.pending ? "Enregistrement…" : `Enregistrer pour ${room.name}`}
        </button>
      </form>
    </details>
  );
}
