## Policies and procedures: database and API built and tested

The database and API for the `policies` module are built, and the suite is green: `pnpm --filter api lint` (0 warnings), `typecheck`, `test` (**658 passed, 32 files**; 589 before, 69 new) and `build` all pass. `pnpm db:seed` works and running it twice changes nothing. Nothing is committed and `apps/web` is untouched.

**The database was not running.** The cluster on localhost:5432 was stopped and empty, with no `trustline` role or database. I started it, created the owner role `trustline` (superuser, as the docker image makes it) with the password from `.env` and the `trustline` database, then migrated and seeded. You should know I made that change to the machine.

### Migrations (generated, not hand-numbered)
- `apps/api/drizzle/0038_policies_and_procedures.sql` (from `db:generate --name policies_and_procedures`):
  - the document, version, approval, signature, review and acknowledgement tables, all under row-level security with composite foreign keys;
  - nine new notification kinds, a `notifications.document_id` column, and the check `notifications_about_one_thing` replacing the old one.
- `0039_policies_grants_and_existing_clients.sql` (`--custom`):
  - the foreign key from a document to its published version (the two tables point at each other, which `schema.ts` cannot type);
  - grants for `trustline_app`: signatures and reviews are insert and select only; acknowledgements are update on 4 columns only; nothing a client writes can be deleted except audiences and route steps, which are replaced as a whole and audited;
  - `policies.approve` and `policies.view_all` added to the built-in Administrator, Quality officer and Department manager of every existing client, with one audit entry per client (`built_in_roles_changed_by_system`);
  - the starting types, categories and routes for existing clients. A test applies this migration twice to its own clients and checks the result is identical to what a new client gets.

### API contract (under `/api/v1/policies`)
Every route sits behind `SessionGuard` and `@ForModule('policies')`. Common answers: 401 with no session; 404 like an unknown route when the module is off; 400 for a body or query that fails strict validation; 404 for another client's record or one the caller may not see. `revision` is **required** on every change. Permission refusals are 403 `{code:'missing_permission', permission}`.

**Document object** (returned by GET, create, PATCH, retire, review):
- `id, number, title, type{id,code,name}, category{id,code,name}, owner{id,name}, ownerUnit{id,name}`
- `confidentiality`, `audience{wholeOrganization, orgUnits[{id,name}], roles[{id,name}]}`, `keywords[], references[]`
- `reviewMonths, nextReviewOn, lastReviewedOn, review:'due'|'overdue'|null`
- `status:'draft'|'active'|'retired', retiredAt, retiredBy, retireReason` (the last two only with full sight)
- `createdAt, updatedAt, revision, access:'full'|'reader'|'assignee'`
- `published{id,version,effectiveOn,publishedAt,acknowledgementRequired}|null`
- `inProgress{id,version,status}|null`
- `myAcknowledgement{versionId,dueOn|null,acknowledgedAt,overdue}|null`
- `moves` ⊂ `edit, new_version, retire, confirm_review`

**Version object:**
- `id, documentId, number, title, version, status, sections[{key,name,required}], content{locale:{key:text}}, languages[], contentHash, changeSummary`
- `preparedBy{id,name}, preparedAt, effectiveOn, scheduledFor, scheduledBy, approvedAt, publishedAt, publishedBy, supersededAt, withdrawnAt, acknowledgementRequired, acknowledgeWithinDays`
- `control{number, version, owner, effectiveOn, nextReviewOn, approvals[{position,kind,meaning,signedBy{id,name},signedAt,contentHash}]}`
- `run{id,status,currentPosition,startedAt,completedAt, steps[{position,kind, assignee{type:'user',user}|{type:'role',role}, status,dueAt,overdue,decidedBy,decidedAt,comment}]}|null` (full sight or assignee only)
- `returned[{position,comment,by,at}]`
- `comparison[{key,name,required,changed, locales{xx:{changed, lines[{op:'same'|'added'|'removed',text}]}}}]|null`
- `myStep{position,kind,dueAt,samePerson}|null, myAcknowledgement, revision`
- `moves` ⊂ `edit, submit, recall, publish, withdraw, approve, return, acknowledge`

**Routes:**

