CREATE TYPE "public"."notification_kind" AS ENUM('incident_reported', 'incident_assigned', 'incident_handed_over', 'comment_added', 'status_changed', 'sign_off_requested', 'sign_off_decided', 'due_soon', 'overdue');--> statement-breakpoint
CREATE TABLE "incident_response_rules" (
	"tenant_id" uuid NOT NULL,
	"harm_level" "incident_harm_level" NOT NULL,
	"triage_within_hours" integer NOT NULL,
	"close_within_days" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_response_rules_pkey" PRIMARY KEY("tenant_id","harm_level"),
	CONSTRAINT "incident_response_rules_triage_hours" CHECK ("incident_response_rules"."triage_within_hours" between 1 and 720),
	CONSTRAINT "incident_response_rules_close_days" CHECK ("incident_response_rules"."close_within_days" between 1 and 365)
);
--> statement-breakpoint
ALTER TABLE "incident_response_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"incident_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "triage_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "close_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "first_triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "triage_due_soon_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "triage_overdue_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "close_due_soon_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "close_overdue_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_response_rules" ADD CONSTRAINT "incident_response_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("tenant_id","user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE INDEX "incidents_triage_due_idx" ON "incidents" USING btree ("tenant_id","status","triage_due_at");--> statement-breakpoint
CREATE INDEX "incidents_close_due_idx" ON "incidents" USING btree ("tenant_id","status","close_due_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_response_rules" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);