## Being fixed in the API

- Hand-off returns a minimal body.
- Triage allowed while in progress.
- A `revision` check answering 409 `stale_incident`.
- `moves` returned on the incident.
- User responses carrying `orgUnit { id, name, active }`.
- Lower bound on occurredAt.
- Audit of changed fields only.

# Code review: incident reporting and organization structure (`1d20a0e..HEAD`, apps/api and apps/web)

I found two high-severity bugs, five medium ones and a handful of low ones; the API's core rules are otherwise sound.

**What I ran.** `pnpm --filter api lint`, `typecheck` and `test` all pass (193 tests). ESLint on the in-scope web files is clean. I ran one throwaway probe spec against the local database; it removed its data (0 `crv-%` tenants left). No servers, no builds, no repository files changed, and nothing was exercised in a browser.

**How to read "confirmed".** "Confirmed by probe" means I reproduced it against the API. "Confirmed by reading" means the code path is unambiguous but I did not run it in a browser. "Suspected" is marked as such.

The review is of HEAD. The other agent's uncommitted work (`apps/web/src/lib/org-units.ts`, edits to `lib/incidents.ts` and `lib/identity.ts`) is ignored, except where noted in findings 2 and 7.

## High

### 1. A triager whose rights come only from the owning department cannot hand the incident on: 404, nothing saved
- **Where:** `/home/user/Trustline/apps/api/src/incidents/incidents.service.ts:562`; `/home/user/Trustline/apps/web/src/components/incidents/triage-panel.tsx:70-73, 182-186, 110-113`.
- **Trigger (confirmed by probe):** incident happened in Ward and is owned by Lab. A Lab-scoped triager (`canTriage: true`) posts triage with `ownerUnitId` = Pharmacy.
- **Result:** 404 `Not Found`; the owner is still Lab and no events are written.
- **Cause:** `triage()` ends with `return this.detail(tx, auth, id)`. After the update the actor no longer passes `visibleTo`, so `detail` throws `NotFoundException` inside the transaction and the whole triage rolls back.
- **Web contradiction:** the panel warns "After saving you will no longer be able to triage or change this incident", then shows "This incident does not exist…" while the incident is still on screen.
- **Fix:** decide which behaviour is wanted.
  - If hand-off is allowed (the UI text says so): when the actor no longer sees the incident, return a small body such as `{ id, reference, access: null }` instead of calling `detail`, and have the panel go to the list with a message.
  - If it is forbidden: refuse before the update with an explicit code, and replace the warning.
- **Test gap:** no e2e test covers this. `incidents.e2e-spec.ts:1016` only covers a triager who keeps access through `orgUnitId`.

### 2. Saving a user whose unit was switched off silently removes them from it; the role-scope select shows the wrong scope
- **Where:** `/home/user/Trustline/apps/web/src/components/admin/user-form.tsx:301-313` (department), `:231-246` (role scope), `:121-122` (submit); `/home/user/Trustline/apps/api/src/identity/users.controller.ts:293`.
- **Department select (API half confirmed by probe, browser half by reading):**
  - `GET /org-units` omits the unit, so the uncontrolled select has no option matching `defaultValue`.
  - React's `updateOptions` then selects the first non-disabled option, which is "no department" (`""`). I checked this in the installed `react-dom`.
  - Any save, for example correcting a phone number, sends `orgUnitId: null`. The API accepts it: PATCH 200, `orgUnitId` null afterwards.
- **Role-scope select (confirmed by reading):** it is controlled with the same missing option, so it displays "Whole organization" while state still holds the switched-off unit. The screen shows wider access than is stored, and touching the select really does widen it.
- **Related:** `/home/user/Trustline/apps/web/src/components/admin/users-list.tsx:44-47` shows a blank department for these users.
- **Audit makes it invisible:** `users.controller.ts:321` records `changed: Object.keys(parsed.data)`, which is every field the form sends, on every save. The move cannot be told apart from an ordinary edit.
- **Fix:**
  - Show the stored unit as a marked "(switched off)" option in both selects. The uncommitted `unitOptions(..., stored)` in `lib/org-units.ts` does this, but `user-form.tsx` is not wired to it at HEAD.
  - The form needs the unit's name. A user manager without `organization.manage` cannot fetch inactive units, so either return inactive units flagged `active: false` to any signed-in user (their names already appear on incidents) or include the unit name in `GET /users/:id`.
  - Audit only the fields that actually changed.

