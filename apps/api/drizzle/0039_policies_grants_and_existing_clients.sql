-- The policies and procedures module: what migration 0038 could not say
-- in the schema, what the application role may do on its tables, and what
-- the clients that existed before it are given. Every statement is safe to
-- repeat.

-- 1. A document's published version, with the tenant. The two tables point
-- at each other, which schema.ts cannot type, so the key is added here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'documents_published_version_fk') THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_published_version_fk"
      FOREIGN KEY ("tenant_id", "published_version_id")
      REFERENCES "document_versions" ("tenant_id", "id");
  END IF;
END $$;--> statement-breakpoint

-- 2. What the application role may do. Row-level security further limits
-- every statement to one tenant. trustline_platform gets nothing: these are
-- client data. Nothing a client writes is deleted: a type, a category or a
-- route is switched off, a document retired, a version withdrawn.
GRANT SELECT, INSERT, UPDATE ON document_types TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON document_categories TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON documents TO trustline_app;--> statement-breakpoint
-- A document's audience is replaced as a whole when it is edited; the
-- audit log keeps what it was.
GRANT SELECT, INSERT, DELETE ON document_audiences TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON document_versions TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_routes TO trustline_app;--> statement-breakpoint
-- A route's steps are replaced as a whole when it is edited. A run copies
-- them when it starts, so this never alters a run, and the audit log keeps
-- what they were.
GRANT SELECT, INSERT, DELETE ON approval_route_steps TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_runs TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_run_steps TO trustline_app;--> statement-breakpoint
-- A signature is never edited or deleted.
GRANT SELECT, INSERT ON signatures TO trustline_app;--> statement-breakpoint
-- A periodic review is written once.
GRANT SELECT, INSERT ON document_reviews TO trustline_app;--> statement-breakpoint
-- An acknowledgement is asked for once per person and version. Afterwards
-- only whether and when it was given, and the reminders, change.
GRANT SELECT, INSERT ON document_acknowledgements TO trustline_app;--> statement-breakpoint
GRANT UPDATE (acknowledged_at, signature_id, reminded_at, overdue_reminded_at) ON document_acknowledgements TO trustline_app;--> statement-breakpoint

-- 3. The two new permissions on the built-in roles of every client that
-- exists: approving and seeing every document, for the Administrator, the
-- Quality officer and the Department manager (SYSTEM_ROLES in
-- src/identity/permissions.ts, which gives them to a new client). Roles a
-- client made itself are left as they are.
UPDATE "roles" SET "permissions" = "permissions" || '{policies.approve}'::text[]
WHERE "is_system" AND "code" IN ('administrator', 'quality_officer', 'department_manager')
  AND NOT ("permissions" @> '{policies.approve}'::text[]);--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '{policies.view_all}'::text[]
WHERE "is_system" AND "code" IN ('administrator', 'quality_officer', 'department_manager')
  AND NOT ("permissions" @> '{policies.view_all}'::text[]);--> statement-breakpoint
-- The Department manager's description says so, in every language.
UPDATE "roles" SET "description" = '{"en": "Sees incidents, manages actions, and reads and approves documents for a department.", "ar": "يطّلع على الحوادث ويدير الإجراءات التصحيحية ويقرأ الوثائق ويعتمدها في قسمه.", "fr": "Consulte les incidents, gère les actions, et lit et approuve les documents de son service."}'::jsonb
WHERE "is_system" AND "code" = 'department_manager';--> statement-breakpoint
-- One audit entry per client says so. No actor: it was the system.
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT t."id", NULL, 'built_in_roles_changed_by_system', 'tenant', t."id",
  jsonb_build_object(
    'migration', '0039_policies_grants_and_existing_clients',
    'roles', (
      SELECT jsonb_agg(r."code" ORDER BY r."code") FROM "roles" r
      WHERE r."tenant_id" = t."id" AND r."is_system"
        AND r."code" IN ('administrator', 'quality_officer', 'department_manager')
    ),
    'permissionsAdded', jsonb_build_array('policies.approve', 'policies.view_all')
  )
FROM "tenants" t
WHERE EXISTS (
    SELECT FROM "roles" r
    WHERE r."tenant_id" = t."id" AND r."is_system"
      AND r."code" IN ('administrator', 'quality_officer', 'department_manager')
  )
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = t."id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0039_policies_grants_and_existing_clients'
  );--> statement-breakpoint

