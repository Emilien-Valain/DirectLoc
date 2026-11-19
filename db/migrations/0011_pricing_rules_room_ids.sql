ALTER TABLE "pricing_rules" ADD COLUMN "room_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Une règle « une chambre » devient une règle visant cette seule chambre.
UPDATE "pricing_rules" SET "room_ids" = ARRAY["room_id"] WHERE "room_id" IS NOT NULL;
