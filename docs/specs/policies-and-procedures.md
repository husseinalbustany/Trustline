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
plain note. **Decided (quality review 2, C1):** this is per section, not
per version: a section with no text in the reader's language shows the
authoritative language's text there, with a note; a section changed in the
authoritative language since the previous published version but not in
another is flagged "translation not updated", at review and to readers.
**Decided (business decision 3):** each client chooses its authoritative
language (a document setting, by default its main language);
`authoritativeLocale()` in `src/policies/languages.ts` is the one place
that says which it is. See "Built: decisions 1 to 3".

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
**Decided (business decision 2):** a fifth, Approving authority, gets view,
view_all and approve.
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

Status: the database and the API are built (migrations 0038 to 0045,
`apps/api/src/policies/`, `apps/api/src/approvals/`), and so are the web
screens (`apps/web/src/components/policies/`). What was decided where this
document left it open is marked **Chosen**; the full request and response
shapes are below. What changed after the second quality review and
language review 6 is in "After quality review 2", and what the business
then decided in "Built: decisions 1 to 3", at the end.

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
- **Chosen, then decided (business decision 2): the starting route** of
  each type: review by the Quality officer role, then approval by the
  Approving authority role, seven days each (the Administrator until
  migration 0045). The last step of a route must
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
  steps is refused when it is saved (400 `same_person_in_two_steps`, with
  the `userId` and the `positions`), and one saved so before that rule at
  sending, at its second step; a route whose first step is a role and
  whose second names one of its holders is accepted, since another holder
  can take the first.
- Two people deciding the same step at once take turns on the document's
  row lock: one decides it, the other is answered 409 (`stale_version`).
- **Chosen:** a manager may **recall** a version in review (back to draft,
  run cancelled) and **withdraw** a version in progress. Not in the list
  above, but without them a run whose assignees have left could never end.
- Step due dates are stored and shown (`dueAt`, `overdue`). **Decided
  (C8):** a step past its due time is reported once to the document's
  managers by the daily check (`document_step_overdue`).

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
  daily check leaves such a version approved, unpublished, names it and
  its client in the log, and, **decided (D10)**, tells the document's
  managers once: `document_publish_failed`).
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
  version is saved a few sections at a time (2 MB on the import routes
  only: see "Built: decisions 1 to 3").
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
  counted. **Decided (C6):** only acknowledgements whose due date has
  passed count, in the targeted and the acknowledged alike
  (`basis: "due_date_passed"`); the figure over everyone asked, due or
  not, is given beside it as `live`.
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
  anyone else relies on. **Decided (D11):** publishing an approved version
  (now or on a later day) and retiring a document stay open too: a
  corrected procedure goes in force, an unsafe one is taken from readers.
  `moves` offers only these while suspended (`publish`, `retire`,
  `acknowledge`). The daily check keeps running for a suspended
  subscription (only a client Trustline suspended, or a cancelled one, is
  skipped), so scheduled publishing and reminders go on.

### Not built in this release

- The owner asking a manager to retire a document: there is no route; the
  owner tells a manager, who retires it.
- Email: built since, by decision 4 (`email.md`); the weekly digest of
  overdue acknowledgements is emailed to the managers it is written for.
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
| `PATCH /documents/:id` | manager | metadata fields, `reason?` (required when `reviewMonths` changes), `revision` | document |
| `POST /documents/:id/retire` | manager (open while suspended) | `reason, revision` | document |
| `POST /documents/:id/review` | owner or manager | `password, comment, revision` | document |
| `GET /documents/:id/changes` | full sight | `page, pageSize` (50, at most 200) | `{ items, total }`, newest first |
| `GET /documents/:id/versions` | any | | `{ versions, reviews }` |
| `POST /documents/:id/versions` | manager | `{}` | 201 version |
| `GET /documents/:id/versions/:versionId` | any | | version |
| `PATCH /documents/:id/versions/:versionId` | manager | `content?, changeSummary?, acknowledgementRequired?, acknowledgeWithinDays?, revision` | version |
| `POST …/submit` | manager | `revision` | version |
| `POST …/approve` | `policies.approve`, assignee | `password, comment?, revision` | version |
| `POST …/return` | `policies.approve`, assignee | `comment, revision` | version |
| `POST …/recall` | manager | `revision` | version |
| `POST …/withdraw` | manager | `reason, revision` | version |
| `POST …/publish` | manager (open while suspended) | `effectiveOn?, revision` | version |
| `POST …/acknowledge` | reader in the audience | `password` | `{ versionId, acknowledgedAt, signature }` |
| `GET …/acknowledgements` | full sight | `state?, includeLeft?, page, pageSize` | counts, `byUnit`, `people` |
| `GET …/acknowledgements/export` | full sight | `locale?` | CSV file |
| `GET /exports/documents` | any | the library's filters and `sort`, `locale?` | CSV file |
| `GET /acknowledgements/overdue` | `policies.manage` or `policies.view_all` | `page, pageSize` | `{ today, items, total }` |
| `GET /approvals` | `policies.approve` | | `{ items, total }` |
| `GET /reviews` | any | | `{ items, total }` |
| `GET /summary` | any | | counts and the two measures |
| `GET /people` | `policies.manage` | `q?, approvers?` | `[{ id, name, orgUnitId }]` |
| `GET /types`, `GET /categories` | any (`includeInactive` for managers) | | list, each with `revision` |
| `POST/PATCH /types`, `/categories` | `policies.manage` everywhere | PATCH: `revision` (409 `stale_type`, `stale_category`) | the record |
| `GET /roles` | `policies.manage` | | `[{ id, code, name, isSystem, approves }]` |
| `GET /settings` | any | | `{ maxReviewMonths, authoritativeLocale, authoritative, revision }` |
| `PATCH /settings` | `policies.manage` everywhere | `maxReviewMonths?, authoritativeLocale?, revision` | as `GET`, with `versionsInProgress` when the authoritative language changed |
| `POST /documents/import` | `policies.manage` everywhere | an import document and `password` | 201 document |
| `POST /imports` | `policies.manage` everywhere | `password, documents` | 201 batch |
| `POST /imports/check` | `policies.manage` everywhere | `documents` | what each would be |
| `GET /approval-routes` | `policies.manage` | | list with steps |
| `POST/PATCH /approval-routes` | `policies.manage` everywhere | `name, documentTypeId, active?, steps[{ kind, userId \| roleId, dueInDays }], revision` (PATCH) | the route |

