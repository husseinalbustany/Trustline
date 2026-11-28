# Security review 19: data export steps 1 to 3, migrations 0070 and 0071 (5f21929)

## Decisions: fix everything
- H1: an allowlist of detail keys per platform action in trustline_records, matching what the client's own mirror shows; no note, no spending limit, no connection ids; e2e assertion that a note never reaches the archive.
- M1: the reclaim branch respects MAX_ATTEMPTS; a stale claim at the limit becomes failed (kind stopped), audited and told.
- M2: paths and storage keys per attempt; a heartbeat every minute while making that checks the claim is still this run's and aborts otherwise.
- M3: refuse approval (403) when the approver's account, or their data.export grant, was made by the requester or within the last 7 days; build the "someone was given data.export" notice now.
- L1: data.export counts only together with incidents.see_reporter for the whole organization (checked on request, approve and download); reporters stay in the archive.
- L2: omit AI cost and connection ids; the coverage test lists every exported column explicitly (an allowlist per table), so a new column needs a decision.
- L3: a cursor, or byte-aware batches for wide tables.
- L4: check the file and unwrap the key before counting; verify the GCM tag before streaming (or chunked authenticated encryption).
- L5: EXPORT_STORAGE_DIR required in production, 0700; refuse equal signing key ids.
- L6: a set of used folder names.
- L7: a time box per client per worker loop; a cap of ready archives per client (1).
- L8: the compulsory export emails are not silenced by the organization's email switch; README with the full keys URL, an openssl example, and advice to save the keys file.
- L9: wider isolation checks, tests for trustline_records, the retry cap and overlapping runs; cleanup removes archive files of deleted test clients.
- 0070/0071 notes: fix the schema comment.

I reviewed data export steps 1–3 and migrations 0070/0071 at 5f21929. There is one high finding, which I reproduced: the archive gives the client Trustline's private subscription note and AI spending limit. There are three medium findings (one reproduced) and several low ones.

**How I tested.** HEAD moved while I worked: two WIP commits ("data export end of contract") landed on top (now bc8e7c0). The working tree also has uncommitted changes. `schema.ts` in the working tree declares `subscriptions.ends_on`, `exit_until` and `retain_until`, but no migration adds them. So test setup fails at the seed step there ("column ends_on does not exist"). I unpacked 5f21929 into `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/tree` and ran the tests from it against the shared database: `src/exports/*.spec.ts` and `test/data-export.e2e-spec.ts` pass (5 files, 27 tests). I wrote two probe tests in that copy, ran them, then deleted them. No repository files were changed.

## High

**H1. The archive includes Trustline's private note on the subscription and the AI spending limit**
- **Where:** `apps/api/src/exports/archive.ts:441-458`. Line 453 writes `platform_audit_log.details` into `organization/trustline_records.jsonl` unchanged.
- **Why it happens:**
  - `subscriptions.service.ts:32-41,189-194` puts `note` into `changes`.
  - `platform-subscriptions.controller.ts:82-88` logs those `changes` as `subscription_updated`.
  - `platform-tenant-ai.controller.ts:166-172` logs `monthlySpendingLimitUsd`, and each feature's `connectionId`, `model` and `quickModel` (`choiceOf`, lines 50-53), as `ai_client_settings_updated`.
- **This contradicts three explicit choices:**
  - `coverage.ts` omits `subscriptions.note` and `ai_client_settings.monthly_spending_limit_micro_usd`;
  - the application role has no column grant on `note`;
  - the client's own log mirror deliberately leaves both out.
- **Proven:** the probe set a note and a $77.25 limit through the platform routes, then requested, approved, made and downloaded an export. The archive's `trustline_records.jsonl` contained `{"action":"subscription_updated",…,"details":{"changes":{"note":{"to":"PRIVATE-TRUSTLINE-NOTE-…","from":null}}}}` and `{"action":"ai_client_settings_updated",…,"details":{"changes":{"monthlySpendingLimitUsd":{"to":77.25,…}}}}`. `subscription.jsonl` correctly had no note.
- **Scenario:** a client in a billing dispute exports its data and reads every note Trustline's staff wrote about it.
- **Fix:** keep an allowlist of detail keys per action, matching what the client's own mirror shows (for `subscription_updated`, the keys of `subscription_changed`). Drop `note`, `monthlySpendingLimitUsd` and the raw connection ids. Add an e2e assertion that sets a note and checks the archive does not contain it.

## Medium

**M1. A crashed export is retried without limit, and blocks the client**
- **Where:** `export-worker.service.ts:174-192`. Reclaiming a claim that has been silent for 30 minutes increments `attempts` with no cap. `MAX_ATTEMPTS` is only checked in the `catch` branch.
- **Proven:** the probe set an export to `making`, `attempts = 3`, `claimed_at` 31 minutes ago. The worker reclaimed it and finished `{status:'ready', attempts:4}`. While the export is `making`, cancel returns 409 and a new request returns 409.
- **Scenario:** a large client's export crashes the process deterministically, for example out of memory (see L3). The worker runs inside the API process, so the API serving every client restarts every 30 minutes, forever. That client can neither cancel nor ask again.
- **Fix:** add `attempts < MAX_ATTEMPTS` to the reclaim branch. A stale claim at the limit becomes `failed` with kind `stopped`, audited and told like any other failure.

