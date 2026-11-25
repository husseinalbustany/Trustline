CREATE TYPE "public"."incident_channel" AS ENUM('app', 'public');--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_comments" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_comments" ADD COLUMN "by_reporter" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "channel" "incident_channel" DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "follow_up_code_hash" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "closure_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "closure_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "public_reporting" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_closure_requested_by_fk" FOREIGN KEY ("tenant_id","closure_requested_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_has_writer" CHECK ("incident_comments"."author_id" is not null or "incident_comments"."by_reporter");--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_public_is_anonymous" CHECK ("incidents"."channel" <> 'public' or "incidents"."reported_by" is null);--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_follow_up_code_is_anonymous" CHECK ("incidents"."follow_up_code_hash" is null or "incidents"."reported_by" is null);--> statement-breakpoint
CREATE POLICY "tenants_app_read" ON "tenants" AS PERMISSIVE FOR SELECT TO "trustline_app" USING (true);--> statement-breakpoint
CREATE POLICY "tenants_app_own_settings" ON "tenants" AS PERMISSIVE FOR UPDATE TO "trustline_app" USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenants_platform" ON "tenants" AS PERMISSIVE FOR ALL TO "trustline_platform" USING (true) WITH CHECK (true);