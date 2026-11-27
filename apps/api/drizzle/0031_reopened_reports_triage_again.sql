ALTER TABLE "incidents" ADD COLUMN "triage_due_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "first_triage_due_at" timestamp with time zone;