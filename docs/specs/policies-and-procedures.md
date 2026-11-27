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
  current one. Each step of a run is decided by a different person
  (decided after the fifth security review).
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

## Built: database and API

Status: the database and the API are built (migrations 0038 to 0041,
`apps/api/src/policies/`, `apps/api/src/approvals/`). The web screens are
not. What was decided where this document left it open is marked
**Chosen**; the full request and response shapes are below.

### Where the code is

- `src/approvals/`: the approval engine (routes, runs, steps, who an
  assignee is) and electronic signatures, generic. It knows nothing of
  documents and has no routes of its own: the document code calls it and
  tells it the subject's owning unit and the permission an assignee needs
  (`policies.approve`). Investigations will call it the same way.
- `src/policies/`: documents, versions, publishing, acknowledgement,
  periodic review, settings, the daily check (`policy-check.service.ts`),
  and who sees what (`visibility.ts`, written once for every list, count,
  search, lookup and notification).

### Who sees and does what

- **Chosen: scope.** `policies.manage` and `policies.view_all` are scoped
  to the document's owning unit (granted for the whole organization, for
  that unit or for one above it). `policies.view` is not: held anywhere, it
  reads every published document open to all staff. Types, categories and
  routes belong to the whole organization: changing them needs
  `policies.manage` for the whole organization.
- **Full sight** (every version, drafts, history, reviews, acknowledgement
  figures): `policies.manage` or `policies.view_all` over the owning unit.
- **Readers** see the published version of an active document: all staff
  for `all_staff`, the audience for `restricted`. **Chosen:** the
  document's owner always reads its published version, whatever its
  confidentiality, and is told of its reviews; and the owner may confirm a
  review with no change (as may a manager of it). Readers do not see older
  versions: the history shows them the published version only.
- **Assignees** of any step of an approval run in progress on a version
  see the document, that version and, **chosen**, the published version it
  is compared with (the comparison needs it). Nothing else, and nothing once
  the run has ended.
- A retired document is seen only with full sight.
- **Chosen: the audience.** A person is in a document's audience when their
  own unit (`users.org_unit_id`) is one of the audience's units or beneath
  one (or the audience is the whole organization), and, if the audience is
  narrowed to roles, they hold one of those roles anywhere; and they hold a
  permission that reads documents at all. A person with no unit of their
  own is in whole-organization audiences only.
- Searching section text searches only versions the caller may open.
  Notifications name the document's number and a version or a day, never
  its title or text; the list adds the title only while the reader can
  open it (`document.canOpen`).

### The approval engine

- **Chosen: assignees.** A step names a person or a role. A role may be
  named only if it includes `policies.approve` (400
  `role_cannot_approve`); a person only if they are active and hold
  `policies.approve` somewhere (400 `user_cannot_approve`). Who may decide
  a step is worked out when it is decided: the person named, if they still
  hold it; or everyone holding the role over the owning unit, if the role
  still includes it.
- **Chosen: the starting route** of each type: review by the Quality
  officer role, then approval by the Administrator role (every client has
  one from its first day), seven days each. The last step of a route must
  be an approval (400 `last_step_must_approve`). At most one active route
  per type, and one for "any type" (409 `route_exists`).
- A run copies the route's steps when it starts; changing a route changes
  nothing for a run in progress.
- **Chosen: the same-person rule** covers everyone who created, edited or
  sent the version for review (`document_versions.contributors`), for
  every step, review or approval (403 `same_person`, `reason: "prepared"`).
  A new version started from a version that was never published (one
  withdrawn) holds its writers' text, so it keeps that version's
  contributors; one started from the published version starts with
  whoever started it only.
- **Decided: one person, one step.** Within one run each step is decided
  by a different person: someone who decided an earlier step of the run,
  for instance holding both the Quality officer and the Administrator
  roles, may not decide a later one (403 `same_person`, `reason:
  "decided_earlier_step"`; the version's `myStep.samePerson` is true and
  `approve` and `return` are not in its `moves`; the step is not in their
  `GET /approvals`, and they are not notified of it).
