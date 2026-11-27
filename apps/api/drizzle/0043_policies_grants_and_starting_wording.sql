-- The policies module after its quality and language reviews: what the
-- application role may do on the tables of migration 0042, and the new
-- wording of the starting sections and categories (language review 6) for
-- the clients that already have them. Nothing the release running from
-- before this migration does is refused by any of it. Every statement is
-- safe to repeat.

-- 1. What the application role may do. Row-level security further limits
-- every statement to one tenant. trustline_platform gets nothing: these are
-- client data.
-- A client's settings of the module: one row, changed in place.
GRANT SELECT, INSERT, UPDATE ON document_settings TO trustline_app;--> statement-breakpoint
-- What a version held when it was sent for review: written once.
GRANT SELECT, INSERT ON document_review_rounds TO trustline_app;--> statement-breakpoint
-- What the daily check has sent once: written once, by whoever claims it.
GRANT SELECT, INSERT ON policy_reminders TO trustline_app;--> statement-breakpoint

-- 2. The starting wording, reworded (src/policies/defaults.ts, which gives
-- it to a new client): on the three starting types, the section names, and
-- the name of the INF category. One language at a time, and only where it
-- still reads as it was given: whatever a client has renamed is left as
-- the client wrote it. Versions keep the sections they were written in (and
-- signed with), so only the types and categories change. One audit entry
-- per client that had anything reworded. No actor: it was the system.
WITH "section_renames" ("type_code", "section_key", "locale", "old_name", "new_name") AS (VALUES
  ('procedure', 'steps', 'ar', 'الخطوات', 'خطوات العمل'),
  ('procedure', 'steps', 'fr', 'Étapes', 'Déroulement'),
  ('work_instruction', 'steps', 'ar', 'الخطوات', 'خطوات العمل'),
  ('work_instruction', 'steps', 'fr', 'Étapes', 'Déroulement'),
  ('procedure', 'exceptions_and_escalation', 'fr', 'Exceptions et escalade', 'Exceptions et procédure d’alerte'),
  ('work_instruction', 'safety_notes', 'ar', 'ملاحظات السلامة', 'تنبيهات السلامة'),
  ('policy', 'policy_statements', 'fr', 'Énoncés de la politique', 'Dispositions')
),
"category_renames" ("code", "locale", "old_name", "new_name") AS (VALUES
  ('INF', 'en', 'Information', 'Information management'),
  ('INF', 'ar', 'المعلومات', 'إدارة المعلومات'),
  ('INF', 'fr', 'Information', 'Gestion de l’information')
),
"rewritten" AS (
  SELECT dt."id",
    (
      SELECT jsonb_agg(
        CASE WHEN fix."names" IS NULL THEN s."section"
          ELSE jsonb_set(s."section", '{name}', (s."section" -> 'name') || fix."names")
        END
        ORDER BY s."position")
      FROM jsonb_array_elements(dt."sections") WITH ORDINALITY AS s("section", "position")
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(r."locale", r."new_name") AS "names"
        FROM "section_renames" r
        WHERE r."type_code" = dt."code"
          AND r."section_key" = s."section" ->> 'key'
          AND s."section" -> 'name' ->> r."locale" = r."old_name"
      ) fix ON true
    ) AS "sections"
  FROM "document_types" dt
  WHERE dt."code" IN ('policy', 'procedure', 'work_instruction')
    AND jsonb_typeof(dt."sections") = 'array'
),
"changed_types" AS (
  UPDATE "document_types" dt
  SET "sections" = rw."sections", "revision" = dt."revision" + 1, "updated_at" = now()
  FROM "rewritten" rw
  WHERE dt."id" = rw."id" AND rw."sections" IS NOT NULL AND rw."sections" <> dt."sections"
  RETURNING dt."tenant_id", dt."code"
),
"category_fixes" AS (
  SELECT c."id", jsonb_object_agg(r."locale", r."new_name") AS "names"
  FROM "document_categories" c
  JOIN "category_renames" r ON r."code" = c."code" AND c."name" ->> r."locale" = r."old_name"
  GROUP BY c."id"
),
"changed_categories" AS (
  UPDATE "document_categories" dc
  SET "name" = dc."name" || fix."names", "revision" = dc."revision" + 1, "updated_at" = now()
  FROM "category_fixes" fix
  WHERE dc."id" = fix."id"
  RETURNING dc."tenant_id", dc."code"
),
"clients" AS (
  SELECT "tenant_id" FROM "changed_types"
  UNION
  SELECT "tenant_id" FROM "changed_categories"
)
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT cl."tenant_id", NULL, 'policy_defaults_reworded_by_system', 'tenant', cl."tenant_id",
  jsonb_build_object(
    'migration', '0043_policies_grants_and_starting_wording',
    'types', coalesce(
      (SELECT jsonb_agg(ct."code" ORDER BY ct."code") FROM "changed_types" ct WHERE ct."tenant_id" = cl."tenant_id"),
      '[]'::jsonb),
    'categories', coalesce(
      (SELECT jsonb_agg(cc."code" ORDER BY cc."code") FROM "changed_categories" cc WHERE cc."tenant_id" = cl."tenant_id"),
      '[]'::jsonb)
  )
FROM "clients" cl;