Each document and version carries `moves`, the actions the caller may take
now: on a document `edit`, `new_version`, `retire`, `confirm_review`; on a
version `edit`, `submit`, `recall`, `publish`, `withdraw`, `approve`,
`return`, `acknowledge`.

## After quality review 2 (and language review 6)

What the lead decided from the second quality review
(`quality-policies.md`, "Being fixed now") and language review 6, as the
API builds it. Migrations 0042 (schema) and 0043 (grants, and the new
starting wording for existing clients). Each new route answers 401 without
a session, 403 without its permission, 404 for a record of another client
or one the caller may not see, and 400 for anything but its strict input.

### Languages (C1)

- Every version carries `languageStatus`, for anyone who may read it:
  `{ authoritative, comparedWith: { id, version } | null, sections: [{
  key, locales: { <locale>: state } }], byLocale: { <locale>: { written,
  fallback, lagging, empty } }, lagging }`. A state is `written` (text in
  that language), `fallback` (none there, the authoritative text is shown
  with a note), `lagging` (changed in the authoritative language since the
  previous published version, not in this one: "translation not
  updated"), or `empty` (no text there nor in the authoritative language).
  `comparedWith` is the version published before this one: for a version
  in progress, the one in force; for a published or superseded one, the
  one it replaced.
- `languages` lists the authoritative language first.

### Review rounds (earlier rounds; comparison with what was returned)

- Sending for review keeps what the version holds (`document_review_rounds`,
  one per run, insert-only): what its reviewers read, since the database
  keeps a version in review from changing.
- A version carries `rounds`: every run, newest first, as `run` is shaped,
  with `snapshot` (whether what it held is kept; runs from before 0042 have
  none). For those who see runs: full sight, and the assignees of the run
  in progress. `run` and `returned` stay as they were.
- `sinceReturned`, for a version in progress whose latest returned run has
  a snapshot: `{ runId, returnedAt, changeSummaryChanged, comparison }`,
  `comparison` shaped as `comparison` (against the published version) but
  against what the version held when it was returned.

### The control block and printing (C3, as far as the API goes)

- `today` (the client's day) on a document and a version, for "printed on
  <date>, valid on that day only".
- `control` adds `title`, `status`, `documentStatus`, `preparedBy`
  (language decision 4) and `inForce`: the published version of an active
  document on or after its effective day, the one copy a print may call
  controlled. The current version of a document is always
  `GET /documents/:id` (`published`), which is what a QR code opens.
- `source` on a version: `written`, or `imported` (decision 1, below);
  `ai_drafted` is for later. Not part of what an approval signs.

### Exports (C5)

- CSV, UTF-8 with a byte-order mark, every cell quoted, CRLF lines, and
  every cell that a spreadsheet would run as a formula (starting, after
  any spaces, with `=`, `+`, `-`, `@`, their full-width forms, the small
  `﹢` (U+FE62) and `﹦` (U+FE66), `|`, a tab or a carriage return, or with
  an invisible mark that can hide one: the direction marks U+200E, U+200F
  and U+061C, or the zero-width space U+200B) given a leading apostrophe. `Content-Disposition:
  attachment`, `Cache-Control: no-store`. Headings and values (statuses,
  yes and no) in the caller's language: `locale` if given (one of the
  client's, 400 `language_mismatch` otherwise), else their own language if
  the client has it, else the client's default (`export-wording.ts`).
  Names and titles in that language, else the default. At most 50,000
  rows. Every export is audited (`documents_exported`,
  `acknowledgements_exported`). The audit entry of the library's export
  keeps its filters but not the search text, which may name a person and
  would be kept for ever: only `search: { used, length }`.
- `GET /exports/documents`: the library as the caller sees it (the same
  `visible()` and filters as `GET /documents`, every page): number, title,
  type, category, responsible area, owner, status, who can read it,
  version in force, in force from, next review, periodic review state,
  last reviewed, review period, acknowledgement asked, and, for documents
  the caller sees in full, the version in progress and its status.
- `GET /documents/:id/versions/:versionId/acknowledgements/export`: full
  sight only (403 `missing_permission` otherwise). Any version of the
  document, superseded included, and everyone asked, those no longer
  active included and marked: document number, version and its status,
  person, employee number, their area, account (active, no longer active,
  invited), asked on, due on, where it stands, acknowledged at (the
  client's time), and the fingerprint of what was signed. The employee
  number is filled in only for the people whose accounts the caller
  manages (`users.manage` covering the person's unit), and left empty for
  everyone else: full sight of a document is not sight of the staff
  register.
- On screen, `GET …/acknowledgements?includeLeft=true` lists those no
  longer active too (`left: true`, `account`); the counts stay over active
  people.

### Measures (C6)

See "Acknowledgement" above: only acknowledgements past their due date.

### Review periods, reasons and the history of a document (C7)

- `document_settings` (one row per client once it changes anything):
  `maxReviewMonths`, 36 by default. `GET /settings` for any user of the
  module, `PATCH /settings` for `policies.manage` everywhere (409
  `stale_settings`; 409 `type_exceeds_max` with the `types` whose own
  period is longer: lower those first). Audited
  (`document_settings_updated`).
- A document's review period, on creating it (its own or its type's) or
  changing it, and a type's period, are refused past the maximum (400
  `review_period_too_long`, with `max`), as is switching a type back on
  whose period is past a maximum lowered while it was off (lower it in
  the same `PATCH`). Checking a type's period holds the maximum
  (`for share`) until the change is written, so the two cannot cross. A document set longer before the
  maximum was lowered keeps its period until it is next changed.
- Changing a document's review period needs `reason` in the same `PATCH`
  (400 `reason_required`, `field: "reviewMonths"`); the reason is kept in
  the audit entry.
- `GET /documents/:id/changes` (full sight; 403 for anyone else who may
  see it): the audit entries `document_updated`, newest first, a page at a
  time (`page`, `pageSize`: 50 by default, at most 200), with `total` the
  number of every change, not of the page: `{ id, at,
  by, reason, changes: [{ field, from, to }] }`, `field` one of `title`,
  `category`, `owner`, `ownerUnit`, `audience`, `confidentiality`,
  `reviewMonths`, `nextReviewOn`, `keywords`, `references`, with people,
  units, categories and roles named as they are now.
- A periodic review's `comment` is required, as is a withdrawal's
  `reason`.

### Reaching someone (C8, D10)

- The daily check reports an approval step past its due time once to the
  document's managers (`document_step_overdue`), and a scheduled version
  left unpublished because its signatures no longer match once to them
  (`document_publish_failed`). Each is claimed in `policy_reminders`
  (insert-only, one row per thing sent once) in the transaction that
  writes the notification.
- **Weekly digest** (`acknowledgements_overdue_digest`): from the first run
  of each ISO week on the client's calendar, every manager of the units
  whose people have acknowledgements overdue (on the version in force of
  an active document) is told how many (`data: { overdue, people, week }`),
  once that week. **Chosen:** a person's managers are whoever holds
  `policies.manage` or `policies.view_all` through a grant for the
  person's unit or one above it (a grant for a unit, not for the whole
  organization); where there is none, or the person has no unit, those
  who hold `policies.manage` for the whole organization. The digest is
  about no one document (`document_id` null) and names no document or
  person. It leads to `GET /acknowledgements/overdue`: the overdue
  acknowledgements of the people in the caller's reach (`policies.manage`
  or `policies.view_all`), most overdue first, each `{ user, orgUnit,
  document: { id, number, title, canOpen }, version, dueOn, daysOverdue }`.
  A row of a document the caller may not open has `document: null` and
  `version: null`: nothing of the document, not its number or id, only the
  person, the due date and its place in `total`; within a day such rows
  come after the others, in no order of theirs. In the app only
  until the mail decision.

