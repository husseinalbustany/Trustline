-- External reviewers, and how long addresses are kept
-- (docs/specs/audit-trail.md, steps 6 and "Personal data in the trail").
-- Safe to repeat.

-- 1. The one-time sign-in codes: the application adds them, counts the
-- tries and marks them used; it never changes what was sent.
GRANT SELECT, INSERT, DELETE ON "sign_in_codes" TO trustline_app;--> statement-breakpoint
GRANT UPDATE ("attempts", "used_at") ON "sign_in_codes" TO trustline_app;--> statement-breakpoint

-- 2. The built-in "External reviewer" role, for every client that exists
-- (new ones get it from ensureSystemRoles): reading only, never reporters'
-- names. A client's own role of that code is left alone. Audited per
-- client.
INSERT INTO "roles" ("tenant_id", "code", "name", "description", "is_system", "permissions")
SELECT t."id", 'external_reviewer',
  jsonb_build_object('en', 'External reviewer', 'ar', 'مراجع خارجي', 'fr', 'Évaluateur externe'),
  jsonb_build_object(
    'en', 'A surveyor or auditor from outside, for a few days: reads the audit trail, every document, incidents without their reporters, and reports.',
    'ar', 'مُقيِّم أو مدقق من خارج المؤسسة لبضعة أيام: يطّلع على سجل التدقيق وكل الوثائق والحوادث دون أسماء المُبلِّغين والتقارير.',
    'fr', 'Un évaluateur ou un auditeur extérieur, pour quelques jours : consulte le journal d’audit, tous les documents, les incidents sans leurs déclarants, et les rapports.'
  ),
  true, ARRAY['audit.view', 'policies.view_all', 'incidents.view', 'reports.view']::text[]
FROM "tenants" t
ON CONFLICT ("tenant_id", "code") DO NOTHING;--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT r."tenant_id", NULL, 'built_in_roles_changed_by_system', 'tenant', r."tenant_id",
  jsonb_build_object(
    'migration', '0061_external_reviewers_and_addresses',
    'rolesAdded', jsonb_build_array('external_reviewer')
  )
FROM "roles" r
WHERE r."is_system" AND r."code" = 'external_reviewer'
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = r."tenant_id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0061_external_reviewers_and_addresses'
  );--> statement-breakpoint

-- 3. Addresses of sign-ins are kept two years (decision 7), then cleared
-- with their salt, and nothing else: the sealed body holds only the
-- commitment, so the chain stays whole. For the calling transaction's own
-- client, and never an address younger than two years, whatever is asked.
CREATE OR REPLACE FUNCTION "audit_log_forget_addresses"(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  client uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  cleared integer;
BEGIN
  IF client IS NULL THEN
    RAISE EXCEPTION 'addresses are cleared for the client of the transaction only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_before > now() - interval '2 years' THEN
    RAISE EXCEPTION 'addresses are kept two years'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE "audit_log" SET "ip_address" = NULL, "ip_salt" = NULL
  WHERE "tenant_id" = client AND "occurred_at" < p_before AND "ip_address" IS NOT NULL;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit_log_forget_addresses"(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "audit_log_forget_addresses"(timestamptz) TO trustline_app;
