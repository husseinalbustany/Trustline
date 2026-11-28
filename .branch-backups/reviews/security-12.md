# Security review 12: audit trail steps 1 to 3 (224733a..8cbffe4)

## Decisions: fix everything, H1 and H2 first
- H1: search_path pg_catalog, public, pg_temp (or '' with qualified names) on every SECURITY DEFINER function, including 0061's; REVOKE TEMP ON DATABASE FROM PUBLIC in a migration (grant back only if a role needs it); a test that tries the temporary-table redirection as trustline_app and trustline_platform.
- H2: the whole check in one REPEATABLE READ transaction (add an isolation option to withTenant); a test that commits an audited entry part-way through a check.
- M1: the full-check schedule derived from something the database cannot change (weekday from the tenant id); run_at forced to now() (column grant or trigger); CHECK at <= now() + slack on checkpoints.
- M2: log tenant, seq, hash to the server log on each pass; an unknown key_id is a break unless listed as retired; the weekly head email (already in step 4-7 work).
- M3: drop the time filters on the unsealed-entry search; force occurred_at := now() for the app role (trigger), or column grants.
- L1 to L7 and the info item: as proposed. L5: refuse to start in production (NODE_ENV=production) without a valid AUDIT_SIGNING_KEY; status reports "signed" only when the signature verifies with a known key.

## Security review: audit trail steps 1 to 3 (224733a..8cbffe4)

I found two high, three medium and several low findings. I proved the first one against the database. Every SQL test I ran was in a transaction I rolled back, as `trustline_app` or `trustline_platform`. I changed no files and left no data.

### High

**H1. The sealing functions can be redirected to temporary tables, so the app and platform roles can write the chain or skip it.**
- Where: `apps/api/drizzle/0058_audit_chain_seal.sql` lines 59 and 95 (`audit_chain_seal_entry`, `audit_log_seal`) and line 154 (`audit_chain_report_break`). All three are `SECURITY DEFINER` with `SET search_path = pg_catalog, public`.
- Why it works: with `pg_temp` left out of the path, PostgreSQL searches the session's temporary schema first for tables. `datacl` is NULL, so every role has TEMP on the database.
- What I proved:
  - **Skipping the seal (app role).** I created `TEMP TABLE audit_chain_heads` and `TEMP TABLE audit_chain`, then inserted into `audit_log`. The seal went into the temporary tables. The real head stayed at 22, and the entry had no real chain row.
  - **Locking a hospital out (app role).** I created only a temporary `audit_chain_heads`, copied from the real one. The function then wrote a correct row at seq 23 into the real `public.audit_chain`, but moved only the temporary head. The next normal audited insert failed with `duplicate key ... audit_chain_pkey (…, 23)`. Once committed, every audited action of that hospital fails, sign-in included, until an operator repairs it by hand.
  - **The platform role can do the same to any hospital.** As `trustline_platform` (`subscription_changed`, temporary head at 5000), the real chain row at seq 5001 was written. That role is meant to see no tenant data. It can find the real head through savepoints and duplicate-key errors, so it can wedge any client. Or it can write rows above the head, which shows as a permanent false break.
- This breaks the spec's line that the application "cannot write the chain". The tests at `test/audit-chain.e2e-spec.ts:175` do not try this.
- Fix: `SET search_path = pg_catalog, public, pg_temp` on all five functions (the pattern `record_module_starts` already uses), or `search_path = ''` with every name schema-qualified. Also consider `REVOKE TEMP ON DATABASE trustline FROM PUBLIC`. Add the temporary-table attempt to the test. `audit_log_forget_addresses` (uncommitted 0061) has the same search path and is executable by the app, so fix it at the same time.

**H2. The daily check reports a false `content_changed` when anything is audited while it runs, and an outsider can cause this.**
- Where: `chain-check.service.ts:219` (`withTenant`, READ COMMITTED; the database default is `read committed`), `:244` (head read once) and `:330-333` (the query for seals past the head).
- Each statement takes a new snapshot. Any audited commit between the head read and line 330 adds a seal at `headSeq+1`, and the check records `content_changed` at that number.
- Scenario: a weekly full check of a large client takes seconds. During it:
  - a night-shift sign-in is enough to cause this by accident;
  - an outsider can do it on purpose, with failed sign-ins against a known staff email (`sign_in_failed` is audited) or reports through the public form (`incident_reported`), at 02:00 local time.
- Result: the client is told at once, as serious, and Trustline's log gets `audit_chain_broken`. `/audit/status` keeps `broken` on show for good. False tamper alarms will teach people to ignore real ones.
- Fix: run the whole check in one REPEATABLE READ transaction (`TenantDb.withTenant` needs an isolation option). Add a test that commits an audited entry part-way through a check.

