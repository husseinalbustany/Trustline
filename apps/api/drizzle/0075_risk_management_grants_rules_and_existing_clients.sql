-- Risk management (docs/specs/risk-management.md) and the shared actions
-- engine (docs/specs/actions.md): what migration 0074 could not say in the
-- schema, what the application role may do on its tables, what the
-- database keeps of a matrix, a rating, an action and an acceptance, the
-- module's permissions on the built-in roles, and what the clients that
-- existed before it are given. Every statement is safe to repeat. Custom
-- SQL only: the tables are in schema.ts. trustline_platform gets nothing:
-- these are client data.

-- 1. What the application role may do. Row-level security further limits
-- every statement to one tenant. trustline_platform gets nothing: these are
-- client data. Nothing a client writes is deleted: a category, a committee,
-- a domain or a control is switched off, a matrix retired, a risk closed.
GRANT SELECT, INSERT, UPDATE ON risk_committees TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_categories TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_settings TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_matrices TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_matrix_levels TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_impact_domains TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_bands TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_matrix_cells TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risks TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_controls TO trustline_app;--> statement-breakpoint
-- A rating and a timeline entry are written once.
GRANT SELECT, INSERT ON risk_ratings TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON risk_events TO trustline_app;--> statement-breakpoint

-- Reviews, timeline entries and reminders are written once. An action
-- changes in place; its timeline is written once. Nothing is deleted.
GRANT SELECT, INSERT ON risk_reviews TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON risk_reminders TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON actions TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON action_events TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON action_reminders TO trustline_app;--> statement-breakpoint
-- A rating's rationale and a review's comment are the only parts of either
-- that change: a manager corrects them, so that a detail of a person typed
-- by mistake can be taken out (security review 15, M1). Column grants: the
-- levels, the band, the day and who made it stay as they were written.
GRANT UPDATE ("rationale") ON risk_ratings TO trustline_app;--> statement-breakpoint
GRANT UPDATE ("comment") ON risk_reviews TO trustline_app;--> statement-breakpoint

-- An acceptance and a link change in place (status, run, taking
-- off); nothing is deleted. A note is written once; only its text is
-- corrected, by a manager, with who did and when.
GRANT SELECT, INSERT, UPDATE ON risk_acceptances TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON risk_incident_links TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON risk_notes TO trustline_app;--> statement-breakpoint
GRANT UPDATE ("text", "corrected_by", "corrected_at") ON risk_notes TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON action_notes TO trustline_app;--> statement-breakpoint
GRANT UPDATE ("text", "corrected_by", "corrected_at") ON action_notes TO trustline_app;--> statement-breakpoint

-- 2. A matrix's size and version are fixed when it is made, and its status
-- goes one way: draft to in use or retired, in use to retired.
CREATE OR REPLACE FUNCTION "risk_matrices_keep_shape"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."likelihood_levels" IS DISTINCT FROM OLD."likelihood_levels"
    OR NEW."impact_levels" IS DISTINCT FROM OLD."impact_levels"
  THEN
    RAISE EXCEPTION 'a matrix keeps its size and version'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_matrices_shape_fixed',
            TABLE = 'risk_matrices';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'draft' AND NEW."status" IN ('in_use', 'retired'))
    OR (OLD."status" = 'in_use' AND NEW."status" = 'retired')
  ) THEN
    RAISE EXCEPTION 'a matrix''s status does not go that way'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_matrices_status_order',
            TABLE = 'risk_matrices';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risk_matrices_shape_fixed"
BEFORE UPDATE ON "risk_matrices"
FOR EACH ROW EXECUTE FUNCTION "risk_matrices_keep_shape"();--> statement-breakpoint

-- 3. What decides a band is fixed once a matrix leaves draft, so that every
-- rating keeps the band it was given: its cells (none added, none changed),
-- its bands (none added; interval, escalation and signature unchanged), and
-- its levels (none added; each keeps its axis and number). Wording (labels,
-- descriptors, band names, domains) changes at any time.
CREATE OR REPLACE FUNCTION "risk_matrix_status_of"(matrix uuid) RETURNS "risk_matrix_status"
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT m."status" FROM public."risk_matrices" m WHERE m."id" = matrix
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "risk_matrix_cells_keep_bands"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public."risk_matrix_status_of"(NEW."matrix_id") IS DISTINCT FROM 'draft'
    OR (TG_OP = 'UPDATE' AND public."risk_matrix_status_of"(OLD."matrix_id") IS DISTINCT FROM 'draft')
  THEN
    RAISE EXCEPTION 'the cells of a matrix out of draft do not change'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_matrix_cells_fixed',
            TABLE = 'risk_matrix_cells';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risk_matrix_cells_fixed"
BEFORE INSERT OR UPDATE ON "risk_matrix_cells"
FOR EACH ROW EXECUTE FUNCTION "risk_matrix_cells_keep_bands"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "risk_bands_keep_rules"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public."risk_matrix_status_of"(NEW."matrix_id") IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'a matrix out of draft takes no new band'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'risk_bands_fixed',
              TABLE = 'risk_bands';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."matrix_id" IS DISTINCT FROM OLD."matrix_id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR (public."risk_matrix_status_of"(OLD."matrix_id") IS DISTINCT FROM 'draft' AND (
      NEW."review_interval_days" IS DISTINCT FROM OLD."review_interval_days"
      OR NEW."escalate_to_committee_id" IS DISTINCT FROM OLD."escalate_to_committee_id"
      OR NEW."acceptance_needs_signature" IS DISTINCT FROM OLD."acceptance_needs_signature"))
  THEN
    RAISE EXCEPTION 'a band of a matrix out of draft keeps its rules'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_bands_fixed',
            TABLE = 'risk_bands';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risk_bands_fixed"
