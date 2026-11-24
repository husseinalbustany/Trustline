CREATE TYPE "public"."incident_comment_visibility" AS ENUM('everyone', 'internal');--> statement-breakpoint
CREATE TYPE "public"."incident_event_kind" AS ENUM('reported', 'triaged', 'assigned', 'status_changed', 'commented', 'reopened', 'closed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."incident_harm_level" AS ENUM('none', 'mild', 'moderate', 'severe', 'death');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('new', 'triaged', 'in_progress', 'closed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."incident_type" AS ENUM('incident', 'near_miss', 'hazard');--> statement-breakpoint
CREATE TABLE "incident_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "incident_categories_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "incident_categories_tenant_id_code_key" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
ALTER TABLE "incident_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "incident_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"visibility" "incident_comment_visibility" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "incident_event_kind" NOT NULL,
	"actor_id" uuid,
	"from_status" "incident_status",
	"to_status" "incident_status",
	"details" jsonb,
	"visible_to_reporter" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"type" "incident_type" NOT NULL,
	"category_id" uuid NOT NULL,
	"org_unit_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"immediate_action" text,
	"reported_by" uuid,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"harm_level" "incident_harm_level" NOT NULL,
	"is_sentinel" boolean DEFAULT false NOT NULL,
	"status" "incident_status" DEFAULT 'new' NOT NULL,
	"owner_unit_id" uuid,
	"assigned_to" uuid,
	"triaged_by" uuid,
	"triaged_at" timestamp with time zone,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"closure_summary" text,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "incidents_tenant_id_reference_key" UNIQUE("tenant_id","reference")
);
--> statement-breakpoint
ALTER TABLE "incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reference_counters" (
	"tenant_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"year" integer NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "reference_counters_pkey" PRIMARY KEY("tenant_id","prefix","year")
);
--> statement-breakpoint
ALTER TABLE "reference_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_categories" ADD CONSTRAINT "incident_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_author_fk" FOREIGN KEY ("tenant_id","author_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_actor_fk" FOREIGN KEY ("tenant_id","actor_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_category_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."incident_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_org_unit_fk" FOREIGN KEY ("tenant_id","org_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_owner_unit_fk" FOREIGN KEY ("tenant_id","owner_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reported_by_fk" FOREIGN KEY ("tenant_id","reported_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_assigned_to_fk" FOREIGN KEY ("tenant_id","assigned_to") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_triaged_by_fk" FOREIGN KEY ("tenant_id","triaged_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_closed_by_fk" FOREIGN KEY ("tenant_id","closed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_counters" ADD CONSTRAINT "reference_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_comments_incident_idx" ON "incident_comments" USING btree ("tenant_id","incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incident_events_incident_idx" ON "incident_events" USING btree ("tenant_id","incident_id","occurred_at");--> statement-breakpoint
CREATE INDEX "incidents_status_idx" ON "incidents" USING btree ("tenant_id","status","reported_at");--> statement-breakpoint
CREATE INDEX "incidents_reported_by_idx" ON "incidents" USING btree ("tenant_id","reported_by");--> statement-breakpoint
CREATE INDEX "incidents_org_unit_idx" ON "incidents" USING btree ("tenant_id","org_unit_id");--> statement-breakpoint
CREATE INDEX "incidents_owner_unit_idx" ON "incidents" USING btree ("tenant_id","owner_unit_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_categories" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_comments" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_events" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incidents" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reference_counters" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);