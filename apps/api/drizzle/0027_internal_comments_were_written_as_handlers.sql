-- Comments stored before the capacity of their writer was recorded.
-- Migration 0025 marked every stored comment whose author is the incident's
-- reporter as written "by the reporter", saying that what the writer could
-- see at the time cannot be recovered. For an internal comment it can: only
-- someone who saw all of the incident could write one, so its author wrote
-- it as one of the people handling the incident. Left as "by the reporter",
-- it tells whoever reads the internal comments that the report was a named
-- one, made by someone with full access to it.
--
-- So an internal comment whose author is the incident's reporter is recorded
-- as written by a handler, and carries its author's name like any other
-- handler's. Comments visible to everyone are left exactly as they are: for
-- those the capacity really cannot be known. Safe to repeat.
UPDATE "incident_comments" c SET "by_reporter" = false, "as_handler" = true
FROM "incidents" i
WHERE i."tenant_id" = c."tenant_id" AND i."id" = c."incident_id"
  AND c."visibility" = 'internal'
  AND c."author_id" IS NOT NULL
  AND c."author_id" = i."reported_by"
  AND NOT c."as_handler";
