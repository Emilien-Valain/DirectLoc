ALTER TABLE "dossiers" ADD COLUMN "network_notified_at" timestamp;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "from_dossier_id" uuid;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "to_dossier_id" uuid;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "share_notified_at" timestamp;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_from_dossier_id_dossiers_id_fk" FOREIGN KEY ("from_dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_to_dossier_id_dossiers_id_fk" FOREIGN KEY ("to_dossier_id") REFERENCES "public"."dossiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referrals_to_dossier_uniq" ON "referrals" USING btree ("to_dossier_id");