BEFORE INSERT OR UPDATE ON "risk_bands"
FOR EACH ROW EXECUTE FUNCTION "risk_bands_keep_rules"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "risk_matrix_levels_keep_place"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public."risk_matrix_status_of"(NEW."matrix_id") IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'a matrix out of draft takes no new level'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'risk_matrix_levels_fixed',
              TABLE = 'risk_matrix_levels';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."matrix_id" IS DISTINCT FROM OLD."matrix_id"
    OR NEW."axis" IS DISTINCT FROM OLD."axis"
    OR NEW."level" IS DISTINCT FROM OLD."level"
  THEN
    RAISE EXCEPTION 'a level keeps its axis and number'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_matrix_levels_fixed',
            TABLE = 'risk_matrix_levels';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risk_matrix_levels_fixed"
BEFORE INSERT OR UPDATE ON "risk_matrix_levels"
FOR EACH ROW EXECUTE FUNCTION "risk_matrix_levels_keep_place"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "risk_impact_domains_keep_matrix"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."matrix_id" IS DISTINCT FROM OLD."matrix_id"
  THEN
    RAISE EXCEPTION 'a domain keeps its matrix'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_impact_domains_fixed',
            TABLE = 'risk_impact_domains';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risk_impact_domains_fixed"
BEFORE UPDATE ON "risk_impact_domains"
FOR EACH ROW EXECUTE FUNCTION "risk_impact_domains_keep_matrix"();--> statement-breakpoint

-- 4. A rating is made on the matrix in use, and nowhere else.
CREATE OR REPLACE FUNCTION "risk_ratings_on_matrix_in_use"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public."risk_matrix_status_of"(NEW."matrix_id") IS DISTINCT FROM 'in_use' THEN
    RAISE EXCEPTION 'a rating is made on the matrix in use'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_ratings_matrix_in_use',
            TABLE = 'risk_ratings';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risk_ratings_matrix_in_use"
BEFORE INSERT ON "risk_ratings"
FOR EACH ROW EXECUTE FUNCTION "risk_ratings_on_matrix_in_use"();--> statement-breakpoint

-- A risk keeps its reference and who raised it. The highest band it has
-- had only rises; its closure needs a second signature once it has been
-- High or Extreme, or escalated (business decision 9), and from then on
-- (spec, "Closing and reopening": the rule sticks). Kept here, whatever
-- the code sets, as an incident's `sign_off_needed` is.
CREATE OR REPLACE FUNCTION "risks_keep_history"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
      OR NEW."reference" IS DISTINCT FROM OLD."reference"
      OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
      OR NEW."source" IS DISTINCT FROM OLD."source"
    THEN
      RAISE EXCEPTION 'a risk keeps its reference, source and author'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'risks_history_kept',
              TABLE = 'risks';
    END IF;
    NEW."highest_band" := GREATEST(OLD."highest_band", NEW."highest_band", NEW."current_band");
    NEW."closure_sign_off_needed" := OLD."closure_sign_off_needed" OR NEW."closure_sign_off_needed";
  ELSE
    NEW."highest_band" := GREATEST(NEW."highest_band", NEW."current_band");
  END IF;
  IF NEW."highest_band" >= 'high' OR NEW."escalated_to_committee_id" IS NOT NULL THEN
    NEW."closure_sign_off_needed" := true;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risks_history_kept"
BEFORE INSERT OR UPDATE ON "risks"
FOR EACH ROW EXECUTE FUNCTION "risks_keep_history"();--> statement-breakpoint

-- 5. An action keeps its reference, its source, its author and its first
-- due day, whatever the code does: so the overdue figure cannot be improved
-- by moving dates without it showing (docs/specs/actions.md, "Rules").
CREATE OR REPLACE FUNCTION "actions_keep_history"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."reference" IS DISTINCT FROM OLD."reference"
    OR NEW."source_type" IS DISTINCT FROM OLD."source_type"
    OR NEW."risk_id" IS DISTINCT FROM OLD."risk_id"
    OR NEW."original_due_on" IS DISTINCT FROM OLD."original_due_on"
    OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'an action keeps its reference, source, author and first due day'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'actions_history_kept',
            TABLE = 'actions';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "actions_history_kept"
BEFORE UPDATE ON "actions"
FOR EACH ROW EXECUTE FUNCTION "actions_keep_history"();--> statement-breakpoint

-- A new action's first due day is its due day.
CREATE OR REPLACE FUNCTION "actions_first_due_day"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW."original_due_on" := NEW."due_on";
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "actions_first_due_day"
BEFORE INSERT ON "actions"
FOR EACH ROW EXECUTE FUNCTION "actions_first_due_day"();--> statement-breakpoint

-- 6. A risk's acceptance in force. Here, not in schema.ts: the two tables
-- name each other.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'risks_acceptance_fk') THEN
    ALTER TABLE "risks" ADD CONSTRAINT "risks_acceptance_fk"
      FOREIGN KEY ("tenant_id", "acceptance_id") REFERENCES "risk_acceptances" ("tenant_id", "id");
  END IF;