- Sending for review is refused when the steps cannot be covered by
  different people other than the contributors (409 `no_assignee` with the
  `position` of the first step left without anyone), so a run cannot be
  started that can never end. A route that names one person for two
  steps is refused this way at its second step; a route whose first step
  is a role and whose second names one of its holders is accepted, since
  another holder can take the first.
- Two people deciding the same step at once take turns on the document's
  row lock: one decides it, the other is answered 409 (`stale_version`).
- **Chosen:** a manager may **recall** a version in review (back to draft,
  run cancelled) and **withdraw** a version in progress. Not in the list
  above, but without them a run whose assignees have left could never end.
- Step due dates are stored and shown (`dueAt`, `overdue`); nothing is
  sent when a step is overdue (not in this release's list of
  notifications).

### Signatures

- Every approval, review sign-off and acknowledgement takes the password
  again in the same request. It is checked as sign-in checks it: the same
  counter of wrong passwords and the same 15-minute lock after five, shared
  with sign-in. Wrong: 401 `{ code: "wrong_password" }`; while locked
  (whatever was typed): 401 `{ code: "password_locked" }`. Neither ends the
  session. A failure is audited as `password_confirmation_failed` with
  `{ locked, purpose }`; the password is never stored, logged or audited.
  Everything else is checked before the password, so a request refused
  for another reason neither asks for it nor counts it.
- `signatures` holds who, when, the meaning (`reviewed` for a review step,
  `approved` for an approval step, `reviewed_no_change`, `acknowledged`),
  the subject, `method: "password"`, and `content_hash`: SHA-256 (hex) of
  the canonical JSON (keys sorted) of what was signed. For a version:
  `{ documentId, number, versionId, version, sections, content,
  changeSummary, acknowledgementRequired, acknowledgeWithinDays }`, shown on
  the version as `contentHash`. **Chosen:** the title is not in it: it is
  the document's, edited on its own, and kept while it is on its way (see
  "Editing a document" below). Publishing, scheduling and the daily check
  on the scheduled day check that every step of the approving run is
  approved by the person whose signature it holds, of what the version
  holds now (409 `content_changed`, which no route can bring about; the
  daily check leaves such a version approved, unpublished, and names it
  and its client in the log).
- The application role may insert and read signatures, never update or
  delete them (migration 0039). Reviews are insert-only too.
- **The database keeps what is signed** (migration 0041), whoever writes:
  outside draft, a version's text, sections, change summary and
  acknowledgement settings, and its document and number, are refused
  (`document_versions_signed_text_fixed`); its status goes only draft →
  in review or withdrawn, in review → draft, approved or withdrawn,
  approved → published or withdrawn, published → superseded
  (`document_versions_status_order`). Of a run's step the application role
  may update only its status, times and decision; a decided or skipped
  step never changes, and only a pending step's decision writes who and
  the signature (`approval_run_steps_decided_fixed`,
  `approval_run_steps_status_order`,
  `approval_run_steps_decision_complete`). A document's published version
  is one of its own versions (`documents_published_version_own_fk`).

### Content

- Markdown limited to paragraphs, headings of levels 1 to 3, bulleted and
  numbered lists (nested by indenting) and bold. Refused with 400
  `unsupported_markup` (`locale`, `section`, `problem`): HTML tags and
  comments and autolinks (`html`), links of any form (`link`), including a
  label's definition (`[x]: …`) wherever it stands, in a list item or
  under a heading; bare web addresses (`http://`, `https://`, any
  `scheme://`, `www.`: `web_address`) and e-mail addresses
  (`email_address`), which a renderer could link by itself; images
  (`image`), code spans and blocks (`code`, `indented`), block quotes
  (`quote`), tables (`table`), headings of level 4 and deeper
  (`heading_level`), and control characters as elsewhere
  (`control_character`). "Less than < 5" is text. The API stores the text
  and never renders HTML.
