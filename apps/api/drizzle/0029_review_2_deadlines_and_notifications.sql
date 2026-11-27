ALTER TYPE "public"."notification_kind" ADD VALUE 'sentinel_flagged';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'public_form_paused';--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "incident_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "close_due_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "close_due_soon_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "close_overdue_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_incident" CHECK ("notifications"."incident_id" is not null or "notifications"."kind"::text = 'public_form_paused');--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_time_zone_shape" CHECK ("tenants"."time_zone" = 'UTC' or ("tenants"."time_zone" ~ '^[A-Z][A-Za-z_]*(/[A-Z0-9][A-Za-z0-9_+-]*){1,2}$' and "tenants"."time_zone" !~ '^Etc/'));