## Security review 3: `08d5229..8a013b3`, `apps/api`

**Verdict: fit for a supervised pilot, on two conditions: the proxy requirement is verified on the pilot host before public reporting is switched on, and someone watches for the public form being held shut.** There are no critical or high findings. H2, M1, M2, M3 and L1 to L5 are fixed; H1 and L6 are partly fixed. Three new medium findings all sit on the public routes.

**How I checked.** I read the code at 8a013b3 (the working tree is clean and matches it). I ran read-only SQL as the owner and application roles (`default_transaction_read_only=on`, `EXPLAIN` only for writes). I ran no tests, server, migration or seed, and wrote nothing in the repository.

**One thing you should know first:** the local database holds 3 clients, 12 roles, 21 units, 15 rule rows and 3 audit rows, but **0 users, 0 incidents, 0 comments and 0 notifications**, and no API connection was open when I looked. So grants, policies, indexes and constraints are confirmed in the database; the backfills of 0023 and 0025 (statements 1 and 2) are read from the code only.

All paths are under `/home/user/Trustline/`.

---

## Job 1: the last review's findings

| Item | Status | Where it shows | Would the test fail without the fix? |
|---|---|---|---|
| **H1** limiter key | Fixed | `apps/api/src/security/rate-limiter.ts:20-26` (`isIP`, 64-character cut); `apps/api/src/incidents/public-limits.ts:60-64` | Yes: `apps/api/test/incident-safeguards.e2e-spec.ts:1679`, `:1707`; `apps/api/src/security/rate-limiter.spec.ts:51-60` |
| **H1** per-hospital ceiling | Fixed, with N2 and N4 below | `apps/api/src/incidents/incidents.service.ts:460-495` | The count, yes (`:1760`). **The lock, no:** the burst at `:1793` is sent after the ceiling is already full |
| **H1** deployment | **Partly** | `README.md:192-220`, `.env.example:10-30`, `apps/api/src/app.setup.ts:11-33` | No test through the real chain (the engineer says so) |
| **H2** staff names with a code | Fixed | `incidents.service.ts:120-127`, `:959`, `:990`, `:1002`, `:1038` | Yes: `:2228` searches the body for every user's id, email and name |
| **M1** incident number | Fixed | `apps/api/src/incidents/public.controller.ts:115-133`; `incidents.service.ts:486-493`, `:1002`, `:1687-1703` | Yes: `:1336`, `:1364`, `:2191`, `:2297` |
| **M2** sticky sign-off | Fixed | `apps/api/src/incidents/status.ts:58-59`, `:138`; `incidents.service.ts:548`, `:1243-1246`; `apps/api/drizzle/0025_security_review_backfill.sql:8-22` | Yes: `:3229`, `:3301`, `:3333` |
| **M3** reporter who handles | Fixed for comments written from now on | `incidents.service.ts:1570-1583`, `:1603-1611`, `:1050-1064`; check `incident_comments_one_capacity` (in the database) | Yes: `:821`, `:884`, `:934`, `:995` |
| **L1** code while form is off | Fixed | `public.controller.ts:84-96`, `:186`, `:213` | Yes: `:2049` |
| **L2** NUL gives 500 | Fixed here; see N5 for sign-in | `public.controller.ts:29-35`, `:45`, `:85` | Yes: `:2191`, `:2168` |
| **L3** revision on sign-off | Fixed | `status.ts:158`; `incidents.service.ts:1416-1418` | Yes: `:3355` |
| **L4** withdrawal note | Fixed | `incidents.service.ts:1072-1077` | Yes: `:2974-3029` |
| **L5** audit row for 0020 | Fixed | `0025_security_review_backfill.sql:41-62`; **confirmed in the database:** one row per client, no actor | `apps/api/src/database/deadlines.spec.ts:594` |
| **L6** /64 counting, no ceiling | Partly | Ceiling added; counting per /64 unchanged (`rate-limiter.ts:41-45`), see N2 | |
| L7, L8 | Unchanged, as the engineer states | L8 now also covers `time_zone`, which is intended | |

Notes on the points you asked me to look hard at:

