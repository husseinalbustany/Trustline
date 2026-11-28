## Report: business decisions 1 to 3, database and API (not committed)

Decisions 1 to 3 are built in the database and API, tested, and written into the spec. In `apps/api`, lint passes, typecheck passes and the suite passes: **709 tests in 37 files** (696 before, plus 11 in the new import spec and 2 new migration tests). `pnpm db:seed` works and can be run again safely. Each demo client now has one imported example, `SOP/OPS/012`, due for review in 30 days. `pnpm --filter api build` passes. I did not run the root `pnpm build`, which also builds the web app, and I did not touch `apps/web`.

PostgreSQL on 5432 was not running, although the brief said it was. I started the local cluster with `pg_ctlcluster 16 main start`.

### Migrations (both additive)
- **0044_policies_import_and_authoritative_language** (generated):
  - adds `imported` to `signature_meaning`;
  - adds `documents.source`, plus a unique index on `(tenant_id, upper(number))`;
  - adds a check that an imported version is always version 1;
  - adds `document_settings.authoritative_locale` (null means the main language);
  - creates the tables `document_import_batches` and `document_imports`, under row-level security.
- **0045_policies_import_grants_and_approving_authority** (custom):
  - the two import tables are insert-only (SELECT and INSERT grants only);
  - triggers stop a version's `source`, and a document's `number` and `source`, from ever changing;
  - adds the Approving authority role for existing clients, and changes their starting routes. Both are audited once per client.

### 1. Import: routes (under `/api/v1/policies`; only `policies.manage` for the whole organization)
| Route | Body | Answer |
|---|---|---|
| `POST /documents/import` | one import document + `password` | 201, same shape as `GET /documents/:id` |
| `POST /imports` | `{ password, documents: [...] }` | 201 `{ batch: { id, size, importedAt, listHash }, documents: [{ index, id, number, numberFrom, versionId, sectionsNotWritten, acknowledgementsAsked, signature: { id, meaning, signedAt, contentHash } }] }` |
| `POST /imports/check` | `{ documents }`, no password, writes nothing | 200 `{ documents: [{ index, number, numberFrom, series, sectionsNotWritten, acknowledgementRequired }] }` |

**An import document** takes:
- everything `POST /documents` takes;
- `number?` (as given; if left out, Trustline numbers it) and `revisionLabel?`;
- `approvedOn`, `approvedBy` and `originalKeptAt`;
- `effectiveOn?` (defaults to the approval day) and `nextReviewOn`;
- `content`, plus `acknowledgementRequired?` (default false) and `acknowledgeWithinDays?`.

`originalKeptAt` is per language. `approvedBy` is a single value, because it is a transcription of what the paper says. That is a deliberate exception to the per-language rule.

**Error codes.** On the single route each refusal comes back with its own status and body:
- 400: `unknown_type`, `unknown_category`, `unknown_owner`, `unknown_role`, `unknown_section`;
- 400: `unsupported_markup`, `section_too_long`, `content_too_large`, `content_required {locale}`;
- 400: `language_mismatch {field}`, `invalid_number`;
- 400 (dates): `approved_in_future`, `effective_before_approval`, `effective_in_future`, `review_before_approval`, `review_date_too_far {latest, maxReviewMonths}`, `review_period_too_long`;
- 409: `number_taken {takenBy}`.

On the batch and check routes:
- 400 `batch_refused { problems: [{ index, number, code, status, ...details }] }`;
- the problem codes are the ones above, plus `invalid_document {fields}` and `duplicate_in_batch {sameAs}`;
- 400 `batch_too_large {maxDocuments: 20, maxCharacters: 600000}`;
- 413 `body_too_large {max}`.

Password errors work as for every signature: 401 `wrong_password` / `password_locked`. The password is checked only after everything else, so a refused batch never asks for it or counts it against the lockout.

**Decisions taken:**
- **Signatures and hashes.** One password per request. Each document gets its own signature, meaning `imported`. It hashes the version plus what the original says (`signedImport` in `signed-content.ts`). The batch row keeps `listHash`, a hash of the ordered list of what was signed.
- **Numbers.** Kept as given (repeated spaces become one). Refused when another document already has the number in any capitals, or with other leading zeros in Trustline's shape (`pol-gov-7` counts as `POL-GOV-007`). I chose to **advance the counter, not reserve numbers**: a number in Trustline's shape pushes its series counter to at least its value, so every number Trustline gives later comes after it. A batch takes all its counters in one fixed order.
- **Missing sections.** Allowed for imports only, and reported as `sectionsNotWritten: [{ key, required }]`, measured against the authoritative language. At least one section must have text in that language.
- **Batches are all or nothing.** One password covers the listed set, so importing part of it would sign a different set from the one the importer confirmed. The refusal lists every failing document at once, and `/imports/check` finds them all first without asking for the password.
- **Body size.** The limit is raised **for these three routes only, to 2 MB**, and only when a session is presented (`security/import-body.ts`). Every other route stays at 100 kB. A batch holds at most 20 documents and 600,000 characters.
- **Acknowledgement** is asked only if the importer says so. The due date counts from the import day.
- **Audit.** One `document_imported` entry per document, and one `document_import_signed` per batch.

