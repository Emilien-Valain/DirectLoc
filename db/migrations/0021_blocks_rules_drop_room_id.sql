ALTER TABLE "booking_rules" DROP CONSTRAINT "booking_rules_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "manual_blocks" DROP CONSTRAINT "manual_blocks_room_id_rooms_id_fk";
--> statement-breakpoint
DROP INDEX "booking_rules_tenant_room_idx";--> statement-breakpoint
DROP INDEX "manual_blocks_tenant_room_idx";--> statement-breakpoint
CREATE INDEX "booking_rules_tenant_idx" ON "booking_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "manual_blocks_tenant_idx" ON "manual_blocks" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "booking_rules" DROP COLUMN "room_id";--> statement-breakpoint
ALTER TABLE "manual_blocks" DROP COLUMN "room_id";