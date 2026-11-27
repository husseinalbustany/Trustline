-- Security review 4. Every statement is safe to repeat.

-- 1. The admin portal adds to a client's audit log only the tenant, action,
-- entity and changes of an entry, so that its id and its time are always
-- the database's own: it cannot backdate one. With the policy changed in
-- 0034 (no actor, no address, `subscription_changed` only), it cannot pass
-- an entry off as one of the client's own staff, nor as anything else.
REVOKE INSERT ON "audit_log" FROM trustline_platform;--> statement-breakpoint
GRANT INSERT ("tenant_id", "action", "entity_type", "entity_id", "changes") ON "audit_log" TO trustline_platform;--> statement-breakpoint

-- 2. The application reads when a subscription last went to or from
-- cancelled, to refuse every session and one-time link issued before.
GRANT SELECT ("access_reset_at") ON "subscriptions" TO trustline_app;