### Notifications

- Every notification about a version carries `versionId` in `data` beside
  `version`: step assigned, returned, approved, published, acknowledgement
  asked, due and overdue, step overdue, publishing failed.

### Settings and routes

- Types and categories carry `revision`; a `PATCH` gives the revision read
  (409 `stale_type`, `stale_category`).
- `GET /roles` for `policies.manage`: the client's roles by name, with
  `approves` (whether a step may name it), without needing `users.manage`
  or `roles.manage`.

### Starting wording (language review 6)

- `defaults.ts` words the procedure's and work instruction's steps «خطوات
  العمل» / « Déroulement », exceptions and escalation « Exceptions et
  procédure d’alerte », safety notes «تنبيهات السلامة», policy statements
  « Dispositions », and the INF category "Information management" /
  «إدارة المعلومات» / « Gestion de l’information ». Migration 0043 rewords
  the clients that exist, one language at a time and only where it still
  reads as first given, with one audit entry per client
  (`policy_defaults_reworded_by_system`). Versions keep the sections they
  were written and signed with.
- The seed's example documents follow the review's table (French
  « vérification » throughout). Demo clients already seeded keep the
  example documents they have: their text is signed, and the seed adds
  only what is missing.

## Decided by the business after the quality review

1. **Existing libraries are migrated, not retyped from scratch.** A manager
   for the whole organization can import a document as "approved before
   Trustline": it keeps its existing number (when it fits the client's
   numbering, or as given otherwise), its original revision label, its
   original approval date and approver as written on the paper, where the
   signed original is kept, and its next review date. It is published as
   version 1 with source `imported`; the importing manager signs that the
   imported text matches the approved original (password, meaning
   `imported`). The control block shows "Approved before Trustline" with
   those details, never as a Trustline approval. Staff are asked to
   acknowledge an imported document only if the importer says so. At its
   next review the document is re-issued under the normal route and
   signatures. Imports can be done one by one and in batches (a file
   prepared with Trustline's help). Attaching the original PDF comes with
   file storage, later.
2. **A built-in "Approving authority" role** (policies view, view all and
   approve), named at onboarding (for example a medical director, a chief
   executive, a plant manager). The starting approval route is review by the
   Quality officer, then approval by the Approving authority. Existing
   clients get the role, and their starting routes are changed only where
   they are still exactly the starting route.
3. **Each organization chooses its authoritative language** for documents
   (a document setting, by default its main language). Sections are checked,
   flagged and shown against that language.
4. **Email.** Notifications are also sent by email, as a daily digest of
   what waits for the person (to acknowledge, to approve or review, reviews
   due) and immediately for what cannot wait. Built so that any mail service
   can be plugged in by configuration; until one is configured, mail is
   kept in an outbox and not sent. See the email section of the
   notifications work.
   > **Built:** `email.md`. At once, `document_step_assigned`; in the
   > morning digest, documents to acknowledge, to review or approve, and
   > reviews due; weekly, `acknowledgements_overdue_digest` to the managers
   > it is written for. By number and version only, never a title.

## Built: decisions 1 to 3

What the API builds of the three decisions above (decision 4, email, is
built in its own spec, `email.md`). The web app has the screens for them:
importing one document and a batch (with the page on preparing the file),
the Approving authority in the roles, and the language that applies in
the settings; and the admin portal sets each client's import window
(security review 7). Migrations 0044 (schema, generated) and 0045
(grants, triggers, the role and the routes of existing clients, custom
SQL), both additive: nothing the release running before them does is
refused. Each new route answers 401 without a session, 403 without its
permission, 404 for a record of another client (or 400 `unknown_*` for
another client's type, category, owner, unit or role named in a body), and
400 for anything but its strict input.

### 1. Importing existing documents

**Routes** (under `/api/v1/policies`, `@ForModule('policies')`, refused
while suspended like any write):

| Route | Who | Body | Answers |
|---|---|---|---|
| `POST /documents/import` | `policies.manage` for the whole organization | one import document (below) and `password` | 201, the document as `GET /documents/:id` |
| `POST /imports` | the same | `{ password, documents: [import document, …] }` | 201 `{ batch: { id, size, importedAt, listHash }, documents: [{ index, id, number, numberFrom, versionId, sectionsNotWritten, acknowledgementsAsked, signature: { id, meaning, signedAt, contentHash } }] }` |
| `POST /imports/check` | the same | `{ documents: [import document, …] }`, no password | 200 `{ documents: [{ index, number, numberFrom, series, sectionsNotWritten, acknowledgementRequired }] }`; writes nothing |

**An import document**: what `POST /documents` takes (`typeId`,
`categoryId`, `title`, `ownerId`, `ownerUnitId`, `audience?`,
`confidentiality?`, `keywords?`, `references?`, `reviewMonths?` for the
reviews after its re-issue, `acknowledgementRequired?` (false),
`acknowledgeWithinDays?` (14)), and what the original says: `number?` (as
given; none: Trustline numbers it), `revisionLabel?` (one line, 40),
`approvedOn` (a day), `approvedBy` (one line, 200, as written on the
original: a transcription, so one value, not per language), `originalKeptAt`
(per language, 300, `localizedText` and `fitsLanguages`), `effectiveOn?`
(the approval day unless given), `nextReviewOn`, and `content` (per
language, per section key, as a version's).

**Chosen:**

- **Who.** Only `policies.manage` granted for the whole organization
  (`requireEverywhere`): a manager of one unit cannot, nor the Approving
  authority.
- **What it makes.** A new document (`source: imported`) whose version 1
  is published at once with `source: imported`, `effectiveOn` as given,
  `publishedAt` and `publishedBy` the import, `approvedAt` null, no
  approval run, and the next review date as given. `lastReviewedOn` stays
  null: it was never reviewed in Trustline. What the original says is kept
  in `document_imports` (one row per document, insert-only for the
  application role), with the sections it came without; the batch in
  `document_import_batches` (insert-only). A version's and a document's
  `source`, and a document's number, can no longer change
  (`document_versions_source_fixed`, `documents_number_fixed`); an
  imported version is always version 1 (`document_versions_imported_first`).
  None of what the original says can be edited: it changes only through a
  new version.
- **The signature.** The importer re-enters the password once per request
  (checked as for every signature, after everything else, so a refused
  batch neither asks for it nor counts it). Each document gets its own
  signature, meaning `imported`, of `signedImport()`
  (`src/policies/signed-content.ts`): the version as an approval signs it
  (`signedVersion`) with `importedOriginal: { numberAsGiven, revisionLabel,
  approvedOn, approvedBy, originalKeptAt, effectiveOn, nextReviewOn }`. The
  batch keeps `listHash`, the SHA-256 of the canonical list `[{ index,
  documentId, number, versionId, contentHash }]` in order: the set the one
  re-entry covered. A version's own `contentHash` stays the hash of
  `signedVersion`, which acknowledgements sign.
- **Numbers.** Kept as given (spaces in a row made one, capitals kept):
  letters and digits of any script with spaces, `-`, `.`, `/`, `_` and
  brackets between them, 40 at most (400 otherwise). Refused when another
  document of the client has it in any capitals (409 `number_taken`, with
  `takenBy`; a new unique index on `upper(number)` keeps this in the
  database), or, for a number in Trustline's shape (`<A-Z…>-<A-Z…>-<digits>`,
  any capitals), the same place of the same series with other zeros
  (`pol-gov-7` is `POL-GOV-007`). **Trustline's numbering is kept clear by
  advancing the counter**, not by reserving numbers: a number in Trustline's
  shape raises its series' counter (`reference_counters`, whatever type or
  category the series names, so a prefix or category made later carries on
  after it) to at least its place, in the import's transaction, so every
  number Trustline gives afterwards comes after it. A place of more than
  nine digits is refused (400 `invalid_number`). Numbers of any other shape
  cannot meet Trustline's. The audit entry says how the counter moved
  (`counter: { series, from, to }`).
- **Content.** The same checks as written text (`checkedSection`, shared
  with `PATCH …/versions/:id`): the client's languages (400
  `language_mismatch`, `field: "content"`), the type's sections (400
  `unknown_section`), the markup (400 `unsupported_markup`), 20,000 a
  section (400 `section_too_long`), 200,000 a version (400
  `content_too_large`). **For imports only**, sections may be left without
  text, required ones too; they are marked not written
  (`sectionsNotWritten: [{ key, required }]`, against the authoritative
  language). At least one section must have text in the authoritative
  language (400 `content_required`, with `locale`).
