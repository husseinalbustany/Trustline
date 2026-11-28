ALTER TYPE "public"."signature_meaning" ADD VALUE 'imported';--> statement-breakpoint
CREATE TABLE "document_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"imported_by" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"size" integer NOT NULL,
	"list_hash" text NOT NULL,
	CONSTRAINT "document_import_batches_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "document_import_batches_size" CHECK ("document_import_batches"."size" between 1 and 100),
	CONSTRAINT "document_import_batches_hash_shape" CHECK ("document_import_batches"."list_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "document_import_batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"batch_index" integer NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"number_as_given" text,
	"revision_label" text,
	"approved_on" date NOT NULL,
	"approved_by" text NOT NULL,
	"original_kept_at" jsonb NOT NULL,
	"effective_on" date NOT NULL,
	"next_review_on" date NOT NULL,
	"sections_not_written" text[] DEFAULT '{}'::text[] NOT NULL,
	"signature_id" uuid NOT NULL,
	"imported_by" uuid NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_imports_document_key" UNIQUE("tenant_id","document_id"),
	CONSTRAINT "document_imports_version_key" UNIQUE("tenant_id","version_id"),
	CONSTRAINT "document_imports_batch_index_key" UNIQUE("tenant_id","batch_id","batch_index"),
	CONSTRAINT "document_imports_dates" CHECK ("document_imports"."effective_on" >= "document_imports"."approved_on" and "document_imports"."next_review_on" > "document_imports"."approved_on")
);
--> statement-breakpoint
ALTER TABLE "document_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_settings" ADD COLUMN "authoritative_locale" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source" "document_version_source" DEFAULT 'written' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_import_batches" ADD CONSTRAINT "document_import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_import_batches" ADD CONSTRAINT "document_import_batches_imported_by_fk" FOREIGN KEY ("tenant_id","imported_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."document_import_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_version_fk" FOREIGN KEY ("tenant_id","document_id","version_id") REFERENCES "public"."document_versions"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_signature_fk" FOREIGN KEY ("tenant_id","signature_id") REFERENCES "public"."signatures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_imported_by_fk" FOREIGN KEY ("tenant_id","imported_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_number_any_case_key" ON "documents" USING btree ("tenant_id",upper("number"));--> statement-breakpoint
ALTER TABLE "document_settings" ADD CONSTRAINT "document_settings_authoritative_locale" CHECK ("document_settings"."authoritative_locale" ~ '^[a-z]{2}$');--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_imported_first" CHECK ("document_versions"."source" <> 'imported' or "document_versions"."version" = 1);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_import_batches" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_imports" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);