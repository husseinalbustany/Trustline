-- Decisions of the second quality review that the database keeps as well as
-- the application, and what they need of the rows already stored. Every
-- statement is safe to repeat.

-- 1. A report through the public link does not start the two-person rule
-- from the sender's own harm level: anyone with the link can pick "Death".
-- `sign_off_needed` is raised for such a report only once a triager has
-- graded it, which `first_triaged_at` records. A report by a signed-in
-- member of staff is unchanged: their grade counts from the report on.
--
-- What migration 0026 made sure of still holds: once raised, the flag stays
-- raised whatever is written to it, and a release that does not know the
-- flag can neither clear it nor fail to set it. A release that still sets it
-- from a public sender's grade is not overruled: the trigger only ever
-- raises the flag.
CREATE OR REPLACE FUNCTION "incidents_keep_sign_off_needed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."is_sentinel" OR NEW."harm_level" = 'death')
     AND (NEW."channel" <> 'public' OR NEW."first_triaged_at" IS NOT NULL) THEN
    NEW."sign_off_needed" := true;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."sign_off_needed"
       OR ((OLD."is_sentinel" OR OLD."harm_level" = 'death')
           AND (OLD."channel" <> 'public' OR OLD."first_triaged_at" IS NOT NULL)) THEN
      NEW."sign_off_needed" := true;
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- 2. Setting a report aside decides about it as much as triaging it, and
-- counts as its first triage, at that moment, for "triaged on time". The
-- application records it from now on; this records it for those set aside
-- before, from the timeline.
UPDATE "incidents" i SET "first_triaged_at" = (
  SELECT min(e."occurred_at") FROM "incident_events" e
  WHERE e."tenant_id" = i."tenant_id" AND e."incident_id" = i."id"
    AND e."kind" = 'rejected' AND e."from_status" = 'new'
)
WHERE i."first_triaged_at" IS NULL
  AND EXISTS (
    SELECT FROM "incident_events" e
    WHERE e."tenant_id" = i."tenant_id" AND e."incident_id" = i."id"
      AND e."kind" = 'rejected' AND e."from_status" = 'new'
  );--> statement-breakpoint

-- 3. Which closing deadline each "due soon" and "overdue" was sent for. A
-- deadline is now announced only if it is later than the last one announced
-- at that stage; what was announced before this release was announced for
-- the deadline the incident has now, or for one it moved from to a moment
-- already past, which counts the same.
UPDATE "incidents" SET "close_due_soon_for" = "close_due_at"
WHERE "close_due_soon_at" IS NOT NULL AND "close_due_soon_for" IS NULL;--> statement-breakpoint
UPDATE "incidents" SET "close_overdue_for" = "close_due_at"
WHERE "close_overdue_at" IS NOT NULL AND "close_overdue_for" IS NULL;
