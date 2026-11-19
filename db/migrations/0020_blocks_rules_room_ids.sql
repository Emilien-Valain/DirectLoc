ALTER TABLE "booking_rules" ADD COLUMN "room_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "manual_blocks" ADD COLUMN "room_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
UPDATE "manual_blocks" SET "room_ids" = ARRAY["room_id"] WHERE "room_id" IS NOT NULL;--> statement-breakpoint
UPDATE "booking_rules" SET "room_ids" = ARRAY["room_id"] WHERE "room_id" IS NOT NULL;
