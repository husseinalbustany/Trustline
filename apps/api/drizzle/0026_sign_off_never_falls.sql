-- Once an incident has been a sentinel event or a death, closing it takes a
-- second person, for good (`sign_off_needed`). Until now only the
-- application kept that: any release, script or mistake that wrote the
-- column could clear it, and a release that does not know the column never
-- set it. From here on the database keeps it. Every statement is safe to
-- repeat.

-- 1. On every insert and update of an incident: the flag is raised when the
-- incident is a sentinel event or a death, or was one until this change, and
-- once raised it stays raised whatever is written to it. A change from true
-- to false is not refused, it simply does not happen: a release that knows
-- nothing of this keeps working, and cannot clear the flag.
CREATE OR REPLACE FUNCTION "incidents_keep_sign_off_needed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."is_sentinel" OR NEW."harm_level" = 'death' THEN
    NEW."sign_off_needed" := true;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD."sign_off_needed" OR OLD."is_sentinel" OR OLD."harm_level" = 'death' THEN
      NEW."sign_off_needed" := true;
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

CREATE OR REPLACE TRIGGER "incidents_sign_off_never_falls"
BEFORE INSERT OR UPDATE ON "incidents"
FOR EACH ROW EXECUTE FUNCTION "incidents_keep_sign_off_needed"();--> statement-breakpoint

-- 2. What migration 0025 did once, done again now that nothing can undo it:
-- an incident that is a sentinel event or a death, or whose timeline shows
-- it once was, and that a release still running since then stored or
-- changed without the flag.
UPDATE "incidents" i SET "sign_off_needed" = true
WHERE NOT i."sign_off_needed" AND (
  i."is_sentinel" OR i."harm_level" = 'death'
  OR EXISTS (
    SELECT FROM "incident_events" e
    WHERE e."tenant_id" = i."tenant_id" AND e."incident_id" = i."id"
      AND e."kind" = 'triaged'
      AND (
        e."details" -> 'harmLevel' ->> 'from' = 'death'
        OR e."details" -> 'harmLevel' ->> 'to' = 'death'
        OR e."details" -> 'isSentinel' ->> 'from' = 'true'
        OR e."details" -> 'isSentinel' ->> 'to' = 'true'
      )
  )
);