- **Chosen: sizes.** 20,000 characters a section in one language (400
  `section_too_long`), 200,000 for the version in all languages together
  (400 `content_too_large`). A request body is at most 100 kB, so a long
  version is saved a few sections at a time.
- **Chosen:** a version keeps the sections its type had when it was
  created; a later change of the type counts for new versions.
- The comparison with the published version is section by section and
  language by language, with whether it changed and the lines kept, added
  and removed. **Chosen: its cost is bounded.** The lines a section starts
  and ends with in both are set aside; what is left is compared line by
  line up to 250,000 cells (lines before times lines after), and up to
  2,000,000 over the whole version; beyond, it is shown removed then
  added.

### Numbering, defaults and dates

- `<prefix>-<category code>-<n>`, at least three digits (more past 999),
  from `reference_counters` (series = the text before the number, year 0).
  Two at once queue on the counter's row; a number is never given twice.
  **Chosen:** a category's code is fixed once created (it is in every
  number); a type's prefix may change and numbers documents from then on.
- Types, categories and routes are created for every new client
  (`ensurePolicyDefaults`) and were given to existing ones by migration
  0039, in English, Arabic and French. Migration 0039 also gave the
  built-in Administrator, Quality officer and Department manager of every
  existing client `policies.approve` and `policies.view_all`, with one
  audit entry per client (`built_in_roles_changed_by_system`).
- Every day is a day on the client's calendar. The next review is the
  effective day plus the review period (a missing day becomes the month's
  last); confirming a review counts from the day it is confirmed.
- **Chosen:** publishing a new version of an active document records the
  periodic review as answered by a revision (`document_reviews`,
  `revised`); retiring an active one records `retired` with the reason.
- **Chosen:** a document's metadata (title, owner, owning unit, audience,
  confidentiality, keywords, references, review period, category) is
  edited directly, audited, not through a version. Its type cannot change.
- **Decided: editing a document** while a version is on its way. Its
  owning unit, which decides who may decide a role's step, may not change
  while a version is in review (409 `in_review`). Its title, which the
  approvers were shown, may not change while a version is in review (409
  `in_review`) or approved and not yet published (409
  `awaiting_publication`). Each answer has the `field` (`ownerUnitId`,
  `title`) and the `version`. Sending the same value again is no change
  (a title is the same whatever order its languages come in). The title
  of a published document with no version on its way may change, audited
  as any edit.

### Acknowledgement

- Asked of everyone in the audience when the version is published (one row
  each, due after `acknowledgeWithinDays` days), and by the daily check of
  anyone who joins the audience later. Someone in the audience who has not
  been asked yet may acknowledge already.
- **Chosen: who is targeted** for the completion measure: everyone asked to
  acknowledge the published version of an active document who is still an
  active user. Someone who left the audience after being asked stays
  counted.
- Reminders: at half the time allowed (the due day less half the days,
  rounded down) and the day after the due day, each once.

### The daily check

- Beside the incident deadline check and built the same way: every API
  process may run it, each thing is claimed by a row lock and marked in the
  transaction that writes its notifications, batches of 100, pieces of at
  most 1,000 rows per statement, no statement longer than 30 seconds, a
  client that fails is named in the log with the kind of failure only, and
  `run(now, only)` lets a test name its own clients.
