ALTER TABLE "payments" DROP CONSTRAINT "payments_booking_id_bookings_id_fk";
--> statement-breakpoint
ALTER TABLE "payments" DROP COLUMN "booking_id";