Library
- `GET /documents` (any policies permission). Query: `q` (number, title in any language, keywords, text of versions the caller may open), `typeId`, `categoryId` (includes sub-categories), `ownerUnitId` (includes sub-units), `status`, `review=due|overdue`, `appliesToMe`, `awaitingMyAcknowledgement`, `sort=number|title|next_review|recently_published`, `page`, `pageSize≤100`.
  - Answers `{items,total}`. Each item: `id, number, title, type, category, ownerUnit, status, confidentiality, version, effectiveOn, publishedAt, nextReviewOn, inProgress|null, review, access:'full'|'other', myAcknowledgement{dueOn,overdue}|null`.
- `POST /documents` → 201 document.
  - Body: `typeId, categoryId, title, ownerId, ownerUnitId, audience{orgUnitIds[],roleIds[]}?` (empty units means the whole organization), `confidentiality?, keywords?, references?, reviewMonths?, acknowledgementRequired?, acknowledgeWithinDays?`.
  - Errors: 403 `outside_scope`; 400 `language_mismatch`, `unknown_type`, `unknown_category`, `unknown_owner`, `unknown_org_unit`, `unknown_role`.
- `PATCH /documents/:id` (metadata fields + `revision`) → document, or `{id, moved:true}` if the manager moved it out of their own reach.
  - Errors: 409 `stale_document`, `document_retired`; 403 `outside_scope`; plus the 400 codes above.
- `POST /documents/:id/retire {reason, revision}` → document. Errors: 409 `document_retired`, `stale_document`.
- `POST /documents/:id/review {password, comment?, revision}` → document (owner or a manager of it).
  - Errors: 403 `outside_scope`; 409 `not_active`, `stale_document`; 401 `wrong_password` or `password_locked`.

Versions
- `GET /documents/:id/versions` → `{versions[{id,version,status,changeSummary,preparedAt,effectiveOn,publishedAt,supersededAt,withdrawnAt}], reviews[{id,dueOn,outcome,comment,reviewedBy{id,name},reviewedAt,nextReviewOn,signatureId}]}`.
- `POST /documents/:id/versions {}` → 201 version. Error: 409 `version_in_progress`.
- `GET /documents/:id/versions/:versionId` → version.
- `PATCH …/:versionId {content?{locale:{key:text|null}}, changeSummary?, acknowledgementRequired?, acknowledgeWithinDays?, revision}` → version.
  - Errors: 409 `not_draft`, `stale_version`.
  - 400 `unsupported_markup{locale,section,problem}`, `section_too_long{max:20000}`, `content_too_large{max:200000}`, `unknown_section{section}`, `language_mismatch`.
- `POST …/submit {revision}` → version.
  - Errors: 400 `missing_sections{locale,sections}`, `change_summary_required`; 409 `no_route`, `no_assignee{position}`, `route_has_no_steps`.

Approval
- `POST …/approve {password, comment?, revision}` (needs `policies.approve`) → version.
- `POST …/return {comment, revision}` (needs `policies.approve`) → version.
- Errors for both: 403 `not_assignee`, `same_person`; 409 `not_current_step`, `not_in_review`, `stale_version`; approve only: 401 `wrong_password` or `password_locked`.
- `POST …/recall {revision}` → version. Error: 409 `not_in_review`.
- `POST …/withdraw {reason?, revision}` → version. Error: 409 `not_in_progress`.
- `GET /approvals` → `{items[{stepId,position,kind,dueAt,activatedAt,overdue,document{id,number,title},type,version{id,version,revision}}],total}`.

Publishing and acknowledgement
- `POST …/publish {effectiveOn?, revision}` → version (a later day schedules it).
  - Errors: 409 `not_approved`, `content_changed`; 400 `effective_in_past`.
- `POST …/acknowledge {password}` (any read permission) → `{versionId, acknowledgedAt, signature{id,meaning,signedAt,contentHash}}`.
  - Errors: 409 `already_acknowledged`, `acknowledgement_not_required`, `stale_version` (not the published version); 403 `not_in_audience`; 401.
- `GET …/acknowledgements?state=pending|acknowledged|overdue&page&pageSize≤500` (full sight only; anyone else who can see the document gets 403 `missing_permission`).
  - Answers `{versionId,version,status,acknowledgementRequired,targeted,acknowledged,pending,overdue,percent, byUnit[{orgUnit|null,targeted,acknowledged,overdue,percent}], people{items[{user,orgUnit,assignedAt,dueOn,acknowledgedAt,overdue}],total}}`.