## Medium

### 3. A stale triage panel overwrites someone else's triage, and the API cannot detect it
- **Where:** `/home/user/Trustline/apps/web/src/components/incidents/triage-panel.tsx:60` and `:123`; `/home/user/Trustline/apps/api/src/incidents/incidents.service.ts:485-515`.
- **Cause in the web:** `ownerUnitId` is `useState`, initialised once, and sits outside the form keyed on `incident.events.length`. When the incident is refetched (page shown again, comment posted, `onStale`), harm, category and assignee reset to the fresh values but the owner select keeps the old one.
- **Trigger a (confirmed by reading):** A has the incident open with owner Lab. B re-triages it to Ward. A returns to the page, changes the harm level and saves. The owner silently reverts to Lab.
- **Trigger b (confirmed by reading):** with no refresh at all, A's older form is a full replace. It overwrites B's owner and, if A's form says "No one yet", clears B's assignee, who then loses access. The API returns 200 because triaged → triaged is legal; the existing test at `incidents.e2e-spec.ts:1056-1058` shows an omitted assignee clears it.
- **Same weakness for status:** closing from a stale "triaged" view succeeds after someone else re-triaged it as sentinel.
- **Side effect of the key:** posting a comment adds an event, which remounts the triage form and discards unsaved triage edits.
- **Fix:**
  - Web: derive the owner from the incident, by keying the whole `TriagePanel` on something that changes with the record, or moving the owner select inside the keyed form.
  - API: accept the `updatedAt` (or event count) the form was based on in triage and status, and answer 409 when it differs. The web already has `onStale` handling to reuse.

### 4. Reject then reopen leaves an incident that can never be triaged or given an owner
- **Where:** `/home/user/Trustline/apps/api/src/incidents/incidents.service.ts:70-75` and `:485`.
- **Trigger (confirmed by probe):** new → rejected → reopen gives `in_progress` with `ownerUnit: null` and `triagedAt: null`. Triage then answers 409 `invalid_transition`.
- **Result on screen:** "Responsible department: Not decided yet" permanently, with only "Close" offered.
- **Note:** the spec literally allows `rejected → in_progress`, so this is a gap in the spec, not a deviation. Worth raising with the quality reviewer.
- **Fix:** reopen a never-triaged incident to `new`, or allow triage from `in_progress`.

### 5. The incidents list sticks on "Loading…"
- **Where:** `/home/user/Trustline/apps/web/src/components/incidents/incidents-list.tsx:55-61, 97`.
- **Trigger (confirmed by reading):** on page 1, click the status chip that is already selected, for example "All". `ask()` sets `data` to null, but status, mine and page are unchanged, so the effect does not run again.
- **Result:** loading text and no pagination until another filter is chosen.
- **Fix:** return early from `ask` when nothing changes, or add a reload counter to the effect's dependencies.

### 6. The "Report sent" screen comes back
- **Where:** `/home/user/Trustline/apps/web/src/components/incidents/report-form.tsx:44, 64-69, 117-155`.
- **Trigger (confirmed by reading plus the Next docs, not in a browser):** send a report, then leave by the sidebar or browser back instead of "View it" / "Report another". Opening "Report an incident" again shows the old success screen and old reference instead of an empty form, including for an anonymous report.
- **Cause:** `sent` is cleared only by those two click handlers, and `cacheComponents: true` keeps the page's state while it is hidden.
- **Fix:** the pattern in `apps/web/node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`: a `useLayoutEffect` cleanup that calls `startAgain()` when a report was sent.
- **Same class, lower impact:** "Triage saved." and "Status changed." (`triage-panel.tsx:62, 226`) stay on screen indefinitely, including after later refetches.

