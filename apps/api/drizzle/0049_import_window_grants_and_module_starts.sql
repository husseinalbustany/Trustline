-- Security review 7: what the application and the admin portal may do on the
-- tables of migration 0048, the day each module is first switched on
-- (recorded by the database), and the authoritative language of every
-- version no longer a draft, recorded and then kept. Nothing the release
-- running from before this migration does is refused: it never writes these
-- tables or columns, and a version it sends for review is recorded with no
-- language, which the application then reads from the setting as before.
-- Every statement is safe to repeat.

-- 1. Grants. module_starts is written by the database alone (section 2):
-- both roles read it, neither writes it. The import window is set by the
-- admin portal and read by the application.
GRANT SELECT ON "module_starts" TO trustline_app;--> statement-breakpoint
GRANT SELECT ON "module_starts" TO trustline_platform;--> statement-breakpoint
GRANT SELECT ON "policy_import_windows" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "policy_import_windows" TO trustline_platform;--> statement-breakpoint

-- 2. The first day of each module, written whenever a client gains one:
-- the subscription created, its plan, add-ons or status changed, or a
-- plan's modules changed. A module already recorded keeps its first day.
-- SECURITY DEFINER, so that neither role needs to write the table; its
-- search_path is fixed so that nothing can be put in its way.
CREATE OR REPLACE FUNCTION "record_module_starts"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'subscriptions' THEN
    INSERT INTO "module_starts" ("tenant_id", "module", "started_on")
    SELECT DISTINCT NEW."tenant_id", m, (clock_timestamp() AT TIME ZONE t."time_zone")::date
    FROM "plans" p
    JOIN "tenants" t ON t."id" = NEW."tenant_id",
    unnest(p."modules" || NEW."add_on_modules") AS m
    WHERE p."id" = NEW."plan_id" AND NEW."status" <> 'cancelled'
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO "module_starts" ("tenant_id", "module", "started_on")
    SELECT DISTINCT s."tenant_id", m, (clock_timestamp() AT TIME ZONE t."time_zone")::date
    FROM "subscriptions" s
    JOIN "tenants" t ON t."id" = s."tenant_id",
    unnest(NEW."modules" || s."add_on_modules") AS m
    WHERE s."plan_id" = NEW."id" AND s."status" <> 'cancelled'
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "record_module_starts"() FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE TRIGGER "subscriptions_record_module_starts"
AFTER INSERT OR UPDATE OF "plan_id", "add_on_modules", "status" ON "subscriptions"
FOR EACH ROW EXECUTE FUNCTION "record_module_starts"();--> statement-breakpoint

CREATE OR REPLACE TRIGGER "plans_record_module_starts"
AFTER UPDATE OF "modules" ON "plans"
FOR EACH ROW EXECUTE FUNCTION "record_module_starts"();--> statement-breakpoint

-- 3. The clients that have modules already. When they were first switched
-- on was never recorded. For policies, which was built after most clients
-- existed, the day is when the client first used it (its first document)
-- or today if it has none, whichever is earlier: imports must then be of
-- documents approved before that. For any other module, the day its
-- subscription started, or today if that is later.
INSERT INTO "module_starts" ("tenant_id", "module", "started_on")
SELECT DISTINCT s."tenant_id", m,
  CASE WHEN m = 'policies' THEN LEAST(
    (clock_timestamp() AT TIME ZONE t."time_zone")::date,
    (SELECT min((d."created_at" AT TIME ZONE t."time_zone")::date)
       FROM "documents" d WHERE d."tenant_id" = s."tenant_id"))
  ELSE LEAST(s."starts_on", (clock_timestamp() AT TIME ZONE t."time_zone")::date)
  END
FROM "subscriptions" s
JOIN "plans" p ON p."id" = s."plan_id"
JOIN "tenants" t ON t."id" = s."tenant_id",
unnest(p."modules" || s."add_on_modules") AS m
WHERE s."status" <> 'cancelled'
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 4. The authoritative language of every version that has left draft, as
-- it stands now: the one the client chose if it still works in it, else its
-- main language. From now on it stays, whatever the setting becomes. Not
-- covered by their signatures (signs_authoritative_locale stays false), so
-- every signature made before keeps its hash. Done before section 5, whose
-- rule would refuse it.
UPDATE "document_versions" v
SET "authoritative_locale" = CASE
  WHEN ds."authoritative_locale" IS NOT NULL AND ds."authoritative_locale" = ANY (t."locales")
    THEN ds."authoritative_locale"
  ELSE t."default_locale" END
FROM "tenants" t
LEFT JOIN "document_settings" ds ON ds."tenant_id" = t."id"
WHERE t."id" = v."tenant_id"
  AND v."status" <> 'draft'
  AND v."authoritative_locale" IS NULL;--> statement-breakpoint

-- 5. The rule of migration 0041, with the recorded language kept as the
-- text is: written while the version is a draft (when it is sent), fixed
-- once it is not. Otherwise as 0041.
CREATE OR REPLACE FUNCTION "document_versions_keep_signed_text"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'draft' AND (
    NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."sections" IS DISTINCT FROM OLD."sections"
    OR NEW."content" IS DISTINCT FROM OLD."content"
    OR NEW."change_summary" IS DISTINCT FROM OLD."change_summary"
    OR NEW."acknowledgement_required" IS DISTINCT FROM OLD."acknowledgement_required"
    OR NEW."acknowledge_within_days" IS DISTINCT FROM OLD."acknowledge_within_days"
    OR NEW."authoritative_locale" IS DISTINCT FROM OLD."authoritative_locale"
    OR NEW."signs_authoritative_locale" IS DISTINCT FROM OLD."signs_authoritative_locale"
  ) THEN
    RAISE EXCEPTION 'a version outside draft keeps its text'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'document_versions_signed_text_fixed',
            TABLE = 'document_versions';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'draft' AND NEW."status" IN ('in_review', 'withdrawn'))
    OR (OLD."status" = 'in_review' AND NEW."status" IN ('draft', 'approved', 'withdrawn'))
    OR (OLD."status" = 'approved' AND NEW."status" IN ('published', 'withdrawn'))
    OR (OLD."status" = 'published' AND NEW."status" = 'superseded')
  ) THEN
    RAISE EXCEPTION 'a version''s status does not go that way'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'document_versions_status_order',
            TABLE = 'document_versions';
  END IF;
  RETURN NEW;
END
$$;
