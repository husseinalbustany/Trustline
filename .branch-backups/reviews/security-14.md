# Security review 14: audit trail steps 4 to 7 (8cbffe4..52b530e)

## Decisions: fix everything
- H1: now, leave bodyHash (and body) out of withheld lines; the verifier checks links and checkpoints for those and the spec says so. Also plan the v2 body with a per-entry salt kept outside the body (spec, not built now).
- H2: mask on what was decided at write time only (incident_reported; incident_commented with byReporter; status moves only the reporter makes, recorded with byReporter: true); drop the actor_id = reported_by branch; test with a handler who also reported, including the person filter.
- M1: delete channel (and anything else that reveals anonymity) for masked entries.
- M2: accessOf keeps only READ_ONLY_PERMISSIONS for external reviewers; refuse (409) role updates beyond them while a reviewer holds the role.
- M3: wrong codes count into failedAttempts with the same lock; cap codes issued per person per hour.
- M4: the verifier requires keys.json (or pinned key ids), fails when no signed checkpoint covers the range, checks entry counts, ids and tenant.
- M5: "checked today" only when today's row references a checkpoint signed today; the weekly head email keyed off checkpoints signed this week.
- L1 to L5: as proposed (L5: in production refuse to issue a code in outbox mode, 503).
- Info: omit platformAdminEmail from the viewer and CSV for old entries; external reviewers do not see sign-in IP addresses (viewer, CSV; the chain file withholds them as it withholds masked bodies); external reviewers are never in document audiences; note in the spec that reviewers cannot sign in at an SSO-only client until SSO exists.

# Security review 13: audit trail, 8cbffe4..52b530e (steps 4 to 7, the security-12 fixes, language review 9, the registry test)

I found two high, five medium and five low findings. Both highs undo the reporter masking.

**How I tested.** I proved four of the findings:
- the first high, with a read-only SQL query that wrote nothing;
- the verifier finding (M4), with files I forged in the scratchpad;
- the security-12 database fixes, by reading the live catalogue.

I ran no test files, because `test/global-setup.ts` migrates and seeds the shared `trustline` database on any vitest run. I changed no repository files. The working tree has someone else's uncommitted edits (in `incidents.service.ts` and `src/reports/`). I checked that none of them touches the code I cite.

## High

