# Security review 16: reports and measures steps 1 to 3 (4acf9c5..5350c22)

## Decisions: fix everything
- M1: corrections and settle copy target, target_source, as_at and unit_path from the revision being replaced; only value, numerator, denominator and details are recomputed; test: change a target, correct the month, the old target stays.
- M2: incidents.reported has no target on unit rows and unit queries; settings leave out firstMonthsBaseline and reportedTarget unless incident reach is 'all'; incident targets skipped when the module is off.
- L1: corrections take the same per-tenant-and-month advisory lock as settle (blocking, or 409 when busy); inserts report what was written, 409 when a revision was taken.
- L2: a migration: taken_at set by the database for the app role (pinned search_path), composite foreign keys for requested_by and updated_by, CHECK corrected <=> requested_by.
- L3: unit rows of policies.acknowledged count only documents owned inside the unit's subtree.
- L4: a correction's reason shows on unit rows only to whole-organization readers; the form says "no personal details".
- L5: decided by the business side here: drop channel from unit rows whose stored subtree differs from today's.
- L6: one correction per client at a time (409 busy); per-month catch in the check; the check does not let one client's backfill delay others (time-box per client per run).
- L7: month regex years 2000+; concurrent first PATCH gives 409 stale_settings.
- For step 8 (packs), recorded in the spec: no channel in packs; byHarm/byCategory cells below 5 hidden for readers without incidents.view over the unit.

## Security review: reports and measures, steps 1 to 3 (API), range 4acf9c5..5350c22

I found nothing critical or high. Five findings change what readers see or what the record says: two medium and three low. Four more lows follow, and are short. Each one has the file:line, a scenario and the smallest fix.

`test/reports.e2e-spec.ts` passes: 12 of 12 in 19 s. The copy I ran is the working tree, which adds one uncommitted test for the Approving authority. The working tree also holds an uncommitted `0067_approving_authority_reports.sql`, which is already applied in the shared `trustline` database. I did not review 0067. I changed no files. One write was a test insert as `trustline_app` inside BEGIN/ROLLBACK, so it left nothing behind.

### M1 (medium): a correction, and the final triage row, store today's target and today's month boundaries
- **Where:**
  - `apps/api/src/reports/snapshots.service.ts:141` and `:153`: `compute()` always calls `targetsOf(tx)`, which gives the targets in force now.
  - `apps/api/src/reports/reports.service.ts:313`: `correct()` uses `compute()`.
  - `apps/api/src/reports/measure-snapshot.check.ts:211-233`: `settle()` uses it too.
  - `compute()` also takes `asAt` and the unit tree from the present. Corrections use `auth.tenant.timeZone`, which platform staff can change.
- **Scenario:** a holder of `reports.manage`, who also has whole-organization reach for incident or document figures, can rewrite whether past months were met:
  1. PATCH `/reports/settings` with `{targets:{"incidents.triaged_on_time":0}, revision:n}`.
  2. POST `/reports/measures/corrections` with `{month:"2026-03", measures:["incidents.triaged_on_time"], reason:"x"}` for each past month.
  3. PATCH the target back to 95.
  - Every month's latest revision now has `target: 0` and `met: true`, in the series, the CSV and later the packs.
  - This breaks the spec's rule ("a later change of target never makes an old month look better or worse") and the contract ("earlier months keep theirs").
  - The same thing happens by accident whenever a target changes between a month's provisional row and its final row.
  - A correction made after a time-zone change gets a different `as_at` and different month boundaries. A correction also applies today's structure (`unit_path` and subtree), against decision 3.
  - The audit trail shows each step, so it can be detected, but the figures are wrong.
  - No test covers this: the targets test runs no correction after its PATCH.
- **Fix:** in `correct()` and `settle()`, copy `target`, `target_source`, `as_at` (and `unit_path`) from the revision being replaced (`latest()`), and recompute only value, numerator, denominator and details. Add a test: change a target, correct the month, and expect the old target.

### M2 (medium): organization-wide reporting figures reach callers who should not see them
- **Path 1, unit-scoped callers:**
  - `reports.service.ts:142,154-155`: `measures()` returns `target` and `targetSource` for `incidents.reported`, taken from `targetsOf()` even when a `unitId` is given.
  - `snapshots.service.ts:98-103,153` stores that same target on every unit row, so `months[].target` carries it too.
  - That target is the client's baseline. Reading the baseline needs whole-organization `reports.view` (GET /settings).
  - Without a baseline, the target is the organization's average monthly reports over its first three full months: an organization row, from `org_unit_id is null` (`snapshots.service.ts:113-118`).
  - **Request:** a department manager calls `GET /reports/measures?from=2026-10&to=2026-10&unitId=<their dept>` and reads `measures[code=incidents.reported].target` and `targetSource:'first_months'`. That is a figure for the whole organization, which their scope refuses with 403. Their ward's `met` is also judged against the whole organization's volume, which is meaningless.
