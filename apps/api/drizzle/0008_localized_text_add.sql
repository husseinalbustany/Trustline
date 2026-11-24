ALTER TABLE "org_units" ADD COLUMN "name" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "name" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "name" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "locales" text[] DEFAULT '{en}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Carry the existing English and Arabic text into the per-language columns.
UPDATE "tenants" SET "name" = jsonb_build_object('en', "name_en", 'ar', "name_ar"), "locales" = CASE WHEN "default_locale" = 'ar' THEN '{ar,en}'::text[] ELSE '{en,ar}'::text[] END;--> statement-breakpoint
UPDATE "org_units" SET "name" = jsonb_build_object('en', "name_en", 'ar', "name_ar");--> statement-breakpoint
UPDATE "users" SET "name" = jsonb_build_object('en', "name_en", 'ar', "name_ar");--> statement-breakpoint
UPDATE "roles" SET "name" = jsonb_build_object('en', "name_en", 'ar', "name_ar");
