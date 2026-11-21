ALTER TABLE "dossiers" ADD COLUMN "reminder_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "dossiers" ADD COLUMN "thank_you_sent_at" timestamp;
--> statement-breakpoint
UPDATE "dossiers" d SET "reminder_sent_at" = (SELECT min(b."reminder_sent_at") FROM "bookings" b WHERE b."dossier_id" = d."id" AND b."reminder_sent_at" IS NOT NULL), "thank_you_sent_at" = (SELECT min(b."thank_you_sent_at") FROM "bookings" b WHERE b."dossier_id" = d."id" AND b."thank_you_sent_at" IS NOT NULL);