-- 4. What the module starts with, for every client that exists: the values
-- of src/policies/defaults.ts, which ensurePolicyDefaults() gives a new one.
-- Only where missing, so nothing a client already has is changed.
INSERT INTO "document_types" ("tenant_id", "code", "name", "number_prefix", "sections", "default_review_months", "position")
SELECT t."id", v.code, v.name, v.number_prefix, v.sections, v.default_review_months, v.position
FROM "tenants" t
CROSS JOIN (VALUES
  ('policy', '{"en":"Policy","ar":"سياسة","fr":"Politique"}'::jsonb, 'POL', '[{"key":"purpose","required":true,"name":{"en":"Purpose","ar":"الغرض","fr":"Objet"}},{"key":"scope","required":true,"name":{"en":"Scope","ar":"النطاق","fr":"Champ d’application"}},{"key":"definitions","required":false,"name":{"en":"Definitions","ar":"التعريفات","fr":"Définitions"}},{"key":"policy_statements","required":true,"name":{"en":"Policy statements","ar":"بنود السياسة","fr":"Énoncés de la politique"}},{"key":"responsibilities","required":true,"name":{"en":"Responsibilities","ar":"المسؤوليات","fr":"Responsabilités"}},{"key":"references","required":false,"name":{"en":"References","ar":"المراجع","fr":"Références"}}]'::jsonb, 36, 1),
  ('procedure', '{"en":"Procedure","ar":"إجراء","fr":"Procédure"}'::jsonb, 'PRC', '[{"key":"purpose","required":true,"name":{"en":"Purpose","ar":"الغرض","fr":"Objet"}},{"key":"scope","required":true,"name":{"en":"Scope","ar":"النطاق","fr":"Champ d’application"}},{"key":"definitions","required":false,"name":{"en":"Definitions","ar":"التعريفات","fr":"Définitions"}},{"key":"responsibilities","required":true,"name":{"en":"Responsibilities","ar":"المسؤوليات","fr":"Responsabilités"}},{"key":"equipment_and_forms","required":false,"name":{"en":"Equipment and forms","ar":"المعدات والنماذج","fr":"Équipements et formulaires"}},{"key":"steps","required":true,"name":{"en":"Steps","ar":"الخطوات","fr":"Étapes"}},{"key":"records","required":false,"name":{"en":"Records","ar":"السجلات","fr":"Enregistrements"}},{"key":"exceptions_and_escalation","required":false,"name":{"en":"Exceptions and escalation","ar":"الاستثناءات والتصعيد","fr":"Exceptions et escalade"}},{"key":"references","required":false,"name":{"en":"References","ar":"المراجع","fr":"Références"}}]'::jsonb, 24, 2),
  ('work_instruction', '{"en":"Work instruction","ar":"تعليمات عمل","fr":"Instruction de travail"}'::jsonb, 'WI', '[{"key":"purpose","required":true,"name":{"en":"Purpose","ar":"الغرض","fr":"Objet"}},{"key":"steps","required":true,"name":{"en":"Steps","ar":"الخطوات","fr":"Étapes"}},{"key":"safety_notes","required":false,"name":{"en":"Safety notes","ar":"ملاحظات السلامة","fr":"Consignes de sécurité"}},{"key":"records","required":false,"name":{"en":"Records","ar":"السجلات","fr":"Enregistrements"}}]'::jsonb, 12, 3)
) AS v(code, name, number_prefix, sections, default_review_months, position)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "document_categories" ("tenant_id", "code", "name", "position")
SELECT t."id", v.code, v.name, v.position
FROM "tenants" t
CROSS JOIN (VALUES
  ('GOV', '{"en":"Governance","ar":"الحوكمة","fr":"Gouvernance"}'::jsonb, 1),
  ('QUA', '{"en":"Quality","ar":"الجودة","fr":"Qualité"}'::jsonb, 2),
  ('SAF', '{"en":"Safety","ar":"السلامة","fr":"Sécurité"}'::jsonb, 3),
  ('OPS', '{"en":"Operations","ar":"العمليات","fr":"Opérations"}'::jsonb, 4),
  ('HR', '{"en":"Human resources","ar":"الموارد البشرية","fr":"Ressources humaines"}'::jsonb, 5),
  ('INF', '{"en":"Information","ar":"المعلومات","fr":"Information"}'::jsonb, 6)
) AS v(code, name, position)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- A route for each starting type that has none at all.
INSERT INTO "approval_routes" ("tenant_id", "name", "subject", "document_type_id")
SELECT dt."tenant_id", v.name, 'document', dt."id"
FROM "document_types" dt
JOIN (VALUES
  ('policy', '{"en":"Policy approval","ar":"اعتماد السياسات","fr":"Approbation des politiques"}'::jsonb),
  ('procedure', '{"en":"Procedure approval","ar":"اعتماد الإجراءات","fr":"Approbation des procédures"}'::jsonb),
  ('work_instruction', '{"en":"Work instruction approval","ar":"اعتماد تعليمات العمل","fr":"Approbation des instructions de travail"}'::jsonb)
) AS v(code, name) ON v.code = dt."code"
WHERE NOT EXISTS (
  SELECT FROM "approval_routes" r
  WHERE r."tenant_id" = dt."tenant_id" AND r."document_type_id" = dt."id"
);--> statement-breakpoint
-- Its steps, on the built-in roles, for a starting route that has none.
INSERT INTO "approval_route_steps" ("tenant_id", "route_id", "position", "kind", "assignee_role_id", "due_in_days")
SELECT r."tenant_id", r."id", v.position, v.kind::"approval_step_kind", ro."id", v.due_in_days
FROM "approval_routes" r
JOIN "document_types" dt ON dt."tenant_id" = r."tenant_id" AND dt."id" = r."document_type_id"
  AND dt."code" IN ('policy', 'procedure', 'work_instruction')
CROSS JOIN (VALUES
  (1, 'review', 'quality_officer', 7),
  (2, 'approve', 'administrator', 7)
) AS v(position, kind, role_code, due_in_days)
JOIN "roles" ro ON ro."tenant_id" = r."tenant_id" AND ro."is_system" AND ro."code" = v.role_code
WHERE NOT EXISTS (
  SELECT FROM "approval_route_steps" s
  WHERE s."tenant_id" = r."tenant_id" AND s."route_id" = r."id"
)
  AND NOT EXISTS (
  SELECT FROM "approval_runs" ru
  WHERE ru."tenant_id" = r."tenant_id" AND ru."route_id" = r."id"
);