Reviews, summary and people
- `GET /reviews` → `{items[{id,number,title,ownerId,ownerUnit,nextReviewOn,revision,mine,state}],total}`: reviews within 60 days or past, for documents the caller owns or manages.
- `GET /summary` → `{today, active, pastReview{count,of,percent,target:5,met}, dueWithin30Days, awaitingMyApproval, awaitingMyAcknowledgement, acknowledgement{targeted,acknowledged,percent,target:90,met}|null}`. `acknowledgement` is null without full sight anywhere.
- `GET /people?q&approvers` (needs `policies.manage`) → `[{id,name,orgUnitId}]`, at most 50.

Settings (reading needs any policies permission; `includeInactive=true` and `GET /approval-routes` need `policies.manage`; changes need `policies.manage` for the whole organization)
- `GET|POST /types`, `PATCH /types/:id`. A type is `{id,code,name,numberPrefix,sections,defaultReviewMonths,active,position}`. Error: 409 `code_taken`.
- `GET|POST /categories`, `PATCH /categories/:id`. A category is `{id,code,name,parentId,active,position}`. Errors: 400 `invalid_parent`; 409 `code_taken`.
- `GET|POST /approval-routes`, `PATCH /approval-routes/:id`.
  - Body: `{name, documentTypeId|null, active?, steps[{kind, userId|roleId, dueInDays}], revision (PATCH)}`.
  - Errors: 400 `role_cannot_approve`, `user_cannot_approve`, `last_step_must_approve`, `unknown_type`, `unknown_role`; 409 `route_exists`, `stale_route`.

### Notifications
Nine new kinds, all mapped to `policies`. Every one's `data` carries `number` and `serious:false`, plus:
- `document_step_assigned`: `version, position, step`
- `document_returned`: `version, position`
- `document_approved`: `version`
- `document_published`, `acknowledgement_assigned`, `acknowledgement_due`, `acknowledgement_overdue`: `version, dueOn`
- `review_due`: `dueOn, days` (60, 30 or 7)
- `review_overdue`: `dueOn`

**Breaking for the web:** every item in `GET /notifications` now has a `document{id,number,title|null,canOpen}|null` key; incident items get `document:null`. The title is given only while the reader can still open the document.

### Decisions I took (all marked "Chosen" in the spec)
- **Scope:** `policies.manage` and `policies.view_all` are scoped to the document's owning unit; `policies.view` is not. Settings need `policies.manage` for the whole organization.
- **Who sees what:**
  - The owner always reads the published version, whatever its confidentiality, and may confirm a review with no change.
  - Readers see only the published version, not older ones.
  - Assignees of any step of a run in progress see the document, that version and the published version (needed for the comparison), and lose sight when the run ends.
  - A retired document is seen only with full sight.
- **Audience:** a person's own unit must be one of the audience's units or beneath one, they must hold a narrowing role (if any) anywhere, and they must hold a read permission.
- **Same-person rule:** it covers everyone who created, edited or submitted the version, for every step, review or approval. Sending for review is refused (409 `no_assignee`) if any step has nobody else who could decide it.
- **Starting route:** review by Quality officer, then approval by Administrator, 7 days each. Recall and withdraw were added so a stuck run can always be ended.
- **Signed hash:** it covers the document and version ids and number, sections, content, change summary and acknowledgement settings. The title is not included. A wrong password is 401 `wrong_password`, a locked account 401 `password_locked`; failures are audited as `password_confirmation_failed {locked, purpose}`, and the lock is shared with sign-in.
- **Content:** headings go to level 3 only. Sizes are 20,000 characters per section per language and 200,000 per version. Request bodies stay at the 100 kB default, so long text is saved a few sections at a time.
- **Daily check:** it runs every 15 minutes and does each thing once. When a review date is found late, only the latest stage is sent. Overdue review reminders also go to the document's managers.
- **Targeted people** for the completion measure: those asked on the current published version who are still active users. People who left the audience stay counted.
- **Other choices:**
  - metadata edits apply directly (audited), not through a version, and the type cannot change;
  - a category's code is fixed once created;
  - a version keeps its type's sections from when it was created;
  - publishing a new version records the periodic review as `revised`, and retiring records `retired`.