- **Days** (the client's calendar): `approvedOn` not after today (400
  `approved_in_future`); `effectiveOn` from `approvedOn` (400
  `effective_before_approval`) to today (400 `effective_in_future`: an
  import is in force already, a future one goes through the route);
  `nextReviewOn` after `approvedOn` (400 `review_before_approval`) and no
  later than today plus the client's longest review period (400
  `review_date_too_far`, with `latest` and `maxReviewMonths`). A next
  review already past is accepted: the document shows overdue, which is
  where it stands. `title` and `originalKeptAt` follow the client's
  languages (400 `language_mismatch`, with `field`).
- **Acknowledgement** is asked only if the importer says so
  (`acknowledgementRequired`): then everyone in the audience is asked, due
  after `acknowledgeWithinDays` from the import day, and told
  (`document_published`), as on publishing.
- **Batches: all or nothing.** One password re-entry signs the listed set,
  so a batch with any document refused imports none: 400 `batch_refused`
  with `problems: [{ index, number, code, status, …details }]`, every
  document refused and why (the `code` and details it would have alone,
  and the `status` it would be answered with: 400, or 409 for
  `number_taken`); a document whose shape is wrong is `invalid_document`
  with the `fields` (names only). Also `duplicate_in_batch` (`sameAs`, the
  index of the first). Importing the rest would sign a set other than the
  one listed, and leave a file half done that someone must then compare
  with the register; refused whole, it is corrected and sent again, and
  `POST /imports/check` finds every problem first without the password.
  The single route answers a refusal with its own status and body
  (without `index`).
