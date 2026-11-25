-- The built-in Administrator and Quality officer roles gain the right to see
-- who reported an incident and the right to sign off the closure of a
-- sentinel event. A new client gets them from ensureSystemRoles(); this gives
-- them to the clients that already exist, whose quality office would
-- otherwise stop seeing reporters the moment this release is deployed.
-- Roles a hospital made itself are left as they are. Safe to repeat.
UPDATE "roles" SET "permissions" = "permissions" || '{incidents.see_reporter}'::text[]
WHERE "is_system" AND "code" IN ('administrator', 'quality_officer')
  AND NOT ("permissions" @> '{incidents.see_reporter}'::text[]);--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" || '{incidents.sign_off}'::text[]
WHERE "is_system" AND "code" IN ('administrator', 'quality_officer')
  AND NOT ("permissions" @> '{incidents.sign_off}'::text[]);
