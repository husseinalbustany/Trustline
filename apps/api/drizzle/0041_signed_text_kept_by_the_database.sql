-- What a signature stands behind, kept by the database as well as by the
-- application (security review 5, finding 5): the text of a version once it
-- has left draft, the order a version's status goes in, a decided approval
-- step, and a document's published version being one of its own. Until now
-- only the application kept these: one bug, or an SQL injection elsewhere,
-- could have changed approved or published text and nothing would have
-- stopped it. Nothing the application does today is refused by any of it,
-- so a release still running from before this migration keeps working.
-- Every statement is safe to repeat.

-- 1. A document's published version is one of its own versions. The key of
-- 0039 keeps the tenant only; this one keeps the document too, using
-- document_versions_document_id_key (0040). The key of 0039 stays: it says
-- less, and nothing is lost by keeping it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'documents_published_version_own_fk') THEN
    ALTER TABLE "documents" ADD CONSTRAINT "documents_published_version_own_fk"
      FOREIGN KEY ("tenant_id", "id", "published_version_id")
      REFERENCES "document_versions" ("tenant_id", "document_id", "id");
  END IF;
END $$;--> statement-breakpoint

-- 2. A version's text, and what it says of itself, change only while it is
-- a draft: what is signed (policies/signed-content.ts) is its document and
-- number, its sections and text in every language, its change summary and
-- what it asks of its readers. And its status goes only the ways the
-- application takes it, so that a version cannot be put back to draft to
-- be edited once approved or published:
--   draft      -> in_review, withdrawn
--   in_review  -> draft (returned or recalled), approved, withdrawn
--   approved   -> published, withdrawn
--   published  -> superseded
--   superseded, withdrawn: final.
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

CREATE OR REPLACE TRIGGER "document_versions_signed_text_fixed"
BEFORE UPDATE ON "document_versions"
FOR EACH ROW EXECUTE FUNCTION "document_versions_keep_signed_text"();--> statement-breakpoint

-- 3. Of a run's step, the application changes only how it stands and its
-- decision. What it is (its run, position, kind, assignee, time allowed)
-- was copied from the route when the run started and never changes.
REVOKE UPDATE ON "approval_run_steps" FROM trustline_app;--> statement-breakpoint
GRANT UPDATE ("status", "activated_at", "due_at", "decided_by", "decided_at", "comment", "signature_id")
  ON "approval_run_steps" TO trustline_app;--> statement-breakpoint

-- 4. A step once decided (approved or returned), or skipped, never changes.
-- A decision is written once, by the step that is pending, as it becomes
-- approved (with the person and the signature) or returned (with the
-- person). The order of a step is waiting -> pending -> approved or
-- returned, and waiting or pending -> skipped when the run ends.
CREATE OR REPLACE FUNCTION "approval_run_steps_keep_decisions"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('approved', 'returned', 'skipped') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      RAISE EXCEPTION 'a decided step does not change'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'approval_run_steps_decided_fixed',
              TABLE = 'approval_run_steps';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'waiting' AND NEW."status" IN ('pending', 'skipped'))
    OR (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'returned', 'skipped'))
  ) THEN
    RAISE EXCEPTION 'a step''s status does not go that way'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'approval_run_steps_status_order',
            TABLE = 'approval_run_steps';
  END IF;
  IF NEW."status" IN ('approved', 'returned') THEN
    IF NEW."decided_by" IS NULL OR NEW."decided_at" IS NULL
      OR (NEW."status" = 'approved' AND NEW."signature_id" IS NULL) THEN
      RAISE EXCEPTION 'a decision names who made it, and an approval its signature'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'approval_run_steps_decision_complete',
              TABLE = 'approval_run_steps';
    END IF;
  ELSIF NEW."decided_by" IS DISTINCT FROM OLD."decided_by"
    OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
    OR NEW."signature_id" IS DISTINCT FROM OLD."signature_id"
    OR NEW."comment" IS DISTINCT FROM OLD."comment" THEN
    RAISE EXCEPTION 'only a decision writes a decision'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'approval_run_steps_decided_fixed',
            TABLE = 'approval_run_steps';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE OR REPLACE TRIGGER "approval_run_steps_decided_fixed"
BEFORE UPDATE ON "approval_run_steps"
FOR EACH ROW EXECUTE FUNCTION "approval_run_steps_keep_decisions"();
