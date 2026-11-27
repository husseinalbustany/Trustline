# Policies and procedures: specification (first release)

Read CLAUDE.md, README.md and docs/specs/modules-and-subscriptions.md first.
This file is the agreed scope. If something here is impossible or wrong, say
so in your report rather than quietly doing something else.

Trustline's clients are any organization, not only hospitals. Write every
rule and every sentence so that it reads correctly for a factory or a school
as well as a hospital.

## What it is

One library of an organization's controlled documents. Each document goes
through the same cycle: it is drafted, reviewed, approved with a signature,
published, read and acknowledged by the people it applies to, and reviewed
again on a schedule. Old versions are kept and can always be shown.

It is the `policies` module: everything here is switched on and off with it
(see the module rules in modules-and-subscriptions.md).

The AI drafting assistant (`ai-policy-drafting.md`) is not part of this
release; this release is what it will draft into.

## Out of scope for this release (do not build)

Uploading existing Word or PDF files, attachments, quizzes, AI drafting,
translation, change requests, links between documents, standards mapping
beyond a free-text reference list, committees as approvers, delegation,
email, a document's own logo and colours (branding is a separate piece of
work), and a PDF produced by the server.

## Words used here

- **Document**: one controlled document, which keeps its number for life.
- **Version**: one edition of a document's content. A document has at most
  one published version and at most one version in progress at a time.
- **Type**: policy, procedure, or work instruction (a one-page instruction or
  checklist for one task, used where the work is done).
- **Approval route**: the ordered steps a version must pass before it is
  published.

## Data (all tenant tables, under row-level security)

The data design (architecture page, "Policies" and "Approval workflows") is
the reference; this release builds the part below.

`document_types` (per client): `code` (policy, procedure, work_instruction;
the three are created for every client, like incident categories), `name`
Localized, `number_prefix` (e.g. POL, PRC, WI), `sections` (ordered list of
`{ key, name: Localized, required: boolean }`), `default_review_months`
(policy 36, procedure 24, work instruction 12 to start; each client changes
them), `active`.

Starting sections, which each client can change:
- Policy: purpose, scope, definitions, policy statements, responsibilities,
  references.
- Procedure: purpose, scope, definitions, responsibilities, equipment and
  forms, steps, records, exceptions and escalation, references.
- Work instruction: purpose, steps, safety notes, records.

`document_categories` (per client): `code`, `name` Localized, `parent_id`,
`active`. A short starting list (governance, quality, safety, operations,
human resources, information); each client edits it.

`documents`:
- `number` text, unique per client, `<prefix>-<category code>-<3 digits>`
  (e.g. PRC-SAF-014), allocated from `reference_counters` when the document
  is created, never reused.
- `type_id`, `category_id`, `title` Localized, `owner_id` → users (the
  person accountable for it), `owner_unit_id` → org_units.
- `applies_to`: the whole organization, or a list of org units (each covers
  its descendants), optionally narrowed to roles. Stored as rows in
  `document_audiences` (`org_unit_id` or null for all, `role_id` or null).
- `confidentiality`: `all_staff` (anyone who may read documents) or
  `restricted` (only the audience and those who manage documents).
- `keywords` text[], `references` (free text list, e.g. "JCI IPSG.1",
  "ISO 45001 7.2").
