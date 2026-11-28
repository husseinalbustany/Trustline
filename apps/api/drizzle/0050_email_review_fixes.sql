-- Security review 8 (L2, L3). Generated, with two changes by hand: the two
-- unique indexes come before the keys that need them, and the one on
-- notifications is made only if it is not there, because migrate.ts builds
-- it concurrently first on a database that already has notifications.
ALTER TYPE "public"."notification_kind" ADD VALUE 'email_turned_off';--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_about_one_thing";--> statement-breakpoint
ALTER TABLE "email_outbox" DROP CONSTRAINT "email_outbox_queue_id_email_queue_id_fk";
--> statement-breakpoint
ALTER TABLE "email_queue" DROP CONSTRAINT "email_queue_notification_id_notifications_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "email_queue_tenant_id_id_key" ON "email_queue" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_tenant_id_id_key" ON "notifications" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "email_preferences" ADD COLUMN "immediate_on_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_preferences" ADD COLUMN "digest_on_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_queue_fk" FOREIGN KEY ("tenant_id","queue_id") REFERENCES "public"."email_queue"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_notification_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."notifications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_about_one_thing" CHECK (("notifications"."incident_id" is null or "notifications"."document_id" is null) and ("notifications"."incident_id" is not null or "notifications"."document_id" is not null or "notifications"."kind"::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off')));