ALTER TYPE "public"."notification_kind" ADD VALUE 'signing_pin_locked';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'review_approval_turned_off';--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "document_imports" ADD COLUMN "confirmation_due_from" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signing_pin_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signing_pin_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_confirmation_due_from_fk" FOREIGN KEY ("tenant_id","confirmation_due_from") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off', 'signing_pin_changed', 'signing_pin_locked', 'review_approval_turned_off')));