- **Sizes.** At most 20 documents and 600,000 characters of text a batch
  (400 `batch_too_large`, with `maxDocuments` and `maxCharacters`). **The
  100 kB body limit is raised for these three routes only, to 2 MB**
  (`src/security/import-body.ts`, `IMPORT_BODY_LIMIT`), and only for a
  request presenting a session: a document comes whole, since it is
  published and signed as it arrives, and its 200,000 characters are 400
  to 600 kB of UTF-8 in Arabic or with typographic quotes. Beyond: 413
  `{ code: "body_too_large", max }`. Every other route keeps 100 kB.
- **Audited per document** (`document_imported`, on the document: number
  and how it was numbered, the counter, type, category, owner, unit,
  confidentiality, audience, review period, version, `original`,
  `sectionsNotWritten`, acknowledgements asked, signature and hash, batch
  and index), and once per batch (`document_import_signed`, on the
  client: batch, size, `listHash` and the list).

**Shown distinctly, everywhere:**

- A version: `source`; `imported` (null unless imported): `{ batch: { id,
  index, size }, numberAsGiven, revisionLabel, approvedOn, approvedBy,
  originalKeptAt, effectiveOn, nextReviewOn, sectionsNotWritten,
  importedBy, importedAt, signature: { id, meaning, signedBy, signedAt,
  contentHash } }`, for every reader.
