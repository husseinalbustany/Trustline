# Security review 15: risk management steps 1 and 2 (e163d95..c6349b1)

## Decisions: fix everything
- M1: the audit trail and the timeline record only which text fields changed (and that a reason was given), never the text itself; rationale on ratings is kept out of the audit; a rating's rationale can be corrected (redacted) by a manager of the risk, audited without the text, with the timeline showing "corrected".
- L1: linking a document needs the caller to be able to read it; to a reader who may not open a restricted document, it shows only as "a restricted document" (no number, state or dates); the unknown_document answer stays, as the caller must be able to read the document anyway.
- L2: the matrix preview counts need requireEverywhere('risks.manage'); others get preview: null.
- L3: refuse rating the current below the stored target (target_above_current), and count such risks in putInUse's result and flag them.
- L4: record old and new wording of labels, descriptors, frequencies and band names when the matrix is in use.
- For the business, decided: a proposer may not accept their own proposal (refuse, same_person) from now on; the migration audit entry lists exactly what each role got; the rating route refuses while suspended where moves offers nothing; at most 12 impact domains in total. Department manager grants: noted in the spec as a deployment check.

## Security review: risk management steps 1 and 2 (`risk-management-api`, e163d95..c6349b1)

I found nothing critical or high. One finding is medium (privacy) and four are low. Tenant isolation, who sees what, permissions on every route and the database rules all hold. I checked the database rules against `trustline_risk` directly.

**Test run.** I ran `risks.e2e-spec.ts` and `risks-migration.e2e-spec.ts` against `trustline_risk` only. The migration suite passed. In `risks.e2e-spec.ts`, 15 tests passed, then the "register" block stopped at the first `POST /risks` with a 500, which skipped the other 18. The server log shows the cause: `column "review_id" of relation "risk_ratings" does not exist`. That column comes from uncommitted step-3 work in the same worktree (`schema.ts` modified, plus untracked migrations 0062 and 0063). Another agent applied those two migrations to `trustline_risk` while I was working; I did not apply them. This is not a fault in c6349b1, but it means I could not get a clean run of the committed code. Fix it before merging: give each agent its own worktree and database, or re-run after a clean checkout.

---

### Medium

**M1. Text people write about a risk is copied into the sealed audit trail and the insert-only timeline, so a patient detail typed by mistake can never be removed.**
- `apps/api/src/risks/register.service.ts:785-789`: `risk_updated` stores the old and new title, cause, event, consequence, references and keywords, plus the reason, in both `risk_events` and `audit_log`.
- Same file, lines 929-932: `risk_proposal_rejected` stores `reason`.
- Same file, lines 1058-1060: `risk_control_updated` stores the old and new `description`, plus `reason`.
- These fields are registered at `apps/api/src/audit/actions.ts:153`, `:155` and `:158`.
- `risk_ratings.rationale` is also kept forever: the app role has no UPDATE on `risk_ratings` (0061 line 23).

Scenario: a department manager writes "Mrs X, bed 12, fell twice" in `cause`, sees the warning, and corrects it.
- The original text stays in `audit_log`. The hash chain and the absence of UPDATE or DELETE rights for the app mean nobody can redact it.
- It also stays in `risk_events`, and `GET /risks/:id` shows it in the timeline (lines 593-603) to every reader: the owner, committee members and anyone with `risks.view`.

This goes against CLAUDE.md ("no real patient data") and against the incidents module, which deliberately keeps notes out of the audit log (`incidents.service.ts`: "The note may hold sensitive detail, so the audit log gets none of it"; "Ids, levels and flags only").

Smallest fix:
- For text fields, audit and record in the timeline only which fields changed (for example `{ cause: { changed: true } }`), never the text.
- Leave reasons out of the audit, or record only that a reason was given.
- If the business wants the history of the wording, keep earlier versions in a table that can be corrected, not in the sealed trail.

### Low

