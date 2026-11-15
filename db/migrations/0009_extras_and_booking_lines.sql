CREATE TYPE "public"."booking_line_kind" AS ENUM('extra', 'fee', 'tax');--> statement-breakpoint
CREATE TYPE "public"."extra_unit" AS ENUM('per_stay', 'per_night', 'per_guest', 'per_guest_night');--> statement-breakpoint
CREATE TABLE "booking_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"kind" "booking_line_kind" NOT NULL,
	"source_id" uuid,
	"label" text NOT NULL,
	"unit" "extra_unit" NOT NULL,
	"unit_price" numeric(10, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"total" numeric(10, 2) NOT NULL,
	"exempt" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "extras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"price" numeric(10, 2) NOT NULL,
	"unit" "extra_unit" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "booking_lines" ADD CONSTRAINT "booking_lines_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extras" ADD CONSTRAINT "extras_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_lines_booking_idx" ON "booking_lines" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "extras_tenant_idx" ON "extras" USING btree ("tenant_id");