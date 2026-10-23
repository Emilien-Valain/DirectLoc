ALTER TABLE "sessions" DROP CONSTRAINT "sessions_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "tenant_id";