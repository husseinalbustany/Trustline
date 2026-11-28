# Security review 21: AI insights (f6023d4..bfbd9c9)

## Decisions: fix everything
- H1: record the ids of every incident sent; show a duplicates suggestion only to a viewer who sees all of them in full; filter passages per match; use returns the filtered view; e2e with two triagers.
- M1: tests save and restore the gate; cleanup never nulls cleared_by while cleared (turn the gate off); CHECK requires cleared_by when cleared; e2e that a fully configured client is refused not_cleared on ask, arrival and daily.
- M2: column-level INSERT on ai_agreements without confirmed_*; trigger refusing used/dismissed/decided_*/specialist at insert on ai_suggestions.
- M3: no medical option, sign or confirm while the agreement text is a draft or insights are not cleared; the version changes with draft:false.
- L1 to L7 as proposed; L4: the specialist is notified and must hold incidents.triage or a clinical role; L5: re-enabling needs a new signature. Duplicates prompt: never guess who wrote a report. Passage minimum 12 characters.

# Security review 21: AI insights on incidents (f6023d4..bfbd9c9)

I found 1 high, 3 medium and 7 low problems. The gate holds in the running code: daily runs, on-arrival runs and asking all stop while it is off. Two other things are weak:
- what a stored suggestion shows to a second viewer;
- the two-step medical agreement.

**Before you read on:** the worktree has uncommitted work from another agent (the assistant step: `src/assistant/`, migrations 0078 and 0079, edits to `ai-sources.service.ts`, `client-ai.ts`, `permissions.ts` and `scope.ts`). I reviewed the commit itself, checked out with `git archive bfbd9c9` into `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r21/tree`. Line numbers below are the commit's, under `apps/api/`.

**Tests**, all against `trustline_ai`:
- 192 of 193 passed: `test/ai-insights.e2e-spec.ts`, `test/ai-foundation.e2e-spec.ts`, and the specs under `src/insights`, `src/ai`, `src/exports`, `src/audit` and `src/identity`, plus `tenant-isolation.spec.ts` and `security-definer.spec.ts`.
- The one failure is `exports/coverage.spec.ts`. It fails on the `assistant_*` tables, which the other agent's 0078/0079 put into `trustline_ai`. It is not caused by this commit.
- That run used the working tree. My probe ran from the exported commit.

