-- Full data export (docs/specs/data-export.md): what the application may
-- do with an export's record, and `data.export` for the built-in
-- Administrator of every existing client, audited per client. Safe to
-- repeat.

-- 1. An export's record is never deleted: when its file expires, the
-- record stays.
GRANT SELECT, INSERT, UPDATE ON "data_exports" TO trustline_app;--> statement-breakpoint

-- 2. Asking for and approving an export is the Administrator's. A client's
-- own role of that code is left alone.
UPDATE "roles" SET "permissions" = array_append("permissions", 'data.export')
WHERE "is_system" AND "code" = 'administrator'
  AND NOT ('data.export' = ANY ("permissions"));--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT r."tenant_id", NULL, 'built_in_roles_changed_by_system', 'tenant', r."tenant_id",
  jsonb_build_object(
    'migration', '0069_data_exports_grants_and_existing_clients',
    'roles', jsonb_build_array('administrator'),
    'permissionsAdded', jsonb_build_array('data.export')
  )
FROM "roles" r
WHERE r."is_system" AND r."code" = 'administrator'
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = r."tenant_id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0069_data_exports_grants_and_existing_clients'
  );