**L1. Any risk owner or manager can link a restricted document they cannot read, and its number and review state then show to every reader of the risk.**
- `apps/api/src/policies/linked-documents.ts:42-48`: `linkable()` checks only that the document is active. It does not check whether the caller may read it.
- `apps/api/src/risks/register.service.ts:242-248` and `apps/api/src/risks/settings.service.ts:238-241` rely on that check.
- `describe()` (linked-documents.ts:76-89) then returns the number, status, version, `nextReviewOn` and `pastReview` of restricted documents, and of retired ones, to any risk reader. It withholds only the title.
- Through `frameworkDocument` in `GET /risks/settings` (settings.service.ts:206-219), every user with the module sees it, Reporters included.
- `POST /risks/:id/controls` also answers `unknown_document` or 201, which tells the caller whether a document id is an active document.

In the policies module, a restricted document is not visible at all to people outside its audience. The spec does say the number shows to any reader, but it never said someone who cannot see a document may link it.

Fix:
- Pass `auth` to `linkable()` and require the policies `visible(viewer)` rule for the person linking.
- Ask the business whether readers who may not open a restricted document should see anything more than "a restricted document".

**L2. The matrix preview counts the risks of the whole organization for any unit manager.**
- `apps/api/src/risks/risks.controller.ts:82-86` uses `requirePermission(req, 'risks.manage')`, so a grant for one unit is enough.
- `apps/api/src/risks/settings.service.ts:296-309, 615-641`: the preview counts every open and proposed risk in the organization, with no visibility filter.

Scenario: the D1 manager reads `GET /risks/settings/matrices/:draftId` while the Quality officer edits the draft one cell at a time. Each `risksChangingBand` value tells them how many risks across the hospital sit in that cell. That includes the organization's own risks and proposals they may not see.

This is the one count that does not go through `visibility.ts`, which the spec says every count must use. Fix: use `requireEverywhere` for the preview (only those managers can put a version in use), or return `preview: null` to anyone else.

**L3. A target above the current rating can still come about.**
- `register.service.ts:817-819` (via `rateAll` at 265-272) checks the target only when a target is being rated. Rating the current kind below the existing target is accepted. Sequence: rate target at 6 with current at 6, then rate current at 3; the target is now above the current rating.
- `settings.service.ts:727-747`: re-banding can also leave the target's band above the current band. With current (1,5) and target (2,2), neither cell dominates the other, so the order check does not stop it.

It gains no one access, but the register breaks the rule the contract states (`target_above_current`). Fix:
- In `rate()` for the current kind, compare against the stored target and refuse, or flag it.
- In `putInUse`, count such risks in the result.

**L4. Wording changes to the matrix in use are audited without their old and new text.**
- `settings.service.ts:453-514` and `596-604` record only `{axis, level}`, `{id}` and `{code, changed: ['name']}`.
- A label or descriptor of the version in use takes effect at once and changes what every existing rating on it means (for example, renaming impact 5 "Catastrophic" to something milder). The trail cannot show what a level said when a risk was rated.
- This is the organization's own text, with nothing personal in it. Fix: record the old and new label, descriptor, frequency and band name when the status is `in_use`.

### For the business, not defects

- **Proposals.** The person who raised a proposal can accept it and name themselves owner (`acceptProposal`, register.service.ts:854-908). This is harmless in step 2, since only managers can create risks and could open it directly. Revisit at step 7, when proposals come from incident handlers who may not be managers.
- **Department manager grants.** 0061:231-235 gives every built-in Department manager `risks.manage`. A client that granted that role for the whole organization will find those people can now change the matrix, tolerances and committees. Check the existing clients' grants before deploying.
- **Imprecise migration audit entry.** The `built_in_roles_changed_by_system` entry (0061:248-258) lists all three permissions for all four roles. In fact the Department manager and the Approving authority each got two.
- **Suspended clients.** A manager can still record a current rating on a proposed risk while the client is suspended, although `moves` offers nothing for it (moves.ts:29-31 versus `rate()`). Trivial.
- **No cap on impact domains.** Each `PATCH` may add up to 12 more, and nothing limits the total (input.ts:162, settings.service.ts:490-493). Only whole-organization managers can do this.

---

### Checked and sound

