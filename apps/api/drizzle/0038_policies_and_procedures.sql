CREATE TYPE "public"."approval_run_status" AS ENUM('in_progress', 'approved', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_run_step_status" AS ENUM('waiting', 'pending', 'approved', 'returned', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."approval_step_kind" AS ENUM('review', 'approve');--> statement-breakpoint
CREATE TYPE "public"."document_confidentiality" AS ENUM('all_staff', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."document_review_outcome" AS ENUM('no_change', 'revised', 'retired');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."document_version_status" AS ENUM('draft', 'in_review', 'approved', 'published', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."signature_meaning" AS ENUM('reviewed', 'approved', 'reviewed_no_change', 'acknowledged');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'document_step_assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'document_returned';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'document_approved';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'document_published';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'acknowledgement_assigned';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'acknowledgement_due';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'acknowledgement_overdue';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'review_due';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'review_overdue';--> statement-breakpoint
CREATE TABLE "approval_route_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "approval_step_kind" NOT NULL,
	"assignee_user_id" uuid,
	"assignee_role_id" uuid,
	"required" integer DEFAULT 1 NOT NULL,
	"due_in_days" integer NOT NULL,
	CONSTRAINT "approval_route_steps_position_key" UNIQUE("tenant_id","route_id","position"),
	CONSTRAINT "approval_route_steps_one_assignee" CHECK (("approval_route_steps"."assignee_user_id" is null) <> ("approval_route_steps"."assignee_role_id" is null)),
	CONSTRAINT "approval_route_steps_required" CHECK ("approval_route_steps"."required" = 1),
	CONSTRAINT "approval_route_steps_due_days" CHECK ("approval_route_steps"."due_in_days" between 1 and 365)
);
--> statement-breakpoint
ALTER TABLE "approval_route_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"subject" text NOT NULL,
	"document_type_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_routes_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_routes_subject" CHECK ("approval_routes"."subject" in ('document'))
);
--> statement-breakpoint
ALTER TABLE "approval_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "approval_step_kind" NOT NULL,
	"assignee_user_id" uuid,
	"assignee_role_id" uuid,
	"due_in_days" integer NOT NULL,
	"status" "approval_run_step_status" DEFAULT 'waiting' NOT NULL,
	"activated_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"signature_id" uuid,
	CONSTRAINT "approval_run_steps_position_key" UNIQUE("tenant_id","run_id","position"),
	CONSTRAINT "approval_run_steps_one_assignee" CHECK (("approval_run_steps"."assignee_user_id" is null) <> ("approval_run_steps"."assignee_role_id" is null))
);
--> statement-breakpoint
ALTER TABLE "approval_run_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" "approval_run_status" DEFAULT 'in_progress' NOT NULL,
	"current_position" integer,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "approval_runs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_runs_subject_type" CHECK ("approval_runs"."subject_type" in ('document_version'))
);
--> statement-breakpoint
ALTER TABLE "approval_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_on" date NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"signature_id" uuid,
	"reminded_at" timestamp with time zone,
	"overdue_reminded_at" timestamp with time zone,
	CONSTRAINT "document_acknowledgements_once_key" UNIQUE("tenant_id","version_id","user_id"),
	CONSTRAINT "document_acknowledgements_signed" CHECK (("document_acknowledgements"."acknowledged_at" is null) = ("document_acknowledgements"."signature_id" is null))
);
--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_audiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"org_unit_id" uuid,
	"role_id" uuid,
	CONSTRAINT "document_audiences_once_key" UNIQUE NULLS NOT DISTINCT("tenant_id","document_id","org_unit_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "document_audiences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"parent_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_categories_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "document_categories_tenant_id_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "document_categories_code_shape" CHECK ("document_categories"."code" ~ '^[A-Z][A-Z0-9]{1,5}$')
);
--> statement-breakpoint
ALTER TABLE "document_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"due_on" date,
	"outcome" "document_review_outcome" NOT NULL,
	"comment" text,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature_id" uuid,
	"next_review_on" date
);
--> statement-breakpoint
ALTER TABLE "document_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"number_prefix" text NOT NULL,
	"sections" jsonb NOT NULL,
	"default_review_months" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_types_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "document_types_tenant_id_code_key" UNIQUE("tenant_id","code"),
	CONSTRAINT "document_types_prefix_shape" CHECK ("document_types"."number_prefix" ~ '^[A-Z][A-Z0-9]{1,5}$'),
	CONSTRAINT "document_types_review_months" CHECK ("document_types"."default_review_months" between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "document_types" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "document_version_status" DEFAULT 'draft' NOT NULL,
	"sections" jsonb NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"change_summary" jsonb,
	"prepared_by" uuid NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contributors" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"effective_on" date,
	"scheduled_by" uuid,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"superseded_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" uuid,
	"acknowledgement_required" boolean DEFAULT false NOT NULL,
	"acknowledge_within_days" integer DEFAULT 14 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "document_versions_number_key" UNIQUE("tenant_id","document_id","version"),
	CONSTRAINT "document_versions_version" CHECK ("document_versions"."version" >= 1),
	CONSTRAINT "document_versions_acknowledge_days" CHECK ("document_versions"."acknowledge_within_days" between 1 and 365)
);
--> statement-breakpoint
ALTER TABLE "document_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"type_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"title" jsonb NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_unit_id" uuid NOT NULL,
	"confidentiality" "document_confidentiality" DEFAULT 'all_staff' NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"review_months" integer NOT NULL,
	"next_review_on" date,
	"last_reviewed_on" date,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"published_version_id" uuid,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	"retire_reason" text,
	"created_by" uuid NOT NULL,
	"review_notice_rank" integer,
	"review_notice_for" date,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "documents_tenant_id_number_key" UNIQUE("tenant_id","number"),
	CONSTRAINT "documents_review_months" CHECK ("documents"."review_months" between 1 and 120),
	CONSTRAINT "documents_active_is_published" CHECK ("documents"."status" <> 'active' or "documents"."published_version_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meaning" "signature_meaning" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"method" text DEFAULT 'password' NOT NULL,
	CONSTRAINT "signatures_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "signatures_subject_type" CHECK ("signatures"."subject_type" in ('document_version', 'document')),
	CONSTRAINT "signatures_method" CHECK ("signatures"."method" in ('password')),
	CONSTRAINT "signatures_hash_shape" CHECK ("signatures"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "signatures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_incident";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_route_steps" ADD CONSTRAINT "approval_route_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_route_steps" ADD CONSTRAINT "approval_route_steps_route_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "public"."approval_routes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_route_steps" ADD CONSTRAINT "approval_route_steps_user_fk" FOREIGN KEY ("tenant_id","assignee_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_route_steps" ADD CONSTRAINT "approval_route_steps_role_fk" FOREIGN KEY ("tenant_id","assignee_role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_routes" ADD CONSTRAINT "approval_routes_document_type_fk" FOREIGN KEY ("tenant_id","document_type_id") REFERENCES "public"."document_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_run_steps" ADD CONSTRAINT "approval_run_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_run_steps" ADD CONSTRAINT "approval_run_steps_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."approval_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_run_steps" ADD CONSTRAINT "approval_run_steps_user_fk" FOREIGN KEY ("tenant_id","assignee_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_run_steps" ADD CONSTRAINT "approval_run_steps_role_fk" FOREIGN KEY ("tenant_id","assignee_role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_run_steps" ADD CONSTRAINT "approval_run_steps_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_run_steps" ADD CONSTRAINT "approval_run_steps_signature_fk" FOREIGN KEY ("tenant_id","signature_id") REFERENCES "public"."signatures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_runs" ADD CONSTRAINT "approval_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_runs" ADD CONSTRAINT "approval_runs_route_fk" FOREIGN KEY ("tenant_id","route_id") REFERENCES "public"."approval_routes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_runs" ADD CONSTRAINT "approval_runs_started_by_fk" FOREIGN KEY ("tenant_id","started_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."document_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_signature_fk" FOREIGN KEY ("tenant_id","signature_id") REFERENCES "public"."signatures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_audiences" ADD CONSTRAINT "document_audiences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_audiences" ADD CONSTRAINT "document_audiences_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_audiences" ADD CONSTRAINT "document_audiences_org_unit_fk" FOREIGN KEY ("tenant_id","org_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_audiences" ADD CONSTRAINT "document_audiences_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_categories" ADD CONSTRAINT "document_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_categories" ADD CONSTRAINT "document_categories_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."document_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_reviewed_by_fk" FOREIGN KEY ("tenant_id","reviewed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_signature_fk" FOREIGN KEY ("tenant_id","signature_id") REFERENCES "public"."signatures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_prepared_by_fk" FOREIGN KEY ("tenant_id","prepared_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_scheduled_by_fk" FOREIGN KEY ("tenant_id","scheduled_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_published_by_fk" FOREIGN KEY ("tenant_id","published_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_withdrawn_by_fk" FOREIGN KEY ("tenant_id","withdrawn_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_fk" FOREIGN KEY ("tenant_id","type_id") REFERENCES "public"."document_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."document_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_unit_fk" FOREIGN KEY ("tenant_id","owner_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_retired_by_fk" FOREIGN KEY ("tenant_id","retired_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signatures" ADD CONSTRAINT "signatures_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_routes_one_active" ON "approval_routes" USING btree ("tenant_id","subject",coalesce("document_type_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "approval_routes"."active";--> statement-breakpoint
CREATE INDEX "approval_run_steps_pending_idx" ON "approval_run_steps" USING btree ("tenant_id","status") WHERE "approval_run_steps"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_runs_subject_idx" ON "approval_runs" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_runs_one_in_progress" ON "approval_runs" USING btree ("tenant_id","subject_type","subject_id") WHERE "approval_runs"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "document_acknowledgements_user_idx" ON "document_acknowledgements" USING btree ("tenant_id","user_id") WHERE "document_acknowledgements"."acknowledged_at" is null;--> statement-breakpoint
CREATE INDEX "document_reviews_document_idx" ON "document_reviews" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_one_published" ON "document_versions" USING btree ("tenant_id","document_id") WHERE "document_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_one_in_progress" ON "document_versions" USING btree ("tenant_id","document_id") WHERE "document_versions"."status" in ('draft', 'in_review', 'approved');--> statement-breakpoint
CREATE INDEX "document_versions_scheduled_idx" ON "document_versions" USING btree ("tenant_id","effective_on") WHERE "document_versions"."status" = 'approved' and "document_versions"."effective_on" is not null;--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("tenant_id","status","next_review_on");--> statement-breakpoint
CREATE INDEX "documents_owner_unit_idx" ON "documents" USING btree ("tenant_id","owner_unit_id");--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("tenant_id","owner_id");--> statement-breakpoint
CREATE INDEX "signatures_subject_idx" ON "signatures" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text = 'public_form_paused'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval_route_steps" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval_routes" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval_run_steps" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval_runs" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_acknowledgements" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_audiences" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_categories" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_reviews" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_types" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_versions" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "documents" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "signatures" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);