CREATE TABLE "export_second_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_tenant_id" uuid NOT NULL,
	"export_id" uuid NOT NULL,
	"written_request" jsonb NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "export_second_approvals_two_people" CHECK ("export_second_approvals"."approved_by" is null or "export_second_approvals"."approved_by" <> "export_second_approvals"."recorded_by")
);
--> statement-breakpoint
ALTER TABLE "client_deletions" ADD COLUMN "certificate_text" text;--> statement-breakpoint
ALTER TABLE "export_second_approvals" ADD CONSTRAINT "export_second_approvals_target_tenant_id_tenants_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_second_approvals" ADD CONSTRAINT "export_second_approvals_recorded_by_platform_admins_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_second_approvals" ADD CONSTRAINT "export_second_approvals_approved_by_platform_admins_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "export_second_approvals_once" ON "export_second_approvals" USING btree ("export_id");