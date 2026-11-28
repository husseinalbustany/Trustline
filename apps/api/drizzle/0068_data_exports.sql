CREATE TYPE "public"."data_export_reason" AS ENUM('contract_end', 'on_request');--> statement-breakpoint
CREATE TYPE "public"."data_export_status" AS ENUM('requested', 'approved', 'refused', 'lapsed', 'cancelled', 'making', 'ready', 'failed', 'expired');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'data_export_changed';--> statement-breakpoint
CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reason" "data_export_reason" NOT NULL,
	"note" text,
	"locale" text NOT NULL,
	"include_pdfs" boolean DEFAULT false NOT NULL,
	"status" "data_export_status" DEFAULT 'requested' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lapses_at" timestamp with time zone NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"refused_by" uuid,
	"refused_at" timestamp with time zone,
	"refused_reason" text,
	"cancelled_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"phase" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_kind" text,
	"snapshot_at" timestamp with time zone,
	"counts" jsonb,
	"size_bytes" bigint,
	"archive_sha256" text,
	"manifest_sha256" text,
	"storage_key" text,
	"wrapped_key" text,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"downloads" integer DEFAULT 0 NOT NULL,
	"last_downloaded_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_exports_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "data_exports_not_self_approved" CHECK ("data_exports"."approved_by" is null or "data_exports"."approved_by" <> "data_exports"."requested_by"),
	CONSTRAINT "data_exports_downloads" CHECK ("data_exports"."downloads" between 0 and 5),
	CONSTRAINT "data_exports_note" CHECK ("data_exports"."note" is null or length("data_exports"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "data_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_refused_by_fk" FOREIGN KEY ("tenant_id","refused_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_exports_one_open" ON "data_exports" USING btree ("tenant_id") WHERE "data_exports"."status" in ('requested', 'approved', 'making');--> statement-breakpoint
CREATE INDEX "data_exports_tenant_idx" ON "data_exports" USING btree ("tenant_id","requested_at");--> statement-breakpoint
CREATE INDEX "data_exports_status_idx" ON "data_exports" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off', 'signing_pin_changed', 'signing_pin_locked', 'review_approval_turned_off', 'audit_chain_broken', 'policies_import_granted', 'external_access_changed', 'audit_chain_head', 'data_export_changed')));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "data_exports" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);