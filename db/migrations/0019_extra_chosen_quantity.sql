ALTER TABLE "booking_lines" ADD COLUMN "chosen" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "extras" ADD COLUMN "max_quantity" integer;--> statement-breakpoint
-- « Par lit » : la quantité enregistrée était déjà le nombre de lits choisi.
UPDATE "booking_lines" SET "chosen" = "quantity" WHERE "unit" = 'per_bed' AND "quantity" > 0;
