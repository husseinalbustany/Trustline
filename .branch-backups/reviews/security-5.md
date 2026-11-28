I reviewed the API change in 6bac8f2 (range 59f83a2..6bac8f2, apps/api, docs and README). I found no hole in tenant isolation or visibility. There are two Medium findings: a way around the "no links" markup rule, and a way around the same-person rule. There are four Low ones.

I changed no files in the repository, ran no tests or server, and ran no migration or seed. All SQL ran in read-only sessions (`PGOPTIONS=-c default_transaction_read_only=on`) as the owner, `trustline_app` and `trustline_platform`. Three small scripts in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/rima5/` (`markup.mts`, `diff.mts`, `hashes.mts`) import the repository's own functions through tsx and only read.

## Findings, most severe first

### 1. Medium: links get past the markup check through a link definition inside a list item
**Confirmed by running the API's own checker.**
- **Where:** `/home/user/Trustline/apps/api/src/policies/content.ts:49`. A link definition is refused only when the line starts with `[`: `^\s*\[[^\]]*\]:`. A definition inside a list item has a list marker first, so it passes.
- **What I ran:** `markupProblem()` from content.ts returned `null` (accepted) for these:
  - `- [x]: javascript:alert(1)\n\nSee [x] for details.`
  - `1. [x]: https://evil.example/login\n\nSee [x].`
  - a definition with a `data:text/html` address under a heading
  - bare `https://…` and `www.…` addresses, and e-mail addresses
- **Why it is a link:** in CommonMark a link definition may sit inside a list item and applies to the whole text, so `[x]` becomes a link. This is from the CommonMark spec (link definitions are allowed inside lists and block quotes). There is no Markdown library in the repository, so I did not render it. Bare addresses become links under GFM (extended autolinks).
- **What someone can do:** a manager, or someone using a manager's account, can put a clickable link into a controlled document that staff must open and acknowledge. It could point to a fake sign-in page, or be a `javascript:` link if the renderer lets it through.
- **Why it matters:** content.ts promises that "no stored text depends on the renderer to be harmless", and that promise is broken. `content.spec.ts` does not test this case.
- **Smallest fix:**
  - Refuse `]:` anywhere: `/\]\s*:/` returns `'link'`.
  - Either refuse `https?://`, `www.` and e-mail addresses, or require the web renderer to switch GFM autolinks off and to filter link addresses.
  - Add these inputs to `content.spec.ts`.

### 2. Medium: the same-person rule can be bypassed by withdrawing and re-creating a version
**Read from the code; no test covers it.**
- **Where:** `/home/user/Trustline/apps/api/src/policies/documents.service.ts:1055` and `:1081`. For a document never published, `createVersion` copies the text of the latest version (`all[0]`), which may be the withdrawn one. It then sets `contributors: [user.id]`, so whoever wrote that text is no longer recorded as a contributor.
- **The steps:**
  1. Manager A (for example an Administrator, who also holds `policies.approve`) writes version 1 of a new document.
  2. A withdraws version 1 (`POST …/v1/withdraw {revision}`).
  3. Manager B, a colleague or A's second account, calls `POST /documents/:id/versions {}`. Version 2 holds A's text word for word, with `contributors = [B]`.
  4. B submits version 2 (`POST …/v2/submit`).
  5. A approves it with their own password: `POST …/v2/approve {password, revision}`. `decision()` at `:1387` checks only `version.contributors`, so A is not refused.
- **What someone can do:** the author signs the approval of their own text, which defeats the spec's first rule. B does not have to collude: restarting a withdrawn draft is a normal thing to do.
- **Smallest fix:** in `createVersion`, when the copied version is not the published one, set `contributors` to `[...base.contributors, user.id]`. Add a test: withdraw, re-create as someone else, the author approves, expect 403 `same_person`.

