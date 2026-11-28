-- Reports and measures (docs/specs/reports-and-measures.md): who may read
-- and write the snapshots and settings, a snapshot never changed, and
-- `reports.manage` for the built-in Administrator and Quality officer of
-- every existing client, audited per client. Safe to repeat.

-- 1. A month's figure is never changed nor deleted by the application:
-- read and added only. A correction is a new revision.
GRANT SELECT, INSERT ON "measure_snapshots" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "report_settings" TO trustline_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "measure_snapshots_fixed"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a month''s figure is never changed: add a revision'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'measure_snapshots_fixed',
          TABLE = 'measure_snapshots';
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "measure_snapshots_fixed" ON "measure_snapshots";--> statement-breakpoint
CREATE TRIGGER "measure_snapshots_fixed" BEFORE UPDATE ON "measure_snapshots"
FOR EACH ROW EXECUTE FUNCTION "measure_snapshots_fixed"();--> statement-breakpoint

-- 2. Corrections, targets and the baseline are the Administrator's and the
-- Quality officer's. A client's own role of either code is left alone.
UPDATE "roles" SET "permissions" = array_append("permissions", 'reports.manage')
WHERE "is_system" AND "code" IN ('administrator', 'quality_officer')
  AND NOT ('reports.manage' = ANY ("permissions"));--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT t."id", NULL, 'built_in_roles_changed_by_system', 'tenant', t."id",
  jsonb_build_object(
    'migration', '0066_reports_grants_and_existing_clients',
    'roles', jsonb_build_array('administrator', 'quality_officer'),
    'permissionsAdded', jsonb_build_array('reports.manage')
  )
FROM "tenants" t
WHERE EXISTS (
    SELECT FROM "roles" r
    WHERE r."tenant_id" = t."id" AND r."is_system" AND r."code" IN ('administrator', 'quality_officer')
  )
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = t."id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0066_reports_grants_and_existing_clients'
  );
