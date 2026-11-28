-- The policies module after the business's decisions on its open points
-- (docs/specs/policies-and-procedures.md, "Decided by the business after
-- the quality review"): what the application role may do on the import
-- tables of migration 0044, what of a document and a version never changes
-- once written, and the built-in Approving authority role with the
-- starting approval route that names it, for the clients that exist.
-- Nothing the release running from before this migration does is refused
-- by any of it. Every statement is safe to repeat.

-- 1. What the application role may do. Row-level security further limits
-- every statement to one tenant. trustline_platform gets nothing: these are
-- client data. An import and what it says of the original are written
-- once: they change only through a new version of the document.
GRANT SELECT, INSERT ON document_import_batches TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON document_imports TO trustline_app;--> statement-breakpoint

-- 2. Where a version came from never changes: an imported version is
-- shown as approved before Trustline, a written one as approved through
-- the route, and neither may pass for the other.
CREATE OR REPLACE FUNCTION "document_versions_keep_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION 'a version keeps where it came from'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'document_versions_source_fixed',
            TABLE = 'document_versions';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE OR REPLACE TRIGGER "document_versions_source_fixed"
BEFORE UPDATE ON "document_versions"
FOR EACH ROW EXECUTE FUNCTION "document_versions_keep_source"();--> statement-breakpoint

-- A document keeps its number for life (an imported one, the number it was
-- given), and where it came from.
CREATE OR REPLACE FUNCTION "documents_keep_number_and_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."number" IS DISTINCT FROM OLD."number"
    OR NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION 'a document keeps its number and where it came from'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'documents_number_fixed',
            TABLE = 'documents';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE OR REPLACE TRIGGER "documents_number_fixed"
BEFORE UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION "documents_keep_number_and_source"();--> statement-breakpoint

-- 3. The built-in Approving authority (src/identity/permissions.ts,
-- SYSTEM_ROLES, which gives it to a new client): reads every document and
-- gives the final approval. For every client that has the built-in roles
-- and no role of that code yet; a role of that code a client made itself is
-- left as it is, and the client gets none. One audit entry per client that
-- got it, as for earlier changes to the built-in roles. No actor: it was
-- the system.
WITH "added" AS (
  INSERT INTO "roles" ("tenant_id", "code", "name", "description", "is_system", "permissions")
  SELECT t."id", 'approving_authority',
    '{"en": "Approving authority", "ar": "صاحب صلاحية الاعتماد", "fr": "Autorité d’approbation"}'::jsonb,
    '{"en": "Gives the final approval of controlled documents, and reads every document, restricted ones and drafts included.", "ar": "يمنح الاعتماد النهائي للوثائق المضبوطة، ويقرأ كل الوثائق بما فيها المقيّدة والمسودات.", "fr": "Donne l’approbation finale des documents maîtrisés, et lit tous les documents, y compris restreints et brouillons."}'::jsonb,
    true,
    '{policies.view,policies.view_all,policies.approve}'::text[]
  FROM "tenants" t
  WHERE EXISTS (SELECT FROM "roles" r WHERE r."tenant_id" = t."id" AND r."is_system")
  ON CONFLICT ("tenant_id", "code") DO NOTHING
  RETURNING "tenant_id"
)
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT a."tenant_id", NULL, 'built_in_roles_changed_by_system', 'tenant', a."tenant_id",
  jsonb_build_object(
    'migration', '0045_policies_import_grants_and_approving_authority',
    'rolesAdded', jsonb_build_array('approving_authority'),
    'permissions', jsonb_build_array('policies.view', 'policies.view_all', 'policies.approve')
  )
FROM "added" a;--> statement-breakpoint

-- 4. The starting approval route of each starting type becomes review by
-- the Quality officer, then approval by the Approving authority, where it
-- is still exactly the starting route: switched on, named as it was given
-- in every language, and with exactly its two steps (a review by the
-- built-in Quality officer, then an approval by the built-in
-- Administrator, a week each, one person each). A route the client has
-- changed in any way is left as the client made it. Runs in progress keep
-- the steps they copied when they started. One audit entry per client
-- whose routes changed. No actor: it was the system.
WITH "starting" ("type_code", "name") AS (VALUES
  ('policy', '{"en":"Policy approval","ar":"اعتماد السياسات","fr":"Approbation des politiques"}'::jsonb),
  ('procedure', '{"en":"Procedure approval","ar":"اعتماد الإجراءات","fr":"Approbation des procédures"}'::jsonb),
  ('work_instruction', '{"en":"Work instruction approval","ar":"اعتماد تعليمات العمل","fr":"Approbation des instructions de travail"}'::jsonb)
),
"unchanged" AS (
  SELECT r."id" AS "route_id", r."tenant_id", dt."code" AS "type_code", s2."id" AS "step_id", au."id" AS "authority_id"
  FROM "approval_routes" r
  JOIN "document_types" dt ON dt."tenant_id" = r."tenant_id" AND dt."id" = r."document_type_id"
  JOIN "starting" st ON st."type_code" = dt."code" AND st."name" = r."name"
  JOIN "approval_route_steps" s1 ON s1."tenant_id" = r."tenant_id" AND s1."route_id" = r."id"
    AND s1."position" = 1 AND s1."kind" = 'review' AND s1."assignee_user_id" IS NULL
    AND s1."due_in_days" = 7 AND s1."required" = 1
  JOIN "roles" qo ON qo."tenant_id" = r."tenant_id" AND qo."id" = s1."assignee_role_id"
    AND qo."is_system" AND qo."code" = 'quality_officer'
  JOIN "approval_route_steps" s2 ON s2."tenant_id" = r."tenant_id" AND s2."route_id" = r."id"
    AND s2."position" = 2 AND s2."kind" = 'approve' AND s2."assignee_user_id" IS NULL
    AND s2."due_in_days" = 7 AND s2."required" = 1
  JOIN "roles" ad ON ad."tenant_id" = r."tenant_id" AND ad."id" = s2."assignee_role_id"
    AND ad."is_system" AND ad."code" = 'administrator'
  JOIN "roles" au ON au."tenant_id" = r."tenant_id" AND au."is_system" AND au."code" = 'approving_authority'
  WHERE r."subject" = 'document' AND r."active"
    AND (SELECT count(*) FROM "approval_route_steps" s
         WHERE s."tenant_id" = r."tenant_id" AND s."route_id" = r."id") = 2
),
"changed_steps" AS (
  UPDATE "approval_route_steps" s
  SET "assignee_role_id" = u."authority_id"
  FROM "unchanged" u
  WHERE s."id" = u."step_id"
  RETURNING s."route_id"
),
"changed_routes" AS (
  UPDATE "approval_routes" r
  SET "revision" = r."revision" + 1, "updated_at" = now()
  FROM "unchanged" u
  WHERE r."id" = u."route_id" AND r."id" IN (SELECT "route_id" FROM "changed_steps")
  RETURNING r."tenant_id", r."id", u."type_code"
)
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT cr."tenant_id", NULL, 'approval_routes_changed_by_system', 'tenant', cr."tenant_id",
  jsonb_build_object(
    'migration', '0045_policies_import_grants_and_approving_authority',
    'routes', jsonb_agg(jsonb_build_object('id', cr."id", 'type', cr."type_code") ORDER BY cr."type_code"),
    'step', jsonb_build_object('position', 2, 'from', 'administrator', 'to', 'approving_authority')
  )
FROM "changed_routes" cr
GROUP BY cr."tenant_id";