- **Chosen:** it runs every 15 minutes (the days are each client's own, so
  a client's midnight comes at a different moment for each), and does each
  thing once whatever the number of runs. It skips a client without the
  module, suspended by Trustline or cancelled; what came due meanwhile is
  done once when it is back.
- Review reminders go to the owner at 60, 30 and 7 days, and when overdue
  to the owner and the document's managers; once per review date, and a
  document found later than a stage is sent the latest stage only.

### Subscription status

- While suspended, every write of the module is refused (403
  `subscription_suspended`) except acknowledging, which stays open
  (`@OpenWhileSuspended()`): agreed, it is safety work, and changes nothing
  anyone else relies on. The daily check keeps running for a suspended
  subscription (only a client Trustline suspended, or a cancelled one, is
  skipped), so scheduled publishing and reminders go on.

### Not built in this release

- The owner asking a manager to retire a document: there is no route; the
  owner tells a manager, who retires it.
- Notifications for an overdue approval step.
- The owner unit head as an assignee, and `required` other than 1, as the
  spec says.

### The API (under `/api/v1/policies`)

Every route: session (401 without), `@ForModule('policies')` (404 like an
unknown route when the module is off), strict bodies (400 on anything
else), 404 for a record of another client or one the caller may not see.
`revision` is required on every change and answered 409 `stale_document`,
`stale_version` or `stale_route` when out of date. Writes are audited.

| Route | Who | Body / query | Answers |
|---|---|---|---|
| `GET /documents` | any policies permission | `q`, `typeId`, `categoryId`, `ownerUnitId`, `status`, `review=due\|overdue`, `appliesToMe`, `awaitingMyAcknowledgement`, `sort=number\|title\|next_review\|recently_published`, `page`, `pageSize` | `{ items, total }` |
| `POST /documents` | `policies.manage` over `ownerUnitId` | `typeId, categoryId, title, ownerId, ownerUnitId, audience?, confidentiality?, keywords?, references?, reviewMonths?, acknowledgementRequired?, acknowledgeWithinDays?` | 201 document |
| `GET /documents/:id` | any | | document |
| `PATCH /documents/:id` | manager | metadata fields, `revision` | document |
| `POST /documents/:id/retire` | manager | `reason, revision` | document |
| `POST /documents/:id/review` | owner or manager | `password, comment?, revision` | document |
| `GET /documents/:id/versions` | any | | `{ versions, reviews }` |
| `POST /documents/:id/versions` | manager | `{}` | 201 version |
| `GET /documents/:id/versions/:versionId` | any | | version |
| `PATCH /documents/:id/versions/:versionId` | manager | `content?, changeSummary?, acknowledgementRequired?, acknowledgeWithinDays?, revision` | version |
| `POST …/submit` | manager | `revision` | version |
| `POST …/approve` | `policies.approve`, assignee | `password, comment?, revision` | version |
| `POST …/return` | `policies.approve`, assignee | `comment, revision` | version |
| `POST …/recall` | manager | `revision` | version |
| `POST …/withdraw` | manager | `reason?, revision` | version |
| `POST …/publish` | manager | `effectiveOn?, revision` | version |
| `POST …/acknowledge` | reader in the audience | `password` | `{ versionId, acknowledgedAt, signature }` |
| `GET …/acknowledgements` | full sight | `state?, page, pageSize` | counts, `byUnit`, `people` |
| `GET /approvals` | `policies.approve` | | `{ items, total }` |
| `GET /reviews` | any | | `{ items, total }` |
| `GET /summary` | any | | counts and the two measures |
| `GET /people` | `policies.manage` | `q?, approvers?` | `[{ id, name, orgUnitId }]` |
| `GET /types`, `GET /categories` | any (`includeInactive` for managers) | | list |
| `POST/PATCH /types`, `/categories` | `policies.manage` everywhere | | the record |
| `GET /approval-routes` | `policies.manage` | | list with steps |
| `POST/PATCH /approval-routes` | `policies.manage` everywhere | `name, documentTypeId, active?, steps[{ kind, userId \| roleId, dueInDays }], revision` (PATCH) | the route |

Each document and version carries `moves`, the actions the caller may take
now: on a document `edit`, `new_version`, `retire`, `confirm_review`; on a
version `edit`, `submit`, `recall`, `publish`, `withdraw`, `approve`,
`return`, `acknowledge`.
