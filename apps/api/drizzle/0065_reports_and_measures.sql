CREATE TYPE "public"."measure_method" AS ENUM('snapshot', 'reconstructed', 'corrected');--> statement-breakpoint
CREATE TYPE "public"."measure_status" AS ENUM('provisional', 'final');--> statement-breakpoint
CREATE TABLE "measure_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"month" date NOT NULL,
	"measure" text NOT NULL,
	"org_unit_id" uuid,
	"unit_basis" text NOT NULL,
	"unit_path" uuid[],
	"value" numeric,
	"numerator" integer,
	"denominator" integer,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target" numeric,
	"target_source" text,
	"status" "measure_status" NOT NULL,
	"method" "measure_method" NOT NULL,
	"revision" integer NOT NULL,
	"reason" text,
	"requested_by" uuid,
	"as_at" timestamp with time zone NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"definition_version" integer NOT NULL,
	CONSTRAINT "measure_snapshots_measure_code" CHECK ("measure_snapshots"."measure" ~ '^[a-z_]+\.[a-z_]+$'),
	CONSTRAINT "measure_snapshots_month_first" CHECK (extract(day from "measure_snapshots"."month") = 1),
	CONSTRAINT "measure_snapshots_revision" CHECK ("measure_snapshots"."revision" >= 1),
	CONSTRAINT "measure_snapshots_correction_said" CHECK (("measure_snapshots"."method" = 'corrected') = ("measure_snapshots"."reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "measure_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "report_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"targets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"baseline_monthly_average" numeric,
	"baseline_note" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "report_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "measure_snapshots" ADD CONSTRAINT "measure_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measure_snapshots" ADD CONSTRAINT "measure_snapshots_unit_fk" FOREIGN KEY ("tenant_id","org_unit_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_settings" ADD CONSTRAINT "report_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "measure_snapshots_once" ON "measure_snapshots" USING btree ("tenant_id","month","measure",coalesce("org_unit_id", '00000000-0000-0000-0000-000000000000'::uuid),"unit_basis","revision");--> statement-breakpoint
CREATE INDEX "measure_snapshots_series_idx" ON "measure_snapshots" USING btree ("tenant_id","measure","org_unit_id","month");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "measure_snapshots" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "report_settings" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);