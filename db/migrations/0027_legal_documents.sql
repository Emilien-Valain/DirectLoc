CREATE TYPE "public"."cancellation_level" AS ENUM('flexible', 'moderate', 'strict', 'custom');--> statement-breakpoint
ALTER TABLE "dossiers" ADD COLUMN "cancellation_level" "cancellation_level";--> statement-breakpoint
ALTER TABLE "dossiers" ADD COLUMN "accepted_cancellation_text" text;--> statement-breakpoint
ALTER TABLE "dossiers" ADD COLUMN "accepted_cgv_text" text;--> statement-breakpoint
ALTER TABLE "dossiers" ADD COLUMN "terms_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "legal_form" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "siret" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "publication_director" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "mediator" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cancellation_level" "cancellation_level" DEFAULT 'moderate' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cancellation_text" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "cgv_text" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "legal_notice_text" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "privacy_text" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "legal_published_at" timestamp;