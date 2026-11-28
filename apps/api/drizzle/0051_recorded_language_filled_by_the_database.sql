-- Security review 9, finding 5: the authoritative language of a version sent
-- for review by a release from before 0049, which does not write it, is
-- filled by the database as the version leaves draft, from the client's
-- setting as it stands then (the one it chose if it still works in it, else
-- its main language). It is not covered by that version's signatures
-- (signs_authoritative_locale stays false): that release signs the earlier
-- form. And a version that left draft with no language recorded may be
-- given one, once: from NULL to a language while its signatures do not
-- cover it. Otherwise as 0049. Nothing either release does is refused.
-- Every statement is safe to repeat.

CREATE OR REPLACE FUNCTION "document_versions_keep_signed_text"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'draft' AND NEW."status" = 'in_review'
    AND NEW."authoritative_locale" IS NULL THEN
    SELECT CASE
      WHEN ds."authoritative_locale" IS NOT NULL AND ds."authoritative_locale" = ANY (t."locales")
        THEN ds."authoritative_locale"
      ELSE t."default_locale" END
    INTO NEW."authoritative_locale"
    FROM "tenants" t
    LEFT JOIN "document_settings" ds ON ds."tenant_id" = t."id"
    WHERE t."id" = NEW."tenant_id";
    NEW."signs_authoritative_locale" := false;
  END IF;
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
    OR (NEW."authoritative_locale" IS DISTINCT FROM OLD."authoritative_locale"
        AND NOT (OLD."authoritative_locale" IS NULL
                 AND NOT OLD."signs_authoritative_locale"
                 AND NOT NEW."signs_authoritative_locale"))
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
$$;--> statement-breakpoint

-- The versions sent by a release from before 0049 since it ran: given the
-- language that stands now, once.
UPDATE "document_versions" v
SET "authoritative_locale" = CASE
  WHEN ds."authoritative_locale" IS NOT NULL AND ds."authoritative_locale" = ANY (t."locales")
    THEN ds."authoritative_locale"
  ELSE t."default_locale" END
FROM "tenants" t
LEFT JOIN "document_settings" ds ON ds."tenant_id" = t."id"
WHERE t."id" = v."tenant_id"
  AND v."status" <> 'draft'
  AND v."authoritative_locale" IS NULL;