- Its control block: `approvedThrough` (`trustline_route` or
  `before_trustline`); `approvals` is always empty for an imported version
  (it has no run); `approvedBeforeTrustline` (null, or `{ numberAsGiven,
  revisionLabel, approvedOn, approvedBy, originalKeptAt, effectiveOn,
  nextReviewOn, importedBy, importedAt }`); `preparedBy` is null for an
  imported version, which nobody prepared in Trustline.
- A document: `source`, `reissueRequired` (active with an imported version
  in force), `published.source` and `published.approvedBeforeTrustline`.
- The library's items: `source` of the version in force. The history of
  versions: `source` on each. `GET /reviews` items: `reissue`. Review
  reminders (`review_due`, `review_overdue`): `reissue: true` in `data`.
  The master list (CSV): a last column "Approved before Trustline" (yes or
  no; empty with no version in force), last so that the other columns keep
  their places.

**At its next review it is re-issued**, how the rest of the module treats
it:

- **Periodic review.** `confirm_review` is not in its `moves` while the
  version in force is imported, and `POST /documents/:id/review` answers
  409 `reissue_required` (before the password). The owner or a manager
  starts a new version (copied from the imported text), writes the
  sections the original lacked (sending it needs the required ones, as for
  any version), and sends it through the route; publishing it records the
  review as answered by a revision (`document_reviews`, `revised`, due on
  the imported review date) and counts the next review from its effective
  day, as for any document. From then on it is reviewed as any other.
  Reminders reach its owner at 60, 30 and 7 days and when overdue, as for
  any document. Changing its review period does not move its imported
  review date (it has no last review in Trustline).
- **Same person.** The importer is a contributor of the imported version,
  and **stays a contributor of a new version started from it**: the text
  came into Trustline by them and was approved by nobody here, so its
  re-issue is its first Trustline approval, of which they decide no step
  (403 `same_person`, `reason: "prepared"`). A version started from a
  published written version still starts with whoever started it only.
- **Measures.** An imported document counts as any active document: past
  its review date by the date it was given (so a library imported late
  shows as late), and in the acknowledgement completion only when its
  readers were asked.

### 2. The Approving authority

- `approving_authority` in `SYSTEM_ROLES`: "Approving authority" /
  «صاحب صلاحية الاعتماد» / « Autorité d’approbation », described as giving
  the final approval of controlled documents and reading every document;
  `policies.view`, `policies.view_all`, `policies.approve`. A new client
  gets it with the other built-in roles. Nobody holds it at first: the
  onboarding names whoever it is.
- The starting route of each type (`DEFAULT_ROUTE_STEPS`): review by the
  Quality officer, then approval by the Approving authority.
- Existing clients (migration 0045): the role is added to every client
  that has the built-in roles and no role of that code (one the client
  made itself is left its own, and `ensureSystemRoles` no longer takes
  such a role over), audited once per client
  (`built_in_roles_changed_by_system`, `rolesAdded`). A starting route
  changes only where it is still exactly the starting route: switched on,
  named as given in every language, and exactly two steps (review by the
  built-in Quality officer, then approval by the built-in Administrator,
  seven days, one person each); its second step then names the Approving
  authority and its revision goes up, audited once per client
  (`approval_routes_changed_by_system`, with the routes and types). Runs in
  progress keep the steps they copied. **Note for onboarding:** a client
  whose routes changed sends nothing for review (409 `no_assignee`,
  `position: 2`) until someone holds the Approving authority.

### 3. The authoritative language

- `document_settings.authoritative_locale` (null: the main language,
  whatever it is). `GET /settings` and `PATCH /settings` answer
  `{ maxReviewMonths, authoritativeLocale, authoritative, revision }`:
  `authoritativeLocale` as set (null or a language), `authoritative` the
  language that stands now (the one set if the client still works in it,
  else its main language). `PATCH /settings` takes `maxReviewMonths?`,
  `authoritativeLocale?` (one of the client's languages, 400
  `language_mismatch`; or null), `revision` (409 `stale_settings`), for
  `policies.manage` for the whole organization. Audited
  (`document_settings_updated`, with `authoritativeLocale` and
  `authoritative` as `{ from, to }`).
