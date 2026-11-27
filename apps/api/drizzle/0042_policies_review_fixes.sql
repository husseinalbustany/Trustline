CREATE TYPE "public"."document_version_source" AS ENUM('written', 'imported', 'ai_drafted');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'document_step_overdue';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'document_publish_failed';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'acknowledgements_overdue_digest';--> statement-breakpoint
CREATE TABLE "document_review_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sections" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"change_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_review_rounds_run_key" UNIQUE("tenant_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "document_review_rounds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"max_review_months" integer DEFAULT 36 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_settings_max_review_months" CHECK ("document_settings"."max_review_months" between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "document_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "policy_reminders" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"period" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_reminders_pkey" PRIMARY KEY("tenant_id","kind","subject_id","period"),
	CONSTRAINT "policy_reminders_kind" CHECK ("policy_reminders"."kind" in ('step_overdue', 'publish_failed', 'acknowledgement_digest'))
);
--> statement-breakpoint
ALTER TABLE "policy_reminders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "document_categories" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_types" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "source" "document_version_source" DEFAULT 'written' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_review_rounds" ADD CONSTRAINT "document_review_rounds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_rounds" ADD CONSTRAINT "document_review_rounds_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."document_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_rounds" ADD CONSTRAINT "document_review_rounds_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."approval_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_settings" ADD CONSTRAINT "document_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_settings" ADD CONSTRAINT "document_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_reminders" ADD CONSTRAINT "policy_reminders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_review_rounds_version_idx" ON "document_review_rounds" USING btree ("tenant_id","version_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest')));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_review_rounds" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_settings" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "policy_reminders" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);