### Medium

**M1. The check decides what to check from rows the app role can write.**
- Where: `chain-check.service.ts:225-235`; `audit.controller.ts:233-238`.
- How:
  - `trustline_app` has INSERT on `audit_chain_verifications`, with `run_at` and `full` freely set.
  - One row with `{full: true, result: 'passed', run_at: '2099-…'}` makes `now - runAt < FULL_EVERY_MS` true forever, so no weekly full check runs again.
  - It also makes `lastCheck` show "passed" for good.
- Consequence: daily checks start at the last checkpoint. An owner who changes an entry older than that checkpoint, and adds this one row, is never found. The full check is the only thing that would catch it.
- Fix:
  - Decide when to run a full check from something the database cannot change, such as a weekday derived from the tenant id.
  - Force `run_at` to the database's `now()`: a column-level grant without `run_at`, or a trigger.
  - Add `CHECK (at <= now() + small slack)` on checkpoints.

**M2. Cutting off the end of the chain cannot be detected yet: the checkpoints live only in the database being protected.**
- Where: `chain-check.service.ts:257-264` and `audit-keys.ts:166-168` (`unknown` is passed over).
- Scenario: an owner deletes the last N entries, their seals and their checkpoints, then resets the head. Setting each checkpoint's `key_id` to an unknown value works just as well. The chain is then consistent and the check passes.
- The test at `:288` removes the tail but leaves the checkpoint in place. No copy of a checkpoint leaves the database yet: the export is step 5 and the email is decision 5. The private key is also in the API's environment, which the same operators can usually read.
- What a checkpoint proves today: only that the holder of the key saw that head at that time, and only while the checkpoint row survives. It cannot show that newly forged entries appended at the head are false. That is inherent, but should be said.
- Cheap fix now:
  - On each pass, write `tenant, seq, hash` to the server log. That is outside the database and contains nothing of the entries.
  - Treat an unknown `key_id` as a break unless it is on a list of retired key ids.
  - Bring the weekly email of the head forward.

**M3. Looking for unsealed entries depends on `occurred_at`, which a writer sets.**
- Where: `chain-check.service.ts:336-343`.
- An entry inserted round the trigger with a far-future `occurred_at` never meets `occurred_at < now − 10 min`, not even weekly. A backdated one is missed by daily checks and caught only weekly, which M1 can switch off.
- The 10-minute slack is not needed. An entry and its seal commit together, so one statement sees both or neither.
- Separately, `trustline_app` holds INSERT on every column of `audit_log`, including `occurred_at` and `id`. The app role can therefore write sealed entries with any future time, which the backdating check never examines.
- Fix:
  - Remove both time filters. The anti-join uses the unique `(tenant_id, entry_id)` index and is cheap.
  - In `audit_log_salt_address`, force `NEW.occurred_at := now()`, or grant the app role INSERT on named columns only, as the platform role already has.

### Low

- **L1. Two seal columns are not covered by the hash.** `sealed_late` and `sealed_at` are outside the hash (`0057`, `audit_chain`). `/audit/status` shows `head.at` from `sealed_at`, and step 4 plans to show `sealedLate`. Derive "recorded before sealing" from `seq <= sealedBefore`, which is taken from the hashed `audit_chain_started` entry. Also, `audit.controller.ts:246-250` picks `audit_chain_started` with no ORDER BY. A second such entry (raw SQL only) could change `sealedBefore`. Join to the chain and take the lowest seq.
- **L2. False alarms can be injected.** The app role can insert a checkpoint with a known `key_id` and a garbage signature. That causes `bad_checkpoint`, which then shows as broken for good. This follows from the app writing checkpoints. Consider marking a break as confirmed only after a second run.
- **L3. A foreign key can point into another hospital.** `audit_chain_verifications.checkpoint_id` uses a single-column foreign key (`0057:62`), so it can point at another client's checkpoint. Nothing in the API can make it do so. Use a composite `(tenant_id, checkpoint_id)` key.
- **L4. The registry is not enforced by the database, and the body can be ambiguous.** `action` and `entity_type` accept any text. With newlines, two different entries can produce the same body, for example `action="x\nentityType: y", entity_type="z"` against `action="x", entity_type="y\nentityType: z"`. Add `CHECK (action ~ '^[a-z_]+$')` and the same for `entity_type`.
- **L5. Running without a key only gives a warning.** In production, refuse to start without a valid `AUDIT_SIGNING_KEY`, or say so loudly. `status` reports `signed` whenever `keyId` is set (`audit.controller.ts:263`), even when the key is unknown or the signature does not hold.
- **L6. A gap in the `policies.import` notice.** `importHolders` leaves out disabled accounts. Re-enabling a disabled account that holds `policies.import` (`users.controller.ts:415-457`) gives the permission back with no notice.
- **L7. The platform role has no timeouts.** `trustline_platform` has no `lock_timeout` or `idle_in_transaction_session_timeout`. A session that runs `SET CONSTRAINTS audit_log_sealed IMMEDIATE` holds a client's head lock until it ends. Give it the app role's limits.
- **Info:** the salt is SHA-256 of two v4 UUIDs, about 244 random bits, not 256. That is harmless; `gen_random_bytes(32)` would make the claim exact.

