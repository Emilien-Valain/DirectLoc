ALTER TABLE "pricing_rules" DROP CONSTRAINT "pricing_rules_room_id_rooms_id_fk";
--> statement-breakpoint
DROP INDEX "pricing_rules_tenant_room_idx";--> statement-breakpoint
CREATE INDEX "pricing_rules_tenant_idx" ON "pricing_rules" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "pricing_rules" DROP COLUMN "room_id";