ALTER TABLE "audit_chain_verifications" DROP CONSTRAINT "audit_chain_verifications_checkpoint_id_audit_chain_checkpoints_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_chain_verifications" ADD COLUMN "confirmed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_chain_checkpoints" ADD CONSTRAINT "audit_chain_checkpoints_tenant_id_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "audit_chain_verifications" ADD CONSTRAINT "audit_chain_verifications_checkpoint_fk" FOREIGN KEY ("tenant_id","checkpoint_id") REFERENCES "public"."audit_chain_checkpoints"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_chain_checkpoints" ADD CONSTRAINT "audit_chain_checkpoints_not_ahead" CHECK ("audit_chain_checkpoints"."at" <= now() + interval '5 minutes');--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_action_word" CHECK ("audit_log"."action" ~ '^[a-z_]+$');--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_entity_type_word" CHECK ("audit_log"."entity_type" is null or "audit_log"."entity_type" ~ '^[a-z_]+$');