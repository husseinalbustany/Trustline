CREATE TYPE "public"."accreditation_standard" AS ENUM('JCI', 'CBAHI');--> statement-breakpoint
CREATE TYPE "public"."org_unit_type" AS ENUM('facility', 'department', 'unit');--> statement-breakpoint
CREATE TABLE "org_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"type" "org_unit_type" NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_units_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "org_units_tenant_id_code_key" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
ALTER TABLE "org_units" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"accreditation_standard" "accreditation_standard" NOT NULL,
	"default_locale" text DEFAULT 'en' NOT NULL,
	"data_region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."org_units"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_units_parent_idx" ON "org_units" USING btree ("tenant_id","parent_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "org_units" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);