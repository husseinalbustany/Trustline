-- Deadlines for what already exists. Every statement is safe to repeat.

-- 1. The starting response rules for every hospital that already exists. A
-- new one gets them from ensureResponseRules(). The values are those of
-- DEFAULT_RESPONSE_RULES in src/incidents/response-rules.ts.
INSERT INTO "incident_response_rules" ("tenant_id", "harm_level", "triage_within_hours", "close_within_days")
SELECT t."id", v.harm_level::"incident_harm_level", v.triage_within_hours, v.close_within_days
FROM "tenants" t
CROSS JOIN (VALUES
  ('none', 72, 30),
  ('mild', 72, 30),
  ('moderate', 48, 30),
  ('severe', 24, 45),
  ('death', 24, 45)
) AS v(harm_level, triage_within_hours, close_within_days)
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 2. When each incident was first triaged, from its timeline: `triaged_at`
-- moves with every later correction, so it cannot say.
UPDATE "incidents" i SET "first_triaged_at" = (
  SELECT min(e."occurred_at") FROM "incident_events" e
  WHERE e."tenant_id" = i."tenant_id" AND e."incident_id" = i."id"
    AND e."kind" = 'triaged' AND e."from_status" = 'new'
)
WHERE i."first_triaged_at" IS NULL;--> statement-breakpoint

-- 3. The two deadlines of every existing incident, counted from when it was
-- reported, so that nothing already old is left without one.
-- Triage: from the harm level the reporter gave, which is what the first
-- change of harm level on the timeline says it was before; a report is never
-- sentinel until triage says so.
-- Closure: from what the incident is now, with the `death` row for a
-- sentinel event. Days are days on the hospital's own calendar.
UPDATE "incidents" i SET
  "triage_due_at" = i."reported_at" + make_interval(hours => tr."triage_within_hours"),
  "close_due_at" = ((i."reported_at" AT TIME ZONE t."time_zone") + make_interval(days => cr."close_within_days")) AT TIME ZONE t."time_zone"
FROM "tenants" t, "incident_response_rules" tr, "incident_response_rules" cr
WHERE t."id" = i."tenant_id"
  AND tr."tenant_id" = i."tenant_id"
  AND tr."harm_level" = coalesce((
    SELECT (e."details" -> 'harmLevel' ->> 'from')::"incident_harm_level"
    FROM "incident_events" e
    WHERE e."tenant_id" = i."tenant_id" AND e."incident_id" = i."id"
      AND e."kind" = 'triaged' AND e."details" -> 'harmLevel' ->> 'from' IS NOT NULL
    ORDER BY e."occurred_at" LIMIT 1
  ), i."harm_level")
  AND cr."tenant_id" = i."tenant_id"
  AND cr."harm_level" = CASE WHEN i."is_sentinel" THEN 'death' ELSE i."harm_level" END
  AND i."triage_due_at" IS NULL AND i."close_due_at" IS NULL;--> statement-breakpoint

-- 4. A deadline that had already passed when this ran, or was already in its
-- last quarter, is recorded as announced, so the deadline check does not send
-- a hospital one notification for every old incident on the day it gets this
-- release. Those incidents are still overdue: they are marked so in every
-- list, found by the "overdue" filter and counted on the dashboard. Only a
-- deadline that passes from now on is announced.
UPDATE "incidents" SET
  "triage_due_soon_at" = CASE WHEN now() >= "triage_due_at" - ("triage_due_at" - "reported_at") / 4 THEN now() END,
  "triage_overdue_at" = CASE WHEN now() >= "triage_due_at" THEN now() END,
  "close_due_soon_at" = CASE WHEN now() >= "close_due_at" - ("close_due_at" - "reported_at") / 4 THEN now() END,
  "close_overdue_at" = CASE WHEN now() >= "close_due_at" THEN now() END
WHERE "triage_due_soon_at" IS NULL AND "triage_overdue_at" IS NULL
  AND "close_due_soon_at" IS NULL AND "close_overdue_at" IS NULL
  AND "triage_due_at" IS NOT NULL AND "close_due_at" IS NOT NULL;
