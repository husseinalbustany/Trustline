CREATE TYPE "public"."email_category" AS ENUM('immediate', 'daily_digest', 'weekly_digest');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('pending', 'sending', 'sent', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"html_body" text NOT NULL,
	"headers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_preferences" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"immediate" boolean DEFAULT true NOT NULL,
	"digest" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_preferences_pkey" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "email_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"category" "email_category" NOT NULL,
	"notification_id" uuid,
	"period" date,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_queue_about_one_thing" CHECK (("email_queue"."category" = 'daily_digest') = ("email_queue"."notification_id" is null and "email_queue"."period" is not null)),
	CONSTRAINT "email_queue_reason_shape" CHECK ("email_queue"."reason" is null or "email_queue"."reason" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "email_queue_error_shape" CHECK ("email_queue"."last_error" is null or "email_queue"."last_error" ~ '^[A-Za-z0-9_]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "email_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "email_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"digests_queued_on" date,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_queue_id_email_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."email_queue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_preferences" ADD CONSTRAINT "email_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_preferences" ADD CONSTRAINT "email_preferences_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_user_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_queue_key" ON "email_outbox" USING btree ("tenant_id","queue_id");--> statement-breakpoint
CREATE INDEX "email_outbox_created_idx" ON "email_outbox" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_queue_notification_key" ON "email_queue" USING btree ("tenant_id","notification_id") WHERE "email_queue"."notification_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_queue_digest_key" ON "email_queue" USING btree ("tenant_id","user_id","period") WHERE "email_queue"."category" = 'daily_digest';--> statement-breakpoint
CREATE INDEX "email_queue_due_idx" ON "email_queue" USING btree ("tenant_id","next_attempt_at") WHERE "email_queue"."status" in ('pending', 'sending');--> statement-breakpoint
CREATE INDEX "email_queue_finished_idx" ON "email_queue" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "email_outbox" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "email_preferences" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "email_queue" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "email_settings" AS PERMISSIVE FOR ALL TO "trustline_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);