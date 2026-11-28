CREATE TYPE "public"."client_deletion_status" AS ENUM('requested', 'approved', 'done', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'contract_ending' BEFORE 'risk_owner_assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'data_export_granted' BEFORE 'risk_owner_assigned';--> statement-breakpoint
ALTER TYPE "public"."tenant_status" ADD VALUE 'deleted';--> statement-breakpoint
CREATE TABLE "client_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"status" "client_deletion_status" DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"written_instruction" jsonb,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"certificate" jsonb,
	"certificate_sha256" text,
	"signature" jsonb,
	CONSTRAINT "client_deletions_two_people" CHECK ("client_deletions"."approved_by" is null or "client_deletions"."approved_by" <> "client_deletions"."requested_by"),
	CONSTRAINT "client_deletions_reason" CHECK (length("client_deletions"."reason") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "data_exports" ADD COLUMN "trustline_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "data_exports" ADD COLUMN "trustline_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_exports" ADD COLUMN "written_request" jsonb;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "ends_on" date;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "exit_until" date;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "retain_until" date;--> statement-breakpoint
ALTER TABLE "client_deletions" ADD CONSTRAINT "client_deletions_target_tenant_id_tenants_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deletions" ADD CONSTRAINT "client_deletions_requested_by_platform_admins_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_deletions" ADD CONSTRAINT "client_deletions_approved_by_platform_admins_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_deletions_one_open" ON "client_deletions" USING btree ("target_tenant_id") WHERE "client_deletions"."status" in ('requested', 'approved');--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_trustline_approved_by_platform_admins_id_fk" FOREIGN KEY ("trustline_approved_by") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_not_self_refused" CHECK ("data_exports"."refused_by" is null or "data_exports"."refused_by" <> "data_exports"."requested_by");--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_one_approval" CHECK (("data_exports"."trustline_approved_by" is null or "data_exports"."approved_by" is null) and (("data_exports"."trustline_approved_by" is null) = ("data_exports"."written_request" is null)));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_retain_after_exit" CHECK ("subscriptions"."retain_until" is null or "subscriptions"."exit_until" is null or "subscriptions"."retain_until" >= "subscriptions"."exit_until");--> statement-breakpoint
CREATE POLICY "data_exports_platform_read" ON "data_exports" AS PERMISSIVE FOR SELECT TO "trustline_platform" USING (true);--> statement-breakpoint
ALTER POLICY "audit_log_platform_insert" ON "audit_log" TO trustline_platform WITH CHECK (actor_id IS NULL AND ip_address IS NULL AND action IN ('subscription_changed', 'import_window_changed', 'client_created_by_platform', 'client_settings_changed_by_platform', 'ai_settings_changed', 'contract_end_set'));