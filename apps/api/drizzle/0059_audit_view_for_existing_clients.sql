-- Reading the audit trail (`audit.view`) is the Administrator's and the
-- Quality officer's (docs/specs/audit-trail.md, decided by the business on
-- 28 November 2026): the built-in roles of every existing client get it,
-- with an audit entry per client, sealed in its chain. A client's own role
-- of either code is left alone. Safe to repeat.
UPDATE "roles" SET "permissions" = array_append("permissions", 'audit.view')
WHERE "is_system" AND "code" IN ('administrator', 'quality_officer')
  AND NOT ('audit.view' = ANY ("permissions"));--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT t."id", NULL, 'built_in_roles_changed_by_system', 'tenant', t."id",
  jsonb_build_object(
    'migration', '0059_audit_view_for_existing_clients',
    'roles', jsonb_build_array('administrator', 'quality_officer'),
    'permissionsAdded', jsonb_build_array('audit.view')
  )
FROM "tenants" t
WHERE EXISTS (
    SELECT FROM "roles" r
    WHERE r."tenant_id" = t."id" AND r."is_system" AND r."code" IN ('administrator', 'quality_officer')
  )
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = t."id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0059_audit_view_for_existing_clients'
  );
