-- The audit trail's hash chain (docs/specs/audit-trail.md, "Tamper
-- evidence"): one chain per client, sealed by the database as each writing
-- transaction commits, so that every writer is chained with no way round
-- it in code: the application, the admin portal's raw inserts, and
-- migrations. Then the entries that exist are sealed as they stand, marked
-- as recorded before the trail was sealed, and each client's chain says so
-- in its first sealed entry (`audit_chain_started`).
--
-- In the migration's transaction, holding the log so that no entry is
-- written meanwhile: an entry written before the trigger existed and
-- committed after it would have no seal. Every statement is safe to repeat.

LOCK TABLE "audit_log" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- 1. The address of a sign-in is kept with a random salt, set here for
-- every writer; the sealed body holds only SHA-256(salt + address), so that
-- the address can be cleared later and the chain still checked.
CREATE OR REPLACE FUNCTION "audit_log_salt_address"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."ip_address" IS NULL THEN
    NEW."ip_salt" := NULL;
  ELSE
    NEW."ip_salt" := encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex');
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_salt_address" ON "audit_log";--> statement-breakpoint
CREATE TRIGGER "audit_log_salt_address" BEFORE INSERT ON "audit_log"
FOR EACH ROW EXECUTE FUNCTION "audit_log_salt_address"();--> statement-breakpoint
UPDATE "audit_log"
SET "ip_salt" = encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex')
WHERE "ip_address" IS NOT NULL AND "ip_salt" IS NULL;--> statement-breakpoint

-- 2. An entry's body: the fixed text that is hashed. One line per field, in
-- this order, with an empty value for none. The daily check rebuilds it
-- outside the database (src/audit/chain.ts), and the chain file will carry
-- it, so this form never changes: a new form is a new version line.
CREATE OR REPLACE FUNCTION "audit_chain_body"(e "audit_log", p_seq bigint, p_commitment text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
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

-- 3. Seals one entry: locks the client's head, hashes the entry, adds its
-- chain row and moves the head. Owned by the owner role, with a fixed
-- search path: the application cannot write the chain itself.
CREATE OR REPLACE FUNCTION "audit_chain_seal_entry"(e "audit_log", p_late boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  head_seq bigint;
  head_hash text;
  next_seq bigint;
  commitment text;
  body_hash text;
  new_hash text;
BEGIN
  SELECT h."seq", h."hash" INTO head_seq, head_hash
  FROM "audit_chain_heads" h WHERE h."tenant_id" = e."tenant_id" FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO "audit_chain_heads" ("tenant_id", "seq", "hash")
    VALUES (e."tenant_id", 0, repeat('0', 64)) ON CONFLICT ("tenant_id") DO NOTHING;
    SELECT h."seq", h."hash" INTO head_seq, head_hash
    FROM "audit_chain_heads" h WHERE h."tenant_id" = e."tenant_id" FOR UPDATE;
  END IF;
  next_seq := head_seq + 1;
  commitment := CASE WHEN e."ip_address" IS NULL THEN NULL
    ELSE encode(sha256(convert_to(coalesce(e."ip_salt", '') || e."ip_address", 'UTF8')), 'hex') END;
  body_hash := encode(sha256(convert_to("audit_chain_body"(e, next_seq, commitment), 'UTF8')), 'hex');
  new_hash := encode(sha256(convert_to(
    'trustline-audit-v1' || E'\n' || next_seq::text || E'\n' || head_hash || E'\n' || body_hash, 'UTF8')), 'hex');
  INSERT INTO "audit_chain" ("tenant_id", "seq", "entry_id", "prev_hash", "body_hash", "hash", "ip_commitment", "sealed_at", "sealed_late")
  VALUES (e."tenant_id", next_seq, e."id", head_hash, body_hash, new_hash, commitment, clock_timestamp(), p_late);
  UPDATE "audit_chain_heads" SET "seq" = next_seq, "hash" = new_hash, "updated_at" = clock_timestamp()
  WHERE "tenant_id" = e."tenant_id";
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit_chain_seal_entry"("audit_log", boolean) FROM PUBLIC;--> statement-breakpoint

-- 4. At commit: a deferred constraint trigger, so that the head is locked
-- only while the transaction commits, never while a long one (an import)
-- works. If sealing fails, the transaction fails: an action that cannot be
-- audited is not taken.
CREATE OR REPLACE FUNCTION "audit_log_seal"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "audit_chain_seal_entry"(NEW, false);
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit_log_seal"() FROM PUBLIC;--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_log_sealed" ON "audit_log";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "audit_log_sealed" AFTER INSERT ON "audit_log"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "audit_log_seal"();--> statement-breakpoint

-- 5. The entries that exist, each client's in the order they were written.
-- Sealed late: the chain shows they have not changed since today, not
-- before.
DO $$
DECLARE
  e "audit_log";
BEGIN
  FOR e IN
    SELECT a.* FROM "audit_log" a
    WHERE NOT EXISTS (
      SELECT FROM "audit_chain" c WHERE c."tenant_id" = a."tenant_id" AND c."entry_id" = a."id"
    )
    ORDER BY a."tenant_id", a."occurred_at", a."id"
  LOOP
    PERFORM "audit_chain_seal_entry"(e, true);
  END LOOP;
END
$$;--> statement-breakpoint

-- 6. Each client's chain says when it was sealed, and how many entries were
-- there before: sealed by the trigger, at commit, after them.
INSERT INTO "audit_log" ("tenant_id", "actor_id", "action", "entity_type", "entity_id", "changes")
SELECT t."id", NULL, 'audit_chain_started', 'tenant', t."id",
  jsonb_build_object(
    'migration', '0058_audit_chain_seal',
    'sealedBefore', coalesce(h."seq", 0),
    'sealedOn', (clock_timestamp() AT TIME ZONE t."time_zone")::date
  )
FROM "tenants" t
LEFT JOIN "audit_chain_heads" h ON h."tenant_id" = t."id"
WHERE NOT EXISTS (
  SELECT FROM "audit_log" a WHERE a."tenant_id" = t."id" AND a."action" = 'audit_chain_started'
);--> statement-breakpoint

-- 7. Who may read and write what. The application reads the chain and its
-- heads, and never writes them; it adds checkpoints and the results of its
-- checks, never changing one. The admin portal reads the results only.
GRANT SELECT ON "audit_chain", "audit_chain_heads" TO trustline_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_chain_checkpoints", "audit_chain_verifications" TO trustline_app;--> statement-breakpoint
GRANT SELECT ON "audit_chain_verifications" TO trustline_platform;--> statement-breakpoint

-- 8. A break is said in Trustline's own log too (`audit_chain_broken`),
-- which the application cannot otherwise write: for the client of the
-- calling transaction only, and nothing of the entries.
CREATE OR REPLACE FUNCTION "audit_chain_report_break"(
  p_tenant uuid, p_kind "audit_chain_break", p_first_bad_seq bigint, p_first_bad_entry uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a break is reported for the client of the transaction only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO "platform_audit_log" ("admin_id", "action", "target_tenant_id", "details")
  VALUES (NULL, 'audit_chain_broken', p_tenant,
    jsonb_build_object('kind', p_kind, 'firstBadSeq', p_first_bad_seq, 'firstBadEntryId', p_first_bad_entry));
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit_chain_report_break"(uuid, "audit_chain_break", bigint, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "audit_chain_report_break"(uuid, "audit_chain_break", bigint, uuid) TO trustline_app;
