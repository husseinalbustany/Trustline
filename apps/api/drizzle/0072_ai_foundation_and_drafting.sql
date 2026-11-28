CREATE TYPE "public"."ai_feature" AS ENUM('drafting', 'insights', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."ai_inference_type" AS ENUM('in_region', 'regional', 'global');--> statement-breakpoint
CREATE TYPE "public"."ai_provider_kind" AS ENUM('anthropic', 'bedrock');--> statement-breakpoint
CREATE TYPE "public"."ai_request_outcome" AS ENUM('pending', 'succeeded', 'failed', 'refused');--> statement-breakpoint
CREATE TYPE "public"."ai_usage_notice_level" AS ENUM('warning', 'reached');--> statement-breakpoint
CREATE TYPE "public"."drafting_author" AS ENUM('assistant', 'person');--> statement-breakpoint
CREATE TYPE "public"."drafting_message_kind" AS ENUM('questions', 'answers', 'revision_request');--> statement-breakpoint
CREATE TYPE "public"."drafting_status" AS ENUM('asking', 'ready', 'drafted', 'handed_over', 'discarded');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ai_provider_changed';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ai_allowance_warning';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'ai_allowance_reached';--> statement-breakpoint
CREATE TABLE "ai_client_features" (
	"tenant_id" uuid NOT NULL,
	"feature" "ai_feature" NOT NULL,
	"connection_id" uuid NOT NULL,
	"model" text NOT NULL,
	"quick_model" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_client_features_pkey" PRIMARY KEY("tenant_id","feature")
);
--> statement-breakpoint
ALTER TABLE "ai_client_features" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_client_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"offered" boolean DEFAULT false NOT NULL,
	"allowance_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"medical_option_allowed" boolean DEFAULT false NOT NULL,
	"monthly_spending_limit_micro_usd" bigint,
	"client_enabled" boolean DEFAULT false NOT NULL,
	"client_switched_by" uuid,
	"client_switched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_client_settings_spending_limit" CHECK ("ai_client_settings"."monthly_spending_limit_micro_usd" is null or "ai_client_settings"."monthly_spending_limit_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_client_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_platform_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"monthly_spending_limit_micro_usd" bigint,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_platform_settings_one_row" CHECK ("ai_platform_settings"."id"),
	CONSTRAINT "ai_platform_settings_spending_limit" CHECK ("ai_platform_settings"."monthly_spending_limit_micro_usd" is null or "ai_platform_settings"."monthly_spending_limit_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "ai_provider_kind" NOT NULL,
	"region" text NOT NULL,
	"inference_type" "ai_inference_type" NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_env" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_connections_name_unique" UNIQUE("name"),
	CONSTRAINT "ai_provider_connections_credential_env" CHECK ("ai_provider_connections"."credential_env" ~ '^AI_CREDENTIAL_[A-Z0-9_]{1,50}$'),
	CONSTRAINT "ai_provider_connections_name" CHECK (length("ai_provider_connections"."name") between 1 and 100),
	CONSTRAINT "ai_provider_connections_region" CHECK ("ai_provider_connections"."region" ~ '^[a-z0-9-]{2,30}$')
);
--> statement-breakpoint
CREATE TABLE "ai_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"feature" "ai_feature" NOT NULL,
	"connection_id" uuid NOT NULL,
	"model" text NOT NULL,
	"user_id" uuid,
	"month" text NOT NULL,
	"unit_key" uuid,
	"counted" boolean NOT NULL,
	"outcome" "ai_request_outcome" NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ai_requests_month" CHECK ("ai_requests"."month" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "ai_requests_sizes" CHECK ("ai_requests"."input_tokens" >= 0 and "ai_requests"."output_tokens" >= 0 and "ai_requests"."cost_micro_usd" >= 0 and "ai_requests"."attempts" between 0 and 2)
);
--> statement-breakpoint
ALTER TABLE "ai_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_usage_notices" (
	"tenant_id" uuid NOT NULL,
	"month" text NOT NULL,
	"feature" "ai_feature" NOT NULL,
	"level" "ai_usage_notice_level" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_notices_pkey" PRIMARY KEY("tenant_id","month","feature","level")
);
--> statement-breakpoint
ALTER TABLE "ai_usage_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_type_id" uuid,
	"version" integer NOT NULL,
	"template" jsonb NOT NULL,
	"writing" jsonb NOT NULL,
	"section_guidance" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_designs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "document_designs_version" CHECK ("document_designs"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "document_designs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drafting_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" "drafting_message_kind" NOT NULL,
	"body" jsonb NOT NULL,
	"ai_request_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafting_messages_seq_key" UNIQUE("tenant_id","session_id","seq")
);
--> statement-breakpoint
ALTER TABLE "drafting_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drafting_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"document_type_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"request" text NOT NULL,
	"status" "drafting_status" DEFAULT 'asking' NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"design_id" uuid,
	"document_id" uuid,
	"handed_over_version" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafting_sessions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "drafting_sessions_request" CHECK (length("drafting_sessions"."request") between 1 and 4000),
	CONSTRAINT "drafting_sessions_handed_over" CHECK (("drafting_sessions"."status" = 'handed_over') = ("drafting_sessions"."document_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "drafting_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drafting_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"author" "drafting_author" NOT NULL,
	"content" jsonb NOT NULL,
	"title" jsonb NOT NULL,
	"gaps" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"model" text,
	"ai_request_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafting_versions_number_key" UNIQUE("tenant_id","session_id","number"),
	CONSTRAINT "drafting_versions_number" CHECK ("drafting_versions"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "drafting_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organization_profiles" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ai_draft_session_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ai_draft_owned_by" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "ai_draft_owned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "ai_allowances" jsonb DEFAULT '{"drafting":0,"insights":0,"assistant":0}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_client_features" ADD CONSTRAINT "ai_client_features_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_client_features" ADD CONSTRAINT "ai_client_features_connection_id_ai_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ai_provider_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_client_settings" ADD CONSTRAINT "ai_client_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_client_settings" ADD CONSTRAINT "ai_client_settings_switched_by_fk" FOREIGN KEY ("tenant_id","client_switched_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_platform_settings" ADD CONSTRAINT "ai_platform_settings_updated_by_platform_admins_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_connection_id_ai_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."ai_provider_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_notices" ADD CONSTRAINT "ai_usage_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_designs" ADD CONSTRAINT "document_designs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_designs" ADD CONSTRAINT "document_designs_type_fk" FOREIGN KEY ("tenant_id","document_type_id") REFERENCES "public"."document_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_designs" ADD CONSTRAINT "document_designs_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_messages" ADD CONSTRAINT "drafting_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_messages" ADD CONSTRAINT "drafting_messages_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."drafting_sessions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_sessions" ADD CONSTRAINT "drafting_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_sessions" ADD CONSTRAINT "drafting_sessions_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_sessions" ADD CONSTRAINT "drafting_sessions_type_fk" FOREIGN KEY ("tenant_id","document_type_id") REFERENCES "public"."document_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_sessions" ADD CONSTRAINT "drafting_sessions_design_fk" FOREIGN KEY ("tenant_id","design_id") REFERENCES "public"."document_designs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_sessions" ADD CONSTRAINT "drafting_sessions_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_versions" ADD CONSTRAINT "drafting_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafting_versions" ADD CONSTRAINT "drafting_versions_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."drafting_sessions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_profiles" ADD CONSTRAINT "organization_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_profiles" ADD CONSTRAINT "organization_profiles_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_client_features_connection_idx" ON "ai_client_features" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "ai_requests_month_idx" ON "ai_requests" USING btree ("tenant_id","month","feature");--> statement-breakpoint
CREATE INDEX "ai_requests_unit_idx" ON "ai_requests" USING btree ("tenant_id","unit_key","month") WHERE "ai_requests"."unit_key" is not null;--> statement-breakpoint
CREATE INDEX "ai_requests_created_idx" ON "ai_requests" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_designs_version_key" ON "document_designs" USING btree ("tenant_id",coalesce("document_type_id", '00000000-0000-0000-0000-000000000000'::uuid),"version");--> statement-breakpoint
CREATE INDEX "drafting_sessions_owner_idx" ON "drafting_sessions" USING btree ("tenant_id","created_by","status");--> statement-breakpoint
CREATE INDEX "drafting_sessions_activity_idx" ON "drafting_sessions" USING btree ("last_activity_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off', 'signing_pin_changed', 'signing_pin_locked', 'review_approval_turned_off', 'audit_chain_broken', 'policies_import_granted', 'external_access_changed', 'audit_chain_head', 'data_export_changed', 'ai_provider_changed', 'ai_allowance_warning', 'ai_allowance_reached')));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_client_features" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ai_client_features_platform" ON "ai_client_features" AS PERMISSIVE FOR ALL TO "trustline_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_client_settings" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ai_client_settings_platform" ON "ai_client_settings" AS PERMISSIVE FOR ALL TO "trustline_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_requests" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ai_requests_platform_read" ON "ai_requests" AS PERMISSIVE FOR SELECT TO "trustline_platform" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_usage_notices" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_designs" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "drafting_messages" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "drafting_sessions" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "drafting_sessions_keep_handed_over" ON "drafting_sessions" AS RESTRICTIVE FOR DELETE TO "trustline_app" USING ("drafting_sessions"."status" <> 'handed_over');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "drafting_versions" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "organization_profiles" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER POLICY "audit_log_platform_insert" ON "audit_log" TO trustline_platform WITH CHECK (actor_id IS NULL AND ip_address IS NULL AND action IN ('subscription_changed', 'import_window_changed', 'client_created_by_platform', 'client_settings_changed_by_platform', 'ai_settings_changed'));