- `review_months` (from the type unless set), `next_review_on` date (in the
  client's time zone), `last_reviewed_on`.
- `status`: draft (never published), active (has a published version),
  retired. `published_version_id`, `retired_at`, `retired_by`,
  `retire_reason`.
- `created_at`, `updated_at`, `revision` (as incidents, for stale-save
  protection).

`document_versions`:
- `document_id`, `version` (integer, 1, 2, 3…), `status`: draft, in_review,
  approved, published, superseded, withdrawn.
- `content` jsonb: per language, per section key, the section's text
  (`{ en: { purpose: "…", steps: "…" }, ar: { … } }`). Text is plain text
  with a small, safe markup: paragraphs, numbered and bulleted lists, bold,
  and headings inside a section. Store it as Markdown limited to those
  elements; render it with a sanitizing renderer that drops everything else
  (no HTML, no links to scripts, no images in this release).
- `change_summary` Localized (required from version 2).
- `prepared_by`, `prepared_at`; `effective_on` date (default: the day it is
  published); `published_at`, `published_by`; `superseded_at`.
- `acknowledgement_required` boolean, `acknowledge_within_days` (default 14).
- `revision`.

Languages: a version must have every required section in the client's
default language before it can be sent for review. Other languages are
optional; when one is missing a reader sees the default language with a
plain note.

### Approval routes (built generically, to be reused by investigations and others)

`approval_routes` (per client): `name` Localized, `subject` (`document`
today), `document_type_id` (optional: the route for that type), `active`.
Each client starts with one route per type: one review step, then one
approval step.

`approval_route_steps`: `route_id`, `position`, `kind` (review, approve),
`assignee` one of: a named user, a role (anyone holding it over the
document's owning unit), or the document's owner unit head (later; leave
out now), `required` (how many people of a role must act; 1 for now),
`due_in_days`.

`approval_runs`: `route_id`, `subject_type` (`document_version`),
`subject_id`, `status` (in_progress, approved, returned, cancelled),
`current_position`, `started_by`, `started_at`, `completed_at`.

`approval_run_steps`: `run_id`, `position`, `kind`, `assignee` (as the route
step, copied at start so a later route change does not alter a run in
progress), `status` (waiting, pending, approved, returned, skipped),
`due_at`, `decided_by`, `decided_at`, `comment`, `signature_id`.

`signatures`: `user_id`, `signed_at`, `meaning` (reviewed, approved,
reviewed_no_change, acknowledged), `subject_type`, `subject_id`,
`content_hash` (a hash of the version's content and metadata as signed),
`method` (`password` in this release). A signature is written only after the
user re-enters their password in the same request; it is never edited or
deleted.

### Periodic review and acknowledgement

`document_reviews`: `document_id`, `due_on`, `outcome` (no_change, revised,
retired), `comment`, `reviewed_by`, `reviewed_at`, `signature_id`,
`next_review_on`.

`document_acknowledgements`: `version_id`, `user_id`, `assigned_at`,
`due_on`, `acknowledged_at`, `signature_id`, `reminded_at`. Created when a
version that requires acknowledgement is published, one row per active user
in its audience at that moment; users who join the audience later are
added by the daily check.

## Who may do what

Existing permissions, plus two new ones:

- `policies.view`: read published documents that are `all_staff`, and
  restricted ones whose audience includes the reader.
- `policies.manage`: create documents and versions, edit drafts, send for
  review, publish once approved, run periodic reviews, retire; manage
  document types, categories and approval routes. Scope applies: a holder
  scoped to a unit manages documents owned by that unit and below.
- `policies.approve` (new): may be named in a route step by role. Being
  assigned a step gives the right to see that version and decide that step,
  nothing else.
- `policies.view_all` (new): read every document including restricted ones
  and drafts, and see acknowledgement figures. For the quality team and
  auditors.

Built-in roles: Administrator and Quality officer get all four; Department
manager gets view, approve and view_all over their unit; Reporter keeps view.
Existing clients get the new permissions on their built-in roles by
migration, audited, as was done for sign-off.

Rules:
- The person who prepared a version cannot approve it (403 `same_person`).
  They may be a reviewer only if the route says so explicitly (not in this
  release: refuse).
- A step can be decided only by an assignee, in order: the step must be the
  current one.
- Every decision, publish, review and acknowledgement is audited, and every
  approval, review sign-off and acknowledgement is a signature.
- Drafts and in-review versions are visible only to those who manage the
  document, the assignees of its current run, and `policies.view_all`.
- Nothing is ever deleted: a document is retired, a version is withdrawn or
  superseded.

## The cycle

1. **Draft.** A manager creates a document (type, category, title, owner,
   owning unit, audience, confidentiality, review period) and its version 1,
   or a new version of an active document (copied from the published one).
   Sections come from the type. Saving a draft writes no event to readers.
2. **Send for review.** Checks: every required section in the default
   language; a change summary from version 2. The route for the document's
   type starts; the first step's assignees are notified.
3. **Review and approve.** Each step's assignee reads the version (with a
   view of what changed from the published version, section by section) and
   either approves (with password re-entry; a signature is written) or
   returns it with a comment (required). Returning ends the run; the
   version goes back to draft with the comments shown. Approving the last
   step makes the version `approved`.
4. **Publish.** A manager publishes an approved version, now or on a future
   effective date (the daily check publishes it that day). The previous
   published version becomes `superseded`. The document's next review date
   is set from the effective date. If acknowledgement is required, the
   audience is assigned and notified.
5. **Read.** Readers see the published version in their language, with its
   control block (number, version, owner, effective date, next review date,
   approvals with names and dates) and a line "Printed copies are not
   controlled. Check Trustline for the current version." when printed.
   Older versions are reachable from the history for those allowed.
6. **Acknowledge.** A reader in the audience confirms "I have read and
   understood this document" (signature, password re-entry). Reminders at
   half the allowed time and when overdue. Managers see who has and has not
   acknowledged, by unit.
7. **Periodic review.** Owners are notified 60, 30 and 7 days before the
   next review date (the days configurable per client later; fixed now). An
   overdue review is marked. The owner either confirms no change (signature;
   the next review date moves on; a `document_reviews` row), starts a new
   version, or asks to retire (a manager retires with a reason).
8. **Retire.** The document leaves the library for readers; it stays in the
   history for those allowed, with its versions.

## API (under `/api/v1`, SessionGuard, `@ForModule('policies')`, strict Zod, audited)

Write the routes yourself following the incident API's conventions (lists
with filters and `{ items, total }`, detail with `revision`, `moves`-style
lists of allowed actions so the screens hold no copy of the rules, 404 for
anything the caller may not see, 409 `stale_*` on a revision mismatch). The
minimum:

- Library: list with search (number, title in any language, keywords,
  section text), filters (type, category, owning unit, status, review due or
  overdue, "applies to me", "awaiting my acknowledgement"), sort (number,
  title, next review, recently published).
- Document: create, edit metadata, history of versions, retire.
- Version: create (new or from published), edit sections, send for review,
  read with a section-by-section comparison to the published version.
- Approval: my pending steps; approve with password; return with comment.
- Publish (now or on a date).
- Acknowledge with password; acknowledgement status per version (counts and
  per-person list, for those allowed).
- Periodic review: confirm no change with password; list of reviews due.
- Settings: document types (sections, prefix, default review months),
  categories, approval routes and their steps.
- Summary for the dashboard: documents past review, due within 30 days,
  awaiting my approval, awaiting my acknowledgement, acknowledgement
  completion for the last published versions.

Password re-entry: the body carries `password`; it is checked like sign-in
(including the lockout counter), never logged, and a wrong password answers
401 `wrong_password` without ending the session.

Notifications (in-app, through the existing notifications, mapped to the
`policies` module): step assigned to you, version returned to its preparer,
version approved (to its preparer and the document's managers), published
(to the audience when acknowledgement is required), acknowledgement due and
overdue, review due (60/30/7 days) and overdue. The daily check (beside the
incident deadline check, with the same safety for several processes and the
per-client limit list) handles scheduled publishing, review reminders and
acknowledgement reminders.

## Web

- Sidebar: "Documents" (the policies module), with the library, "Awaiting
  me" (approvals and acknowledgements), and for managers the settings pages.
- Library: search box, filters, rows with number, title, type pill, owner
  unit, version, effective date, review state (due, overdue) and, for the
  reader, an "Acknowledge" mark when due.
- Document page: the published version laid out as a controlled document
  (control block, sections in order, headings numbered), language switch
  among the languages the version has, history, and for managers the
  actions the API allows.
- Editor: one field per section from the type, in each of the client's
  languages (tabs per language, default language first), with the small
  markup toolbar (paragraph, list, bold, heading) and a live preview; save
  draft; send for review. Required sections are marked.
- Review screen: the version with changes since the published one marked
  section by section; approve (password prompt) or return (comment).
- Acknowledge: a clear "I have read and understood" with password prompt,
  after the document has been opened.
- Print view: the document in the client's layout for printing, with the
  "printed copies are not controlled" line, in the reader's language.
- Dashboard tiles (policies module): past review, awaiting my approval,
  awaiting my acknowledgement.
- Settings: document types (sections, prefix, review period), categories,
  approval routes (steps with kind, assignee, days).
- All wording in the three dictionaries; neutral for any organization.

## Measures the business named

"Policies past their review date: under 5%" and "Policy acknowledgement
completion: 90% or more of targeted staff". The summary route must produce
both, over what the caller may see, and the dashboard shows them to those
allowed.
