-- Security review 11 of the business decisions after quality review 3.
-- Database rules that keep what was signed, and corrections to what
-- migration 0054 backfilled. Nothing the release running before this
-- migration does is refused: it never changes an acknowledgement once given
-- nor a decided review, and it writes no confirmation. Every statement is
-- safe to repeat.

-- 1. An acknowledgement once given stays as it was given: its time and its
-- signature (finding 4). The reminders may still be marked.
CREATE OR REPLACE FUNCTION "document_acknowledgements_keep_given"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."acknowledged_at" IS NOT NULL AND (
    NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at"
    OR NEW."signature_id" IS DISTINCT FROM OLD."signature_id"
  ) THEN
    RAISE EXCEPTION 'an acknowledgement once given does not change'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'document_acknowledgements_given_fixed',
            TABLE = 'document_acknowledgements';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "document_acknowledgements_given_fixed"
BEFORE UPDATE ON "document_acknowledgements"
FOR EACH ROW EXECUTE FUNCTION "document_acknowledgements_keep_given"();--> statement-breakpoint

-- 2. A "no change" review once decided stays decided (finding 5): nothing of
-- it changes; and a pending one is decided only with who and when.
CREATE OR REPLACE FUNCTION "document_review_approvals_keep_decision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'pending' AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'a decided review does not change'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'document_review_approvals_decided_fixed',
            TABLE = 'document_review_approvals';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "document_review_approvals_decided_fixed"
BEFORE UPDATE ON "document_review_approvals"
FOR EACH ROW EXECUTE FUNCTION "document_review_approvals_keep_decision"();--> statement-breakpoint

-- 3. Whom a confirmation is due from: moved to each new owner while it
-- awaits, and fixed with the rest once it is given (finding 1).
GRANT UPDATE ("confirmation_due_from") ON "document_imports" TO trustline_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "document_imports_keep_confirmation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."confirmed_at" IS NOT NULL AND (
    NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
    OR NEW."confirmed_by" IS DISTINCT FROM OLD."confirmed_by"
    OR NEW."confirmation_signature_id" IS DISTINCT FROM OLD."confirmation_signature_id"
    OR NEW."confirmation_due_from" IS DISTINCT FROM OLD."confirmation_due_from"
  ) THEN
    RAISE EXCEPTION 'an import is confirmed once'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'document_imports_confirmation_fixed',
            TABLE = 'document_imports';
  END IF;
  -- The importer never confirms their own import with a signature: only an
  -- importer who was the owner when importing, by the import itself.
  IF NEW."confirmed_at" IS NOT NULL AND OLD."confirmed_at" IS NULL
    AND NEW."confirmed_by" = NEW."imported_by" AND NOT NEW."confirmed_by_import" THEN
    RAISE EXCEPTION 'the importer does not confirm their own import'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'document_imports_importer_confirms',
            TABLE = 'document_imports';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- 4. Corrections to what 0054 backfilled (findings 1 and 9). It compared
-- the importer with the owner when 0054 ran, not when the document was
-- imported, and made the confirmation due from nobody. The owner at import
-- time is in the import's audit entry (`document_imported`, `ownerId`).
-- Where it was not the importer, or is not known, the confirmation was
-- not given: it is awaited again, due 30 days from today. Rules 1 to 3 are
-- the application's, not the owner's: they are set aside for this
-- correction only.
ALTER TABLE "document_imports" DISABLE TRIGGER "document_imports_confirmation_fixed";--> statement-breakpoint
WITH wrong AS (
  SELECT di."id", di."tenant_id"
  FROM "document_imports" di
  WHERE di."confirmed_by_import"
    AND di."confirmation_signature_id" IS NULL
    AND NOT EXISTS (
      SELECT FROM "audit_log" a
      WHERE a."tenant_id" = di."tenant_id" AND a."action" = 'document_imported'
        AND a."entity_id" = di."document_id"
        AND a."changes" ->> 'ownerId' = di."imported_by"::text
    )
),
corrected AS (
  UPDATE "document_imports" di
  SET "confirmed_at" = NULL, "confirmed_by" = NULL, "confirmed_by_import" = false,
      "confirmation_due_on" = (clock_timestamp() AT TIME ZONE t."time_zone")::date + 30
  FROM wrong, "tenants" t
  WHERE di."id" = wrong."id" AND t."id" = di."tenant_id"
  RETURNING di."tenant_id", di."id"
)
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT c."tenant_id", NULL, 'import_confirmations_corrected_by_system', 'tenant', c."tenant_id",
  jsonb_build_object(
    'migration', '0056_security_review_11_rules_and_corrections',
    'reason', 'the importer was not the owner when the document was imported, or that is not known',
    'imports', jsonb_agg(c."id" ORDER BY c."id"),
    'confirmationDueIn', 30
  )
FROM corrected c
GROUP BY c."tenant_id";--> statement-breakpoint
ALTER TABLE "document_imports" ENABLE TRIGGER "document_imports_confirmation_fixed";--> statement-breakpoint

-- 5. Imports with no due day (made by the release before 0054 while it
-- ran): due 30 days after they were made, as every other.
UPDATE "document_imports" di
SET "confirmation_due_on" = ((di."imported_at" AT TIME ZONE t."time_zone")::date + 30)
FROM "tenants" t
WHERE t."id" = di."tenant_id" AND di."confirmation_due_on" IS NULL;--> statement-breakpoint

-- 6. Whom each confirmation not yet given is due from: the document's owner
-- now (the import's own, or whoever it was handed to since).
UPDATE "document_imports" di
SET "confirmation_due_from" = d."owner_id"
FROM "documents" d
WHERE d."id" = di."document_id" AND di."confirmation_due_from" IS NULL AND di."confirmed_at" IS NULL;--> statement-breakpoint

-- 7. What 0054 itself backfilled, said in each client's log (finding 9):
-- the confirmations it set as given by the import, and the due days.
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT di."tenant_id", NULL, 'import_confirmations_backfilled_by_system', 'tenant', di."tenant_id",
  jsonb_build_object(
    'migration', '0054_business_decisions_q3_grants_and_existing_clients',
    'recordedBy', '0056_security_review_11_rules_and_corrections',
    'imports', count(*),
    'confirmedByImport', count(*) FILTER (WHERE di."confirmed_by_import")
  )
FROM "document_imports" di
WHERE NOT EXISTS (
  SELECT FROM "audit_log" a
  WHERE a."tenant_id" = di."tenant_id" AND a."action" = 'import_confirmations_backfilled_by_system'
)
GROUP BY di."tenant_id";