- **H1, ceiling.** It cannot be raced. The advisory lock is taken before the count; isolation is read committed (confirmed), so each count sees every earlier commit. The count is one backward index scan on `incidents_public_recent_idx` (plan confirmed). A body that fails the schema is refused before the transaction opens.
- **H1, README.** What it says about the header is right. I re-read Next 16.4.6: the rewrite proxy is created without `xfwd`, and the one place that fills in `x-forwarded-for` (`base-server.js:604`) is not on the rewrite path for `/api/*`, because `apps/web/src/proxy.ts:25` excludes it. The hop table is right. It is incomplete; see N1.
- **M1, lookup.** `incidents_follow_up_code_key` is unique on `(tenant_id, follow_up_code_hash)` and the plan uses both columns (confirmed). The value compared is a SHA-256 of the guess, so a sender cannot steer the comparison. Another hospital's code is 404 through row-level security. Nothing in the view, errors, events or the comment answer carries the id or number; a note written by staff could, and that is content.
- **M2, fallback.** `needsSignOff` is the stored flag or the present gravity, and triage also counts what the incident was before the change. No path closes a once-sentinel incident alone: `reject` leads only from `new`, and nothing returns to `new`. Two gaps remain, in N10.
- **M3, with notifications.** I tried again as a department manager and found no way. The capacity is decided under the row lock; a reader without full access is necessarily the reporter. A notification's recipients are visible only to each recipient. A named and an anonymous report produce the same inbox for everyone else. No answer carries a count of who was told.
- **The 50 ms floor.** It holds on every 404 of both follow-up routes, counted from after the limit and the schema check. 429 and 400 come before any lookup and say nothing of a hospital. No database connection is held during the wait, so it cannot tie up the server. Two limits are in N8.

---

## New findings

### Medium

**N1. The proxy requirement in the README is incomplete, and nothing checks it.**
- **What someone can do:** on a host set up as the README says, anyone who can reach port 3001 or 3000 directly sends their own `X-Forwarded-For` and chooses their address. That is H1's bypass again, with only the ceiling behind it.
- **Where:** `README.md:192-220`; `apps/api/src/main.ts:13` (listens on every interface).
- **Three gaps:**
  1. It never says the API and the web app must be reachable only from the proxy.
  2. Its nginx line (`X-Forwarded-For $remote_addr`) is right for the outermost proxy only. Used on the inner one in the "CDN, load balancer" row, every caller becomes the CDN and shares one allowance.
  3. There is no start-up check or log line, and still no test through the real chain.
- **How I know:** read from the code and the README.
- **Smallest fix:** add those two sentences; bind the API to loopback or a private interface by default; log the trust setting at start.

**N2. One ordinary home connection can hold a hospital's public form shut, and nobody is told.**
- **What someone can do:** 60 reports an hour, one a minute, keeps the form answering 429 to everyone. Each address gets 10 an hour per API process. IPv6 is counted per /64, so a common home /56 prefix has 256 allowances and a /48 has 65,536. The same sender leaves 1,440 permanent junk incidents a day.
- **Amplification:** each junk report notifies every triager of the unit when it arrives, again at "due soon", and again at "overdue" together with every whole-organization triager. Notifications cannot be deleted and have no retention.
- **Silent:** when the ceiling trips, nothing is logged, audited or notified.
- **Where:** `incidents.service.ts:460-495`; `rate-limiter.ts:41-45`; `public-limits.ts:60-64`.
- **How I know:** read from the code. The engineer flagged the lever; not its cost on IPv6, the notification multiplier or the silence.
- **Smallest fix:** log one line with the hospital id (or write one audit row an hour) when the ceiling refuses; also count IPv6 by /56 or /48. For the pilot, keep the switch off until N1 is verified.