**How imports show everywhere:**
- On a version: `source`, and an `imported` object holding the original's details, the batch, the importer, the signature and `sectionsNotWritten`.
- In the control block:
  - `approvedThrough` is `trustline_route` or `before_trustline`;
  - for imported versions `approvals` is always empty, `approvedBeforeTrustline` holds the original's details, and `preparedBy` is null;
  - `approvedAt` stays null and there is no approval run.
- On a document: `source`, `reissueRequired`, `published.source` and `published.approvedBeforeTrustline`.
- In lists and files:
  - library items and the version history carry `source`; `GET /reviews` items carry `reissue`;
  - review reminders carry `data.reissue: true`;
  - the CSV master list gets a new **last** column, "Approved before Trustline", so existing columns keep their positions.

**Re-issue, same-person rule and measures:**
- `confirm_review` is no longer offered for an imported document, and `POST …/review` answers 409 `reissue_required` (before the password is asked). The next review is a new version through the route; the required sections must be written before it can be sent. Publishing it records the review as `revised`, and from then on the document is reviewed like any other.
- **The importer stays a contributor of a version started from the imported text**, so they cannot decide any step of its re-issue (403 `same_person`, reason `prepared`).
- In the measures, an imported document counts by the review date it was given, so an overdue paper document shows as overdue. It counts in acknowledgement completion only if readers were asked.

### 2. Approving authority
- New built-in role `approving_authority`, named in three languages (Arabic «صاحب صلاحية الاعتماد», French « Autorité d’approbation »), with `policies.view`, `policies.view_all` and `policies.approve`.
- New clients get it, and the starting route is now: review by the Quality officer, then approval by the Approving authority.
- For existing clients, migration 0045:
  - adds the role wherever no role of that code exists; a client's own role with that code is left alone, and `ensureSystemRoles` no longer takes such a role over;
  - changes a route only if it is still exactly the starting route (switched on, original name in all languages, exactly the two original steps);
  - leaves runs in progress on the steps they copied.
- **Onboarding consequence:** nobody holds the role at first. A client whose routes changed gets 409 `no_assignee` with `position: 2` when sending for review, until someone is given it. The seed gives the example approver this role.

### 3. Authoritative language
- `GET` and `PATCH /settings` now answer `{ maxReviewMonths, authoritativeLocale (null or a language), authoritative (the language in effect), revision }`.
- `PATCH` accepts `maxReviewMonths?`, `authoritativeLocale?` (one of the client's languages or null; otherwise 400 `language_mismatch`) and `revision`. A change is audited as `document_settings_updated`.
- It is used through the single `authoritativeLocale()` everywhere languages are compared: `languageStatus` and `languages`, the required-sections and change-summary checks on submit, and imports.
- Titles and other client-written names still have to be written in the main language, as before.
- **Versions in progress keep their text and their runs carry on.** From then on everything is checked and shown against the new language. When the language in effect changes, the `PATCH` answer and the audit entry include `versionsInProgress: { draft, in_review, approved }`.

### Existing tests I changed (to the new rules, not weakened)
- Test approvers now hold `approving_authority` as well as `administrator`.
- The starting-route assertion now expects the Approving authority.
- The settings shape assertions include the two new fields.
- A new client has five built-in roles, not four; `safeguards.spec.ts` now lists the new role.
- The migration spec now runs 0045, and its trigger statements are filtered out like the grants are.
- `test/support/hospital.ts` lets test staff hold several roles, and `test/cleanup.ts` removes the new tables.

### Files
- New:
  - `/home/user/Trustline/apps/api/src/policies/imports.service.ts`
  - `/home/user/Trustline/apps/api/src/policies/section-input.ts`
  - `/home/user/Trustline/apps/api/src/security/import-body.ts`
  - `/home/user/Trustline/apps/api/test/policies-import.e2e-spec.ts`
  - the migrations 0044 and 0045 in `/home/user/Trustline/apps/api/drizzle/`
- Spec: `/home/user/Trustline/docs/specs/policies-and-procedures.md`, new section "Built: decisions 1 to 3" plus the passages it changes. `README.md` now says five built-in roles.

### For review
- `security-reviewer`: the import routes, the 2 MB parser (it only checks that a session token is present; the guard then validates it as usual), and the triggers and grants.
- `bilingual-reviewer`: the Arabic and French role name and description, and the Arabic CSV heading «معتمدة قبل Trustline».
- The web screens for all three decisions are not built yet.