- Used wherever languages are compared: `languageStatus` (and
  `languages`, authoritative first), sending for review (the required
  sections, 400 `missing_sections` with its `locale`, and the change
  summary), and imports (`content_required`, `sectionsNotWritten`).
  Titles, names and other text a client writes keep the general rule
  (written in the main language).
- **Versions in progress when it changes keep their text, and runs go
  on**: nothing written, sent, approved or published changes. From then on
  every version is checked, flagged and shown against the new language: a
  draft is sent only with its required sections and change summary in it,
  a version in review or approved goes on as it is (what its approvers
  signed is every language of it). A version that is no longer a draft
  keeps the language recorded on it when it was sent or imported (security
  review 7, below), so its language status does not change. The answer says how many versions are in progress
  (`versionsInProgress: { draft, in_review, approved }`, when the language
  that stands changed), and so does the audit entry.

## Built: security review 7

What the API changed after the security review of the import (the lead's
decisions). Migrations 0048 (generated: two tables and two columns, the
widened check of the portal's audit entries) and 0049 (custom SQL: grants,
the trigger that records when a module is first switched on, the
backfills, the database rule of 0041 extended), both additive. The web
contract is in the API engineer's notes to the web engineer.

1. **The large body of the import routes** (2 MB, where every other route
   takes 100 kB) is read only once the session is looked up, as the guard
   does, and found live and holding `policies.manage` for the whole
   organization. Anything else, a credential that is no session included,
   gets the 100 kB of every other route and then the guard's own answer.
   The path is matched whole, under the prefix the API is served at
   (`^/api/v1/policies/(?:imports(?:/check)?|documents/import)$`). A body
   nested more than 64 deep is refused (400 `body_too_deep`, `max`) before
   it is parsed. Since security review 9 the client must also have the
   policies module and a subscription that is not suspended; otherwise the
   guard answers, after 100 kB.
2. **Imports are for migration only.**
   - An imported document's approval day must be before the day the
     policies module was first switched on for the client (400
     `approved_after_start`, with `latestApprovedOn` and `startedOn`; in a
     batch, as that document's problem).
   - Imports, and their check, are accepted only while the import window
     is open: by default from that day to the 90th day, counting the
     first; otherwise to the last day Trustline's staff set (403
     `import_window_closed`, with `closedOn`, `latestApprovedOn`,
     `startedOn`). `GET /settings` gives it as `importWindow: { startedOn,
     closesOn, latestApprovedOn, open }`, and `POST /imports/check`
     answers it as `window`.
   - The first day of each module is recorded by the database
     (`module_starts`, trigger `record_module_starts`) whenever a client
     gains it, by its plan, an add-on, a plan given the module, or its
     subscription leaving cancelled. Switched off and on again, a module
     keeps its first day. For the clients that had the policies module
     already, the day is the earlier of their first document and the day of
     migration 0049. With no day recorded, the window is closed (security
     review 9).
   - `GET` and `PUT /platform/tenants/:id/import-window` (admin portal):
     `PUT { closesOn, reason }` (reason 1 to 500 characters) sets the last
     day, from the day before the module's first day (closed from the
     start) to a year and a day ahead (400 `invalid_closes_on` with
     `earliest`, `latest`; 409 `policies_never_on`). Audited in the
     platform log (`import_window_set`) and in the client's own
     (`import_window_changed`, with the member of staff), in the same
     transaction.
   - No second person confirms an import: the business may add it.
3. **The authoritative language is recorded on the version** when it is
   sent for review, and on an imported version. Every version that is no
   longer a draft is checked, flagged and shown against it; a draft follows
   the setting. New signatures cover it (`signedVersion` adds
   `authoritativeLocale` where `signs_authoritative_locale`); the versions
   that had left draft before were recorded by migration 0049 with the
   language that stood then and keep the earlier form, so every signature
   made before stays valid. The database keeps both columns fixed once the
   version leaves draft, as it keeps the text. Versions answer
   `authoritativeLocale` (null on a draft). Since migration 0051 (security
   review 9, finding 5), a version sent by a release from before 0049,
   which writes no language, is given the one that stands as it leaves
   draft (not covered by its signatures); and a version out of draft with
   none recorded may be given one, once.
4. **Numbers are kept normalised**: NFKC, every digit of any script as its
   ASCII digit, spaces made one, before the taken check, the series and the
   counter, and stored so, which the unique key on the number in any
   capitals then holds. Its letters may be only Latin (Trustline's own
   numbers are) or of the scripts of the client's languages: Arabic where
   it works in Arabic (security review 9, finding 3); any other letter is
   refused (400 `invalid_number`, `reason: 'script'`), so that a number
   wholly in a script that looks like Latin (Cyrillic `ЅОР-001`, Lisu,
   Cherokee) cannot pass for another. A number whose letters mix scripts
   is refused (400 `invalid_number`, `reason: 'mixed_scripts'`). The check
   answers the normalised number.