- **While suspended:** everything in the module is read-only except acknowledging, which stays open. I agree with that. The daily check keeps running for a suspended subscription, as the incident deadline check does.

### Not done, or needing your call
- There is no route for an owner to "ask to retire"; the owner tells a manager.
- Nothing is sent when an approval step is overdue. Due dates are stored and shown.
- I did not make review and approval require different people within one run. The spec only names the preparer; say if you want that rule.
- For the web engineer: `apps/web` dictionaries need labels for `policies.approve`, `policies.view_all`, the nine notification kinds and the new error codes.
- I updated three existing tests for intended contract changes: exact key lists in `notifications` and `incident-review-2`, and the Department manager's permission list in `incidents`. The guard test in `modules-and-subscriptions.e2e-spec.ts` now fails for any policies controller that declares a module other than `policies`; I checked by changing one decorator, saw it fail, and restored it.
- I fixed one real bug before finishing: `ensurePolicyDefaults` relied on row-level security, which the owner role bypasses, so the seed could have picked another client's roles. It now names the client explicitly. Composite foreign keys had stopped any wrong row from being written.

### Files
Under `/home/user/Trustline/apps/api/`:
- New:
  - `src/approvals/` (`approval-engine.service.ts`, `signatures.ts`, `approvals.module.ts`, `signatures.spec.ts`)
  - `src/policies/` (every module file and `content.spec.ts`, `policy-check.spec.ts`)
  - `src/database/seed-documents.ts`
  - `test/policies.e2e-spec.ts`, `test/policies-check.e2e-spec.ts`, `test/policies-migration.e2e-spec.ts`
- Changed: `src/database/schema.ts`, `seed.ts`, `identity/auth.service.ts` (`confirmPassword`), `identity/permissions.ts`, `identity/provisioning.service.ts`, `incidents/notifier.ts`, `incidents/notifications.service.ts`, `main.ts`, `test/cleanup.ts`.
- Docs: `/home/user/Trustline/docs/specs/policies-and-procedures.md` (new "Built: database and API" section with every decision and the route table), `/home/user/Trustline/README.md`, `/home/user/Trustline/docs/specs/modules-and-subscriptions.md`.

The seed gives each demo client five documents:
- POL-GOV-001: published
- PRC-SAF-001: published, asks for acknowledgement, with version 2 in review
- WI-OPS-001: draft
- PRC-QUA-001: approved, scheduled in 14 days
- POL-INF-001: restricted, past its review date

It also adds three fictional invited staff, none of them an administrator, so the admin portal can still create each client's first administrator.

## Server-made PDF of a version (docs/specs/document-pdf.md, added 28 November 2026)

`GET /api/v1/policies/documents/:id/versions/:versionId/pdf?languages=en,ar&locale=ar`

- `languages` is optional. It takes one or two of the version's languages; the language that applies is put first whatever the order. By default, the page's language if the version has it, else the language that applies.
- `locale` is optional: the page's language and direction, one of the client's languages. By default, the client's language.
- Refusals:
  - 401 without a session;
  - 404 when the caller may not read the document, or for a version not in force without full sight (`policies.manage` or `policies.view_all`). Another client's version is 404 too.
  - 400 `{ code: 'language_mismatch', field: 'languages' | 'locale' }`, or 400 for unknown query keys.
  - 503 `{ code: 'pdf_unavailable' | 'pdf_busy' | 'pdf_timeout' | 'pdf_failed' }`.
- Answer: `application/pdf`, `Content-Disposition: attachment; filename="<number>-v<version>-<languages>.pdf"`, `Cache-Control: no-store`, and `X-Content-SHA256`.
- Audit action `document_pdf_made`, with versionId, version, languages, locale, pages and sha256. **Web:** it needs an audit label:
  - en "Document printed to PDF"
  - ar "إعداد ملف PDF لوثيقة"
  - fr "Impression d’un document en PDF"
- Suggested web use: a "Download PDF" button beside Print on the version page, with a language choice (one language, or side by side with the language that applies), shown when the client works in more than one language.
