-- The admin portal's role manages client records and platform staff sessions.
-- It gets nothing on tenant data tables, and cannot create platform admins or
-- alter the audit log.
GRANT USAGE ON SCHEMA public TO trustline_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON tenants TO trustline_platform;--> statement-breakpoint
GRANT SELECT, UPDATE ON platform_admins TO trustline_platform;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON platform_sessions TO trustline_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON platform_audit_log TO trustline_platform;
