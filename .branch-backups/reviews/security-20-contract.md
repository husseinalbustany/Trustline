# Security review 20: contract end, exit window, deletion; review 19 fixes (3cb3342)

## Decisions: fix everything
- M1: approver_not_independent also when, in the last 7 days, the approver's password changed or the requester created a sign-in link for them, or a role the approver holds gained data.export or incidents.see_reporter; same rule in data_export_second_approval(); tests.
- M2: Trustline's second approval needs two different staff members (one records the written request, another approves), and is refused when the requester's account was made by the platform, is under 7 days old, or had its password set within 7 days.
- M3: store the certificate's exact bytes (text); the portal view uses a left join and handles a deleted client; a test reads and verifies it from the stored bytes.
- M4: cancelling opens a new window unless the stored one ends today or later; reactivation clears exit_until and retain_until; only exports downloaded after the cancellation count.
- L1 to L9 as proposed; L7: throw (the export fails with a recorded kind) rather than write an empty file; L9: count bytes with Buffer.byteLength; certificate signature with its own prefix.

I found four medium findings and nine low ones, and nothing critical or high. Each medium one is backed by code I read and, where noted, by a database query. I wrote no probe tests and changed no files.

Two medium findings each undo a decision. M1 lets one administrator still pass the two-person rule (review 19 M3). M2 lets one Trustline staff member get a full export alone, which goes against the spec's "This releases nothing to Trustline".