END
$$;--> statement-breakpoint

-- 7. What an acceptance was asked on and signed never changes: the risk,
-- who asked and when, the rationale, the conditions, the last day, the
-- rating, score, band, tolerance and category. Its run is set once. Its
-- status moves forward only: in approval to accepted, returned or
-- withdrawn; accepted to lapsed, with a reason.
CREATE OR REPLACE FUNCTION "risk_acceptances_keep_content"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."risk_id" IS DISTINCT FROM OLD."risk_id"
    OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
    OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
    OR NEW."rationale" IS DISTINCT FROM OLD."rationale"
    OR NEW."conditions" IS DISTINCT FROM OLD."conditions"
    OR NEW."until_on" IS DISTINCT FROM OLD."until_on"
    OR NEW."rating_id" IS DISTINCT FROM OLD."rating_id"
    OR NEW."score" IS DISTINCT FROM OLD."score"
    OR NEW."band_code" IS DISTINCT FROM OLD."band_code"
    OR NEW."tolerance_band" IS DISTINCT FROM OLD."tolerance_band"
    OR NEW."category_id" IS DISTINCT FROM OLD."category_id"
    OR (OLD."approval_run_id" IS NOT NULL AND NEW."approval_run_id" IS DISTINCT FROM OLD."approval_run_id")
  THEN
    RAISE EXCEPTION 'what an acceptance was asked on and signed does not change'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_acceptances_content_fixed',
            TABLE = 'risk_acceptances';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'in_approval' AND NEW."status" IN ('accepted', 'returned', 'withdrawn'))
    OR (OLD."status" = 'accepted' AND NEW."status" = 'lapsed')
  ) THEN
    RAISE EXCEPTION 'an acceptance moves from % to no %', OLD."status", NEW."status"
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risk_acceptances_status_order',
            TABLE = 'risk_acceptances';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risk_acceptances_content_fixed"
BEFORE UPDATE ON "risk_acceptances"
FOR EACH ROW EXECUTE FUNCTION "risk_acceptances_keep_content"();--> statement-breakpoint

-- 8. While an acceptance is in approval, what was put to its signers stays
-- as it was: the risk's title, category, unit and current rating, as
-- migration 0041 keeps a version in review (spec, "Acceptance above
-- tolerance"). The application refuses first, with 409
-- `acceptance_in_progress`.
CREATE OR REPLACE FUNCTION "risks_fixed_while_accepting"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW."title" IS DISTINCT FROM OLD."title"
      OR NEW."category_id" IS DISTINCT FROM OLD."category_id"
      OR NEW."org_unit_id" IS DISTINCT FROM OLD."org_unit_id"
      OR NEW."current_likelihood" IS DISTINCT FROM OLD."current_likelihood"
      OR NEW."current_impact" IS DISTINCT FROM OLD."current_impact"
      OR NEW."current_score" IS DISTINCT FROM OLD."current_score"
      OR NEW."current_band" IS DISTINCT FROM OLD."current_band"
      OR NEW."current_matrix_id" IS DISTINCT FROM OLD."current_matrix_id")
    AND EXISTS (
      SELECT FROM "risk_acceptances" a
      WHERE a."tenant_id" = OLD."tenant_id" AND a."risk_id" = OLD."id" AND a."status" = 'in_approval'
    )
  THEN
    RAISE EXCEPTION 'a risk whose acceptance is in approval keeps what was put to its signers'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'risks_acceptance_in_progress',
            TABLE = 'risks';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "risks_acceptance_in_progress"
BEFORE UPDATE ON "risks"
FOR EACH ROW EXECUTE FUNCTION "risks_fixed_while_accepting"();--> statement-breakpoint

-- 9. The module's permissions on the built-in roles of every client that
-- exists (SYSTEM_ROLES in src/identity/permissions.ts, which gives them to
-- a new client): all three for the Administrator and the Quality officer,
-- viewing and managing for the Department manager, viewing and approving
-- for the Approving authority. Roles a client made itself are left alone.
--
-- The audit entry first, while it can still be seen what each role lacks:
-- one per client that gets something, naming exactly what each of its
-- roles got (security review 15). No actor: it was the system.
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT g."tenant_id", NULL, 'built_in_roles_changed_by_system', 'tenant', g."tenant_id",
  jsonb_build_object(
    'migration', '0075_risk_management_grants_rules_and_existing_clients',
    'roles', jsonb_agg(g."code" ORDER BY g."code"),
    'permissionsAdded', jsonb_object_agg(g."code", g."added")
  )
FROM (
  SELECT r."tenant_id", r."code",
    to_jsonb(ARRAY(SELECT p FROM unnest(v.perms) AS p WHERE NOT (p = ANY (r."permissions")))) AS "added"
  FROM "roles" r
  JOIN (VALUES
    ('administrator', ARRAY['risks.view', 'risks.manage', 'risks.approve']::text[]),
    ('quality_officer', ARRAY['risks.view', 'risks.manage', 'risks.approve']::text[]),
    ('department_manager', ARRAY['risks.view', 'risks.manage']::text[]),
    ('approving_authority', ARRAY['risks.view', 'risks.approve']::text[]),
    ('external_reviewer', ARRAY['risks.view']::text[])
  ) AS v(code, perms) ON v.code = r."code"
  WHERE r."is_system" AND NOT (r."permissions" @> v.perms)
) g
WHERE NOT EXISTS (
  SELECT FROM "audit_log" a
  WHERE a."tenant_id" = g."tenant_id" AND a."action" = 'built_in_roles_changed_by_system'
    AND a."changes" ->> 'migration' = '0075_risk_management_grants_rules_and_existing_clients'
)
GROUP BY g."tenant_id";--> statement-breakpoint
UPDATE "roles" r SET "permissions" = r."permissions" || ARRAY(
    SELECT p FROM unnest(ARRAY['risks.view', 'risks.manage', 'risks.approve']::text[]) AS p
    WHERE NOT (p = ANY (r."permissions")))
