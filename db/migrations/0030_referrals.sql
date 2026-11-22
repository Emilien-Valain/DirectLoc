CREATE TYPE "public"."referral_kind" AS ENUM('full', 'shared');--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_tenant_id" uuid NOT NULL,
	"to_tenant_id" uuid NOT NULL,
	"check_in" timestamp NOT NULL,
	"check_out" timestamp NOT NULL,
	"guest_count" integer NOT NULL,
	"kind" "referral_kind" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dossiers" ADD COLUMN "referred_by_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_from_tenant_id_tenants_id_fk" FOREIGN KEY ("from_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_to_tenant_id_tenants_id_fk" FOREIGN KEY ("to_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "referrals_from_idx" ON "referrals" USING btree ("from_tenant_id");--> statement-breakpoint
CREATE INDEX "referrals_to_idx" ON "referrals" USING btree ("to_tenant_id");--> statement-breakpoint
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_referred_by_tenant_id_tenants_id_fk" FOREIGN KEY ("referred_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;