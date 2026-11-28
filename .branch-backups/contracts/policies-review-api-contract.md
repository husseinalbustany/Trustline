## Report: API side of the policies review fixes

Everything you listed is done in the API, tests and docs. `pnpm --filter api lint` and `typecheck` are clean. `pnpm --filter api test` passes **693 of 693 tests in 36 files**, up from 668: 15 new end-to-end tests, 1 new migration test and 9 new unit tests. `pnpm db:seed` works on the dev database, and twice in a row on a fresh scratch database, which I then dropped.

I did not commit, run `pnpm build`, write to `apps/api/dist` or touch `apps/web`. Someone else saved a checkpoint commit of my work in progress (4fabdee, 21:34). The finished state is that commit plus the uncommitted changes in the working tree.

### Each item
| Item | Status |
|---|---|
| C1 languages | Done: `languageStatus` on every version. The authoritative-language choice lives only in `authoritativeLocale()` in `src/policies/languages.ts` (default language for now). |
| C3 print support | Done, API part only: `today`, and `control.title`, `status`, `documentStatus`, `preparedBy`, `inForce`. A QR code should open `GET /documents/:id`. |
| C5 exports | Done: CSV of the master list and of acknowledgements per version, with screen visibility. Exports are audited. |
| C6 measure | Done: only acknowledgements past their due date count. |
| C7 review periods | Done: a maximum per client (36 by default); changing a period needs a reason; history of a document's details; review comment and withdraw reason required. |
| C8 reaching someone | Done: overdue steps go to the document's managers once; a weekly in-app digest goes to unit managers, with a list it leads to. |
| D10 | Done: a scheduled version left unpublished is reported to its managers once. |
| D11 | Done: publish and retire stay open while suspended. |
| Version source | Done: `source` (`written`, `imported`, `ai_drafted`), not part of what is signed. |
| Earlier rounds and "since returned" | Done: `rounds` and `sinceReturned`. |
| Web points 1 to 5 | Done (roles list, `versionId` in data, suspended `moves`, revisions on types and categories, `same_person_in_two_steps`). |
| Starting wording | Done in `defaults.ts` and the seed, applied to existing clients by migration 0043. French « vérification » was already in the seed and is kept. |

### For the web engineer
**Breaking changes:**
- `PATCH /policies/types/:id` and `/categories/:id` now require `revision`. A mismatch answers 409 `stale_type` or `stale_category`. Lists and records now carry `revision`.
- `POST …/documents/:id/review` requires `comment`.
- `POST …/withdraw` requires `reason`.
- `PATCH /documents/:id`:
  - takes `reason`, which is required when `reviewMonths` changes (400 `{code:'reason_required', field:'reviewMonths'}`);
  - a period above the maximum answers 400 `{code:'review_period_too_long', max}`, and so does document create and type create/update.
- `GET /summary` → `acknowledgement` is now `{ basis:'due_date_passed', targeted, acknowledged, percent, target, met, live:{targeted, acknowledged, percent} }`.
- Saving a route that names one person in two steps answers 400 `{code:'same_person_in_two_steps', userId, positions}`.

**While suspended,** `moves` offers only `publish`, `retire` and `acknowledge`.

**New fields on a version:**
- `languageStatus`, for everyone who can read the version:
  - `{ authoritative, comparedWith:{id,version}|null, sections:[{key, locales:{<loc>:'written'|'fallback'|'lagging'|'empty'}}], byLocale:{<loc>:{written,fallback,lagging,empty}}, lagging }`
  - `comparedWith` is the version published before this one.
- `source` and `today`.
- `control` adds `title`, `status`, `documentStatus`, `preparedBy` and `inForce`.
- `rounds`: every run, newest first, shaped like `run`, plus `snapshot`. Only for full sight and the assignees of the run in progress.
- `sinceReturned`: `{ runId, returnedAt, changeSummaryChanged, comparison }`, shaped like `comparison`. Only on versions in progress.

A document now also carries `today`.

**New routes, all under `/policies`:**
- `GET /roles` (`policies.manage`, any scope) → `[{ id, code, name, isSystem, approves }]`.
- `GET /settings` (any policies permission) → `{ maxReviewMonths, revision }`.
- `PATCH /settings` (`policies.manage` for the whole organization), body `{ maxReviewMonths, revision }`. It can answer 409 `stale_settings`, or 409 `type_exceeds_max` with `types`.
- `GET /documents/:id/changes` (full sight; 403 for others who can see the document) → `{ items:[{ id, at, by, reason, changes:[{ field, from, to }] }], total }`.
  - `field` is one of `title`, `category`, `owner`, `ownerUnit`, `audience`, `confidentiality`, `reviewMonths`, `nextReviewOn`, `keywords`, `references`.
  - People, units, categories and roles come back with their names.