WHERE r."is_system" AND r."code" IN ('administrator', 'quality_officer')
  AND NOT (r."permissions" @> ARRAY['risks.view', 'risks.manage', 'risks.approve']::text[]);--> statement-breakpoint
UPDATE "roles" r SET "permissions" = r."permissions" || ARRAY(
    SELECT p FROM unnest(ARRAY['risks.view', 'risks.manage']::text[]) AS p
    WHERE NOT (p = ANY (r."permissions")))
WHERE r."is_system" AND r."code" = 'department_manager'
  AND NOT (r."permissions" @> ARRAY['risks.view', 'risks.manage']::text[]);--> statement-breakpoint
UPDATE "roles" r SET "permissions" = r."permissions" || ARRAY(
    SELECT p FROM unnest(ARRAY['risks.view', 'risks.approve']::text[]) AS p
    WHERE NOT (p = ANY (r."permissions")))
WHERE r."is_system" AND r."code" = 'approving_authority'
  AND NOT (r."permissions" @> ARRAY['risks.view', 'risks.approve']::text[]);--> statement-breakpoint
-- The External reviewer reads the risk register (decision 17), as
-- READ_ONLY_PERMISSIONS allows.
UPDATE "roles" r SET "permissions" = array_append(r."permissions", 'risks.view')
WHERE r."is_system" AND r."code" = 'external_reviewer'
  AND NOT ('risks.view' = ANY (r."permissions"));--> statement-breakpoint
-- The two descriptions that name what the role manages say so, in every
-- language.
UPDATE "roles" SET "description" = '{"en": "Triages incidents, manages actions, policies and risks, and views reports.", "ar": "يفرز الحوادث ويدير الإجراءات التصحيحية والسياسات والمخاطر ويطّلع على التقارير.", "fr": "Trie les incidents, gère les actions, les politiques et les risques, et consulte les rapports."}'::jsonb
WHERE "is_system" AND "code" = 'quality_officer';--> statement-breakpoint
UPDATE "roles" SET "description" = '{"en": "Sees incidents, manages actions and risks, and reads and approves documents for a department.", "ar": "يطّلع على الحوادث ويدير الإجراءات التصحيحية والمخاطر ويقرأ الوثائق ويعتمدها في قسمه.", "fr": "Consulte les incidents, gère les actions et les risques, et lit et approuve les documents de son service."}'::jsonb
WHERE "is_system" AND "code" = 'department_manager';--> statement-breakpoint
UPDATE "roles" SET "description" = jsonb_build_object(
    'en', 'Reads, for a limited time, the audit trail, all documents, reports, the risk register, and incidents without the reporters'' names. For surveyors and auditors from outside.',
    'ar', 'يطّلع لمدة محدودة على سجل التدقيق وجميع الوثائق والتقارير وسجل المخاطر، وعلى الحوادث دون أسماء المبلّغين. للمقيّمين والمدققين من خارج المنشأة.',
    'fr', 'Consulte pour une durée limitée le journal d’audit, tous les documents, les rapports, le registre des risques et les incidents sans le nom des déclarants. Pour les évaluateurs et auditeurs extérieurs.')
WHERE "is_system" AND "code" = 'external_reviewer';--> statement-breakpoint

-- 10. What the module starts with, for every client that exists: the values
-- of src/risks/defaults.ts, which ensureRiskDefaults() gives a new one, and
-- one audit entry per client that gets them. Only where missing: committees
-- and categories by code, the matrix only for a client that has none.
INSERT INTO "risk_committees" ("tenant_id", "code", "name", "position")
SELECT t."id", v.code, v.name, v.position
FROM "tenants" t
CROSS JOIN (VALUES
  ('risk_committee', '{"en":"Risk committee","ar":"لجنة المخاطر","fr":"Comité des risques"}'::jsonb, 1),
  ('governing_body', '{"en":"Governing body","ar":"الهيئة الحاكمة","fr":"Instance de gouvernance"}'::jsonb, 2)
) AS v(code, name, position)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "risk_categories" ("tenant_id", "code", "name", "position", "appetite", "tolerance_band")
SELECT t."id", v.code, v.name, v.position, 'cautious', 'medium'
FROM "tenants" t
CROSS JOIN (VALUES
  ('people_safety', '{"en":"Safety of the people we serve","ar":"سلامة من نخدمهم","fr":"Sécurité des personnes que nous servons"}'::jsonb, 1),
  ('staff_safety', '{"en":"Staff health and safety","ar":"صحة العاملين وسلامتهم","fr":"Santé et sécurité du personnel"}'::jsonb, 2),
  ('operations', '{"en":"Service and operations","ar":"الخدمة والعمليات","fr":"Service et activités"}'::jsonb, 3),
  ('compliance', '{"en":"Compliance and regulation","ar":"الامتثال والأنظمة","fr":"Conformité et réglementation"}'::jsonb, 4),
  ('finance', '{"en":"Finance","ar":"المالية","fr":"Finances"}'::jsonb, 5),
  ('reputation', '{"en":"Reputation","ar":"السمعة","fr":"Réputation"}'::jsonb, 6),
  ('information', '{"en":"Information and data","ar":"المعلومات والبيانات","fr":"Information et données"}'::jsonb, 7),
  ('facilities', '{"en":"Facilities, equipment and environment","ar":"المرافق والمعدات والبيئة","fr":"Locaux, équipements et environnement"}'::jsonb, 8),
  ('strategy', '{"en":"Strategy","ar":"الاستراتيجية","fr":"Stratégie"}'::jsonb, 9)
) AS v(code, name, position)
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The entry first, for the clients about to get a matrix: no actor, it was
-- the system.
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT t."id", NULL, 'risk_defaults_created_by_system', 'tenant', t."id",
  jsonb_build_object(
    'migration', '0075_risk_management_grants_rules_and_existing_clients',
    'matrix', jsonb_build_object('version', 1, 'likelihoodLevels', 5, 'impactLevels', 5),
    'categories', (SELECT jsonb_agg(c."code" ORDER BY c."position") FROM "risk_categories" c WHERE c."tenant_id" = t."id"),
    'committees', (SELECT jsonb_agg(c."code" ORDER BY c."position") FROM "risk_committees" c WHERE c."tenant_id" = t."id")
  )