5. **A starting route always ends with an approval**: with no built-in
   Approving authority (a client's own role holds that code), the
   Administrator approves, and the audit entry (`approval_route_created`,
   `startingRoute: true`, `fallback: { missing, approvedBy }`) says so.
   With neither, no route is made.


## Built: quality review 3

What the API built after the quality review of the finished module (the
lead's decisions). Migration 0052, generated and additive: two columns of
`document_imports`, their check, and the notification kind
`document_owner_assigned`. Each new route answers 401 without a session,
403 without its permission, 404 for a record of another client or out of
the caller's reach, and 400 for anything but its strict input. Every export
is audited.

1. **The original's last review (M2).** An import takes `lastReviewedOn?`,
   as the original says: not before `approvedOn` (400
   `reviewed_before_approval`), not after today (400 `reviewed_in_future`).
   The next review must come after it (400 `review_before_last_review`) and
   no later than the later of `approvedOn` and `lastReviewedOn` plus the
   client's longest review period (400 `review_date_too_far`, with
   `latest`, `maxReviewMonths` and `from`, the day it is counted from). So
   an old document cannot be given a fresh review date by being imported:
   one whose review has passed is imported as it stands, overdue. Kept in
   `document_imports.last_reviewed_on`.
2. **Differences from the original (M3).** An import takes `differences?`,
   plain text per language (2,000 characters; the client's languages, 400
   `language_mismatch` with `field: 'differences'`), as for where the
   original is kept. The import signature covers it: what is signed is that
   the text matches the approved original, except as noted there. Both new
   fields are in what the importer signs (`signedImport`) when given, and
   only then, so a signature over an import made before keeps its hash; the
   batch's `listHash` covers each signature's hash. Both are answered in
   `imported` and in `control.approvedBeforeTrustline` (with
   `sectionsNotInOriginal`, for the reader's view and the print), and are
   the last two columns of the master list ("Last reviewed on the
   original", "Differences from the original").
3. **The register of imports (S1).** `GET /imports` (`page`, `pageSize` to
   500) and `GET /exports/imports?locale=` (CSV), for `policies.manage` for
   the whole organization: every import, newest first, with the number and
   title, the number and revision on the original, approved on and by, last
   reviewed on, where the original is kept, the differences, who imported
   it and when, its batch (`id`, `index`, `size`, `listHash`) and the
   fingerprint of its signature. The export is audited
   (`imports_exported`).
4. **The library's filters (S1).** `source=imported|written` (where the
   version in force came from) and `reissueDue=true` (in force as
   imported, its review within 60 days or past), on the screen and in the
   master list.
5. **The owner is told (S1)** when an import makes them owner of a
   document (`document_owner_assigned`, in the app): its periodic review,
   and its re-issue, are theirs. Not when they imported it themselves.
6. **Overdue approval steps by email (S2):** in the daily digest of those
   who manage documents, and counted in the weekly email to managers
   (`email.md`).
7. **Acknowledgements as files (S5).**
   - `GET /exports/acknowledgements/overdue?locale=`: the late list as a
     CSV (person, employee number for those whose accounts the caller
     manages, area, document number, title, version, due on, days
     overdue), for `policies.view_all` or `policies.manage`. Audited
     (`overdue_acknowledgements_exported`).
   - `GET /people/:userId/acknowledgements` (`page`, `pageSize`) and
     `GET /people/:userId/acknowledgements/export?locale=`: one person's
     record, for `policies.manage` over the person's own unit (for a person
     with none, over the whole organization); 404 otherwise. Every version
     they were asked to acknowledge, newest first: document and version
     (not named where the caller may not open them, as on the late list),
     asked on, due on, acknowledged at, `state` (acknowledged, pending,
     overdue) and `late` (acknowledged after the due day, or not and the
     day has passed). People who have left are included. The export is
     audited (`person_acknowledgements_exported`, about the person).
8. **Who has switched email off (S3, the minimum).** `GET
   /settings/email/opt-outs`, for `settings.manage` for the whole
   organization: each active person with a switch off, by name, with
   `reliedOn: { approves, triages }` (whether they decide approval steps,
   or triage incidents, in the modules the client has). `GET
   /me/notification-preferences` answers the same `reliedOn`, so that the
   screen can warn before such a person switches the immediate emails off.
   Which emails are compulsory for which role waits for the business
   (question 4).
9. **"Confirm no change" only when the review is due.** Within 60 days of
   the due date, or after it; otherwise 409 `review_not_due` with `dueOn`
   and `opensOn`, checked before the password, and `confirm_review` is not
   among the document's moves. The document answers `reviewOpensOn` (next
   to `nextReviewOn`), the day it opens, from the same function
   (`reviewConfirmation`) as the moves and the refusal. Reversible if the
   business answers question 6 otherwise.
10. **The original's revision for the print header:**
    `control.originalRevision` ("Version 1 (Rev. 4 on the original)").