**What I ran:** `test/contract-end.e2e-spec.ts` and `src/exports/coverage.spec.ts` both pass (2 files, 16 tests). I also ran read-only SQL against the shared database as the owner (the probe files are in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r20/`).

## Medium

**M1. One administrator can still pass the two-person rule by taking over an existing account**
- **Where:** `apps/api/src/exports/exports.service.ts:38-60` (`dependenceOf`), `apps/api/src/identity/users.controller.ts:548-588`, `apps/api/src/identity/roles.controller.ts:~200`.
- **Why:** `dependenceOf` only checks how old the approver's account and `role_assignments` grant are, and who made them. Two things it does not see:
  - `POST /users/:id/invite` hands the administrator the raw `password_reset` token for any account they can manage, including another Administrator who has no PIN or single sign-on.
  - Editing a role changes `roles.permissions` but not `granted_at`. A grant made months ago starts giving `data.export` today and still counts as "old and not by the requester".
- **Scenario (one administrator, nobody else told):**
  1. `PUT /roles/<quality officer>` adds `data.export` and `incidents.see_reporter`. The `data_export_granted` notice skips the actor, and there is no other administrator to tell.
  2. `POST /users/<long-standing quality officer>/invite` returns the token.
  3. `POST /auth/invite/accept` with a password of their choice, then sign in as that person.
  4. `POST /exports` as themselves, then `POST /exports/:id/approve` as the taken-over account. `dependenceOf` returns null.
- **Tests:** none cover this. Only `account_by_requester` is tested (`data-export.e2e-spec.ts:193`).
- **Fix:** also refuse with `approver_not_independent` when either of these happened in the last 7 days:
  - the approver's `password_changed_at` moved, or the requester made a `sign_in_link_created` entry for the approver;
  - a role the approver holds gained `data.export` or `incidents.see_reporter` (a `role_updated` entry).

  Apply the same rule in `data_export_second_approval()`.

**M2. One Trustline staff member can make and download a full export alone**
- **Where:** `apps/api/src/platform/platform-tenants.controller.ts:375-414` and `apps/api/drizzle/0077_contract_end_grants_and_second_approval.sql:38-63`.
- **Scenario:** a client whose Administrators are all disabled.
  1. Staff call `POST /platform/tenants/:id/administrators`. The response carries the invite token (line 413).
  2. They set the password and sign in.
  3. `POST /exports`.
  4. `POST /platform/tenants/:id/exports/:exportId/approve` with a written request they type themselves. `not_alone` passes, because nobody else qualifies.
  5. They download the archive as the requester.
- **Context:** that account could already read everything in the app. But the second approval is meant to be a check, and the function never looks at the requester.
- **Fix:** the function should return a refusal when the requester's account:
  - was made by the platform (an `administrator_created_by_platform` entry for `requested_by`);
  - or is less than 7 days old;
  - or had its password set less than 7 days ago.

  Better still, require a second staff member for the second approval.

**M3. The deletion certificate cannot be checked from what is stored, and the portal cannot show it once the client is deleted**
- **Where:** `apps/api/src/platform/delete-client.ts:170` and `apps/api/src/platform/platform-contract.controller.ts:249-252`.
- **Stored copy:**
  - `certificate = ${bytes}::jsonb` changes the order of keys and the spacing. The probe showed `{"client":…,"format":…,"version":1,"deletionId":…}`.
  - So the signature and `certificate_sha256` no longer match anything kept in the database. The test checks only the bytes held in memory (`contract-end.e2e-spec.ts:195`).
- **Portal:**
  - `contract()` uses an `innerJoin` on `subscriptions`, and the deletion removes that row (line 136; the test checks `subscriptions: 0`).
  - So `GET /platform/tenants/:id/contract` answers 404 after deletion, and `already_deleted` can never be returned.
  - The only copy that can be verified is the file the command writes in whatever directory it was run from.
- **Fix:**
  - Store the exact bytes (`text` or `bytea`).
  - Build the view with a `leftJoin` and handle a deleted client.
  - Add a test that reads the certificate back through the portal and verifies it from the stored bytes.

**M4. A client cancelled a second time gets no exit window, and can be deleted at once**
- **Where:** `apps/api/src/platform/platform-subscriptions.controller.ts:119` and `apps/api/src/platform/platform-contract.controller.ts:253-255` (also `delete-client.ts:84-86`).
- **Why:**
  - `openExitWindow` returns early whenever `exit_until` is already set, even if that date has passed.
  - Nothing clears `exit_until` or `retain_until` when a subscription becomes active again.
  - "Downloaded" counts any export the client ever downloaded.
- **Scenario:** a client is cancelled, made active again (the dispute is settled), then cancelled a year later.
  - The window is already closed, so nobody can sign in, and the deletion can be asked for immediately.
  - The rule that an export was downloaded is met by a routine export from years before.
- **Fix:**
  - On cancelling, open a new window unless the one stored ends today or later.
  - Clear both dates when the subscription becomes active again.
  - Count only exports downloaded after the cancellation, or after `ends_on` minus 90 days.

## Low

- **L1. External reviewers in the exit window** (`apps/api/src/identity/auth.service.ts:346-365`).
  - The reviewer branch runs before the cancelled check at 368, so a reviewer of a cancelled client with the right password gets `{challenge}` and an emailed code.
  - The next step (`loginWithCode`) then refuses. That still makes the reply differ from a wrong password, sends an email, and records no `sign_in_failed`.
  - **Fix:** move the cancelled check above the reviewer branch.
- **L2. One staff member can close an open exit window at once** (`PUT contract` with a past `exitUntil`, `platform-contract.controller.ts:99-131`). The holders get no email, and the client's log entry is unreadable since nobody can sign in. **Fix:** refuse shortening an open window, or require a second staff member, and email the holders.
- **L3. Archive files are removed after the commit and failures are silent** (`delete-client.ts:180`, `storage.ts:43,144-147`).
  - The command does not require `EXPORT_STORAGE_DIR`, so on the wrong host it falls back to the temp directory and removes nothing, quietly (`force: true`).
  - The certificate does not say whether files were removed. The archives are cut off from their wrapped keys, but those keys survive in database backups.
  - **Fix:** require the variable and check the root exists; remove the files before writing the certificate, or record `archivesRemoved`.
- **L4. `trustline_platform` has unrestricted UPDATE on `client_deletions`** (`0077:18`).
  - It can write `status`, `approved_by`, `certificate` and `signature`. The database itself enforces only `approved_by <> requested_by`.
  - The gain is limited, since anyone with platform credentials can already make up staff sessions.
  - **Fix:** grant only the columns the portal writes, a trigger that allows only legal status changes, and certificate columns writable by the owner only.
- **L5. The deleted stub can still be edited, and the platform log keeps the name.**
  - `PATCH /platform/tenants/:id` can set a deleted stub back to `active` and rename it (`platform-tenants.controller.ts:258-280`).
  - `platform_audit_log` keeps `client_updated.name` and the contact names in written requests. The certificate should say what is kept.
  - **Fix:** refuse any change to a deleted client.
- **L6. `--backups-expire-on` is checked for shape only** (`delete-client.ts:46`): `2026-02-31` or a past day is accepted. **Fix:** require a real day, today or later, ideally taken from configuration.
- **L7. `coverage-columns.ts` empty fallback** (`archive.ts:405-414`).
  - This is acceptable as built: `coverage.spec.ts` fails for any exported table with no list, and for any column decided nowhere, so it cannot ship past CI.
  - At run time, though, it writes an empty file with no schema file, and the signed manifest says the table has 0 rows.
  - **Fix:** throw instead (the export fails with a recorded kind, and is retried and reported), or mark the file "undecided" in the manifest.
- **L8. `trustline_app` can write the Trustline approval columns.** It still has full UPDATE on `data_exports` (0069), including `trustline_approved_by`, `trustline_approved_at` and `written_request`, so an app bug could fake a Trustline approval. **Fix:** column-level UPDATE grants that leave these out.
- **L9. Smaller points:**
  - Batch size counts `line.length`, which is UTF-16 units, not bytes; Arabic text is under-counted by about half.
  - The certificate is signed with the export key with no prefix to set it apart from manifests (informational).
  - Tests missing: `grant_new`, `grant_by_requester`, `account_new`; the portal after deletion; a reviewer in the exit window; cancelling a second time.

## Checked and sound

- **Exit window:**
  - Only those with `data.export` and `incidents.see_reporter` for the whole organization can sign in.
  - `SessionGuard` refuses every route not marked `@OpenInExitWindow()`, and only `/auth/me`, sign-out and `/exports` are marked. Notifications, preferences, the PIN, audit, AI and users all answer 403.
  - Public routes, invites, password resets and the code step call `findTenant` without the exit flag, so they stay shut.
  - It is enforced on every request (`contextIn`: window end, `mayExport`), and sessions from before stay void (tested).
  - Background checks skip cancelled clients (`mayUse`). The email worker sends only `data_export_changed` in the window, and no digests.
- **Contract dates:**
  - Strict zod schemas and `invalid_dates`; both logs written in one transaction.
  - `audit_log_platform_insert` is updated in both the migration and `schema.ts`.
  - The 90, 30 and 7-day notices go once per end date, under an advisory lock, compulsory, and past the organization's email switch.
- **`data_export_second_approval()`:**
  - `search_path = pg_catalog, public, pg_temp`, every name schema-qualified, no dynamic SQL.
  - EXECUTE is revoked from PUBLIC and granted to the platform role only. I verified `trustline_app` cannot execute it and neither role can CREATE in `public`.
  - It locks the export row, matched by tenant, so another client's export is 404; status and lapse are checked.
  - `not_alone` matches the app's independence rule, `see_reporter` included.
  - Database CHECKs: one approval, and the written request present exactly when Trustline approved.
  - Only the requester can download. Column grants for `trustline_platform` (verified) leave out `requested_by`, the note, the storage key and the wrapped key.
- **Deletion:**
  - Two staff, enforced by the route and a database CHECK.
  - The command re-checks everything under `FOR UPDATE`, runs once only, and is bound to the deletion's client.
  - It refuses before the retention date.
  - The tables come from the catalogue. I verified only platform tables lack `tenant_id`, and none of them points into client tables.
  - It takes the audit chain head and checkpoint first; the identifier stays unique; the in-memory certificate verifies against the published key.
- **Review 19 fixes:**
  - H1 allowlist: an unlisted action gets null details.
  - M1 cap and the `stopped` failure.
  - M2 paths per attempt, the minute heartbeat with abort, and the `ours` predicate.
  - M3 for new accounts only (see M1 above).
  - L1 on every route, at sign-in and in the function.
  - L2 cost and connection ids left out.
  - L4 the whole file checked before a download is counted. What is left is only a swap of the file between that check and the stream, which needs write access to storage.
  - L5 the directory required and kept 0700; key ids come from the public key, so equal keys are caught.
  - L6 unique folder names; L7 quick work first, the time budget, one ready archive; L8 the email switch and the README.
- **Isolation:** `client_deletions` has no `tenant_id` and is platform-only; I verified the app role has no grant on it. The new `data_exports` columns fall under the existing `tenant_isolation`, and their foreign keys go only to `platform_admins`.

## Not checked

- The production database role. `session_replication_role = replica` needs a superuser or a SET grant; the owner here is a superuser.
- Rows another process might insert between the per-table deletes.
- Real backups.
- The web and portal screens (not built).
- Behaviour at real sizes.
- The full test suite.