CREATE TYPE "public"."review_approval_status" AS ENUM('pending', 'approved', 'returned');--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'import_confirmation_due';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'review_approval_requested';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'review_returned';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'signing_pin_changed';--> statement-breakpoint
ALTER TYPE "public"."signature_meaning" ADD VALUE 'import_confirmed';--> statement-breakpoint
ALTER TYPE "public"."signature_meaning" ADD VALUE 'reviewed_no_change_approved';--> statement-breakpoint
CREATE TABLE "document_review_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"due_on" date,
	"comment" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_signature_id" uuid NOT NULL,
	"status" "review_approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"decision_signature_id" uuid,
	CONSTRAINT "document_review_approvals_decided" CHECK (("document_review_approvals"."status" = 'pending') = ("document_review_approvals"."decided_by" is null and "document_review_approvals"."decided_at" is null)),
	CONSTRAINT "document_review_approvals_approved_signed" CHECK ("document_review_approvals"."status" <> 'approved' or "document_review_approvals"."decision_signature_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "document_review_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "policy_reminders" DROP CONSTRAINT "policy_reminders_kind";--> statement-breakpoint
ALTER TABLE "document_imports" ADD COLUMN "confirmation_due_on" date;--> statement-breakpoint
ALTER TABLE "document_imports" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_imports" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "document_imports" ADD COLUMN "confirmation_signature_id" uuid;--> statement-breakpoint
ALTER TABLE "document_imports" ADD COLUMN "confirmed_by_import" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_reviews" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "document_reviews" ADD COLUMN "approval_signature_id" uuid;--> statement-breakpoint
ALTER TABLE "document_types" ADD COLUMN "no_change_needs_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "authoritative_locale" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signing_pin_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signing_pin_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_review_approvals" ADD CONSTRAINT "document_review_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_approvals" ADD CONSTRAINT "document_review_approvals_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_approvals" ADD CONSTRAINT "document_review_approvals_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_approvals" ADD CONSTRAINT "document_review_approvals_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_approvals" ADD CONSTRAINT "document_review_approvals_request_signature_fk" FOREIGN KEY ("tenant_id","request_signature_id") REFERENCES "public"."signatures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_review_approvals" ADD CONSTRAINT "document_review_approvals_decision_signature_fk" FOREIGN KEY ("tenant_id","decision_signature_id") REFERENCES "public"."signatures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_review_approvals_one_pending" ON "document_review_approvals" USING btree ("tenant_id","document_id") WHERE "document_review_approvals"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_confirmed_by_fk" FOREIGN KEY ("tenant_id","confirmed_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_confirmation_signature_fk" FOREIGN KEY ("tenant_id","confirmation_signature_id") REFERENCES "public"."signatures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_approved_by_fk" FOREIGN KEY ("tenant_id","approved_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_approval_signature_fk" FOREIGN KEY ("tenant_id","approval_signature_id") REFERENCES "public"."signatures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_confirmation" CHECK ("document_imports"."confirmed_at" is null or ("document_imports"."confirmed_by" is not null and ("document_imports"."confirmed_by_import" or "document_imports"."confirmation_signature_id" is not null)));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_authoritative_locale" CHECK ("documents"."authoritative_locale" is null or "documents"."authoritative_locale" ~ '^[a-z]{2}$');--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off', 'signing_pin_changed')));--> statement-breakpoint
ALTER TABLE "policy_reminders" ADD CONSTRAINT "policy_reminders_kind" CHECK ("policy_reminders"."kind" in ('step_overdue', 'publish_failed', 'acknowledgement_digest', 'import_confirmation_due', 'import_confirmation_overdue'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_method" CHECK ("sessions"."method" in ('password', 'sso'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_review_approvals" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);