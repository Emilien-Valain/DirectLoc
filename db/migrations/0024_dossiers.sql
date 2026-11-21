CREATE TABLE "dossiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"check_in" timestamp NOT NULL,
	"check_out" timestamp NOT NULL,
	"guest_name" text NOT NULL,
	"guest_first_name" text DEFAULT '' NOT NULL,
	"guest_last_name" text DEFAULT '' NOT NULL,
	"guest_email" text NOT NULL,
	"guest_phone" text,
	"guest_address" text,
	"guest_country" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "dossier_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "dossier_id" uuid;--> statement-breakpoint
-- Un Dossier par réservation existante (même id, pour rattacher les paiements sans table de correspondance).
INSERT INTO "dossiers" ("id", "tenant_id", "check_in", "check_out", "guest_name", "guest_first_name", "guest_last_name", "guest_email", "guest_phone", "guest_address", "guest_country", "created_at", "updated_at")
  SELECT "id", "tenant_id", "check_in", "check_out", "guest_name", "guest_first_name", "guest_last_name", "guest_email", "guest_phone", "guest_address", "guest_country", "created_at", "updated_at" FROM "bookings";--> statement-breakpoint
UPDATE "bookings" SET "dossier_id" = "id";--> statement-breakpoint
UPDATE "payments" SET "dossier_id" = "booking_id";--> statement-breakpoint
ALTER TABLE "bookings" ALTER COLUMN "dossier_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "dossier_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dossiers_tenant_idx" ON "dossiers" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_dossier_id_dossiers_id_fk" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_dossier_id_dossiers_id_fk" FOREIGN KEY ("dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_dossier_idx" ON "bookings" USING btree ("dossier_id");--> statement-breakpoint
CREATE INDEX "payments_dossier_idx" ON "payments" USING btree ("dossier_id");