### 7. Names of switched-off units vanish from the timeline, and the triage owner select misleads
- **Where:** `/home/user/Trustline/apps/web/src/components/incidents/incident-detail.tsx:105-106, 154, 161`; `/home/user/Trustline/apps/web/src/components/incidents/triage-panel.tsx:166-180`.
- **Timeline (confirmed by reading; the probe confirmed events hold ids only and the list omits inactive units):** events are resolved against active-only `GET /org-units`. Once an owning unit is switched off, the timeline reads "Responsible department: " and "Handed to , with no one assigned".
- **Owner select:** it has no fallback for a stored unit that is missing, unlike the assignee (`:77-83`) and category (`:84-87`). React shows the first real unit as selected while state still sends the old id.
- **Result:** 400 `unknown_org_unit` with "Reload the page and choose another", and reloading reproduces the same state.
- **Fix:** resolve unit and category names on the server when returning events, or return inactive units flagged; add the stored owner as a marked option.

## Low

- **Time shown is not the time sent.** `report-form.tsx:85-88, 236`: if "when" is untouched, the field shows the minute the form loaded or was last focused, but the request sends `new Date()` at submit. On a workstation left on the form for hours the stored `occurredAt` is hours later than what the reporter saw. Send the displayed value, or tick `now` while untouched.
- **No lower bound on `occurredAt`.** `incidents.controller.ts:49, 118-121`: `0001-01-01T00:00:00Z` is accepted with 201 (confirmed by probe). The future check lives in the controller, not in `IncidentsService.report`. Other shapes behave: no seconds, no offset and Feb 30 are 400.
- **Time zone.** The reference year comes from `getUTCFullYear()` (`incidents.service.ts:262`), so a UTC+3 hospital gets last year's number until 03:00 on 1 January. `lib/format.ts:8-14` renders in the viewer's device zone with no zone shown, and there is no tenant time zone anywhere.
- **Duplicated status moves.** `lib/incidents.ts:124-140` and `MOVES` in `incidents.service.ts:51-76` are identical today: I compared all six moves, the note rule and `canBeTriaged`. To stop drift, return the allowed moves on `GET /incidents/:id` next to `canTriage` and keep only labels in the web.
- **Paging past the end.** The API returns `items: []` with the real total (confirmed by probe). The list then shows "No incidents match this filter" with "Page 3 of 2" (`incidents-list.tsx:123, 174`).
- **Expired session (suspected, by reading).** `lib/api.ts` has no 401 handling, so after the 8-hour session ends the report form answers "Could not save. Check your connection" (`report-form.tsx:98` via `explain`).
- **Refresh failure replaces the page.** `incident-detail.tsx:73-81, 91`: a failed refetch after a successful comment swaps the whole detail for the load error and drops any drafts.
- **Tests.**
  - Nothing covers findings 1, 3 or 4.
  - `incidents.e2e-spec.ts:1529` (`closedLast30Days` equals the count of closed) holds only because it runs before the test that back-dates `closed_at`.
  - `apps/web` has no test runner, so every web finding here is untested.
  - Existing tests were not weakened; the org-unit delete test in `tenant-isolation.spec.ts` was replaced by a stricter one.
- **Simplicity.** `indent` and the unit option list are duplicated between `user-form.tsx:24` and `lib/incidents.ts:158-184`; the working tree is already moving this to `lib/org-units.ts`.

## Sound

- **Visibility.** The SQL `visibleTo` and the per-row `holds` / `seesAll` agree, including NULL owner, NULL reporter and empty reach. List, count, summary and detail share the same predicate. Ordering is deterministic and the excerpt is cut in the database.
- **Transitions and locking.** `FOR UPDATE` on the incident re-evaluates after a wait, so two opposite decisions cannot both pass. 404 versus 403 follows the spec.
- **Reference counter.** Single upsert under a row lock; no gap on rollback.
- **Org units.** Level rules, the parent `FOR SHARE` / unit `FOR UPDATE` ordering (no lock cycle; create, switch-on and move against a parent switch-off all serialise correctly), `assertActive`, audit entries and the no-delete grant.
- **Scope.** `buildScope`, `covers` and `reachOf` are correct, and scope is recomputed per request so it cannot go stale on the server.
- **Cross-incident state in the web.** The triage panel and comment box cannot show another incident's values: the `loaded?.id === id` guard unmounts them. Lists and the dashboard refetch when shown again. Sign-out does a full page load.

## Probe

The throwaway spec and its output are at `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/review-cr/review.e2e-spec.ts` and `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/review-cr/out.json`. Its cases for findings 1 and 4 can be lifted into `incidents.e2e-spec.ts` as regression tests.
