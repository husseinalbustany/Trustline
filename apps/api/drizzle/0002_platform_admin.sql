CREATE TYPE "public"."sign_in_method" AS ENUM('password', 'sso', 'both');--> statement-breakpoint
CREATE TYPE "public"."tenant_plan" AS ENUM('starter', 'professional', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_admins_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "platform_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"target_tenant_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"admin_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_sessions_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status" "tenant_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan" "tenant_plan" DEFAULT 'starter' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "sign_in_method" "sign_in_method" DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit_log" ADD CONSTRAINT "platform_audit_log_target_tenant_id_tenants_id_fk" FOREIGN KEY ("target_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."platform_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_audit_log_tenant_idx" ON "platform_audit_log" USING btree ("target_tenant_id");