**M2. Two runs of the same export share files, and the stale one can delete the live one's archive**
- **Where:** heartbeats happen only at the three phase boundaries (`archive.ts:184,192,196`), so a data phase longer than 30 minutes is reclaimed while still running. Both runs use the same `work/<tenant>/<export>` directory (`storage.ts:59-64`) and the same `<tenant>/<export>.zip.enc` (`storage.ts:68`).
- **What goes wrong:**
  - the second run's `workDir()` empties the first run's files;
  - the first run's `remove()` (worker lines 215 and 252) deletes the second run's files;
  - if the second run made the export ready first, the first run's `put` overwrites the file under a different key, and its `!ready` branch (line 247) then deletes it.
- **Result:** an export marked `ready` with no file. Each download attempt is counted and audited, then fails.
- **Fix:** use paths per attempt (`work/<t>/<e>/<attempt>`, and a storage key that includes the attempt). Run a heartbeat every minute while making, which checks the claim is still this run's (attempts match) and aborts if not.

**M3. One administrator can satisfy the two-person rule alone**
- **How:** an Administrator holds `users.manage` and may grant Administrator (`mayGrant`). They create a user with a mailbox they control (`users.controller.ts:296`), assign the role (480), send the invite (548), set its password, and approve their own request.
- **What limits it:** only notices. For a client with one administrator, the notices reach the attacker and the second account. The "someone was given `data.export`" notice is listed under "Not done".
- **Fix:** refuse approval (403) when the approver's account, or their grant of `data.export`, was made by the requester or within the last N days. Use `role_assignments` and the audit log. Build the grant notice before release.

## Low

**L1. The export ignores `incidents.see_reporter`**
- `data.export` can sit on a custom role without `incidents.see_reporter`. In the app, `reporterToldTo` hides named reporters from such a role; the export (`allSeeing`, `archive.ts:461-481`) shows them. The role-editor warning the spec relies on is not built.
- **On including reporters:** keep them. The spec treats this as the controller's data, and a processor's return of data (GDPR Art. 28(3)(g)) should be whole.
- **No masking option:** a masked variant would also have to withhold the `incident_reported` chain bodies, whose `actorId` is hashed. That would make the archive's audit chain incomplete.
- **Fix:** gate instead. Allow `data.export` only on a role that also covers `incidents.see_reporter` for the whole organization, or check it on request, approve and download.

**L2. AI cost and Trustline's connection ids are exported (`coverage.ts:120-132`)**
- `ai_requests.cost_micro_usd`, `ai_requests.connection_id` and `ai_client_features.connection_id`/`model` go out, although the client is shown neither in the app, and the spending limit was omitted as "Trustline's control of its own costs". The rows carry no request text, which is fine.
- **Fix:** omit the cost and the connection ids, or record an explicit decision.
- **Registry gap:** new columns are exported by default. Only names matching `SECRET_LIKE` force a decision, which is how the cost column got through. Consider a coverage test that lists every exported column.

**L3. Batches are sized by rows, not bytes (`archive.ts:31,405-409`)**
- `node-postgres` buffers the whole result. 2,000 rows of `document_versions`, `drafting_versions` or `audit_log` with large jsonb can reach hundreds of MB, which is the trigger for M1.
- **Fix:** a cursor, or a smaller limit for wide tables.

**L4. Downloads are counted and audited before the file is known to open (`exports.controller.ts:85-98`)**
- A missing file or a key that cannot be unwrapped uses up a download and records one that never happened.
- `storage.ts:103` streams AES-GCM plaintext before the tag is checked. With `Content-Length` set, a tampered file can arrive looking complete.
- **Fix:** stat the file and unwrap its key inside the service before committing. Check the tag in a first pass, or use chunked authenticated encryption.

**L5. Production defaults and key separation (`main.ts:23-30`, `storage.ts:43`)**
- Production does not require `EXPORT_STORAGE_DIR`; it falls back to `os.tmpdir()`, where the client's plaintext working files sit during a build (files 0600, directories 0755).
- Nothing refuses the same key for `EXPORT_SIGNING_KEY` and `AUDIT_SIGNING_KEY`. Damage would be limited: checkpoints are signed with a `trustline-audit-checkpoint-v1` prefix, so neither signature passes for the other.
- **Fix:** require the directory in production and create it 0700. Refuse to start when both keys have the same key id.