- **Path 2, callers with no incident rights:**
  - `reports.service.ts:364-365`: GET /settings returns `firstMonthsBaseline` and `reportedTarget` to anyone with whole-organization `reports.view`, even without incident reach.
  - Uncommitted 0067 gives the Approving authority that grant, which makes this concrete. It breaks "Incident measures need incidents.view or incidents.triage".
- **Fix:**
  - For unit rows and unit queries, give `incidents.reported` a null target and source. A per-unit first-months baseline could come later.
  - In `settingsIn()`, leave out `firstMonthsBaseline` and `reportedTarget` unless incident reach is `'all'`. Also skip incident targets when the client lacks the module.

### L1 (low to medium): two writers can claim the same revision, and the loser is reported as stored
- **Where:**
  - `snapshots.service.ts:209-212`: `store()` inserts with `onConflictDoNothing()` and returns the rows it meant to write, not the rows it wrote.
  - `reports.service.ts:296-339`: `correct()` takes no advisory lock. The check's `settle()` takes `trustline.measures.<id>.settle.<month>`; corrections ignore it.
- **Scenario:** two administrators correct the same month at once, or a correction runs while the 15-minute check makes a month final. Both compute revision n+1 and one insert is silently dropped. The losing caller still gets 201, and `measure_correction_requested` records "revision n+1, from X to Y, reason R2". The row stored as n+1 holds reason R1, or is a `reconstructed`/`final` row. The audit no longer matches the figures.
- **Fix:**
  - In `correct()`, take the blocking `pg_advisory_xact_lock` on the same per-tenant-and-month key that `settle()` uses.
  - Insert corrections without `onConflictDoNothing`, or use `.returning()` and answer 409 when fewer rows came back.
  - Do the same for `settle()`.

### L2 (low): the app role chooses a snapshot's timestamps and requester, and the user columns have no foreign keys
- **Where:**
  - `drizzle/0065_reports_and_measures.sql:21,23`, `schema.ts:2787` (`requested_by`) and `schema.ts:2836` (`report_settings.updated_by`): no foreign keys.
  - 0066 adds only a BEFORE UPDATE trigger.
