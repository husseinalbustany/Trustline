# Incident reporting: specification (first release)

Read CLAUDE.md and README.md in /home/user/Trustline first. This file is the
agreed scope. If something here is impossible or wrong, say so in your report
rather than quietly doing something else.

## What it is

Any signed-in member of staff can report an incident, near miss or hazard in
under two minutes. Quality staff triage it, hand it to a department, and close
it. Everything that happens is on a timeline.

## Out of scope for this release (do not build)

Patient identifiers of any kind (no name, no record number: there is no
encryption yet), file attachments, people involved, medication and device
details, contributing factors, investigations, actions, response-time rules,
regulator reports, email notifications, reporting without signing in.

## Data (all tenant tables, under row-level security)

`incident_categories`
- `code` text, unique per tenant; `name` Localized (jsonb); `position` int; `active` boolean default true.
- Every tenant gets the default list below, created idempotently next to the
  built-in roles (when a client is created, and by the seed). Names in en, ar, fr.
  medication, fall, infection, equipment, identification, clinical_care,
  laboratory, facility, security, other.

`incidents`
- `reference` text, unique per tenant, format `INC-<year>-<5 digits>`, e.g. INC-2026-00042,
  numbered per tenant per year from `reference_counters` with no gaps reused and
  no duplicates under concurrent reports.
