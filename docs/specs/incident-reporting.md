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
- `occurred_at` timestamptz (not in the future). `description` text (required, the
  reporter's own words, in whatever language they write). `immediate_action` text, optional.
- `reported_by` → users, NULL when reported anonymously. `reported_at`.
- `harm_level`: none | mild | moderate | severe | death. Set by the reporter,
  corrected at triage. `is_sentinel` boolean default false, set at triage.
- `status`: new | triaged | in_progress | closed | rejected.
- `owner_unit_id` → org_units (the department responsible) and `assigned_to` → users, both set at triage, both optional until then.
- `triaged_by`, `triaged_at`, `closed_by`, `closed_at`, `closure_summary` text, `rejection_reason` text.
- `created_at`, `updated_at`.
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
- A user **sees** an incident if: they reported it; or they hold `incidents.view`
  or `incidents.triage` covering the incident's `org_unit_id` or its `owner_unit_id`.
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
  `{ type, categoryId, orgUnitId, occurredAt, description, immediateAction?, harmLevel, anonymous }`
  → 201 `{ id, reference }`. Writes the `reported` event (visible to reporter).
- `GET /incidents?status=&mine=true&page=&pageSize=` → `{ items, total }`, newest first,
  only incidents the caller may see. `mine=true` limits to ones they reported.
  Items carry: id, reference, type, category (id + name), orgUnit (id + name),
  ownerUnit, occurredAt, reportedAt, harmLevel, isSentinel, status, and a
  description excerpt of at most 140 characters.
- `GET /incidents/summary` → `{ open, awaitingTriage, closedLast30Days }` counted over what the caller may see.
- `GET /incidents/:id` → the incident, `access: "full" | "reporter"`, `canTriage: boolean`,
  the reporter's name (null if anonymous), its events and its comments, filtered as above.
- `POST /incidents/:id/triage` (triage in scope) body
  `{ harmLevel, isSentinel, categoryId?, ownerUnitId, assignedTo? }` → status `triaged`
  (allowed from `new` or `triaged`). Events: `triaged`, and `assigned`.
  `assignedTo` must be an active user of this tenant.
- `POST /incidents/:id/status` (triage in scope) body `{ to, note? }`. Allowed moves:
  triaged → in_progress; triaged | in_progress → closed (note required, stored as closure_summary);
  new → rejected (note required, stored as rejection_reason);
  closed | rejected → in_progress (reopen, note required). Anything else is 409 `invalid_transition`.
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