- **Proof** (as `trustline_app`, rolled back): this insert succeeded:
  ```
  insert into measure_snapshots (..., method, revision, as_at, taken_at, requested_by)
  values (..., 'snapshot', 7, '2020-02-01', '2020-02-01 00:05', gen_random_uuid())
  ```
  So a backdated `taken_at`, a forged `method:'snapshot'`, and a `requested_by` naming no user (or another hospital's) are all accepted.
  - Security review 12 (M1/M3, migration 0063) settled that the application never chooses when something happened.
  - The 37 other user references in the schema use composite `(tenant_id, user_id)` foreign keys.
- **Impact:** only through an application bug or a compromised API process; the API never does this today. It weakens the "insert-only record" claim.
- **Fix:** a migration with:
  - a BEFORE INSERT trigger that sets `taken_at := now()` for `trustline_app`, with `search_path` pinned as in 0063;
  - composite foreign keys `(tenant_id, requested_by)` and `(tenant_id, updated_by)` to `users(tenant_id, id)`;
  - optionally, `CHECK ((method = 'corrected') = (requested_by IS NOT NULL))`.

### L3 (low): a unit's acknowledgement figure counts documents its reader cannot see in full
- **Where:**
  - `measures.ts:357-360`: unit rows join on `users.org_unit_id` and do not restrict the document's owner.
  - `reports.service.ts:87`: the gate is reach over the unit.
  - The dashboard instead limits this measure to `fullSight(viewer)`, documents owned within the viewer's full reach (`library.service.ts:529`).
- **Scenario:** a department manager with `policies.view_all` over their department reads `policies.acknowledged` for it. The count includes acknowledgements their staff owe on restricted documents owned by another unit, which the dashboard would not count for them. Only counts leak, but it breaks "tells nobody what their screens would not".
- **Fix:** on unit rows, count only documents whose owner is inside that unit's subtree. Otherwise, give unit rows of this measure only to callers whose `policies.manage`/`policies.view_all` reach is `'all'`.

### Further lows, briefly
- **L4, correction reasons go wide** (`reports.service.ts:315-318`, `:223`): a correction for the whole organization copies its free-text reason (1 to 1000 characters) onto every unit row. History then shows it to every unit's readers. Reasons will name wards, and possibly incidents or people. Fix: show a reason on a unit row only to whole-organization readers, or store a neutral reason there, and add a "no personal details" hint on the form.
- **L5, history after a structure move:** this follows decision 3, so it needs the business, not code. A stored department row still counts a unit that has since moved out of it. Subtracting the department's current children gives the moved-out unit's past figures. With `see_reporter` over the department, that includes its channel split, the one thing the spec says must not leak. Fix: drop `channel` from unit rows whose stored `unit_path` subtree differs from today's, or accept it in writing.
- **L6, performance:**
  - Read routes are cheap: one indexed query, at most 600 rows, and only the current month worked out live. Nobody can trigger reconstruction of many months by request.
  - Corrections have no rate limit. One rebuilds a document month across every unit, with correlated `audit_log` subqueries, holding a pooled connection (default pool of 10, shared by every hospital) for up to about six statements of 15 s each. Parallel corrections, or a stolen administrator session, could starve other hospitals. The per-tenant lock in L1 also fixes this; answer 409 when it is busy.
  - In the check, `takeClient()` has no per-month catch. One month that keeps hitting the 30 s limit stops that client's other module and `settle()`. Since the check takes clients one at a time, ordered by id, a large backfill delays every other client's month end past the 6-hour on-time window.
- **L7, input edges:**
  - `input.ts:12`: the month regex accepts `0000-01`, which Postgres rejects, so `from=0000-01&to=0000-01` gives a 500. Fix: require a year of 2000 or later.
  - `reports.service.ts:382,416`: two first-ever PATCH /settings calls at once both find no row to lock. The second insert hits the primary key and gives a 500, where the contract says 409 `stale_settings`.

### On anonymity: no small-count threshold is needed today
- The public form and the staff form send the same fields, `startedAt` included (`report-input.ts`, `report-fields.tsx`). So `withStartTime`, `byType`, `byHarm`, `byCategory` and `nearMissShare` do not stand in for channel.
- Incident visibility is by unit only (`visibility.ts`). Aggregates over a unit in `incidents.view`/`incidents.triage` reach therefore show nothing beyond what that person's incident list shows.
- `channel` is removed from the series, from `current` and from history, and is in neither the CSV, the correction response nor the audit.
- **For step 8, the committee packs:** packs go to `reports.view` holders who may have no incident rights. Leave `channel` out of packs entirely. Hide any `byHarm` or `byCategory` cell below 5 for a unit when a pack reader lacks `incidents.view` over it.

### Checked and sound
- **Tenant isolation:**
  - Both tables have RLS and the `tenant_isolation` policy (picked up by the generic check in `tenant-isolation.spec.ts`).
  - The owner is `trustline`, and the app role cannot bypass RLS.
  - `org_unit_id` has a composite foreign key to `org_units(tenant_id, id)`.
  - Every read and write is inside `withTenant`, with the tenant from the session. The check works client by client.
  - A unit of another hospital answers 404 (tested).
- **Grants:**
  - `measure_snapshots`: SELECT and INSERT only. `report_settings`: SELECT, INSERT and UPDATE. I confirmed there is no DELETE or TRUNCATE.
  - The BEFORE UPDATE trigger refuses updates even by the owner, and its `search_path` ends in `pg_temp`. Its body references no object.
  - No audit grant was widened.
- **Routes:**
  - Every route has SessionGuard, `@ForModule('core')` and `reports.view` first.
  - `requireEverywhere` guards corrections, settings and reading settings. `reports.manage` is not in `READ_ONLY_PERMISSIONS`, so external reviewers cannot hold it.
  - All schemas are strict, and corrections have no value field (tested).
  - The organization without whole reach gives 403; a unit out of reach gives 404; an unknown or invisible code in history gives 404.
- **Month-end check:**
  - It runs once across processes: a try-lock per client, module and month, a re-check inside the lock, and the unique key.
  - The client's calendar comes from `dayOf`/`startOfDay`, which handle daylight saving.
  - Logs carry only the client id and the kind of failure, with no patient data.
- **CSV:**
  - It uses the shared `csv()`: every cell quoted, formula starts neutralised (`\p{Cf}` included), BOM, CRLF.
  - The file name is sanitised. Headers are `attachment` and `no-store`.
  - Language is checked (`language_mismatch`), and each export is audited with its filters.
  - The "Place in the structure" column names only ancestor units, which every signed-in user can already list.
- **Settings:** target ranges, the reporting-volume target refused, `localizedText` with `fitsLanguages` on the note, the revision checked under FOR UPDATE, audit with from and to, and a request that changes nothing keeps the revision.
- **0066:** it changes built-in roles only, is safe to repeat, and writes one audit entry per client, exactly as 0059 does.
- **Other:** no secrets, and no real names or patient data in the test or the wording.

### Not checked
- The web side.
- Uncommitted 0067 and its test.
- Behaviour on large data: statement times of reconstruction for a big client.
- That the audit inserts in 0066 are sealed in each client's chain. I assumed so from the 0059 precedent.
- The L1 race, which I did not reproduce, to avoid parallel writes to the shared database.

### Files
- /home/user/Trustline/apps/api/src/reports/reports.service.ts
- /home/user/Trustline/apps/api/src/reports/snapshots.service.ts
- /home/user/Trustline/apps/api/src/reports/measure-snapshot.check.ts
- /home/user/Trustline/apps/api/src/reports/measures.ts
- /home/user/Trustline/apps/api/src/reports/input.ts
- /home/user/Trustline/apps/api/drizzle/0065_reports_and_measures.sql
- /home/user/Trustline/apps/api/drizzle/0066_reports_grants_and_existing_clients.sql
- /home/user/Trustline/apps/api/src/database/schema.ts
- /home/user/Trustline/apps/api/test/reports.e2e-spec.ts