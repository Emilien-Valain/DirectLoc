ALTER TABLE "bookings" ADD COLUMN "guest_first_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "guest_last_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "guest_country" text;--> statement-breakpoint
-- Réservations existantes : « Marie Dupont » → prénom « Marie », nom « Dupont » ; un seul mot = nom.
UPDATE "bookings" SET
  "guest_first_name" = CASE WHEN position(' ' in btrim("guest_name")) > 0 THEN split_part(btrim("guest_name"), ' ', 1) ELSE '' END,
  "guest_last_name" = CASE WHEN position(' ' in btrim("guest_name")) > 0 THEN btrim(substr(btrim("guest_name"), position(' ' in btrim("guest_name")) + 1)) ELSE btrim("guest_name") END;