FROM "tenants" t
WHERE NOT EXISTS (SELECT FROM "risk_matrices" m WHERE m."tenant_id" = t."id")
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = t."id" AND a."action" = 'risk_defaults_created_by_system'
      AND a."changes" ->> 'migration' = '0075_risk_management_grants_rules_and_existing_clients'
  );--> statement-breakpoint
-- The matrix, as a draft until it is filled (the rules above let a matrix
-- out of draft take no new cell or band).
INSERT INTO "risk_matrices" ("tenant_id", "version", "likelihood_levels", "impact_levels", "status")
SELECT t."id", 1, 5, 5, 'draft'
FROM "tenants" t
WHERE NOT EXISTS (SELECT FROM "risk_matrices" m WHERE m."tenant_id" = t."id");--> statement-breakpoint
INSERT INTO "risk_matrix_levels" ("tenant_id", "matrix_id", "axis", "level", "label", "descriptor", "frequency")
SELECT m."tenant_id", m."id", v.axis::"risk_axis", v.level, v.label, v.descriptor, v.frequency
FROM "risk_matrices" m
CROSS JOIN (VALUES
  ('likelihood', 1, '{"en":"Rare","ar":"نادر","fr":"Rare"}'::jsonb, '{"en":"May happen only in exceptional circumstances.","ar":"قد يحدث في ظروف استثنائية فقط.","fr":"Pourrait se produire seulement dans des circonstances exceptionnelles."}'::jsonb, '{"en":"Less than once in five years","ar":"أقل من مرة كل خمس سنوات","fr":"Moins d’une fois tous les cinq ans"}'::jsonb),
  ('likelihood', 2, '{"en":"Unlikely","ar":"غير مرجّح","fr":"Peu probable"}'::jsonb, '{"en":"Could happen at some time, but is not expected.","ar":"قد يحدث في وقت ما، لكنه غير متوقع.","fr":"Pourrait se produire un jour, mais n’est pas attendu."}'::jsonb, '{"en":"Once in two to five years","ar":"مرة كل سنتين إلى خمس سنوات","fr":"Une fois tous les deux à cinq ans"}'::jsonb),
  ('likelihood', 3, '{"en":"Possible","ar":"ممكن","fr":"Possible"}'::jsonb, '{"en":"Might well happen; has happened here or in similar organizations.","ar":"قد يحدث فعلًا، وقد حدث هنا أو في جهات مماثلة.","fr":"Pourrait bien se produire ; s’est déjà produit ici ou dans des organisations comparables."}'::jsonb, '{"en":"About once a year","ar":"مرة في السنة تقريبًا","fr":"Environ une fois par an"}'::jsonb),
  ('likelihood', 4, '{"en":"Likely","ar":"مرجّح","fr":"Probable"}'::jsonb, '{"en":"Will probably happen in most circumstances.","ar":"سيحدث على الأرجح في معظم الظروف.","fr":"Se produira probablement dans la plupart des circonstances."}'::jsonb, '{"en":"Several times a year","ar":"عدة مرات في السنة","fr":"Plusieurs fois par an"}'::jsonb),
  ('likelihood', 5, '{"en":"Almost certain","ar":"شبه مؤكد","fr":"Quasi certain"}'::jsonb, '{"en":"Is expected to happen in most circumstances.","ar":"يُتوقع حدوثه في معظم الظروف.","fr":"Devrait se produire dans la plupart des circonstances."}'::jsonb, '{"en":"Monthly or more often","ar":"شهريًا أو أكثر","fr":"Tous les mois ou plus souvent"}'::jsonb),
  ('impact', 1, '{"en":"Negligible","ar":"ضئيل","fr":"Négligeable"}'::jsonb, '{"en":"Hardly noticed; dealt with in the normal course of work.","ar":"بالكاد يُلاحظ، ويُعالج ضمن سير العمل المعتاد.","fr":"À peine perceptible ; traité dans le cours normal du travail."}'::jsonb, NULL::jsonb),
  ('impact', 2, '{"en":"Minor","ar":"طفيف","fr":"Mineur"}'::jsonb, '{"en":"Noticed, and put right quickly within the unit.","ar":"يُلاحظ ويُصحَّح سريعًا داخل الوحدة.","fr":"Perceptible, et corrigé rapidement au sein de l’unité."}'::jsonb, NULL::jsonb),
  ('impact', 3, '{"en":"Moderate","ar":"معتدل","fr":"Modéré"}'::jsonb, '{"en":"Needs management attention and resources beyond the unit.","ar":"يتطلب اهتمام الإدارة وموارد من خارج الوحدة.","fr":"Demande l’attention de la direction et des moyens au-delà de l’unité."}'::jsonb, NULL::jsonb),
  ('impact', 4, '{"en":"Major","ar":"كبير","fr":"Majeur"}'::jsonb, '{"en":"Serious harm to people or to the organization; leadership must act.","ar":"ضرر كبير بالأشخاص أو بالجهة، ويتطلب تدخل القيادة.","fr":"Atteinte grave aux personnes ou à l’organisation ; la direction doit agir."}'::jsonb, NULL::jsonb),
  ('impact', 5, '{"en":"Catastrophic","ar":"كارثي","fr":"Catastrophique"}'::jsonb, '{"en":"Threatens lives or the organization’s ability to carry on.","ar":"يهدد الأرواح أو قدرة الجهة على الاستمرار.","fr":"Menace des vies ou la capacité de l’organisation à poursuivre son activité."}'::jsonb, NULL::jsonb)
) AS v(axis, level, label, descriptor, frequency)
WHERE m."status" = 'draft' AND m."version" = 1
  AND NOT EXISTS (SELECT FROM "risk_matrix_levels" x WHERE x."tenant_id" = m."tenant_id" AND x."matrix_id" = m."id");--> statement-breakpoint
