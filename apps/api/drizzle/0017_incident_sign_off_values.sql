ALTER TYPE "public"."incident_event_kind" ADD VALUE 'sign_off_requested';--> statement-breakpoint
ALTER TYPE "public"."incident_event_kind" ADD VALUE 'signed_off';--> statement-breakpoint
ALTER TYPE "public"."incident_event_kind" ADD VALUE 'sent_back';--> statement-breakpoint
ALTER TYPE "public"."incident_status" ADD VALUE 'awaiting_sign_off' BEFORE 'closed';