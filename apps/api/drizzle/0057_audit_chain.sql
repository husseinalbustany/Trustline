CREATE TYPE "public"."audit_chain_break" AS ENUM('content_changed', 'missing_entry', 'missing_seal', 'gap', 'head_rewound', 'backdated', 'bad_checkpoint');--> statement-breakpoint
CREATE TYPE "public"."audit_chain_result" AS ENUM('passed', 'failed');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'audit_chain_broken';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'policies_import_granted';--> statement-breakpoint
CREATE TABLE "audit_chain" (
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"entry_id" uuid NOT NULL,
	"prev_hash" text NOT NULL,
	"body_hash" text NOT NULL,
	"hash" text NOT NULL,
	"ip_commitment" text,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sealed_late" boolean DEFAULT false NOT NULL,
	CONSTRAINT "audit_chain_pkey" PRIMARY KEY("tenant_id","seq"),
	CONSTRAINT "audit_chain_tenant_id_entry_id_key" UNIQUE("tenant_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "audit_chain" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_chain_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"hash" text NOT NULL,
	"at" timestamp (3) with time zone NOT NULL,
	"key_id" text,
	"signature" text,
	CONSTRAINT "audit_chain_checkpoints_signed_whole" CHECK (("audit_chain_checkpoints"."key_id" is null) = ("audit_chain_checkpoints"."signature" is null))
);
--> statement-breakpoint
ALTER TABLE "audit_chain_checkpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_chain_heads" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_chain_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_seq" bigint NOT NULL,
	"to_seq" bigint NOT NULL,
	"full" boolean NOT NULL,
	"result" "audit_chain_result" NOT NULL,
	"kind" "audit_chain_break",
	"first_bad_seq" bigint,
	"first_bad_entry_id" uuid,
	"checkpoint_id" uuid,
	CONSTRAINT "audit_chain_verifications_failure_named" CHECK (("audit_chain_verifications"."result" = 'failed') = ("audit_chain_verifications"."kind" is not null))
);
--> statement-breakpoint
ALTER TABLE "audit_chain_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "ip_salt" text;--> statement-breakpoint
ALTER TABLE "audit_chain" ADD CONSTRAINT "audit_chain_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain_checkpoints" ADD CONSTRAINT "audit_chain_checkpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain_heads" ADD CONSTRAINT "audit_chain_heads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain_verifications" ADD CONSTRAINT "audit_chain_verifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain_verifications" ADD CONSTRAINT "audit_chain_verifications_checkpoint_id_audit_chain_checkpoints_id_fk" FOREIGN KEY ("checkpoint_id") REFERENCES "public"."audit_chain_checkpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_chain_checkpoints_tenant_seq_idx" ON "audit_chain_checkpoints" USING btree ("tenant_id","seq");--> statement-breakpoint
CREATE INDEX "audit_chain_verifications_tenant_run_idx" ON "audit_chain_verifications" USING btree ("tenant_id","run_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off', 'signing_pin_changed', 'signing_pin_locked', 'review_approval_turned_off', 'audit_chain_broken', 'policies_import_granted')));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_chain" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_chain_checkpoints" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_chain_heads" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_chain_verifications" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "audit_chain_verifications_platform_read" ON "audit_chain_verifications" AS PERMISSIVE FOR SELECT TO "trustline_platform" USING (true);