"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";
import { mergeTenantConfig } from "@/lib/tenant-config";
import { MAX_REMINDER_DAYS } from "@/lib/email-template";
import type { FormResult } from "@/lib/validation";

const MAX_MESSAGE = 5000;

export async function updateEmailSettings(formData: FormData): Promise<FormResult> {
  const { tenantId } = await requireSession();

  const text = (name: string) => formData.get(name)?.toString().trim() || undefined;
  const confirmationMessage = text("confirmationMessage");
  const postStayMessage = text("postStayMessage");
  const reminderMessage = text("reminderMessage");
  const reviewUrl = text("reviewUrl");

  const fieldErrors: Record<string, string> = {};
  for (const [name, value] of Object.entries({ confirmationMessage, postStayMessage, reminderMessage })) {
    if (value && value.length > MAX_MESSAGE) fieldErrors[name] = `Message trop long (${MAX_MESSAGE} caractères max)`;
  }
  const rawDays = text("reminderDaysBefore");
  const reminderDaysBefore = rawDays === undefined ? undefined : Number(rawDays);
  if (
    reminderDaysBefore !== undefined &&
    !(Number.isInteger(reminderDaysBefore) && reminderDaysBefore >= 0 && reminderDaysBefore <= MAX_REMINDER_DAYS)
  ) {
    fieldErrors.reminderDaysBefore = `Rappel : un nombre de jours entre 0 et ${MAX_REMINDER_DAYS}`;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { error: Object.values(fieldErrors).join(" · "), fieldErrors };
  }

  await db
    .update(tenants)
    .set({
      config: mergeTenantConfig({
        confirmationMessage,
        postStayMessage,
        reminderDaysBefore,
        reminderMessage,
        reviewUrl,
      }),
    })
    .where(eq(tenants.id, tenantId));

  revalidatePath("/admin/parametres");
}
