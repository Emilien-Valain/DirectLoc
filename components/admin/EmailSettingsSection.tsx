"use client";

import { useFormAction } from "@/components/admin/useFormAction";
import { updateEmailSettings } from "@/lib/actions/email-settings";
import {
  AdminInput,
  AdminTextarea,
  Field,
  SettingsSection,
  StatusBanner,
} from "@/components/admin/ui";
import { DEFAULT_REMINDER_DAYS, MAX_REMINDER_DAYS } from "@/lib/email-template";
import EmailVariablesHelp from "@/components/admin/EmailVariablesHelp";

type EmailSettingsSectionProps = {
  confirmationMessage?: string;
  postStayMessage?: string;
  reminderDaysBefore?: number;
  reminderMessage?: string;
  reviewUrl?: string;
};

export default function EmailSettingsSection({
  confirmationMessage,
  postStayMessage,
  reminderDaysBefore,
  reminderMessage,
  reviewUrl,
}: EmailSettingsSectionProps) {
  const form = useFormAction(updateEmailSettings);

  return (
    <SettingsSection
      title="Emails"
      desc="Personnalisez les messages envoyés aux clients par email. Un message propre à une chambre (code d'accès, étage…) se règle dans la fiche de la chambre."
    >
      {form.saved && (
        <StatusBanner variant="success">
          Paramètres email mis à jour avec succès.
        </StatusBanner>
      )}
      {form.error && <StatusBanner variant="error">{form.error}</StatusBanner>}

      <form onSubmit={form.onSubmit}>
        <EmailVariablesHelp />

        <Field
          label="Message de confirmation de réservation"
          hint="Apparaît dans l'email de confirmation envoyé au client après paiement."
          error={form.fieldError("confirmationMessage")}
        >
          <AdminTextarea
            id="email-confirmation"
            name="confirmationMessage"
            rows={3}
            defaultValue={confirmationMessage ?? ""}
            placeholder="ex : Nous avons hâte de vous accueillir, {client} ! N'hésitez pas à nous contacter pour toute demande spéciale."
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3">
          <Field
            label="Rappel avant l'arrivée"
            hint="Jours avant l'arrivée ; 0 = pas de rappel."
            error={form.fieldError("reminderDaysBefore")}
          >
            <AdminInput
              id="email-reminder-days"
              name="reminderDaysBefore"
              type="number"
              min={0}
              max={MAX_REMINDER_DAYS}
              step={1}
              inputMode="numeric"
              defaultValue={reminderDaysBefore ?? DEFAULT_REMINDER_DAYS}
            />
          </Field>
          <Field
            label="Message du rappel"
            hint="Ajouté à l'email de rappel, sous le récapitulatif du séjour."
            error={form.fieldError("reminderMessage")}
          >
            <AdminTextarea
              id="email-reminder"
              name="reminderMessage"
              rows={3}
              defaultValue={reminderMessage ?? ""}
              placeholder="ex : Arrivée à partir de 16 h le {arrivee}. Pensez à nous prévenir de votre heure d'arrivée."
            />
          </Field>
        </div>

        <Field
          label="Message post-séjour"
          hint="Envoyé automatiquement le lendemain du départ."
          error={form.fieldError("postStayMessage")}
        >
          <AdminTextarea
            id="email-poststay"
            name="postStayMessage"
            rows={3}
            defaultValue={postStayMessage ?? ""}
            placeholder="ex : Merci pour votre séjour ! Nous espérons vous revoir bientôt."
          />
        </Field>

        <Field
          label="Lien Google Reviews"
          hint="Un bouton « Laisser un avis » sera ajouté à l'email post-séjour."
        >
          <AdminInput
            id="email-review-url"
            name="reviewUrl"
            type="url"
            defaultValue={reviewUrl ?? ""}
            placeholder="ex : https://g.page/r/votre-etablissement/review"
          />
        </Field>

        <div className="flex justify-end mt-4">
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
            {form.pending ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </form>
    </SettingsSection>
  );
}
