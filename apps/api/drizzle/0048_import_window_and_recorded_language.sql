CREATE TABLE "module_starts" (
	"tenant_id" uuid NOT NULL,
	"module" text NOT NULL,
	"started_on" date NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "module_starts_pkey" PRIMARY KEY("tenant_id","module"),
	CONSTRAINT "module_starts_module" CHECK ("module_starts"."module" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "module_starts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "policy_import_windows" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"closes_on" date NOT NULL,
	"reason" text NOT NULL,
	"set_by" uuid NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_import_windows_reason" CHECK (length("policy_import_windows"."reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "policy_import_windows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "authoritative_locale" text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "signs_authoritative_locale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "module_starts" ADD CONSTRAINT "module_starts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_import_windows" ADD CONSTRAINT "policy_import_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_import_windows" ADD CONSTRAINT "policy_import_windows_set_by_platform_admins_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_authoritative_locale" CHECK ("document_versions"."authoritative_locale" is null or "document_versions"."authoritative_locale" ~ '^[a-z]{2}$');--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_signed_locale_recorded" CHECK (not "document_versions"."signs_authoritative_locale" or "document_versions"."authoritative_locale" is not null);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "module_starts" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "module_starts_platform" ON "module_starts" AS PERMISSIVE FOR SELECT TO "trustline_platform" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "policy_import_windows" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "policy_import_windows_platform" ON "policy_import_windows" AS PERMISSIVE FOR ALL TO "trustline_platform" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER POLICY "audit_log_platform_insert" ON "audit_log" TO trustline_platform WITH CHECK (actor_id IS NULL AND ip_address IS NULL AND action IN ('subscription_changed', 'import_window_changed'));