**N3. A follow-up code can be used to write to an incident without end, also after it is closed or rejected.**
- **What someone can do:** post 30 comments of 2,000 characters an hour per address per process, for ever. Each is stored for good, adds a timeline and an audit entry, and notifies the assignee and the last triager (every triager while it is untriaged).
- **No recourse:** staff cannot revoke a code, mute an incident or remove a comment. The 60-an-hour ceiling covers reports only.
- **Where:** `incidents.service.ts:1736-1756`, `:1593-1675` (no check of status, no count per incident).
- **How I know:** read from the code. No test covers a comment on an ended incident, and the spec does not say.
- **Smallest fix:** a ceiling per incident for comments written with a code, counted in the database like the hospital's (say 10 a day). Decide whether a code may still comment once the incident has ended.

### Low

**N4. A flood on one hospital's public form can make every hospital wait.**
- Public reports to one hospital queue on the advisory lock, each holding a pooled connection. The pool is `pg`'s default of 10 with no connection timeout (`apps/api/src/database/client.ts:6`). `statement_timeout` and `lock_timeout` are 0 (confirmed).
- A request with a well-formed but unknown category takes the lock too and is not counted by the ceiling.
- It needs many addresses if N1 holds. Read from the code, not measured.
- **Fix:** `pg_try_advisory_xact_lock` and answer 429 when it is busy, or allow one or two such requests per hospital at a time in the process; set timeouts for the application role.

**N5. Sign-in tells whether a hospital exists.**
- `POST /auth/login` with a NUL in `email` answers 500 when the organization exists, is active and allows passwords, and 401 otherwise. There is no rate limit on sign-in.
- This is the fact the 50 ms floor was added to hide.
- **Where:** `apps/api/src/identity/auth.controller.ts:30-35`; `apps/api/src/identity/auth.service.ts:121-134`. Outside this diff; I missed it last time.
- **How I know:** the database's refusal (22021) is confirmed for that lookup; the route is read from the code.
- **Fix:** refuse control characters in `org`, `email` and the invite `org`, with the existing helper.

**N6. The deadline check can stop without anyone knowing.**
- **Where:** `apps/api/src/incidents/deadline-check.service.ts:112-118`, `:157-161`, `:264`.
- If the query for the list of hospitals fails, the error is swallowed with no log.
- No query has a timeout, and the next run is scheduled only when the last one ends, so one stalled statement stops the check for every hospital in that process.
- A successful run logs nothing either.
- One insert carries a whole batch's notifications. Past about 13,000 rows (100 incidents with more than 130 recipients each) it exceeds the driver's parameter limit and that hospital's stage fails on every run.
- **Fix:** log a failed run and a one-line summary; set a statement timeout for the check; insert in chunks.

**N7. Someone with the right to triage can make the check repeat itself.**
- Changing the harm level of an overdue incident clears the close markers (`incidents.service.ts:1251-1255`), so the next run tells the assignee and every whole-organization triager again.
- Each change is audited, so this is a nuisance from inside, not a hole.

**N8. The floor is a minimum, not a fixed step, and stands alone.**
- When the work itself takes more than 50 ms, as under load, nothing is added (`public.controller.ts:160-171`).
- `GET /public/reporting/:slug` has the same found-versus-not-found difference with no floor and no rate limit.
- **Fix:** round the answer up to the next multiple of the floor. Whether hospital existence is worth hiding at all is settled by N5.

**N9. Control characters are refused in incident text only.**
- Names of users, roles, units and clients (`apps/api/src/i18n/locales.ts:20-30`) and `dataRegion` accept them. A NUL there gives a 500; the rest are stored.
- These routes need a session and are audited.

**N10. Two gaps in what Job 1 calls fixed.**
- **Sticky sign-off rests on application code only.** The application role can write `sign_off_needed` (table-wide UPDATE, confirmed). A downgrade made by the previous build during a deployment loses the flag, and the backfill does not run again. A trigger that never lets the flag fall would close both.
- **Comments stored before this release** by a reporter who was also a handler still read "the reporter" on an internal comment, which tells a manager the report was named and by someone with full access. The migration says the capacity cannot be recovered; for an internal comment it can, because only full access could write one. This matters only where such data exists; there is none here.

