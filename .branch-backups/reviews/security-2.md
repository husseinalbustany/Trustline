## Security review of 08d5229 "Add incident safeguards to the API" (incl. 17ca28e)

**Verdict: not ready to release.** Two high findings sit on the public routes; three medium ones need a decision. The `tenants` row-level security, the grants, migration 0020 and the sign-off mechanics are sound.

**How I checked.** I read the code at 08d5229; the working tree matches it for `apps/api`. I ran read-only SQL against the local database as the owner, application and platform roles (read-only sessions, `EXPLAIN` only for writes). I ran no tests, server, migration or seed, and wrote nothing. Each finding says "confirmed in the database" or "read from the code".

All paths below are under `/home/user/Trustline/`.

---

### High

**H1. The public rate limit does not see the caller's address: one header bypasses it, and without the header every caller shares one count.**
- **Where:** `apps/api/src/app.setup.ts:14-19` (trusts 1 proxy hop by default), `apps/api/src/incidents/public-limits.ts:36`, `apps/api/src/security/rate-limiter.ts:12-17`, `apps/web/next.config.ts:10-12`.
- **What an attacker can do:**
  - **Bypass:** send a different `X-Forwarded-For` on each request and get a fresh count every time. Unlimited junk reports go into any hospital with the public form on. They are permanent (the application role cannot delete incidents), each needs a triager to reject it with a note, and they use up INC numbers.
  - **Lockout:** send no header at all. Every request then counts against the web server's own address, so 10 reports or 30 follow-up attempts an hour are shared by all callers of all hospitals per API process. One person can close the public form and follow-up for everyone.
  - **Memory:** `clientKey` returns any string that is not IPv6 unchanged (`rate-limiter.ts:17`). A forged header can be about 16 KB, and each limiter keeps 50,000 keys for an hour, so roughly 800 MB per limiter.
- **How I know:** read from the code, not run. The web app reaches the API only through a Next.js rewrite. In the installed Next 16.4.6, `apps/web/node_modules/next/dist/server/lib/router-utils/proxy-request.js` creates the proxy without `xfwd`, so it neither adds nor replaces `X-Forwarded-For`; the client's own header passes through. Express with one trusted hop takes the right-most entry. The e2e suite shows the mechanism: its helper `freshAddress()` (`apps/api/test/incident-safeguards.e2e-spec.ts:279-286`) gets a new count per request by setting that header.
- **Condition:** it is safe only if something in front of the web app appends or overwrites the header with the real address. Nothing in the repository does or requires this.
- **Smallest fix:**
  1. Make the tier in front of the web app set `X-Forwarded-For` authoritatively, and state it in the README and `.env.example`.
  2. In `clientKey`, return `'unknown'` unless `net.isIP(address)` is non-zero.
  3. Add a test that goes through the real chain.
- **Side effect outside this change:** the sign-in audit `ip_address` is forgeable the same way.

**H2. Anyone holding a follow-up code reads staff names and internal user ids.**
- **Where:** `apps/api/src/incidents/incidents.service.ts:103-109` (`ANONYMOUS_REPORTER`), `:774` (event actor), `:806` (comment author), `:1286-1295`.
- **What an attacker can do:** file a public report, then open it with the code. The view names, with `{ id, name }`, whoever triaged it, changed its status, asked for or gave sign-off, and wrote an `everyone` comment. No session is needed.
- **How I know:** read from the code. The spec's "Decided after the first build" section (added in a8841a6, after this commit) says such a reader gets no person and `byStaff: true`; the code does not do that yet.
- **Smallest fix:** add a reader flag (for example `seesStaff: false` on `ANONYMOUS_REPORTER`) that nulls `actor` and `author` and sets `byStaff` in `view()`, with a test that no staff id or name appears in the body.
- **Related:** the same view returns the incident's internal `id` (`:678`), although the report route deliberately omits it.

---

### Medium

**M1. A public report tells anyone how many incidents the hospital has had this year.**
- **Where:** `incidents.service.ts:459-464` and `:430`; `apps/api/src/incidents/reference.ts`.
- **What an attacker can do:** the public route answers with `INC-<year>-<n>` from the same gapless series as staff reports. One report gives the year's count; two a week apart give the rate. A hospital would treat that as confidential.
- **How I know:** read from the code.
- **Smallest fix:** answer public (or all anonymous) reports with a random receipt as the follow-up reference and keep the INC number internal. This changes the contract, so it needs the owner's decision.

**M2. One person with triage rights can close a sentinel event or a death alone.**
- **Where:** `incidents.service.ts:922-993` (triage has no check when the change removes the need for sign-off); `apps/api/src/incidents/status.ts:113`.
- **What they can do:** re-triage to "severe, not sentinel", then `close`. If closure is already waiting, any triager can `withdraw` it first, then downgrade and close. The downgrade is on the timeline, but no second person is involved.
- **How I know:** read from the code. The test at `incident-safeguards.e2e-spec.ts:2305` asserts this works, so it is deliberate.
- **Smallest fix:** in `triage()`, when the incident needs sign-off before and not after, require `incidents.sign_off` covering it and a reason. Stricter: an incident that ever needed sign-off keeps needing it to close.

**M3. A reporter who also handles the incident can be picked out.**
- **Where:** `incidents.service.ts:768-771` and `:802-803` ("by the reporter" is worked out at read time from `authorId === reportedBy`).
- **What a department manager learns:**
  - An internal comment marked "the reporter" proves the report was named and that the reporter is one of the few people with full access. The engineer flagged this part.
  - Not flagged: every handler whose comment shows a name is ruled out. In a small unit that leaves one person.
