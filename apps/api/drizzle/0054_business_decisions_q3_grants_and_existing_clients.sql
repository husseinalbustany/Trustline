-- The business decisions after quality review 3 (policies-and-procedures.md):
-- grants for the tables and columns of migration 0053, and what the clients
-- that exist get. Nothing the release running before this migration does is
-- refused: it writes none of these columns, and the importer it lets in
-- (policies.manage for the whole organization) is refused only by the new
-- release. Every statement is safe to repeat.

-- 1. A "no change" review awaiting the Approving authority: written when
-- asked, and decided once (status and the decision). Never deleted.
GRANT SELECT, INSERT ON "document_review_approvals" TO trustline_app;--> statement-breakpoint
GRANT UPDATE ("status", "decided_by", "decided_at", "decision_comment", "decision_signature_id")
  ON "document_review_approvals" TO trustline_app;--> statement-breakpoint

-- 2. The owner's confirmation of an import: given once, then fixed.
GRANT UPDATE ("confirmed_at", "confirmed_by", "confirmation_signature_id")
  ON "document_imports" TO trustline_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "document_imports_keep_confirmation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."confirmed_at" IS NOT NULL AND (
    NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
    OR NEW."confirmed_by" IS DISTINCT FROM OLD."confirmed_by"
    OR NEW."confirmation_signature_id" IS DISTINCT FROM OLD."confirmation_signature_id"
  ) THEN
    RAISE EXCEPTION 'an import is confirmed once'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'document_imports_confirmation_fixed',
            TABLE = 'document_imports';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "document_imports_confirmation_fixed"
BEFORE UPDATE ON "document_imports"
FOR EACH ROW EXECUTE FUNCTION "document_imports_keep_confirmation"();--> statement-breakpoint

-- 3. The imports made before: due 30 days after they were made, on the
-- client's calendar; and confirmed by the import itself where the importer
-- is the document's owner.
UPDATE "document_imports" di
SET "confirmation_due_on" = ((di."imported_at" AT TIME ZONE t."time_zone")::date + 30)
FROM "tenants" t
WHERE t."id" = di."tenant_id" AND di."confirmation_due_on" IS NULL;--> statement-breakpoint
UPDATE "document_imports" di
SET "confirmed_at" = di."imported_at", "confirmed_by" = di."imported_by", "confirmed_by_import" = true
FROM "documents" d
WHERE d."id" = di."document_id" AND d."owner_id" = di."imported_by" AND di."confirmed_at" IS NULL;--> statement-breakpoint

-- 4. "No change" reviews of policies need the Approving authority's
-- signature (business decision 6): the policy type of every client, with
-- an audit entry per client.
UPDATE "document_types" SET "no_change_needs_approval" = true, "revision" = "revision" + 1
WHERE "code" = 'policy' AND NOT "no_change_needs_approval";--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT dt."tenant_id", NULL, 'document_type_changed_by_system', 'document_type', dt."id",
  jsonb_build_object(
    'migration', '0054_business_decisions_q3_grants_and_existing_clients',
    'noChangeNeedsApproval', jsonb_build_object('from', false, 'to', true)
  )
FROM "document_types" dt
WHERE dt."code" = 'policy' AND dt."no_change_needs_approval"
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = dt."tenant_id" AND a."action" = 'document_type_changed_by_system'
      AND a."changes" ->> 'migration' = '0054_business_decisions_q3_grants_and_existing_clients'
  );--> statement-breakpoint

-- 5. Importing is for the Quality officer (business decision 1): the
-- built-in role of every client gets `policies.import`, audited per client.
-- The Administrator never had it. A client's own role of that code is left
-- alone.
UPDATE "roles" SET "permissions" = array_append("permissions", 'policies.import')
WHERE "is_system" AND "code" = 'quality_officer' AND NOT ('policies.import' = ANY ("permissions"));--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT r."tenant_id", NULL, 'built_in_roles_changed_by_system', 'tenant', r."tenant_id",
  jsonb_build_object(
    'migration', '0054_business_decisions_q3_grants_and_existing_clients',
    'roles', jsonb_build_array('quality_officer'),
    'permissionsAdded', jsonb_build_array('policies.import')
  )
FROM "roles" r
WHERE r."is_system" AND r."code" = 'quality_officer' AND 'policies.import' = ANY (r."permissions")
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = r."tenant_id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0054_business_decisions_q3_grants_and_existing_clients'
  );