**Smaller points**
- `isTimeZone` accepts `Etc/GMT+3` and names in any letter case, though the contract says offsets are refused (`apps/api/src/i18n/time-zones.ts:21-31`). Harmless: the name reaches `Intl` only, never SQL.
- `tenants.time_zone` has no check in the database. A value written outside the API that `Intl` does not know would give that hospital a 500 on every report and summary.
- The check fills in missing deadlines with no audit row (`deadline-check.service.ts:316-355`).
- A code pasted with an invisible direction mark is not a control character, so it is looked up, fails and uses an attempt. One for the bilingual reviewer.
- A sender who files until 429 learns how many public reports the hospital had in the last hour. It costs them their own junk and is not worth a change.

---

## Job 2: checked and found sound

**Notifications (read from the code; tables confirmed in the database)**
- Every notification is written by `Notifier`. A recipient must be active, not the actor, and either have full access as the change leaves the incident, or be the reporter for something not internal. That is the same rule as `visibleTo` and `seesAll`.
- People named directly are filtered the same way: the assignee, the last triager, the requester.
- Nobody keeps learning after losing access. The list shows past notifications with `canOpen: false`, the reference and the kind, all of which the person was sent while they had access. A "closed" change goes only to the reporter and the current assignee.
- Nothing reveals the reporter. `data` holds the reference and one of `deadline`, `decision` or `change`. An anonymous report, signed in or public, tells every triager including the reporter. A comment written with a code has no actor.
- Own notifications only: every query filters on the caller. Another person's, another hospital's and a malformed id all give the same 404.
- Both foreign keys are composite on `tenant_id`. The application role has SELECT, INSERT and UPDATE of `read_at` only; no DELETE. All confirmed.
- The session cookie is `SameSite=Strict`, so the two POST routes without a body cannot be driven from another site.
- `AccessService.holders` agrees with `scope.ts`: both walk the whole unit tree whether or not a unit is active, so a grant on a switched-off unit counts in both; nested units count in both; both are safe against a loop. Disabled and invited users are excluded. Roles are read at the moment of sending, and the caller's scope is rebuilt on every request. The test is at `apps/api/test/notifications.e2e-spec.ts:253`, not in `identity.e2e-spec.ts` as the comment in `access.service.ts` says.

**Deadline check (read from the code)**
- The list of hospitals is read outside any tenant, as sign-in does; everything else runs inside `withTenant`. Suspended hospitals are skipped.
- The claim is sound: `FOR UPDATE SKIP LOCKED` rechecks each row as it now is, and the marker and the notifications are written in one transaction.
- Every batch makes progress, so the loop ends. A failing hospital is caught and logged with its id and the error's class only.
- It is started from `main.ts` alone, with a fixed interval and no setting that could shorten it.

**Deadlines and time zone**
- A reporter-only reader gets nulls in the fields, is left out of `overdue` and `triagedOnTime`, is not matched by `overdue=true`, and is sorted as having no deadline. A deadline is still derivable from the reported time by anyone who knows the rules, which cannot be helped.
- The zone name is checked by pattern and by `Intl` before it is stored, and never reaches SQL as text.
- Only a platform admin can set it; the application role cannot (confirmed). The change is in the platform audit.
- Reading the rules needs triage or settings rights; changing them needs `settings.manage` for the whole organization, uses a strict schema and is audited with from and to.

**Migrations 0021 to 0025 and grants (confirmed in the database unless marked)**
- All 26 are applied. Both new tables have row-level security and `tenant_isolation`; every table with `tenant_id` has both.
- Grants are as the contract says. `audit_log`, `incident_events` and `incident_comments` remain INSERT and SELECT; nothing was widened. The platform role has nothing on the new tables.
- Rule rows are 5 per client with the starting values. The 0025 audit rows are present.
- The backfill statements touch only what they say and are guarded against repeating (read from the code).

**Control characters:** every incident text field uses `text()`. Joiners, non-breaking spaces and direction marks pass; only C0 controls other than tab and line breaks, and DEL, are refused.

**Secrets:** none in the diff. Test passwords are made per run.

---

## Could not check

- Anything at run time: N1 through the real chain, N4 under load, the engineer's timing figures, and the check with two processes.
- The backfills against real rows, since the database has none.
- Web code beyond confirming that the public pages call the API from the browser, and web-tier logs.
- The production topology.