- `type`: incident | near_miss | hazard.
- `category_id` → incident_categories. `org_unit_id` → org_units: where it happened.
- `occurred_at` timestamptz (not more than 5 minutes ahead of the server, not before 1900-01-01). `description` text (required, the
  reporter's own words, in whatever language they write). `immediate_action` text, optional.
- `reported_by` → users, NULL when reported anonymously. `reported_at`.
- `report_started_at` timestamptz NULL: when the reporter opened the form, as their device
  told it, to measure the two-minute promise. Kept for anonymous reports too: it is a time, not an identity.
- `harm_level`: none | mild | moderate | severe | death. Set by the reporter,
  corrected at triage. `is_sentinel` boolean default false, set at triage.
  Type and harm must agree: a near miss or a hazard always has harm `none` and is never sentinel.
- `status`: new | triaged | in_progress | closed | rejected.
- `owner_unit_id` → org_units (the department responsible) and `assigned_to` → users, both set at triage, both optional until then.
- `triaged_by`, `triaged_at`, `closed_by`, `closed_at`, `closure_summary` text, `rejection_reason` text.
- `revision` int, starts at 1, raised by every triage and every status change and by
  nothing else (a comment does not raise it). `created_at`, `updated_at`.
- Composite foreign keys on (tenant_id, x) as the other tables do.

`incident_events` (the timeline; the application may INSERT and SELECT only)
- `incident_id`, `occurred_at`, `kind`: reported | triaged | assigned | status_changed | commented | reopened | closed | rejected,
  `actor_id` → users (NULL for an anonymous report), `from_status`, `to_status`,
  `details` jsonb, `visible_to_reporter` boolean.

`incident_comments`
- `incident_id`, `author_id` → users, `body` text, `visibility`: everyone | internal
  (internal = not shown to someone who can see the incident only because they reported it), `created_at`.

`reference_counters`
- `prefix` text, `year` int, `last_number` int, unique (tenant_id, prefix, year).

## Who may do what

Permissions already exist: `incidents.report`, `incidents.view`, `incidents.triage`.

**Scope is enforced for the first time here.** A role is granted either for the
whole organization (org_unit_id NULL) or for one org unit. A permission granted
for a unit covers that unit and every unit beneath it in the tree. So:

- The session must carry, for each permission, either "everywhere" or the set
  of org unit ids it covers (the granted units plus all their descendants).
  `permissions: string[]` in `/auth/me` stays as it is (the union), and a new
  field describes scope. Existing `requirePermission(req, p)` keeps meaning
  "has it anywhere".
- A user **sees** an incident if: they reported it; or it is assigned to them; or they
  hold `incidents.view` or `incidents.triage` covering the incident's `org_unit_id` or its `owner_unit_id`.
- The **assignee** sees all of the incident (access `full`: internal comments, every
  timeline entry, who it is assigned to) for as long as it is assigned to them, and may
  post both kinds of comment. Being assigned gives no right to triage or change status.
  Taken off the incident, they lose that access at once.
- A user may **triage / change status** if they hold `incidents.triage` covering
  the incident's `org_unit_id` or `owner_unit_id`.
- An incident a user may not see returns 404, never 403.
- Someone who sees an incident only as its reporter gets: the incident's own
  fields, timeline events with `visible_to_reporter`, and comments with
  visibility `everyone`. They may add `everyone` comments. They never see
  `internal` comments or who it was assigned to internally beyond the department name.
- An anonymous report stores no reporter. The reporter therefore cannot find
  it again afterwards; the web form must say so before they submit. Nothing
  (audit log, event, comment) may record who made an anonymous report.

## API (all under SessionGuard; validate with strict Zod; audit every change)

- `GET /incident-categories` → active categories, ordered by position. Any signed-in user.
- `POST /incidents` (needs `incidents.report`) body:
  `{ type, categoryId, orgUnitId, occurredAt, description, immediateAction?, harmLevel, anonymous, startedAt? }`
  → 201 `{ id, reference }`. Writes the `reported` event (visible to reporter).
  400 `occurred_in_future`, `occurred_too_long_ago` (before 1900), `harm_not_applicable`
  (a near miss or hazard with harm other than `none`), `unknown_category`, `unknown_org_unit`.
  `startedAt` (ISO date-time) is stored only if it lies within the 24 hours before now and
  not more than 5 minutes ahead; otherwise it is ignored, never refused: a wrong phone clock must not block a report.
- `GET /incidents?status=&mine=true&page=&pageSize=` → `{ items, total }`,
  only incidents the caller may see. `mine=true` limits to ones they reported.
  Further optional filters, all applied inside what the caller may see, with `total` to match:
  `type`, `harmLevel`, `sentinel` (true | false), `orgUnitId` (where it happened or who owns it,
  that exact unit; a unit outside the caller's view gives no rows, not an error),
  `from` and `to` (dates `YYYY-MM-DD` on the day of reporting in UTC, both included),
  `reference` (the start of a reference or all of it, any letter case), `assignedToMe=true`,
  `categoryId` (a category of another hospital gives no rows), and `channel` = `app` | `public`
  (see `incident-safeguards-and-deadlines.md`, "Decided after the second quality review").
  `sort` = `newest` (default) | `oldest` | `harm` (death first, down to none; the oldest first within a level).
  Items carry: id, reference, type, category (id + name), orgUnit (id + name),
  ownerUnit, occurredAt, reportedAt, harmLevel, isSentinel, status, assignedToMe, and a
  description excerpt of at most 140 characters. Also `access` (`full` | `reporter`, as the
  detail gives it) and `channel` (null where the caller is not told who reported).
- `GET /incidents/summary` → `{ open, awaitingTriage, closedLast30Days, assignedToMe, serious, medianSecondsToReport }`
  counted over what the caller may see. `assignedToMe`: open incidents assigned to the caller.
  `serious`: open incidents that are severe, death or sentinel. `medianSecondsToReport`: the median
  time from opening the form to sending it, over the reports of the last 30 days that carry a start time; null if none.
- `GET /incidents/:id` → the incident, `access: "full" | "reporter"`, `canTriage: boolean`,
  the reporter's name (null if anonymous), its events and its comments, filtered as above. Also:
  `revision`; `canRetriage` (may triage, and the status allows it); `moves: [{ to, noteRequired }]`,
  the status moves this caller may make now (empty without the right to triage; no `rejected` for a
  serious incident), so no screen repeats the rules; `orgUnit` and `ownerUnit` carry `active`;
  and `people`, `units`, `categories`: the names, by id, of every user, org unit and category the
  returned events' details point at, including people who have left and units and categories switched off since.
- `POST /incidents/:id/triage` (triage in scope) body
  `{ harmLevel, isSentinel, categoryId?, ownerUnitId, assignedTo?, revision? }`.
  Allowed from `new`, `triaged` (→ `triaged`) and `in_progress` (stays `in_progress`: triage stays
  possible while work is in progress); 409 `invalid_transition` from `closed` and `rejected`.
  For a near miss or a hazard: 400 `harm_not_applicable` unless harm is `none`, 400 `sentinel_not_applicable` if sentinel.
  Nothing changes without a trace: the `triaged` event's details hold `{ from, to }` for each of
  `harmLevel`, `isSentinel`, `categoryId`, `ownerUnitId` that changed (on first triage `from` is the
  reporter's value, or null for the owner). The `assigned` event (`{ ownerUnitId, assignedTo }`,
  not shown to the reporter) is written when the owner or the person changes. A triage that changes
  nothing writes nothing. `assignedTo` must be an active user of this tenant; a newly chosen owner
  unit or category must be in use, one the incident already has may stay.
  If the caller no longer sees the incident afterwards (a scoped triager handing it to a department
  outside their scope), the change stands and the answer is 200 `{ id, reference, handedOff: true }`.
- `POST /incidents/:id/status` (triage in scope) body `{ to, note?, revision? }`. Allowed moves:
  triaged → in_progress; triaged | in_progress → closed (note required, stored as closure_summary);
  new | triaged → rejected (note required, stored as rejection_reason; from `triaged` added
  after the second quality review, for a duplicate or something that is not an incident found
  at triage);
  closed | rejected → in_progress (reopen, note required). Anything else is 409 `invalid_transition`.
  A serious incident (harm severe or death, or sentinel) cannot be rejected: 409 `serious_cannot_be_rejected`;
  nor can one that has needed a second person to close it (`sign_off_needed`), whatever it is called now.
  Lowering the harm level at triage first is allowed, and leaves its trace.
- Stale decisions: when `revision` is sent to triage or status and differs from the stored one,
  the answer is 409 `stale_incident` and nothing changes. Left out, the call is not checked.
- `POST /incidents/:id/comments` body `{ body, visibility }`. Anyone who sees the
  incident may comment; a reporter-only viewer may only post `everyone`. Writes a `commented` event.

Events shown to the reporter: reported, triaged (without assignee), status changes, closed, rejected, reopened, and `everyone` comments.

## Web

- `/[lang]/incidents`: list with status filter (All, New, Triaged, In progress, Closed), a
  "Reported by me" toggle, pagination, and a "Report an incident" button. Empty, loading, error states.
- `/[lang]/incidents/new`: the report form. Fast: type (three large choices), category,
  where (org unit), when (defaults to now), what happened, what was done immediately (optional),
  harm level, and "Report anonymously" with the warning above. On success show the reference
  and links to "View it" (not for anonymous) and "Report another".
- `/[lang]/incidents/[id]`: reference, status, the report, the timeline, comments with a
  box to add one (visibility choice only for full access), and for triagers a triage panel
  and the status actions that are valid from the current status.
- Dashboard: the "Open incidents" and "Awaiting triage" tiles and the "Recent incidents"
  panel show real data. The other tiles stay as they are.
- All text in en.json, ar.json and fr.json with identical keys. Category and unit names via `pick()`.
- Dates and times are shown in the reader's language with Western digits.
