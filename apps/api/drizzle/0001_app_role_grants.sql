-- The application role gets the least it needs on each table. Tenant-owned
-- tables are further restricted by their tenant_isolation policy.
GRANT USAGE ON SCHEMA public TO trustline_app;--> statement-breakpoint
GRANT SELECT ON tenants TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON org_units TO trustline_app;
