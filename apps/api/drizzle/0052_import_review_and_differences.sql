ALTER TYPE "public"."notification_kind" ADD VALUE 'document_owner_assigned' BEFORE 'email_turned_off';--> statement-breakpoint
ALTER TABLE "document_imports" ADD COLUMN "last_reviewed_on" date;--> statement-breakpoint
ALTER TABLE "document_imports" ADD COLUMN "differences" jsonb;--> statement-breakpoint
ALTER TABLE "document_imports" ADD CONSTRAINT "document_imports_last_reviewed" CHECK ("document_imports"."last_reviewed_on" is null or ("document_imports"."last_reviewed_on" >= "document_imports"."approved_on" and "document_imports"."next_review_on" > "document_imports"."last_reviewed_on"));