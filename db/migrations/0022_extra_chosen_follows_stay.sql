ALTER TABLE "booking_lines" ALTER COLUMN "chosen" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "booking_lines" ALTER COLUMN "chosen" DROP NOT NULL;--> statement-breakpoint
-- Nouveau sens : le nombre choisi remplace la dimension (nuits, personnes, lits) ; NULL = tout le séjour.
UPDATE "booking_lines" SET "chosen" = NULL WHERE "kind" <> 'extra' OR "unit" IN ('per_night', 'per_guest', 'per_guest_night');
