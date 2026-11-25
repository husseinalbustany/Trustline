ALTER TABLE "incident_comments" ADD COLUMN "as_handler" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "sign_off_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "incidents_public_recent_idx" ON "incidents" USING btree ("tenant_id","reported_at") WHERE "incidents"."channel" = 'public';--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_follow_up_code_key" UNIQUE("tenant_id","follow_up_code_hash");--> statement-breakpoint
ALTER TABLE "incident_comments" ADD CONSTRAINT "incident_comments_one_capacity" CHECK (not ("incident_comments"."by_reporter" and "incident_comments"."as_handler"));