INSERT INTO "risk_impact_domains" ("tenant_id", "matrix_id", "name", "descriptors", "position")
SELECT m."tenant_id", m."id", v.name, v.descriptors, v.position
FROM "risk_matrices" m
CROSS JOIN (VALUES
  ('{"en":"Safety of people","ar":"سلامة الأشخاص","fr":"Sécurité des personnes"}'::jsonb, '{"1":{"en":"No harm, or first aid only.","ar":"لا ضرر، أو إسعافات أولية فقط.","fr":"Aucun dommage, ou premiers soins seulement."},"2":{"en":"Minor harm, recovered within days.","ar":"ضرر طفيف يُتعافى منه خلال أيام.","fr":"Dommage mineur, rétabli en quelques jours."},"3":{"en":"Harm needing professional treatment or time off, recovered within weeks.","ar":"ضرر يتطلب علاجًا متخصصًا أو انقطاعًا عن العمل، ويُتعافى منه خلال أسابيع.","fr":"Dommage nécessitant des soins professionnels ou un arrêt, rétabli en quelques semaines."},"4":{"en":"Long-term harm or disability.","ar":"ضرر طويل الأمد أو إعاقة.","fr":"Dommage durable ou invalidité."},"5":{"en":"Death, or permanent harm to one or more people.","ar":"وفاة، أو ضرر دائم لشخص أو أكثر.","fr":"Décès, ou dommage permanent pour une ou plusieurs personnes."}}'::jsonb, 1),
  ('{"en":"Service and operations","ar":"الخدمة والعمليات","fr":"Service et activités"}'::jsonb, '{"1":{"en":"No noticeable disruption.","ar":"لا اضطراب ملحوظ.","fr":"Aucune perturbation notable."},"2":{"en":"Brief disruption, absorbed by the unit.","ar":"اضطراب قصير تستوعبه الوحدة.","fr":"Courte perturbation, absorbée par l’unité."},"3":{"en":"A service reduced or delayed for days.","ar":"تراجع خدمة أو تأخرها لأيام.","fr":"Un service réduit ou retardé pendant plusieurs jours."},"4":{"en":"A key service stopped for days, or reduced for weeks.","ar":"توقف خدمة رئيسية لأيام، أو تراجعها لأسابيع.","fr":"Un service essentiel arrêté plusieurs jours, ou réduit plusieurs semaines."},"5":{"en":"Several key services stopped for a long time.","ar":"توقف عدة خدمات رئيسية لمدة طويلة.","fr":"Plusieurs services essentiels arrêtés durablement."}}'::jsonb, 2),
  ('{"en":"Compliance","ar":"الامتثال","fr":"Conformité"}'::jsonb, '{"1":{"en":"A minor departure from internal rules, corrected at once.","ar":"مخالفة طفيفة للقواعد الداخلية تُصحَّح فورًا.","fr":"Un écart mineur aux règles internes, corrigé aussitôt."},"2":{"en":"A departure from a standard, noted at an inspection.","ar":"مخالفة لمعيار تُرصد أثناء تفتيش.","fr":"Un écart à une norme, relevé lors d’une inspection."},"3":{"en":"A finding by a regulator or an accrediting body that requires a plan.","ar":"ملاحظة من جهة رقابية أو جهة اعتماد تتطلب خطة تصحيح.","fr":"Une constatation d’une autorité ou d’un organisme d’accréditation exigeant un plan d’action."},"4":{"en":"A formal notice, a fine, or accreditation put at risk.","ar":"إنذار رسمي أو غرامة أو تعريض الاعتماد للخطر.","fr":"Une mise en demeure, une amende, ou l’accréditation mise en péril."},"5":{"en":"Loss of a licence or of accreditation, or prosecution.","ar":"فقدان ترخيص أو اعتماد، أو ملاحقة قضائية.","fr":"Perte d’une autorisation ou de l’accréditation, ou poursuites pénales."}}'::jsonb, 3),
  ('{"en":"Finance","ar":"المالية","fr":"Finances"}'::jsonb, '{"1":{"en":"A loss absorbed within a unit’s budget.","ar":"خسارة تُستوعب ضمن ميزانية الوحدة.","fr":"Une perte absorbée par le budget d’une unité."},"2":{"en":"A loss absorbed within a department’s budget.","ar":"خسارة تُستوعب ضمن ميزانية القسم.","fr":"Une perte absorbée par le budget d’un service."},"3":{"en":"A loss that needs the organization’s budget to be revised.","ar":"خسارة تتطلب مراجعة ميزانية الجهة.","fr":"Une perte qui oblige à réviser le budget de l’organisation."},"4":{"en":"A loss that affects the organization’s yearly results.","ar":"خسارة تؤثر في النتائج السنوية للجهة.","fr":"Une perte qui pèse sur les résultats annuels de l’organisation."},"5":{"en":"A loss that threatens the organization’s survival.","ar":"خسارة تهدد بقاء الجهة.","fr":"Une perte qui menace la pérennité de l’organisation."}}'::jsonb, 4),
  ('{"en":"Reputation","ar":"السمعة","fr":"Réputation"}'::jsonb, '{"1":{"en":"Not known outside the unit.","ar":"لا يُعرف خارج الوحدة.","fr":"Inconnu hors de l’unité."},"2":{"en":"Complaints from a few people, or local talk.","ar":"شكاوى من عدد قليل من الأشخاص، أو حديث محلي.","fr":"Plaintes de quelques personnes, ou rumeur locale."},"3":{"en":"Local media coverage, or many complaints.","ar":"تغطية إعلامية محلية، أو شكاوى كثيرة.","fr":"Couverture par les médias locaux, ou nombreuses plaintes."},"4":{"en":"National media coverage, or loss of partners’ confidence.","ar":"تغطية إعلامية وطنية، أو فقدان ثقة الشركاء.","fr":"Couverture médiatique nationale, ou perte de confiance des partenaires."},"5":{"en":"Lasting loss of public trust.","ar":"فقدان دائم لثقة الجمهور.","fr":"Perte durable de la confiance du public."}}'::jsonb, 5)
) AS v(name, descriptors, position)
WHERE m."status" = 'draft' AND m."version" = 1
  AND NOT EXISTS (SELECT FROM "risk_impact_domains" x WHERE x."tenant_id" = m."tenant_id" AND x."matrix_id" = m."id");--> statement-breakpoint
