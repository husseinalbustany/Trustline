-- Who may do what with plans and subscriptions, and a subscription for every
-- client that already exists. Every statement is safe to repeat.

-- 1. Plans are Trustline's own. The admin portal reads, adds and changes
-- them, and never deletes one: a plan is retired. The application reads
-- only what a client's entitlements are made of: never a price.
GRANT SELECT, INSERT, UPDATE ON "plans" TO trustline_platform;--> statement-breakpoint
GRANT SELECT ("id", "code", "name", "modules", "limits", "extras") ON "plans" TO trustline_app;--> statement-breakpoint

-- 2. A subscription is the client's, under row-level security. The admin
-- portal writes it (subscriptions_platform) and never deletes it. The
-- application reads its own client's (tenant_isolation), every column but
-- Trustline's note, and writes nothing.
GRANT SELECT, INSERT, UPDATE ON "subscriptions" TO trustline_platform;--> statement-breakpoint
GRANT SELECT ("tenant_id", "plan_id", "status", "starts_on", "renews_on", "trial_ends_on", "add_on_modules", "limit_overrides", "created_at", "updated_at") ON "subscriptions" TO trustline_app;--> statement-breakpoint

-- 3. The admin portal records in the client's own audit log what it changed
-- about what the client may use, in the same transaction as the change.
-- INSERT alone: it cannot read the log or change an entry
-- (audit_log_platform_insert limits it to adding rows).
GRANT INSERT ON "audit_log" TO trustline_platform;--> statement-breakpoint

-- 4. The plan every client that existed before plans is moved to: every
-- module, no limit, the extras they had. Until now every client got
-- everything that is built, so nothing changes for anyone. Trustline moves
-- each one to its contracted plan from the admin portal.
INSERT INTO "plans" ("code", "name", "description", "modules", "limits", "extras", "position")
VALUES (
  'everything',
  '{"en": "Everything", "ar": "كل الوحدات", "fr": "Tout"}'::jsonb,
  '{"en": "Every module and no limits. Given to every client that existed before plans, so that nothing changed for them; move each to its contracted plan.", "ar": "كل الوحدات بلا حدود. أُعطيت لكل عميل كان قائمًا قبل الخطط حتى لا يتغير شيء عليه؛ انقل كل عميل إلى خطته المتعاقد عليها.", "fr": "Tous les modules, sans limite. Attribuée à chaque client existant avant les offres, pour que rien ne change pour lui ; passez chacun à l''offre de son contrat."}'::jsonb,
  '{incidents,investigations,actions,policies,risks,training,ai_assistant}'::text[],
  '{"users": null, "sites": null, "storageMb": null, "aiCreditsPerMonth": null}'::jsonb,
  -- Clinical AI suggestions need a signed agreement (ai-insights.md), and
  -- no client has one: nothing of AI is built.
  '{"sso": true, "publicReporting": true, "clinicalAiSuggestions": false}'::jsonb,
  1000
)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint

-- 5. An active subscription on it for every client without one, started on
-- the day the client was created, in its own time zone.
INSERT INTO "subscriptions" ("tenant_id", "plan_id", "status", "starts_on")
SELECT t."id", p."id", 'active', (t."created_at" AT TIME ZONE t."time_zone")::date
FROM "tenants" t
CROSS JOIN "plans" p
WHERE p."code" = 'everything'
ON CONFLICT ("tenant_id") DO NOTHING;
