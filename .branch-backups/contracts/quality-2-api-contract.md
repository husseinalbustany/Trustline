## Report: API fixes from the second quality review (Q-A1 to Q-A8, the three security leftovers, and the coordinator's two additions)

All of it is built and tested. `pnpm --filter api lint` and `typecheck` are clean. `pnpm --filter api test` passes **537 tests in 24 files** (508 before), and `pnpm db:seed` works.

I made no commits. Someone else made the checkpoint commit c0416d6 of my work while it was in progress; the finished changes are uncommitted on top of it. I did not run `pnpm build`, did not write `apps/api/dist`, and did not touch `apps/web`.

### Items
- **Q-A1 — done.** "Not taken forward" is now also allowed from `triaged` for anything not serious, and a note is still required.
  - **Decision:** it is also refused for an incident with `sign_off_needed`. Otherwise one person could triage a sentinel event down and then set it aside, ending it without the second signature. The answer is 409 `serious_cannot_be_rejected`.
- **Q-A2 — done.** "Triaged on time" now counts three kinds of report from the last 30 days:
  - triaged ones;
  - set-aside ones (setting aside from `new` now records `first_triaged_at`, and migration 0030 backfills it for older ones);
  - ones still `new` past their triage deadline, which count as late.
- **Q-A3 — done.** Reopening sets `close_due_at` to the reopening time plus the rule, and records when that clock started in the new column `close_due_from`.
  - A later regrade and the "due soon" moment are counted from the reopening too.
  - The old deadline stays in the `reopened` event's details and in its audit entry as `closeDueAt: {from, to}`.
  - That part of the details is hidden from reporter-only readers.
- **Q-A4 — done.** A public report no longer sets `sign_off_needed` from the sender's own grade. It is set only once a triager grades the report sentinel or death.
  - The 0026 trigger is replaced in migration 0030 with the same rule: a public report's grade counts only once `first_triaged_at` is set. It still only ever raises the flag and never lowers it.
  - Signed-in reports are unchanged. `needsSignOff` and `moves` follow the same rule.
  - Existing rows that already have the flag keep it. There are no incidents in the database now.
- **Q-A5 — done.** New list filter `channel=app|public`.
  - It answers 403 to anyone who holds `incidents.see_reporter` nowhere.
  - For everyone else it matches only incidents whose reporter the caller is told of. Any other incident matches neither value, so the filter cannot be used to tell anonymous reports apart.
- **Q-A6 — done.** The incident now carries `signOff: {others}`. A closure deadline that passes while awaiting sign-off is now also announced (`overdue`) to the people who may sign it off, except the requester.
- **Q-A7 — done.**
  - A handover now also reaches holders of `incidents.view` over the new department who could not view or triage it before.
  - New notification `sentinel_flagged`.
  - `serious` is in every notification's `data`.
  - New notification `public_form_paused`.
- **Q-A8 — done.** New list filter `categoryId`.
- **Leftover 1 — done.** A database check, `tenants_time_zone_shape`: `UTC`, or Area/Location with at most one more part, each part starting with a capital or a digit, nothing in `Etc/`. A test confirms every name the API can store passes it.
- **Leftover 2 — done.** Each incident whose deadlines the check fills in gets an audit row `incident_deadlines_filled`, with no actor and `changes: {triageDueAt?, closeDueAt?: {from: null, to}}`.
- **Leftover 3 — done, and wider than asked.** Changing the harm level back and forth no longer repeats `due_soon`, and it no longer repeats `overdue` either (going past → future → past used to repeat it too).
  - Announcement markers are no longer cleared when a deadline moves. New columns `close_due_soon_for` and `close_overdue_for` record which deadline was announced.
  - A closing deadline is announced only if it is later than the last one announced at that stage.
- **Addition 1 — done.** List items carry `access`.
- **Addition 2 — done.** The follow-up view's `hospital` carries `timeZone`.

### What the web must handle (exact shapes)
- **`GET /incidents` list items** gain:
  - `access: "full" | "reporter"`
  - `channel: "app" | "public" | null` (null unless the caller is told who reported)