INSERT INTO "risk_bands" ("tenant_id", "matrix_id", "code", "name", "review_interval_days", "escalate_to_committee_id", "acceptance_needs_signature")
SELECT m."tenant_id", m."id", v.code::"risk_band", v.name, v.review_interval_days, c."id", v.signature
FROM "risk_matrices" m
CROSS JOIN (VALUES
  ('low', '{"en":"Low","ar":"منخفض","fr":"Faible"}'::jsonb, 365, NULL, false),
  ('medium', '{"en":"Medium","ar":"متوسط","fr":"Moyen"}'::jsonb, 180, NULL, true),
  ('high', '{"en":"High","ar":"مرتفع","fr":"Élevé"}'::jsonb, 90, 'risk_committee', true),
  ('extreme', '{"en":"Extreme","ar":"بالغ الخطورة","fr":"Extrême"}'::jsonb, 30, 'governing_body', true)
) AS v(code, name, review_interval_days, committee_code, signature)
LEFT JOIN "risk_committees" c ON c."tenant_id" = m."tenant_id" AND c."code" = v.committee_code
WHERE m."status" = 'draft' AND m."version" = 1
  AND NOT EXISTS (SELECT FROM "risk_bands" x WHERE x."tenant_id" = m."tenant_id" AND x."matrix_id" = m."id");--> statement-breakpoint
INSERT INTO "risk_matrix_cells" ("tenant_id", "matrix_id", "likelihood", "impact", "band_code")
SELECT m."tenant_id", m."id", v.likelihood, v.impact, v.band::"risk_band"
FROM "risk_matrices" m
CROSS JOIN (VALUES
  (1, 1, 'low'),
  (1, 2, 'low'),
  (1, 3, 'low'),
  (1, 4, 'medium'),
  (1, 5, 'medium'),
  (2, 1, 'low'),
  (2, 2, 'medium'),
  (2, 3, 'medium'),
  (2, 4, 'high'),
  (2, 5, 'high'),
  (3, 1, 'low'),
  (3, 2, 'medium'),
  (3, 3, 'high'),
  (3, 4, 'high'),
  (3, 5, 'extreme'),
  (4, 1, 'medium'),
  (4, 2, 'high'),
  (4, 3, 'high'),
  (4, 4, 'extreme'),
  (4, 5, 'extreme'),
  (5, 1, 'medium'),
  (5, 2, 'high'),
  (5, 3, 'extreme'),
  (5, 4, 'extreme'),
  (5, 5, 'extreme')
) AS v(likelihood, impact, band)
WHERE m."status" = 'draft' AND m."version" = 1
  AND NOT EXISTS (SELECT FROM "risk_matrix_cells" x WHERE x."tenant_id" = m."tenant_id" AND x."matrix_id" = m."id");--> statement-breakpoint