**H1. The chain file lets anyone with `audit.view` recover a masked reporter, and whether the report was anonymous.**
- **Where:** `apps/api/src/audit/trail.service.ts:437-445` and `:448-470`.
- **The flaw:** for a withheld entry, the line still carries `bodyHash`. The body is the eleven-line text in `chain.ts:31`. For a masked entry, a viewer without `incidents.see_reporter` already has everything in it except two values: `actor` and `changes.anonymous` (or `byReporter`).
  - The viewer gives `id`, `seq`, `at` (to the microsecond, the body's own format), `action`, `entityType`/`entityId`, and `details` with only those keys removed.
  - The `ip` line is empty: `incident_reported` and comments are audited with no address.
  - The candidates are the client's user ids, plus "none". The trail shows every staff member's id as the actor of their own sign-ins.
- **Scenario:** an external reviewer, or an internal auditor, downloads `/audit/exports/chain` and opens `/audit/entries?reference=INC-…`. They then hash about (users + 1) × 2 candidate bodies. The one that matches names the reporter, or proves the report was anonymous.
- **Proof:** I built a sealed `incident_reported` body for a demo-jci user with `audit_chain_body()` in a read-only transaction. A search over the client's users × {true, false} found the right user at once (4 candidates).
- **Test gap:** `test/audit-trail.e2e-spec.ts:437-445` checks only that `body` is missing.
- **Fix:**
  - Smallest: leave `bodyHash` out of withheld lines. `hash` cannot be reversed, and the next line's `prevHash` still links. The verifier then checks the link and the checkpoints only, which the spec should say.
  - Lasting: a v2 body that carries a random per-entry salt kept outside the body (as `ip_salt` is), withheld for masked entries.

**H2. The trail's masking rule is wider than the incident screens' rule, so it marks a handler as the reporter.**
- **Where:** `trail.service.ts:146-149`, the branch `or (a.actor_id is not null and a.actor_id = incidents.reported_by)` for `incident_status_changed` and `incident_commented`.
- **The conflict:** the incident screens show under the person's own name whatever a reporter does as a handler. `incidents.service.ts:1112-1115` says so: "triaging it, say, or commenting as one of its handlers". Only the report and comments written as the reporter are masked there. The trail masks every status change and comment whose actor is `reported_by`.
- **Scenario:** a ward manager reports an incident in their unit and later closes it, or comments on it as its handler.
  - An external reviewer (`incidents.view` everywhere plus `audit.view`) sees "Closed by Dr A" on the incident timeline.
  - The trail shows "The reporter closed it" at the same moment, with the same `commentId` for comments.
  - So Dr A reported it.
  - The person filter is a second oracle: `?actorId=<Dr A>` lists their triage of that incident but not their closing of it.
- **Test gap:** no test has a handler who also reported.
- **Fix:** mask on what was decided at write time, as the comments already do:
  - `incident_reported`;
  - `incident_commented` with `byReporter`;
  - status moves only the reporter makes (record `byReporter: true` in `changes` for those, such as withdraw).
  - Drop the `actor_id = reported_by` branch.

## Medium

**M1. `channel: "public"` shows that a masked report was anonymous.**
- **Where:** `trail.service.ts:248-251`. Only `anonymous` and `byReporter` are deleted; `incidents.service.ts:722` writes `channel: 'public'` for public reports.
- **The leak:** a public report is always anonymous. `incidents.service.ts:965-967` and `:761-762` hide the channel for exactly that reason. The viewer and the CSV (details JSON) show it to everyone with `audit.view`.
- **Fix:** delete `channel` for masked entries as well (and keep it out of the body that H1's fix withholds).

**M2. A role edit gives an external reviewer `incidents.see_reporter`, or anything else.**
- **Where:** `external-access.service.ts:113-128` checks the role only at grant time. `roles.controller.ts:165-212` (`PATCH /roles/:id`) does not look at who holds the role. `auth.service.ts:224-243` (`accessOf`) does not filter an external reviewer's permissions.
- **Scenario:** a `roles.manage` holder adds `incidents.see_reporter` or `users.manage` to the custom read-only role a reviewer holds. A role shared with staff works the same way.
  - Writes are still refused by `SessionGuard`.
  - The reviewer now reads reporters' names, unmasked trail entries, and the staff list with emails.
- **Fix:** in `accessOf`/`contextIn`, keep only `READ_ONLY_PERMISSIONS` for `kind = 'external_reviewer'`. This is one line and covers migrations too. Also refuse (409) a role update that goes beyond `READ_ONLY_PERMISSIONS` while a reviewer holds the role.

**M3. The one-time code can be brute-forced across codes: wrong codes never lock the account.**
- **Where:**
  - `sign-in-codes.service.ts:128-151`: 5 tries per code.
  - `auth.service.ts:340-355`: a wrong code is audited only; `failedAttempts`/`lockedUntil` are untouched.
  - `login` issues a fresh code on every correct password, and nothing limits the rate.
- **Scenario:** someone holding a reviewer's password loops "password → challenge → 5 guesses".
  - Each round succeeds with probability 5/10⁶.
  - About 20,000 rounds (a few hours) gives roughly 10%.
  - The reviewer's inbox fills with codes, but nothing stops it.
- **Fix:** count wrong codes into `failedAttempts` with the same lock (5, then `LOCK_MINUTES`). Also cap the codes issued per person per hour.

**M4. The verifier script trusts the file it checks.**
- **Where:** `scripts/verify-audit-chain.mjs:29-31` takes the keys from the file's own header when no `keys.json` is given. `:62-80` reports "Every check held." when there is no checkpoint at all, and when there are no entries.
- **Proof:** I forged three files and ran the script on each.
  - A self-made chain signed with my own key: exit 0, "Every check held".
  - The same chain with no checkpoint: exit 0, even with the published `keys.json`.
  - A header claiming entries 1 to 1000 with no entry lines: exit 0.
- **Scenario:** a surveyor checks a file the hospital hands over. That is the very case the script is for.
- **Fix:**
  - Require `keys.json` (or pinned key ids), or print "unanchored: keys taken from the file" and exit non-zero.
  - Fail when no signed checkpoint covers `lastSeq` (or the range), and when the entry count does not equal `lastSeq − firstSeq + 1`.
  - Check that each body's `id:` equals `entryId` and its `tenant:` equals `header.tenant`.

**M5. Security-12 M1 is only partly closed: one inserted row still turns off the weekly full check.**
- **Where:** `chain-check.service.ts:291-307`. Any verification row dated today (`run_at` is now `now()`) makes the scheduled check return null.
- **Scenario:** with the application role's credentials (no signing key), someone inserts `{result: 'passed', full: true}` just after midnight on the client's `fullCheckDayOf` weekday, once a week.
  - The full check never runs, and an entry changed before the last checkpoint stays hidden.
  - `checkpoint_id` can point at an older, genuinely signed checkpoint, so `/audit/status` shows `signed: true`.
- **The weekly head email has the same hole:** one inserted `audit_chain_head` notification suppresses it for the week (`:325-331`).
- **Fix:** treat "checked today" as true only when today's row references a checkpoint whose signed `at` falls today. For the head email, key off checkpoints signed this week rather than notifications.

## Low

- **L1. Nulling a checkpoint's key still bypasses the M2 fix.** Setting `key_id` or `signature` to NULL returns `unsigned`, which is passed over (`audit-keys.ts:119`, `chain-check.service.ts:370-371`). Production must now sign (security-12 L5). So treat `unsigned` as `bad_checkpoint` when a signer is configured, apart from checkpoints from before a configured "signed since" date. Deleting a checkpoint remains inherent; the server-log line and the weekly email are the answer to that.
- **L2. Gaps in recording an external reviewer's reads** (`audit/reviewer-reads.interceptor.ts:37-51`):
  - Only the route pattern is kept, so the trail filters (such as `actorId` and `reference`) and list searches are not recorded.
  - Ids under other parameter names (`:versionId`) are not captured.
  - For `exports/chain` (`@Res()`), the entry is written after the file has gone, which contradicts "written before the answer goes".
  - **Fix:** record the query string's keys and values, apart from free text if needed.
- **L3. The chain export ignores backpressure.** `audit.controller.ts:101-120` calls `res.write` without waiting for `drain`. A slow reader makes the API hold the whole chain in memory, and the API is shared by every client. Several slow downloads by any `audit.view` holder could exhaust it. **Fix:** await `drain`, and allow one chain export per client at a time.
- **L4. `test/cleanup.ts:97-99` swallows errors.** If the query fails, the registry check passes silently. Rethrow after the clean-up, as the final throw already does.
- **L5. Outbox mode keeps sign-in codes in plain text.** In outbox mode, which is also the fallback when SMTP is misconfigured, each code sits rendered in `email_outbox`, readable by `trustline_app`. In production, refuse to issue a code (503) when the mode is outbox.

## Info and questions
- **Trustline staff emails are newly visible.** Entries written before step 7 keep `platformAdminEmail`. Clients and external reviewers can now read them in the viewer, the CSV and the chain file. The sealed bodies cannot change, but the viewer and CSV could omit that key. New entries name staff by name and id only, which reveals nothing more.
- **External reviewers see every staff sign-in address** (two years) in the viewer and the chain file. This is consistent between the two, but should be a deliberate decision.
- **Reviewers fall into document audiences (not security).** They are in the whole-organization audience (`policies/visibility.ts:168-190`): asked to acknowledge, reminded, counted as overdue, yet unable to acknowledge. Hand this to the quality reviewer. Also, reviewers cannot sign in at a client using SSO (`findTenant`, forPassword).

## Security-12 fixes: checked against the decisions
- **H1:** done. All five definer functions have `search_path = pg_catalog, public, pg_temp` and qualified names; I confirmed this in `pg_proc`. `datacl` of `trustline` is `{=c/trustline,…}`, so TEMP is revoked from PUBLIC. Nothing new added.
- **H2:** done. The check runs in REPEATABLE READ (`withTenant` option) and writes no audit entry. Housekeeping runs in its own transactions, and a test for a concurrent write exists.
- **M1:** done as specified (weekday from the id, `run_at` trigger, `CHECK at <= now()+5min`). It is still open in practice: see M5.
- **M2:** the log line, the unknown-key break, the retired list and the weekly email are all in. The nulling bypass remains (L1).
- **M3:** done. Both time filters are gone, and `occurred_at := now()` is forced for the app and platform roles.
- **L1 to L7:** each done as decided:
  - L1: `sealedLate` derives from the sequence number, and `audit_chain_started` is taken by lowest seq.
  - L2: `confirmed` exists.
  - L3: the composite foreign key exists.
  - L4: the `^[a-z_]+$` checks exist.
  - L5: the production refusal and the `signed`-means-verifies change are in.
  - L6: re-enabling an account now notifies.
  - L7: the platform role has its timeouts.

  The `confirmed` column can be written by the app role, which is no worse than before.

## Found sound
- **The viewer:**
  - All SQL is parameterised. The cursor is checked by a regex, and paging is by key.
  - `requireEverywhere('audit.view')` runs on every route. Every query strictly validated.
  - The total is capped at 10,001.
  - Modules that are off are hidden by action.
  - The person filter and the count exclude masked rows (apart from H2).
  - Addresses are shown for sign-in entries only, never when masked.
  - The CSV is protected against formula injection.
- **External reviewers:**
  - **Codes and challenges:**
    - The code: 6 digits from `randomInt`.
    - The challenge: 32 random bytes.
    - Both stored only as hashes, the code bound to its challenge.
    - Codes last 10 minutes, are taken under `FOR UPDATE`, can be used once, and are voided by the next sign-in.
    - Refusals are an identical 401.
  - **Sessions:** they end with the last access day and are refused on every request outside the days.
  - **Read-only:** every non-GET is refused in `SessionGuard`, including notification read marks, preferences, the PIN route, imports and the settings routes; only logout is open. I mapped every write controller; all use `SessionGuard`.
  - **Account controls:**
    - `assertStaff` covers user updates, role changes and invites.
    - No route changes `kind`.
    - Not counted as named users.
    - `endExpired` disables the account, revokes sessions and voids links.
    - Granting and extending need `users.manage` and `audit.view` for the whole organization, plus `mayGrant`.
- **The `sign_in_codes` table:** under RLS with `tenant_isolation`. A composite foreign key to users. Grants are narrow: UPDATE on `attempts` and `used_at` only.
- **Clearing addresses:**
  - The definer function works on the caller's client only and refuses anything younger than two years.
  - The chain still verifies after clearing: the body holds the commitment, and the check skips addresses that are gone.
- **Mirroring:** the platform insert policy allows only the four actions, with no actor and no address.
- **`details.spec.ts`:** sound as a guard.
