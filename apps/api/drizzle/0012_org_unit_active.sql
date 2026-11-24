ALTER TABLE "org_units" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "org_units" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;