### 3. Low: one person can sign both steps of a run
**Read from the code.**
- **Where:** `/home/user/Trustline/apps/api/src/policies/documents.service.ts:1379-1389` (`decision()`) and `approval-engine.service.ts:316-327` (`start()`). Only the version's contributors are left out. Someone who decided an earlier step of the same run is not.
- **What someone can do:** a person holding both the Quality officer and Administrator roles, or a route that names one role twice, can sign "reviewed" and then "approved" on one version. The control block then shows two approvals from one person.
- **Status:** the engineer flagged this as needing a decision. The spec does not forbid it, but a hospital quality department will expect two different people.
- **Smallest fix:** in `decision()`, refuse with 403 `same_person` when `run.steps.some(s => s.decidedBy === auth.user.id)`. In `start()`, also leave out the assignees already counted for earlier steps when checking for `no_assignee`.

### 4. Low: one version request can block the shared API for about 0.65 s, for every client
**Measured on the code.**
- **Where:** `/home/user/Trustline/apps/api/src/policies/content.ts:108-136`. `diffLines` falls back to a whole-section comparison only above 2,000 lines per side. Below that it fills an (a+1)×(b+1) table.
- **What I measured:** sections of 2,000 short lines, 33 section-languages, within the 200,000-character limit. One `compareVersions` call took 643 ms on the event loop.
- **Who can trigger it:** it runs on every `GET …/versions/:id` that is not the published version. That includes drafts, versions in review and superseded versions, opened by managers, `view_all` holders and assignees.
- **What it takes:** the published version must also be long, so it needs one approved publication.
- **Impact:** availability only, but the API process is shared by every hospital.
- **Smallest fix:** decide by size, not line count. Above about 250,000 table cells (`a.length * b.length`), compare the section whole, or use a Myers diff.

### 5. Low: published text is protected only by the application code, not by the database
**Confirmed in the database, apart from the last point.**
- **Versions can be changed:** `trustline_app` has full UPDATE on `document_versions`, including `content`, `sections`, `change_summary` and the acknowledgement fields, whatever the status.
- **Approval steps can be changed:** it also has full UPDATE on `approval_run_steps`, including `decided_by` and `signature_id`. I checked both with EXPLAIN as the app role, and the permission checks passed.
- **The published-version key is loose:** `documents_published_version_fk` is `(tenant_id, published_version_id) → document_versions(tenant_id, id)`. It keeps the tenant but not the document, so a document could point at another document's version. Migration 0039, lines 8-13.
- **Scheduled publishing skips the signature check:** `publishScheduled` publishes without calling `assertSigned` (`/home/user/Trustline/apps/api/src/policies/policy-check.service.ts:319`). It is checked only when the version is scheduled. (This one is read from the code.)
- **What someone can do:** nothing through the API today. But one bug or an SQL injection elsewhere could change approved or published text, and nothing in the database would stop it. The live `contentHash` would simply stop matching the signatures.
- **Smallest fix:**
  - A trigger that refuses changes to `content`, `sections`, `change_summary`, `acknowledgement_required` and `acknowledge_within_days` when `OLD.status <> 'draft'`.
  - Column-level UPDATE on `approval_run_steps` (status, activated_at, due_at, decided_by, decided_at, comment, signature_id), and a trigger refusing changes to a step that has already been decided.
  - Call `assertSigned` in `publishScheduled` and skip the version if it fails.
  - A three-column key: `(tenant_id, id, published_version_id)` → `document_versions(tenant_id, document_id, id)`.

### 6. Low: a document's metadata can change during review and after approval
**Read from the code.**
- **Where:** `update()` in `/home/user/Trustline/apps/api/src/policies/documents.service.ts:859-881` has no check on the version's status.
- **Title:** the title is not in the signed hash (a stated choice). It can change after the approvals, and the control block still shows them.
- **Owning unit:** it can change while a run is in progress. `isAssignee` reads the current `ownerUnitId`, so moving the document changes who may decide a role step. A manager covering two units could move a document under review to the unit where a chosen person holds the approving role. This needs `policies.manage` over both units.
- **Smallest fix:** refuse `ownerUnitId` changes (409) while a version is `in_review`. Consider putting the title in the signed content.

## Checked and found sound

**Tenant isolation (confirmed in the database)**
- All 12 new tables have row-level security on, with the `tenant_isolation` policy for `trustline_app`. `notifications` keeps its policy.
- As `trustline_app` with no tenant set, `documents` returns 0 rows. With a tenant set, it returns only that tenant's rows.
- Every foreign key includes `tenant_id`, including `notifications_document_fk` and the mutual key.
- The tenant always comes from `auth.tenant.id`.
- `trustline_platform` is refused on every new table.