-- Put in use by the system: only the starting matrix, filled above, of a
-- client that has no matrix in use.
UPDATE "risk_matrices" m SET "status" = 'in_use', "put_in_use_at" = now()
WHERE m."status" = 'draft' AND m."version" = 1 AND m."created_by" IS NULL
  AND EXISTS (SELECT FROM "risk_matrix_cells" x WHERE x."tenant_id" = m."tenant_id" AND x."matrix_id" = m."id")
  AND NOT EXISTS (SELECT FROM "risk_matrices" u WHERE u."tenant_id" = m."tenant_id" AND u."status" = 'in_use');--> statement-breakpoint

-- 11. The starting acceptance and closure routes (risks/defaults.ts), for
-- each client that has none of that subject and band and has the built-in
-- roles they name, as `ensureRiskRoutes` gives a new client. The entry
-- first, written by the system, naming the routes the client is about to
-- get.
CREATE TEMPORARY TABLE "risk_default_routes" ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('risk_acceptance', 'medium', '{"en":"Acceptance of a Medium risk above tolerance","ar":"قبول خطر متوسط فوق حدّ التحمّل","fr":"Acceptation d’un risque moyen au-delà de la tolérance"}'::jsonb, 1, 'approve', 'approving_authority', 2),
  ('risk_acceptance', 'high', '{"en":"Acceptance of a High risk above tolerance","ar":"قبول خطر مرتفع فوق حدّ التحمّل","fr":"Acceptation d’un risque élevé au-delà de la tolérance"}'::jsonb, 1, 'approve', 'approving_authority', 3),
  ('risk_acceptance', 'extreme', '{"en":"Acceptance of an Extreme risk above tolerance","ar":"قبول خطر بالغ الخطورة فوق حدّ التحمّل","fr":"Acceptation d’un risque extrême au-delà de la tolérance"}'::jsonb, 1, 'review', 'quality_officer', 4),
  ('risk_acceptance', 'extreme', '{"en":"Acceptance of an Extreme risk above tolerance","ar":"قبول خطر بالغ الخطورة فوق حدّ التحمّل","fr":"Acceptation d’un risque extrême au-delà de la tolérance"}'::jsonb, 2, 'approve', 'approving_authority', 4),
  ('risk_closure', NULL, '{"en":"Closure of a risk","ar":"إغلاق خطر","fr":"Clôture d’un risque"}'::jsonb, 1, 'approve', 'quality_officer', 5)
) AS v(subject, variant, name, position, kind, role_code, sort);--> statement-breakpoint
-- The routes each client is due: none of that subject and band yet, and
-- every role their steps name.
CREATE TEMPORARY TABLE "risk_routes_due" ON COMMIT DROP AS
SELECT DISTINCT t."id" AS tenant_id, d.subject, d.variant, d.name, d.sort
FROM "tenants" t
JOIN "risk_default_routes" d ON true
WHERE NOT EXISTS (
    SELECT FROM "approval_routes" r
    WHERE r."tenant_id" = t."id" AND r."subject" = d.subject AND r."variant" IS NOT DISTINCT FROM d.variant
  )
  AND NOT EXISTS (
    SELECT FROM "risk_default_routes" s
    WHERE s.subject = d.subject AND s.variant IS NOT DISTINCT FROM d.variant
      AND NOT EXISTS (
        SELECT FROM "roles" ro WHERE ro."tenant_id" = t."id" AND ro."is_system" AND ro."code" = s.role_code
      )
  );--> statement-breakpoint
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT due.tenant_id, NULL, 'risk_defaults_created_by_system', 'tenant', due.tenant_id,
  jsonb_build_object(
    'migration', '0075_risk_management_grants_rules_and_existing_clients',
    'routes', jsonb_agg(jsonb_build_object('subject', due.subject, 'variant', due.variant) ORDER BY due.sort)
  )
FROM "risk_routes_due" due
GROUP BY due.tenant_id;--> statement-breakpoint
INSERT INTO "approval_routes" ("tenant_id", "name", "subject", "variant")
SELECT due.tenant_id, due.name, due.subject, due.variant
FROM "risk_routes_due" due
ORDER BY due.tenant_id, due.sort;--> statement-breakpoint
INSERT INTO "approval_route_steps" ("tenant_id", "route_id", "position", "kind", "assignee_role_id", "due_in_days")
SELECT r."tenant_id", r."id", d.position, d.kind::"approval_step_kind", ro."id", 7
FROM "risk_routes_due" due
JOIN "approval_routes" r
  ON r."tenant_id" = due.tenant_id AND r."subject" = due.subject AND r."variant" IS NOT DISTINCT FROM due.variant
JOIN "risk_default_routes" d ON d.subject = due.subject AND d.variant IS NOT DISTINCT FROM due.variant
JOIN "roles" ro ON ro."tenant_id" = r."tenant_id" AND ro."is_system" AND ro."code" = d.role_code
WHERE NOT EXISTS (SELECT FROM "approval_route_steps" s WHERE s."tenant_id" = r."tenant_id" AND s."route_id" = r."id");--> statement-breakpoint
-- Gone now, not at the end of the transaction: so that the section may be
-- run again in it.
DROP TABLE "risk_routes_due";--> statement-breakpoint
DROP TABLE "risk_default_routes";
