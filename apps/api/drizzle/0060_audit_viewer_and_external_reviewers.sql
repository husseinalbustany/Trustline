CREATE TYPE "public"."user_kind" AS ENUM('staff', 'external_reviewer');--> statement-breakpoint
ALTER TYPE "public"."email_category" ADD VALUE 'sign_in_code';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'external_access_changed';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'audit_chain_head';--> statement-breakpoint
CREATE TABLE "sign_in_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"challenge_hash" text NOT NULL,
	"code_hash" text NOT NULL,
	"client" text DEFAULT 'web' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_codes_challengeHash_unique" UNIQUE("challenge_hash")
);
--> statement-breakpoint
ALTER TABLE "sign_in_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" "user_kind" DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_from" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_until" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_organization" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_purpose" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_extended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_extension_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "access_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sign_in_codes" ADD CONSTRAINT "sign_in_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_in_codes" ADD CONSTRAINT "sign_in_codes_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_time_idx" ON "audit_log" USING btree ("tenant_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("tenant_id","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("tenant_id","action","occurred_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off', 'signing_pin_changed', 'signing_pin_locked', 'review_approval_turned_off', 'audit_chain_broken', 'policies_import_granted', 'external_access_changed', 'audit_chain_head')));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_external_access" CHECK (("users"."kind" = 'external_reviewer') = ("users"."access_from" is not null and "users"."access_until" is not null));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sign_in_codes" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "audit_log_platform_insert" ON "audit_log" TO trustline_platform WITH CHECK (actor_id IS NULL AND ip_address IS NULL AND action IN ('subscription_changed', 'import_window_changed', 'client_created_by_platform', 'client_settings_changed_by_platform'));