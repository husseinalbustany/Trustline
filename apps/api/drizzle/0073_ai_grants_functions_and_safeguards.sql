-- The AI foundation and AI drafting (docs/specs/ai-providers-and-allowances.md,
-- docs/specs/ai-policy-drafting.md): what the application and the admin
-- portal may do on the tables of migration 0072; the two functions through
-- which the application learns what every client has spent and tells
-- Trustline's staff that a spending limit stopped requests; request records
-- that cannot be rewritten once ended (security review 13); and the starting
-- allowances of the plan every existing client is on. Nothing the release
-- running from before this migration does is refused: it reads none of
-- these tables. Every statement is safe to repeat.

-- 1. Grants. Connections and the platform's settings are Trustline's: the
-- admin portal writes them, the application reads them (a connection names
-- the variable its credential is in, never the credential). A client's
-- settings and features are written by the portal; the application reads
-- them and writes the client's own switch alone. Requests are added and
-- finished by the application, never deleted or rewritten; the portal
-- reads them. A plan's allowances are read by the application.
GRANT SELECT ("ai_allowances") ON "plans" TO trustline_app;--> statement-breakpoint
GRANT SELECT ON "ai_provider_connections" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ai_provider_connections" TO trustline_platform;--> statement-breakpoint
GRANT SELECT ON "ai_platform_settings" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ai_platform_settings" TO trustline_platform;--> statement-breakpoint
GRANT SELECT ON "ai_client_settings" TO trustline_app;--> statement-breakpoint
GRANT UPDATE ("client_enabled", "client_switched_by", "client_switched_at") ON "ai_client_settings" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ai_client_settings" TO trustline_platform;--> statement-breakpoint
GRANT SELECT ON "ai_client_features" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "ai_client_features" TO trustline_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "ai_requests" TO trustline_app;--> statement-breakpoint
GRANT UPDATE ("outcome", "reason", "attempts", "input_tokens", "output_tokens", "cost_micro_usd", "finished_at") ON "ai_requests" TO trustline_app;--> statement-breakpoint
GRANT SELECT ON "ai_requests" TO trustline_platform;--> statement-breakpoint
GRANT SELECT, INSERT ON "ai_usage_notices" TO trustline_app;--> statement-breakpoint

-- 2. What every client's requests have cost this month in UTC. The month is
-- the function's own: a caller cannot ask about any other moment, and so
-- cannot watch when other clients use AI. Its search_path ends with
-- pg_temp, and every name is qualified, so that no temporary table of the
-- session can stand in for the real one. Counted as AiService counts:
-- answered, failed, or under way for less than 15 minutes
-- (PENDING_STALE_MINUTES), at the most a request under way can cost.
CREATE OR REPLACE FUNCTION public."ai_platform_spend_this_month"() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(sum(r."cost_micro_usd"), 0)::bigint
  FROM public."ai_requests" r
  WHERE r."created_at" >= (date_trunc('month', pg_catalog.now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    AND (r."outcome" IN ('succeeded', 'failed')
         OR (r."outcome" = 'pending' AND r."created_at" > pg_catalog.now() - interval '15 minutes'))
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public."ai_platform_spend_this_month"() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public."ai_platform_spend_this_month"() TO trustline_app;--> statement-breakpoint

-- 3. A spending limit stopped requests: said in Trustline's own log
-- (`ai_spending_limit_reached`), which the application cannot otherwise
-- write, once a month per limit: the client's (its month), or the
-- platform's (the UTC month). For the client of the calling transaction
-- only, and nothing of any request. Search path and names as section 2.
CREATE OR REPLACE FUNCTION public."ai_report_spending_limit"(p_tenant uuid, p_scope text, p_month text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(pg_catalog.current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a spending limit is reported for the client of the transaction only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_scope NOT IN ('client', 'platform') OR p_month !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'unknown spending limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'trustline.ai.spending_notice.' || p_scope || '.' ||
    CASE WHEN p_scope = 'client' THEN p_tenant::text ELSE '' END || '.' || p_month, 0));
  IF EXISTS (
    SELECT FROM public."platform_audit_log" l
    WHERE l."action" = 'ai_spending_limit_reached'
      AND l."details" ->> 'scope' = p_scope
      AND l."details" ->> 'month' = p_month
      AND (p_scope = 'platform' OR l."target_tenant_id" = p_tenant)
  ) THEN
    RETURN;
  END IF;
  INSERT INTO public."platform_audit_log" ("admin_id", "action", "target_tenant_id", "details")
  VALUES (NULL, 'ai_spending_limit_reached', p_tenant, pg_catalog.jsonb_build_object('scope', p_scope, 'month', p_month));
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public."ai_report_spending_limit"(uuid, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public."ai_report_spending_limit"(uuid, text, text) TO trustline_app;--> statement-breakpoint

-- 4. The plan every existing client is on (`everything`: every module, no
-- limit) gets the largest allowances of the spec's table, Enterprise's, if
-- they were never set. AI stays off for every client all the same: it is
-- offered only once Trustline's staff configure it, and used only once the
-- client switches it on.
UPDATE "plans"
SET "ai_allowances" = '{"drafting":200,"insights":2000,"assistant":5000}'::jsonb
WHERE "code" = 'everything'
  AND "ai_allowances" = '{"drafting":0,"insights":0,"assistant":0}'::jsonb;--> statement-breakpoint

-- 5. A request is finished once, while it is under way, and what it was
-- (whose, which feature, connection and model, its month and whether it
-- counted) never changes: so its records cannot be rewritten to reset a
-- client's usage or cost.
CREATE OR REPLACE FUNCTION public."ai_requests_finish_once"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."outcome" <> 'pending' OR OLD."finished_at" IS NOT NULL
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."feature" IS DISTINCT FROM OLD."feature"
    OR NEW."connection_id" IS DISTINCT FROM OLD."connection_id"
    OR NEW."model" IS DISTINCT FROM OLD."model"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."month" IS DISTINCT FROM OLD."month"
    OR NEW."unit_key" IS DISTINCT FROM OLD."unit_key"
    OR NEW."counted" IS DISTINCT FROM OLD."counted"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'an AI request is finished once, and what it was does not change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ai_requests_finished_once', TABLE = 'ai_requests';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "ai_requests_finish_once" ON public."ai_requests";--> statement-breakpoint
CREATE TRIGGER "ai_requests_finish_once" BEFORE UPDATE ON public."ai_requests"
FOR EACH ROW EXECUTE FUNCTION public."ai_requests_finish_once"();--> statement-breakpoint

-- 6. AI drafting. The profile is read and written by the client's
-- administrators. A design is added as a new version and never changed. A
-- conversation's turns and versions are added and never changed; a
-- conversation is removed only when it was not handed over (the policy
-- drafting_sessions_keep_handed_over), and its turns and versions go with
-- it. The admin portal reaches none of them.
GRANT SELECT, INSERT, UPDATE ON "organization_profiles" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "document_designs" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "drafting_sessions" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "drafting_messages" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "drafting_versions" TO trustline_app;