**Grants (confirmed in the database)**
- They match migration 0039 exactly.
- UPDATE and DELETE are refused on `signatures`, `document_reviews` and `audit_log`.
- DELETE is refused on documents, versions, runs and steps.
- On `document_acknowledgements`, only the four listed columns can be updated.

**Built-in roles (confirmed in the database)**
- Administrator and Quality officer hold all four policies permissions in every client. Department manager holds view, approve and view_all. Reporter holds view.
- Only `is_system` roles were changed, and exactly one audit entry exists per pre-existing client, with no actor.

**Signatures (confirmed in the database)**
- I recomputed `contentHash(signedVersion(...))` for all 27 version signatures in the database, and every one matches.
- Content cannot be edited outside draft, recall and resubmit starts a new run, and publishing requires every step of the approving run to have signed the current hash.

**Password re-entry (read from the code)**
- `confirmPassword` uses the same columns, counter, five-attempt limit and 15-minute lock as sign-in, under a row lock.
- It hashes before checking the lock, so locked and wrong answers take the same time. An account without a password burns the same time.
- The password is never stored, logged or audited; the audit has `{locked, purpose}` only.
- Everything is checked again under the lock after the password.

**Concurrency (read from the code)**
- Decisions, publishing, recall, withdraw and acknowledging all lock the document row first, then compare the revision.
- A second approver gets 409 `stale_version`, and there is a test for it.
- Out-of-order decisions get `not_current_step` or `not_assignee`.

**Who sees what (read from the code)**
- One `visible()` condition is used for the list, count, summary, search and notifications.
- Section-text search matches only versions the caller may open, so partial matches reveal nothing from drafts or restricted documents.
- Readers see the published version only. Retired documents need full sight. An assignee loses sight when the run ends.
- `inProgress`, the run, comments and acknowledgement figures need full sight. `GET …/acknowledgements` answers 404 when the document is hidden and 403 only when it can be seen.
- A scoped manager of another unit gets 404 for drafts there, and 403 `outside_scope` only on documents they can already read.
- Notifications carry the number and version only. The title is shown only while the reader can open the document.
- The list's sort is chosen from fixed options and every value is a bound parameter. The two `sql.raw` uses are constants.

**Scope and settings (read from the code)**
- Types, categories and routes need `policies.manage` for the whole organization.
- Moving a document needs `covers()` on the new unit.
- Routes refuse roles or people without `policies.approve`.

**Module and suspension (read from the code)**
- Notification kinds are mapped to `policies`, and `seesDocument` is false when the module is off.
- Only acknowledging is open while suspended.
- The daily check skips clients Trustline suspended (`tenants.status`) and those without the module (`mayUse`). It uses `withTenant`, `SKIP LOCKED` with marks, `ON CONFLICT DO NOTHING`, and a 30-second statement limit. It logs the client id and the kind of failure only. Tests pass their own client ids to `run(now, [id])`.

**Notifications and incidents (confirmed in the database and the code)**
- The new check `notifications_about_one_thing` is as the migration says.
- Incident notifications get `document: null`. Incident visibility files are unchanged.

**Other**
- `/people` (read from the code): it gives any `policies.manage` holder, even one scoped to a unit, names and units of all active staff, and who can approve. That is needed to pick an owner; I note it but do not count it as a finding.
- Request bodies are limited to 100 kB (Nest's default).
- No secrets in the diff. The seed uses `example.invalid` addresses and made-up names.

## Not checked
- **Rendering.** The web does not render documents yet, so whether a renderer turns finding 1 into a clickable or script link is not tested. It is from the CommonMark and GFM specs.
- **Timing and concurrency.** I measured no response times, and tested no concurrent requests live.
- **Test suite.** I did not run it, as instructed.
- **Snapshots.** I did not compare the drizzle snapshot JSON with the SQL; I checked the live database instead.
- **Leftover test client.** The shared database has an extra client, `zz-maya-pol-check`, probably left by a test run. Someone should check that the cleanup removes it.

**Verdict:** no tenant-isolation, visibility or privilege-escalation hole. Fix the markup bypass (1) before the web renders documents, and the same-person bypass (2) before release.