**My proofs:**
- the probe `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r21/tree/apps/api/test/zr21-probe.e2e-spec.ts`, with its output in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r21/out.txt` (prefix `zr21`, cleaned up afterwards);
- one psql transaction as `trustline_app`, rolled back.

I changed no files.

## High

**H1. A stored duplicates suggestion shows other departments' reports to a triager who cannot open them.**
- **Where:** `src/insights/suggestions.service.ts:409` (evidence passages of all matches merged), `:510` (passages always kept), `:486` (`use` returns the raw content).
- **Cause:** whoever asks for duplicates gets candidates from everything they see in full. Anyone who may triage the subject incident reads the stored suggestion later:
  - `views()` removes the matches the viewer cannot open, but keeps every `passage` in `evidence`;
  - `POST /suggestions/:id/use` returns `updated.content` as it was stored, not as filtered.
- **Proven (P1):**
  - A whole-organization triager asked for duplicates on an OPS incident. The OPS-only triager gets 404 on the MED report.
  - The OPS triager's panel still showed `"patient in bed 12 was moved"` and `"Ceiling leak in MED"` from the MED report.
  - `use` returned `draft.matches` with the MED report's `incidentId`, its reference `INC-2026-00003`, and its reason ("A leak in MED where a patient in bed 12 was moved.").
- **Same problem by another route:** a visible match's `reason` can repeat what a hidden candidate says, either naturally or through text written into that candidate. This also affects automatic runs, which read by place rather than by viewer.
- **Fix:**
  - Record on the row the ids of every incident sent to the model.
  - Show a duplicates suggestion only to a viewer who sees all of them in full. Otherwise leave it out, as when no match is visible.
  - At minimum, keep passages per match and filter them with the match, and return `view.content` as the draft.
  - Add an e2e test with two triagers of different scope.

## Medium

**M1. The tests clear the platform gate, never set it back, and erase who cleared it.**
- **Where:**
  - `test/ai-foundation.e2e-spec.ts:84-85` ("never set back");
  - `test/ai-insights.e2e-spec.ts:204`;
  - `test/cleanup.ts:157-161` sets `insights_cleared_by` to null and leaves `insights_cleared = true`. The CHECK at `0076:97` does not require `cleared_by`.
- **Seen in `trustline_ai` now:**
  - cleared, basis `legal_review`;
  - reference "Legal opinion eaa794d1, accepted in writing";
  - `insights_cleared_by` null.
- **Scenario:** one test run against any shared, demo or staging database clears insights for every client in it, including the seeded hospitals, and leaves a clearance with no author. Also, because the foundation test leaves it cleared, the e2e suite never checks that insights are refused while the gate is off. Only `gate.spec.ts` checks `offerOf` as a unit.
- **Fix:**
  - Save the gate in `beforeAll` and restore it in `afterAll`.
  - Never null `insights_cleared_by` while it is cleared: either turn the gate off in cleanup, or require `cleared_by` in the CHECK.
  - Add an e2e test that a fully configured client gets 409 `not_cleared` and nothing is sent, on asking, on arrival and daily.

**M2. The application role can insert an agreement that is already "confirmed by Trustline".**
- **Where:** `drizzle/0077_ai_insights_grants_and_safeguards.sql:13` grants INSERT on every column. `ai_agreements_signed_once` covers only UPDATE.
- **Proven (as `trustline_app`, rolled back):** `INSERT … confirmed_by, confirmed_at, confirmation_reference` succeeded and returned `confirmed = t`.
- **A platform admin id is readable by the app:**
  - `ai_platform_settings.insights_cleared_by`, on which the app has SELECT;
  - `platformAdminId` in the client's own `ai_medical_agreement_confirmed` audit entry.
- **Scenario:** SQL injection anywhere in the API skips Trustline's confirmation, one of the two steps decision 5 requires. The medical option becomes effective.
- **Related:** `ai_suggestions` INSERT also lets the app write rows already `used` or `dismissed`, with any `decided_by`.
- **Fix:**
  - Grant INSERT on `ai_agreements` column by column, leaving out the three `confirmed_*` columns.
  - On `ai_suggestions`, a BEFORE INSERT trigger or CHECK that refuses `used`/`dismissed` and any `decided_*` or `specialist_id` at insert.

**M3. The draft agreement can be signed for real, and confirmed, while it is a draft and while insights are not cleared.**
- **Where:**
  - `src/insights/settings.service.ts:86`: `medical` depends only on `medicalOptionAllowed` and the plan extra, not on `insightsCleared` or `MEDICAL_AGREEMENT.draft`;
  - `:288-298` (`sign`);
  - `src/platform/platform-tenant-ai.controller.ts:242-257` (confirm).
- **Scenario:**
  - The client is shown the switch and the "DRAFT FOR LEGAL REVIEW" text before any legal view.
  - A signer commits it, and staff confirm the addendum.
  - The day the gate is cleared, clinical suggestions are already in force on a text no lawyer accepted.
  - If the lawyers only flip `draft: false` and keep the version string, nothing pauses.
- **This contradicts:**
  - the spec: "a lawyer reviews it before any client may sign it for real";
  - decision 5: "until that is done the switch is not shown".
- **Fix:**
  - Return `medicalOption: null`, and refuse sign and confirm (409), while `MEDICAL_AGREEMENT.draft` is true or insights are not cleared.
  - Make the version part of what `draft: false` changes.

## Low

- **L1. A dismissal reason goes into the immutable audit trail.**
  - **Where:** `suggestions.service.ts:210` and `audit/actions.ts:183`.
  - **Cause:** up to 500 characters of free text, which can name a patient, are copied into `audit_log.changes`, and the row itself is also unchangeable.
  - **Conflicts with:** the incidents rule "The note may hold sensitive detail, so the audit log gets none of it" (`incidents.service.ts:1800`).
  - **Fix:** record `hasReason: true` only.
- **L2. The public form can use up 80% of a hospital's insights allowance.**
  - **Where:** `insights/check.service.ts:130-137`.
  - **Cause:** under `on_arrival`, each public report costs 2 runs. At 60 public reports an hour (`public-limits.ts:22`), that is 120 runs an hour.
  - **Result:** the Professional plan's 500 reaches 80% in about 3.5 hours, Enterprise's 2,000 in about 13 hours. Automatic triage for real reports then stops for the month, and an anonymous sender's text is fed into the other reports' duplicate runs. With an unlimited allowance (`:147`), only the spending limits stop it.
  - **Fix:** a per-client hourly cap on automatic runs. Apply it to every channel alike: skipping public reports would show the channel through which reports lack "Suggested automatically".
- **L3. Only `PERSON_n` makes a suggestion withheld.**
  - **Where:** `prompts.ts:180`.
  - **Proven (P3):** a closure summary "Contact [EMAIL_1] or [PHONE_1]" was shown, with a staff email and phone put back, in a text written for the reporter.
  - **Fix:** treat any placeholder kind as naming someone, or at least EMAIL and PHONE.
- **L4. The specialist is anyone active, named without their knowledge.**
  - **Where:** `suggestions.service.ts:177-183`.
  - **Cause:** any active user may be named, including oneself. The person named is not told and does not confirm.
  - **Scenario:** a triager names a consultant as having reviewed a clinical suggestion, and the record says so.
  - **Fix:** notify the specialist and show it in their history. Better, have them confirm, or require a permission or role.
- **L5. Withdrawing the agreement is only the switch.**
  - **Cause:** any `settings.manage` holder can switch the option back on without a new signature, even after the signer has left. The agreement itself cannot be withdrawn.
  - **Also:** the portal never sees who signed, so staff cannot check the addendum's signatory against the person who signed in the product.
  - **Fix:** switching it on again after a switch-off requires a new signature (or at least `ai.medical_agreement`). Show the signer's role or name to staff, or record the addendum's signatory at confirmation.
- **L6. The portal's counts function shows activity in near real time.**
  - **Where:** `0077:80-89`.
  - **Cause:** `ai_suggestion_outcomes(p_tenant, p_since)` accepts any `p_since`, so the portal can poll any client's suggestion activity, `withheld` and `failed` included, minute by minute. This is the same point as review 13 M1.
  - **Fix:** take a month (or nothing) and work out the month's start inside the function. Return only `open`, `used`, `dismissed` and `empty`.
- **L7. `use` and `dismiss` ignore the gate and the client's switch.**
  - **Where:** `suggestions.service.ts:474-480`.
  - **Cause:** after Trustline withdraws clearance or the client switches AI off, the panel hides suggestions, but `POST /suggestions/:id/use` still returns their content.
  - **Fix:** refuse with the panel's reason when `!state.offered || !state.active`.

## Anonymity, names and the rest of what you asked about

**Reporters and anonymity:**
- **Fields sent** (`ai-sources.service.ts`, `prompts.ts:114-148`):
  - reference, type, category, recorded harm, place, `occurredAt`, status, description, immediate action;
  - for the closure summary and causes only: the reporter-visible timeline (kind, statuses, times) and comments visible to everyone, with no author.
- **Never sent:** `reportedBy`, `channel`, `followUpCodeHash`, `reportedAt`, `reportStartedAt`.
- The e2e check that a named and an anonymous report produce the same labels is sound.
- **Duplicates:** no reporter data reaches the model. But nothing stops its free-text `reason` from guessing that two reports were written by the same person. Add to `TASKS.duplicates` (`prompts.ts:88-92`): "never say or guess who wrote a report, or whether two were written by the same person".
- **Inaccurate comment, no leak:** `ai-sources.service.ts:276-283` says the reporter is never looked up. In fact a named reporter's own comment creates a `commented` event with `actorId` = the reporter, so they enter `people`. The model sees nothing different, because `admit()` already removes every user's name (`ai.service.ts:464`). Correct the comment, or exclude the reporter's comment events.

**Names:** every user goes through name removal. The free-text names of patients and visitors remain the known limit. Withholding leaks nothing: a withheld suggestion returns `suggestion: null`, exactly like one with nothing visible. Its outcome appears only in the audit entry and the internal status.

**Prompt injection:** `asData` defuses `<record` and `</record>`. Every record text goes through it. Answers are checked with Zod, and lines refuse control characters. Passages must be found word for word in the original records. A passage of 3 characters counts as found, which is weak evidence; consider 12 characters or more.

**Sound (checked by reading, and by tests where noted):**
- **The gate:**
  - `offerOf` gives `not_cleared` in `admit()`, `state()`, the automatic runs (`runAutomatic` returns early while `!state.active`) and the panel;
  - no migration or seed sets it;
  - only the portal role can write it (grants checked);
  - the `entity_recognition` basis is refused;
  - every change is in the platform log.
- **Isolation:**
  - row-level security with `tenant_isolation` on all 3 new tables;
  - composite foreign keys to users, incidents and AI requests;
  - everything runs inside `withTenant`;
  - another client gets 404 (tested);
  - grants in the database match the migration;
  - the portal reaches no suggestion.
- **Who may do what:**
  - every route checks `incidents.triage`, then the incident's visibility (404), then that the person may triage it (403);
  - settings need `settings.manage` for the whole organization;
  - the agreement needs `ai.medical_agreement` for the whole organization;
  - no built-in role holds it, and the Administrator gets 403 (tested);
  - nobody can grant it to themselves (`cannot_change_self`, `cannot_change_own_role`);
  - an external reviewer cannot hold it (`READ_ONLY_PERMISSIONS`).
- **Use and dismiss:**
  - each is once only, with a row lock and the `ai_suggestions_written_once` trigger (tested by the owner role);
  - each is audited in the same transaction;
  - neither writes to the incident.
- **Medical decision:**
  - an incident with no category counts as clinical (`coalesce(..., true)`);
  - clinical incidents are left out of duplicates unless the option is in force;
  - asking is refused before anything is sent;
  - existing suggestions are hidden;
  - marking is audited;
  - the specialist is recorded.
- **Agreement:**
  - the version and hash of the text shown are checked;
  - the password or PIN goes through `confirmPassword`;
  - one signature at a time (advisory lock);
  - the text and its hash are stored and cannot change;
  - confirmation is once only and for the version in force, in both logs.
- **Automatic runs:**
  - once per report and kind (partial unique index, with the row as the claim);
  - the daily run is claimed per day;
  - the 80% stop;
  - no notification;
  - no actor.
- **Definer function:** `search_path = pg_catalog, public, pg_temp`, qualified table names, EXECUTE for the portal role only.

## Not checked

- How a real model behaves: whether it actually writes placeholders, or comments on who wrote a report.
- Load and races between processes beyond reading the code.
- The screens, which are not built.
- The uncommitted assistant work in the worktree.
- The gate's state in `trustline` and `trustline_risk`, which I did not touch. In `trustline_ai` I left it as I found it: cleared, by the tests.