- **How I know:** read from the code. The named-versus-anonymous test compares only one life story with `everyone` comments.
- **Smallest fix:** record the capacity when the comment is written (`by_reporter` true only when the author has no full access, or used a code). A handler's comments then always carry their name, which says nothing about who reported.

---

### Low

- **L1. Follow-up codes are dead while public reporting is off.** `apps/api/src/incidents/public.controller.ts:56-59`, `:102`, `:121`. The later spec decision says follow-up answers for every active hospital, and the README still describes the old behaviour. Read from the code. Fix: the two follow-up routes call `findTenant()` directly.
- **L2. A NUL character in `reference` gives a 500 and a log line instead of 404.** `public.controller.ts:22-25` has no NUL check and the value reaches the query at `incidents.service.ts:1272`. It happens the same for every hospital, so it distinguishes nothing. Inferred from the code. Fix: validate with the existing `text()` helper or a character pattern.
- **L3. `revision` is optional on sign-off.** `apps/api/src/incidents/incidents.controller.ts:38`, `:95`. A signer can sign a summary that was withdrawn and re-proposed after they read it. Fix: require it for `sign_off`.
- **L4. The withdrawal note is shown to the reporter, including a public one.** `incidents.service.ts:1145-1158`, `:777`. Only `sent_back` notes are hidden, though a withdrawal note is the same kind of internal remark. The spec allows this; worth confirming.
- **L5. Migration 0020 changes role permissions with no audit row.** `apps/api/drizzle/0020_built_in_roles_reporter_and_sign_off.sql`. CLAUDE.md requires every role change to be audited. Fix: insert one `audit_log` row per client in the migration.
- **L6. Per-/64 counting leaves room, and there is no per-hospital ceiling.** Anyone with an IPv6 /48 has 65,536 separate counts. Consider a ceiling per hospital as a circuit breaker.
- **L7. The quality office sees `channel: "app"` on an anonymous report.** `incidents.service.ts:819`. It narrows the reporter to signed-in staff. This is by spec; flagging it for the privacy promise.
- **L8. The platform role can write `public_reporting`.** Confirmed in the database: it has table-wide UPDATE on `tenants`, which predates this change. The portal's update schema does not expose the column.

---

### Checked and found sound

**`tenants` row-level security (confirmed in the database)**
- RLS is enabled, not forced; the owner bypasses it, and migrations, seed and test cleanup connect as owner.
- The application role sees all 4 clients with no tenant set, so sign-in and `findTenant` work.
- Its UPDATE and `SELECT ... FOR UPDATE` plans are filtered to `id = app.tenant_id`.
- UPDATE of `status`, UPDATE of `slug` together with `public_reporting`, DELETE and INSERT are all refused with permission denied.
- Its only column grant is UPDATE on `public_reporting`.
- The platform role keeps unfiltered SELECT, INSERT and UPDATE, has no DELETE, and has no access to `incidents` or `users`.

**Grants and constraints (confirmed in the database)**
- No other grant was widened. `audit_log`, `incident_events` and `incident_comments` remain INSERT and SELECT only.
- Every new foreign key is composite on `tenant_id`.
- The three check constraints exist as described.

**Migration 0020 (confirmed in the database)**
- Migrations 0017 to 0020 are applied.
- All 4 clients' built-in Administrator and Quality officer roles hold both permissions; Department manager and Reporter hold neither.
- The one custom role is untouched and no role has duplicate permissions.
- The statement keys on `is_system` and the two codes; the API cannot set `is_system`.

**Reporter hiding (read from the code)**
- Every incident response goes through `view()`; `reportedBy` is never returned.
- No stable id stands in for a hidden reporter.
- `mine` filters only on the caller.
- Lists, the summary and assignable users carry no reporter.
- `channel` is null to a reader not told the reporter.
- No route reads the audit log.
- User routes show last sign-in by day only.
- Role edits cannot grant a permission the editor lacks for the whole organization.
- No notifications exist yet.

**Public routes (read from the code)**
- The tenant always comes from `findTenant`, and all work runs inside `withTenant`.
- An unknown hospital runs the same lookup under an all-zero tenant.
- Unknown, suspended and switched-off hospitals take the same path and give the same 404.
- A valid pair under another hospital's slug is 404 through row-level security.
- The code is about 79 bits from `randomInt`, stored as SHA-256, compared with `timingSafeEqual` against a decoy when nothing is stored.
- Bodies are strict schemas, JSON only.
- Nothing about the sender is passed to the service, and audit rows carry no actor or address.
- The public form shows only active units and categories.

**Sign-off (read from the code)**
- "Same person" is the stored requester read under `FOR UPDATE`, so two sessions of one user are refused.
- Triage is blocked while closure waits.
- `kind` cannot turn a close into a sign-off.
- Reopening clears the request.
- The permission is checked with scope.

**Secrets:** none in the diff.

---

### Could not check

- **Anything at run time:** H1 end to end through the web app, the engineer's timing figures for refusals, and behaviour under concurrency.
- **Production topology:** what sits in front of the web app, and whether the migration role there owns the tables. If it does not, RLS on `tenants` would apply to migrations and the seed.
- **Web code and web-tier logs.**

### What the new tests do not cover

- The limiter with a sender-chosen single address, with no header, or with a non-IP or very long address.
- Staff names in the follow-up view. The test at `incident-safeguards.e2e-spec.ts:1343` does not assert their absence.
- A reporter who is also a handler compared against an anonymous report, and the elimination case in M3.
- Refusal of the downgrade-then-close path; the suite asserts it succeeds.
- Timing of follow-up refusals.
- A NUL in `reference`.
- A sign-off sent without `revision` after a re-request.
- `apps/api/src/database/safeguards.spec.ts` does not check the row-lock path on another client's record. I confirmed that separately.