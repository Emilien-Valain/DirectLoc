CREATE TABLE "fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"unit" "extra_unit" NOT NULL,
	"room_ids" uuid[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "child_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fees" ADD CONSTRAINT "fees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fees_tenant_idx" ON "fees" USING btree ("tenant_id");