- **`GET /incidents` query** gains:
  - `categoryId=<uuid>`: a non-uuid gives 400; another hospital's category gives an empty list.
  - `channel=app|public`: any other value gives 400. Without `see_reporter` anywhere the answer is 403 `{code:'missing_permission', permission:'incidents.see_reporter'}`.
- **`GET /incidents/:id`** gains `signOff: {others: number} | null`.
  - It is non-null only for full-access readers when the incident needs sign-off.
  - `others` counts active people who hold `incidents.sign_off` covering the incident and can see all of it.
  - It excludes the stored requester while `awaiting_sign_off`, and otherwise the reader (who would be the one asking).
  - `0` means nobody else can sign.
- **`moves`** may include `{to:'rejected', kind:'reject', noteRequired:true, revisionRequired:false}` from `triaged`.
- **The `reopened` event's `details`** are `{note, closeDueAt:{from, to}}` for full readers and `{note}` for reporters. The detail's `closeDueAt` and `overdue` reflect the new deadline.
- **A public report graded death before triage** shows `needsSignOff: false`.
- **Every notification's `data`** has `serious: boolean`. Rows written by the old running build lack it, so treat a missing value as false.
- **New notification kinds:**
  - `sentinel_flagged`, with `data {reference, serious}`. Sent to those who may sign off and can see the incident, plus whole-organization triagers, never the triager.
  - `public_form_paused`, with `incident: null` and `data {limit: 60, serious: false}`. Sent once an hour, at the first ceiling refusal, to holders of `settings.manage` or `incidents.triage` for the whole organization.
- **`GET /notifications`**: `incident` can now be `null`.
- **`incident_handed_over`** now also reaches department managers, with the same kind and data.
- **`POST /public/follow-up/:slug`** and the comment route's 201: `hospital` is now `{name, locales, defaultLocale, timeZone}`.
- No new routes and no new status codes beyond the ones above.

### Migrations (applied to the local database; both additive and safe for the running dist build)
- **`0029_review_2_deadlines_and_notifications`** (generated):
  - enum values `sentinel_flagged` and `public_form_paused`;
  - `notifications.incident_id` made nullable, with a check that only `public_form_paused` may have no incident (written as a text comparison, because all pending migrations run in one transaction);
  - new columns `incidents.close_due_from`, `close_due_soon_for` and `close_overdue_for`;
  - the `tenants.time_zone` check.
- **`0030_public_grade_and_announced_deadlines`** (`--custom`):
  - the replaced sign-off trigger;
  - the `first_triaged_at` backfill for set-aside reports;
  - the `_for` backfill.
- The old build's notification list uses an inner join, so it simply skips the incident-less rows.

### Other decisions I took
- For `public_form_paused` I took `settings.manage` for the whole organization, because only that can switch the form.
- `sentinel_flagged` is sent as its own announcement, so someone assigned in the same triage gets both notifications.
- "Newly covering" for view holders means they could neither view nor triage the incident before. The existing triage part of the rule is unchanged.
- Overdue-while-awaiting covers `overdue` only, not `due_soon`.

### Tests and docs
- New tests: `/home/user/Trustline/apps/api/test/incident-review-2.e2e-spec.ts`, 27 tests.
- I updated the existing tests that encoded the old behaviour:
  - the `serious` key in notification data;
  - set-aside from `triaged`;
  - the reopen deadline;
  - the triaged-on-time figures;
  - the list keys;
  - the marker columns.
- Specs and README updated:
  - `/home/user/Trustline/docs/specs/incident-safeguards-and-deadlines.md`: notes in place, plus new sections "Decided after the second quality review" and "Left open by the third security review, done in this step".
  - `/home/user/Trustline/docs/specs/incident-reporting.md`
  - `/home/user/Trustline/README.md`

### Main code files (under `/home/user/Trustline/apps/api`)
- `src/incidents/incidents.service.ts`
- `src/incidents/status.ts`
- `src/incidents/notifier.ts`
- `src/incidents/deadline-check.service.ts`
- `src/incidents/notifications.service.ts`
- `src/incidents/visibility.ts`
- `src/incidents/incidents.controller.ts`
- `src/incidents/public.controller.ts`
- `src/database/schema.ts`
- `drizzle/0029_review_2_deadlines_and_notifications.sql`
- `drizzle/0030_public_grade_and_announced_deadlines.sql`