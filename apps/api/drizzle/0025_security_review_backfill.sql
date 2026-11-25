-- What the decisions taken after the security review mean for the records
-- that already exist. Every statement is safe to repeat.

-- 1. An incident that is a sentinel event or a death, or whose timeline shows
-- it once was, keeps needing a second person to close it. Each triage wrote
-- what it changed, with the value before and after, so the timeline says
-- whether it was ever either.
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
);--> statement-breakpoint

-- 2. Comments already stored. Until now "by the reporter" was worked out
-- when a comment was read, from whether its author had reported the
-- incident. Whether that author saw all of the incident when writing was
-- never recorded and cannot be recovered. So every stored comment whose
-- author is the incident's reporter is recorded as written by the reporter:
-- exactly what each reader has been shown so far, and nobody's name appears
-- where it did not before. Nothing is marked as written by a handler.
UPDATE "incident_comments" c SET "by_reporter" = true
FROM "incidents" i
WHERE i."tenant_id" = c."tenant_id" AND i."id" = c."incident_id"
  AND c."author_id" = i."reported_by"
  AND NOT c."by_reporter" AND NOT c."as_handler";--> statement-breakpoint

-- 3. Migration 0020 gave the built-in Administrator and Quality officer of
-- every client two permissions and wrote nothing to the audit log. One entry
-- per client says so now. No actor: it was the system, not a person. The time
-- is that of this entry; 0020 kept none.
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT t."id", NULL, 'built_in_roles_changed_by_system', 'tenant', t."id",
  jsonb_build_object(
    'migration', '0020_built_in_roles_reporter_and_sign_off',
    'roles', (
      SELECT jsonb_agg(r."code" ORDER BY r."code") FROM "roles" r
      WHERE r."tenant_id" = t."id" AND r."is_system"
        AND r."code" IN ('administrator', 'quality_officer')
    ),
    'permissionsAdded', jsonb_build_array('incidents.see_reporter', 'incidents.sign_off')
  )
FROM "tenants" t
WHERE EXISTS (
    SELECT FROM "roles" r
    WHERE r."tenant_id" = t."id" AND r."is_system"
      AND r."code" IN ('administrator', 'quality_officer')
  )
  AND NOT EXISTS (
    SELECT FROM "audit_log" a
    WHERE a."tenant_id" = t."id" AND a."action" = 'built_in_roles_changed_by_system'
      AND a."changes" ->> 'migration' = '0020_built_in_roles_reporter_and_sign_off'
  );