- `GET /exports/documents?<library filters, sort>&locale=` → CSV.
- `GET /documents/:id/versions/:versionId/acknowledgements/export?locale=` → CSV. Full sight only; any version; people who have left are included and marked.
- `GET …/acknowledgements?includeLeft=true` adds people who left to the on-screen list. Each person now has `left` and `account`; the counts stay over active people.
- `GET /acknowledgements/overdue?page&pageSize` (`policies.view_all` or `policies.manage`) → `{ today, items:[{ user, orgUnit, document:{id, number, title|null, canOpen}, version:{id, version}, dueOn, daysOverdue }], total }`.

**Export language:** `locale` must be one of the client's languages (400 `language_mismatch` otherwise). Without it, the file uses the caller's own language, or else the client's default. Every cell that a spreadsheet would run as a formula starts with an apostrophe.

**Notifications:** every notification about a version carries `data.versionId`. These new kinds need dictionary entries:
- `document_step_overdue` `{version, versionId, position, step}`;
- `document_publish_failed` `{version, versionId, effectiveOn, reason}`;
- `acknowledgements_overdue_digest` `{overdue, people, week}`. It has `document: null` and is about no one document.

### Migrations
Both are additive, and the running old build works with them.
- **0042** (generated): new enum `document_version_source` and column `document_versions.source`; 3 new notification kinds; tables `document_settings`, `document_review_rounds` and `policy_reminders`, all with tenant isolation; `revision` on types and categories; the notifications check now accepts a digest about no document.
- **0043** (`--custom`):
  - grants: settings select/insert/update; rounds and reminders select/insert;
  - rewording: the starting section and category names change one language at a time, only where the client hasn't renamed them;
  - one audit entry per client (`policy_defaults_reworded_by_system`).
  - I checked it on the demo clients.

### Decisions I took (please confirm)
- **Who gets the weekly digest:** a person's managers are whoever holds `policies.manage` or `policies.view_all` through a grant on the person's unit or a unit above it. If there is none, or the person has no unit, it goes to those who hold `policies.manage` for the whole organization. It is sent once per ISO week on the client's calendar, with counts only.
- **Lowering the maximum review period** is refused while an active type's own period is longer. Documents set longer before keep their period until it is next changed.
- **C6:** acknowledgements given late still count as acknowledged. The day's overall figure is kept as `live`.
- **Exports are audited.** The acknowledgement export includes the employee number but not the email address.
- **`includeLeft` defaults to false**, so the screen behaves as before until the web engineer opts in.
- **Snapshots of review rounds exist only from now on**, so runs from before show `snapshot: false`. The seed now writes them too.
- **Already seeded demo documents keep their old wording:** their text is signed, and the seed only adds what is missing.
- **Not changed:** while suspended, review reminders still arrive although confirming a review is closed. "Confirm no change" can still be signed at any time (D8 was not in the list).

### Files
- New code: `/home/user/Trustline/apps/api/src/policies/languages.ts`, `csv.ts`, `export-wording.ts`, `document-settings.ts`.
- New tests: `/home/user/Trustline/apps/api/test/policies-review-2.e2e-spec.ts`, `/home/user/Trustline/apps/api/src/policies/csv.spec.ts`, `languages.spec.ts`.
- Migrations: `/home/user/Trustline/apps/api/drizzle/0042_policies_review_fixes.sql`, `/home/user/Trustline/apps/api/drizzle/0043_policies_grants_and_starting_wording.sql`.
- Existing tests changed to the new rules (required reasons and comments, revisions, publish and retire open while suspended, the new measure, route refused at save, 0039 followed by 0043): `policies.e2e-spec.ts`, `policies-check.e2e-spec.ts`, `policies-migration.e2e-spec.ts`.
- Specs:
  - `/home/user/Trustline/docs/specs/policies-and-procedures.md`: existing rules updated, new section "After quality review 2";
  - `/home/user/Trustline/docs/specs/modules-and-subscriptions.md`: what stays open while suspended.

The new routes and the daily check touch tenant data, permissions and exports, so `security-reviewer` should look at this before the change goes in.