### What I checked and found sound
- **Bypasses:**
  - The app and platform roles cannot set `session_replication_role` (confirmed) and cannot disable triggers.
  - COPY fires the trigger.
  - Owner tampering (update, delete, replica insert) is detected, subject to M1 and M3.
- **The head row:**
  - Concurrent first entries are handled by `FOR UPDATE` and `ON CONFLICT DO NOTHING`.
  - In READ COMMITTED the locked read sees the latest head.
  - The `(tenant_id, seq)` primary key rules out forks.
  - A rollback undoes the seal and the head together, so there are no gaps.
  - Measured cost is fine: imports are capped at 20 documents, about 21 seals per commit.
- **Permissions:**
  - The app cannot execute `audit_chain_seal_entry` or `audit_log_seal`.
  - Grants match the spec, and the app has no UPDATE or DELETE on audit rows.
  - Tables are not FORCE RLS, so the owner-run definer functions work.
- **Hashes:**
  - The entry body and the link hash each start with a fixed version line.
  - The body includes tenant and seq, so a body cannot be replayed in another client or position.
  - Hashes are fixed-length hex.
  - The body covers every column except the salt and address, which are replaced by the commitment.
  - `jsonb::text` gives a stable rendering, and the Node rebuild matches it.
  - The checkpoint message includes the tenant.
- **The address salt:**
  - It is set by trigger for every writer.
  - A salt and an address that are both present are checked.
  - Once both are cleared, the commitment reveals nothing.
- **The daily check:** it rebuilds the hashes in Node and does not trust `prev_hash` beyond the trusted checkpoint.
- **Migration 0058:** the lock and the order of sealing are correct, and `audit_chain_started` is sealed after the existing entries.
- **Migration 0059:** it touches only the built-in roles of each client and writes one guarded entry per client.
- **Routes:**
  - `/audit/status` checks `requireEverywhere` before validating the query, takes a strict query, and works only inside `withTenant`.
  - `/audit/keys` returns public keys only.
  - Key errors never include the key's value.
- **Tenant isolation and clean-up:**
  - All four new tables have `tenant_isolation`, which `tenant-isolation.spec.ts` enumerates automatically.
  - `cleanup.ts` deletes whole test clients only, now in one transaction.
- **New entries:**
  - `user_created` and `client_administrator_created` no longer keep the email.
  - `user_roles_changed` keeps the list before.
- **The `policies.import` notice:** it goes to active holders of the built-in roles in the same client. It excludes the one who made the change and the one given it, and carries only `personId`.

### What I could not check
- **I did not run the test suite.** The working tree has another agent's uncommitted step-4 work (`schema.ts`, `notifier.ts`, migrations 0060 and 0061). The shared database already has 0060 and 0061 applied (`__drizzle_migrations` ids 61 and 62). Running the suite would test that work, not 8cbffe4, and its global setup re-migrates and re-seeds the shared database.
- I reasoned H2 from the code and PostgreSQL's isolation rules. I did not reproduce it, because that needs a committed write to a demo client.
- I did not test production role settings, for example whether the owner role is a superuser there.

Files: `/home/user/Trustline/apps/api/drizzle/0058_audit_chain_seal.sql`, `/home/user/Trustline/apps/api/drizzle/0057_audit_chain.sql`, `/home/user/Trustline/apps/api/src/audit/chain-check.service.ts`, `/home/user/Trustline/apps/api/src/audit/audit.controller.ts`, `/home/user/Trustline/apps/api/src/audit/audit-keys.ts`, `/home/user/Trustline/apps/api/src/identity/provisioning.service.ts`, `/home/user/Trustline/apps/api/src/identity/users.controller.ts`, `/home/user/Trustline/apps/api/test/audit-chain.e2e-spec.ts`.