**L6. Document folder collision (`archive.ts:597-600`)**
- The suffix form `<base>-<id8>` is not checked against other documents' folder names. An imported number equal to another document's suffixed folder overwrites that document's `content.json` and HTML in the archive. `versions.jsonl` keeps the text.
- **Fix:** keep a set of used folder names.

**L7. One export can delay work for other clients**
- The worker handles clients one by one in a single loop, so one long export delays lapse, expiry and exports for every other client in that process.
- A long REPEATABLE READ snapshot holds back vacuum across the whole database.
- There is no limit on how many `ready` archives one client keeps on the shared volume.

**L8. Notices and README**
- The organization's email switch also silences the compulsory export email (`organization_off`).
- The README gives a relative `/api/v1/audit/keys` and no command. It should give the full URL and an `openssl pkeyutl -verify` example, and say to save the keys file when downloading, since the client may not reach Trustline after its contract ends.

**L9. Tests**
- The e2e isolation check covers only client B's user, unit and role ids.
- Nothing tests `trustline_records`, the retry cap, or overlapping runs.
- Encrypted archives of deleted test clients are left in `/tmp/trustline-exports`, my probe runs' included; cleanup deletes the rows, not the files.

## 0070 and 0071: sound
- **0070:** the composite foreign keys (`measure_snapshots.requested_by` and `report_settings.updated_by` to `users(tenant_id, id)`) are correct, and the correction CHECK matches `correction_said`.
- **0071:** `taken_at` is forced to `now()` for `trustline_app`, the API's actual login role. The trigger has `SET search_path = pg_catalog, pg_temp` and is not security definer.
- It only fires on insert, which is enough: the application has no UPDATE on `measure_snapshots`, and 0066's `measure_snapshots_fixed` trigger refuses updates.
- **Notes:**
  - the schema comment says the `taken_at` trigger is migration 0070; it is 0071.
  - `unit_path uuid[]` cannot have a foreign key; the server computes it.

## Checked and sound
- **`data_exports` table:**
  - row-level security with `tenant_isolation`;
  - grants are SELECT, INSERT and UPDATE, with no DELETE;
  - composite foreign keys to users;
  - a partial unique index allows one open export per client;
  - CHECKs on downloads (0–5) and on approver ≠ requester.
  - A DB CHECK that the refuser is not the requester would be a nice addition.
- **No hidden tenant data:** every public table holding client data has `tenant_id`. Only platform tables and `tenants` do not.
- **Routes:**
  - a session plus `data.export` for the whole organization (`requireEverywhere`) on every route;
  - another client's export returns 404, through row-level security;
  - strict zod schemas and `ParseUUIDPipe`;
  - external reviewers cannot POST.
- **Request and approval:**
  - the password is re-checked through `confirmPassword`, on the same counter and lock as sign-in;
  - `same_person` is checked both before and after the password;
  - revision compare-and-set under `FOR UPDATE`;
  - approve, cancel, lapse and claim are serialized by row locks, `SKIP LOCKED` and status predicates;
  - the `ready` update is guarded by `attempts`.
- **Download:**
  - requester or approver only;
  - the counter is updated under the row lock;
  - 410 after expiry;
  - `no-store` and attachment headers, and a sanitized file name.
  - Storage keys are built from ids only, and `pathOf` checks each part is a UUID and stays under the root, so there is no path traversal.
  - Concurrent downloads are fine: `pipeline` handles backpressure.
- **Secrets:**
  - password, PIN and follow-up code hashes are left out;
  - `sessions`, `user_tokens`, `sign_in_codes`, `email_queue` and `email_outbox` are excluded;
  - `storage_key` and `wrapped_key` are left out;
  - `ip_salt` is cleared together with the address.
- **Anonymous reports:** `reported_by`, the event actor and the audit actor are null, and the code hash is left out. All triagers are notified, so who was not told reveals nothing. The archive does not link a report to its reporter.
- **ZIP writer:**
  - ZIP64 local and central fields, the end record and locator, and patched compressed sizes are all correct;
  - entry names are validated (no leading slash, backslash or `..`), and the folder names built from document numbers are sanitized;
  - entries are streamed, never held whole.
- **HTML:** everything is escaped before bold is applied, and the CSP is `default-src 'none'`.
- **Signing:** a separate key variable, published under `exportKeys`; production refuses to start without it; the manifest's exact bytes are signed.
- **Storage encryption:** AES-256-GCM with a random key and IV per archive, the key wrapped by `EXPORT_STORAGE_KEY`; production refuses to start without it.
- **Notices:** sent always, compulsory, sent while suspended, and the email names nobody.
- **0069:** limited to `is_system` Administrator roles, safe to repeat, one audit entry per client; new clients get `data.export` through `BUILT_IN_ROLES`.

## Not checked
- The web page (not built).
- Object storage and the key service (decision 4).
- Behaviour at real sizes and timings.
- PDFs.
- The exit-window work committed after 5f21929.
- The full test suite (not run, as asked).