- **Who sees what** (`apps/api/src/risks/visibility.ts`):
  - A unit's register reaches the units beneath it.
  - A null unit (a risk of the whole organization) needs `'all'` in both `within()` and `reaches()`.
  - Proposed and rejected risks are read only by their managers and by whoever raised them; closed risks only through a permission.
  - Committee membership is read from live grants for the whole organization. No route sets `escalated_to_committee_id` yet, so that path is not used.
  - Every lookup goes through `lock()` or `view()` with `visible()`, so a risk out of reach is 404 and one in reach but not the caller's to change is 403.
- **List, counts and pickers:**
  - The list's total, filters (`unitId`, `ownerId`, `committeeId`, `q`, `band`, `review`), sorting and name maps all apply `visible()` first.
  - `q` is a bound parameter with its wildcards escaped.
  - The people and role pickers return names and unit ids only, as the policies pickers do.
- **Permissions on every route:**
  - Every settings write uses `requireEverywhere('risks.manage')`.
  - Routes only a manager uses check `risks.manage` first, so the 403 does not depend on the id given.
  - Rating and controls check owner or manager on the locked row, and the owner works only on open risks.
  - Moving a risk needs `risks.manage` over both units.
- **Settings readable by everyone:** they contain criteria and role ids only, apart from L1.
- **Matrix life-cycle:**
  - Ratings, risk creation and accepting a proposal hold `FOR SHARE` on the matrix in use. `putInUse` takes the matrix in use, then the draft, then the risks, all `FOR UPDATE`, so the steps cannot interleave. I found no deadlock order.
  - A rating that waits behind a put-in-use gets 409 `no_matrix` (harmless), and the database trigger refuses a rating on any other version anyway.
  - Partial unique indexes keep one draft and one version in use per client.
  - `highest_band` only rises and `closure_sign_off_needed` sticks, both enforced in the database. Re-banding is for whole-organization managers only, and is audited with the risk ids and written to each risk's timeline.
- **Database rules,** probed as `trustline_app` in transactions I rolled back:
  - Changing the cells or band rules of a version in use is refused.
  - A version cannot go back to draft.
  - A category of another client is refused by `risks_category_fk`.
  - An attempt to lower `highest_band` or clear the sign-off is overridden.
  - The app role has no UPDATE or DELETE on `risk_ratings`, `risk_events` or `audit_log`, and no DELETE on any risk table. `trustline_platform` has nothing.
  - All 12 tables have RLS and one `tenant_isolation` policy.
  - Every trigger function has `search_path = pg_catalog, public, pg_temp` and none is `SECURITY DEFINER`; the app role cannot create objects in `public`.
  - Every link has a composite key with the tenant, including the five-column keys from ratings to cells.
  - The CHECKs on scores, complete ratings, open-means-rated and rejected-with-reason are present.
- **Migration 0061:** grants, triggers, backfill of the built-in roles and defaults, each step safe to repeat and audited once per client (the migration test passed). New clients get the defaults through `ensureRiskDefaults()` under `withTenant`.
- **Input:** every body and query is a strict schema. Client text is stored per language through `localizedText` / `optionalLocalizedText` with control characters refused. Length limits cover all free text: names 200, title 300, cause, event and consequence 4000 per language, control description 2000, wording, rationale and reasons 1000, up to 30 references of 120 and 30 keywords of 60. Names require the default language. No query is built by joining strings.
- **Audit:** every change is audited in its own transaction, apart from the content issues in M1 and L4.
- **Secrets:** nothing committed; only `.env.example` is tracked.

### Not checked

- A clean e2e run of c6349b1 itself (see "Test run").
- The unit specs `tenant-isolation.spec.ts` and `actions.spec.ts`: the worktree's `schema.ts` is not the committed one, so a run now would not test c6349b1.
- Behaviour of `whileSuspended` and the global suspension guard beyond reading the code.
- Whether existing clients have Department manager grants for the whole organization; that needs production data.

The probe SQL I used is in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/probe1.sql` and `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/probe2.sql`. I changed no files in the repository.