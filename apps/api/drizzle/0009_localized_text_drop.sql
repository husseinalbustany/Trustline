ALTER TABLE "org_units" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "description" SET DATA TYPE jsonb USING CASE WHEN "description" IS NULL THEN NULL ELSE jsonb_build_object('en', "description") END;--> statement-breakpoint
ALTER TABLE "tenants" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "org_units" DROP COLUMN "name_en";--> statement-breakpoint
ALTER TABLE "org_units" DROP COLUMN "name_ar";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "name_en";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "name_ar";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "name_en";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "name_ar";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "name_en";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "name_ar";