-- Security review 12 of the audit trail. Safe to repeat.

-- H1. Every function that runs as the owner names `pg_temp` last on its
-- search path: a role that made a temporary table of the same name can no
-- longer have the seal, a break notice or the clearing of addresses read
-- or write it instead of the real one. And no role makes temporary tables
-- any more unless it is granted to (none needs to).
DO $$ BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "audit_chain_body"(e "audit_log", p_seq bigint, p_commitment text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT 'trustline-audit-entry-v1' || E'\n'
    || 'id: ' || e."id"::text || E'\n'
    || 'tenant: ' || e."tenant_id"::text || E'\n'
    || 'seq: ' || p_seq::text || E'\n'
    || 'occurredAt: ' || to_char(e."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || E'\n'
    || 'actor: ' || coalesce(e."actor_id"::text, '') || E'\n'
    || 'action: ' || e."action" || E'\n'
    || 'entityType: ' || coalesce(e."entity_type", '') || E'\n'
    || 'entityId: ' || coalesce(e."entity_id"::text, '') || E'\n'
    || 'changes: ' || coalesce(e."changes"::text, '') || E'\n'
    || 'ip: ' || coalesce(p_commitment, '')
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "audit_chain_seal_entry"(e "audit_log", p_late boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  head_seq bigint;
  head_hash text;
  next_seq bigint;
  commitment text;
  body_hash text;
  new_hash text;
BEGIN
  SELECT h."seq", h."hash" INTO head_seq, head_hash
  FROM public."audit_chain_heads" h WHERE h."tenant_id" = e."tenant_id" FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public."audit_chain_heads" ("tenant_id", "seq", "hash")
    VALUES (e."tenant_id", 0, repeat('0', 64)) ON CONFLICT ("tenant_id") DO NOTHING;
    SELECT h."seq", h."hash" INTO head_seq, head_hash
    FROM public."audit_chain_heads" h WHERE h."tenant_id" = e."tenant_id" FOR UPDATE;
  END IF;
  next_seq := head_seq + 1;
  commitment := CASE WHEN e."ip_address" IS NULL THEN NULL
    ELSE encode(sha256(convert_to(coalesce(e."ip_salt", '') || e."ip_address", 'UTF8')), 'hex') END;
  body_hash := encode(sha256(convert_to(public."audit_chain_body"(e, next_seq, commitment), 'UTF8')), 'hex');
  new_hash := encode(sha256(convert_to(
    'trustline-audit-v1' || E'\n' || next_seq::text || E'\n' || head_hash || E'\n' || body_hash, 'UTF8')), 'hex');
  INSERT INTO public."audit_chain" ("tenant_id", "seq", "entry_id", "prev_hash", "body_hash", "hash", "ip_commitment", "sealed_at", "sealed_late")
  VALUES (e."tenant_id", next_seq, e."id", head_hash, body_hash, new_hash, commitment, clock_timestamp(), p_late);
  UPDATE public."audit_chain_heads" SET "seq" = next_seq, "hash" = new_hash, "updated_at" = clock_timestamp()
  WHERE "tenant_id" = e."tenant_id";
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "audit_log_seal"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public."audit_chain_seal_entry"(NEW, false);
  RETURN NULL;
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "audit_chain_report_break"(
  p_tenant uuid, p_kind "audit_chain_break", p_first_bad_seq bigint, p_first_bad_entry uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a break is reported for the client of the transaction only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public."platform_audit_log" ("admin_id", "action", "target_tenant_id", "details")
  VALUES (NULL, 'audit_chain_broken', p_tenant,
    jsonb_build_object('kind', p_kind, 'firstBadSeq', p_first_bad_seq, 'firstBadEntryId', p_first_bad_entry));
END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "audit_log_forget_addresses"(p_before timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  client uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  cleared integer;
BEGIN
  IF client IS NULL THEN
    RAISE EXCEPTION 'addresses are cleared for the client of the transaction only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_before > now() - interval '2 years' THEN
    RAISE EXCEPTION 'addresses are kept two years'
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public."audit_log" SET "ip_address" = NULL, "ip_salt" = NULL
  WHERE "tenant_id" = client AND "occurred_at" < p_before AND "ip_address" IS NOT NULL;
  GET DIAGNOSTICS cleared = ROW_COUNT;
  RETURN cleared;
END
$$;--> statement-breakpoint

-- M3. The application and the admin portal never choose when an entry
-- happened: the database's time, set with the address's salt. Only the
-- owner role (migrations) writes another.
CREATE OR REPLACE FUNCTION "audit_log_salt_address"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user IN ('trustline_app', 'trustline_platform') THEN
    NEW."occurred_at" := now();
  END IF;
  IF NEW."ip_address" IS NULL THEN
    NEW."ip_salt" := NULL;
  ELSE
    NEW."ip_salt" := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- M1. When a check ran is the database's time, whoever writes the result.
CREATE OR REPLACE FUNCTION "audit_chain_verifications_now"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW."run_at" := now();
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_chain_verifications_now" ON "audit_chain_verifications";--> statement-breakpoint
CREATE TRIGGER "audit_chain_verifications_now" BEFORE INSERT ON "audit_chain_verifications"
FOR EACH ROW EXECUTE FUNCTION "audit_chain_verifications_now"();--> statement-breakpoint

-- L7. The admin portal's sessions are limited as the application's are: a
-- session that holds a client's chain head cannot hold it for ever.
ALTER ROLE "trustline_platform" SET statement_timeout = '15s';--> statement-breakpoint
ALTER ROLE "trustline_platform" SET lock_timeout = '5s';--> statement-breakpoint
ALTER ROLE "trustline_platform" SET idle_in_transaction_session_timeout = '60s';
