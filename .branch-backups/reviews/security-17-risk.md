# Security review 17: risk management steps 3 to 5 (c6349b1..0255823)

## Decisions: fix everything
- M1: escalate() refuses a target with a lower or equal position when the risk is already before a committee (409 already_escalated); moving down only through de-escalate.
- L1: a committee's review may change the rating, but cannot set treatment (managers only; "accept" only through the signed acceptance in step 6); the person who lowered the rating in a review cannot de-escalate the same risk on the same day.
- L2: refuse same_person when completedBy is the verifier.
- L3: refuse switching a committee off while open risks are before it (409 committee_in_use); ignore switched-off committees in automatic escalation.
- L4: corrections cover the text of rejected proposals and finished actions, audited as { field } only.
- L5: keep reasons on the record in columns a manager can correct (never in the audit trail or timeline text); actions.md made consistent.
- L6: actionContext applies the same statuses as visibility.
- Also: rating inherent is not refused by target_above_current after a re-banding.

## Security review 16: risk management steps 3 to 5 and the review-15 fixes (`risk-management-api`, c6349b1..0255823)

**Verdict.** Nothing critical or high. One medium finding: a unit manager can take a risk off a higher committee's list by "escalating" it to a lower one. Five low findings. The review-15 fixes (M1, L1 to L4 and the smaller items) work as decided. Tenant isolation, row-level security, grants, composite keys, triggers and the email rules hold. I proved each finding below with a request against `trustline_risk`.

**How I tested.** Another agent has uncommitted step-6 work in the worktree again (`schema.ts`, `approvals/approval-engine.service.ts`, `approvals/signatures.ts`, `incidents/notifier.ts`). So I exported 0255823 to `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/clean-0255823`, linked the worktree's `node_modules`, and ran with the worktree's `.env` (all three URLs point at `trustline_risk`). I changed nothing in the repository.

**Results.**
- `risks-work`, `risks`, `risks-migration`, `notifications`, `risk-mail.spec` and `tenant-isolation.spec`: all pass. 120 of 121 tests passed overall.
- The one failure, `audit/actions.spec.ts` "holds every action stored in the database", is environmental. It needs at least one `audit_log` row, and `trustline_risk.audit_log` is empty right now because the test cleanups remove their rows.
- My two probe specs live only in the scratchpad copy (`apps/api/test/probe-rima.e2e-spec.ts` and `probe-rima-db.e2e-spec.ts`). Their output is in `scratchpad/probe1.log` and `scratchpad/probe2.log`; the suite output is in `scratchpad/suite.log`.

---

### Medium

**M1. A manager of one unit can move a risk down from a higher committee by "escalating" it to a lower one. This skips every rule for coming off a committee's list.**
- **Where:** `apps/api/src/risks/work.service.ts:224-245`. `escalate()` refuses only the committee the risk is already before (`:235`). `escalation.ts:68-101` then notifies only the new committee and the owner.
- **Scenario (proved, P1):**
  - An Extreme risk of D1 is escalated automatically to the governing body.
  - The D1 manager is refused `POST /risks/:id/de-escalate` (403: not a member, not a whole-organization manager, and still above the threshold).
  - The same manager sends `POST /risks/:id/escalate {committeeId: <risk committee>, reason: "x"}` and gets 200. The risk is now before the risk committee while still Extreme.
  - The governing body's member gets 404 on the risk, 0 items in their committee list, and no notification.
- **What this bypasses:** `still_above_threshold`, the rule that only a member or a whole-organization manager takes a risk off a list, and "a committee should see a risk come off its list". It undoes "never down to a lower committee" by hand. It is audited (`from` names the old committee), but nobody on the board is told.
- **No test covers it.**
- **Smallest fix:** in `escalate()`, when the risk is already before a committee, refuse a target with a lower or equal `position` (for example 409 `already_escalated`). A move down then has to go through `de-escalate`.

### Low

**L1. One committee member can re-rate an Extreme risk down to Low, set its treatment, and then take it off the list, with no owner or manager involved.**
- **Where:** `work.service.ts:104-117` (a committee's review accepts any current rating, target, treatment and controls) and `:261` (the same person may then de-escalate).
- **Scenario (proved, P4):** a board member sends a committee review with `current 1×2` and `treatment: 'accept'` (200, band low), then `POST /de-escalate` (200, `{access:'none', ...}`). The risk has left the board's list and the member can no longer see it.
- The spec does let a committee's review change the rating. The gap is that one person can do both steps, and that treatment `accept` can be set through a review although `PATCH` keeps treatment for managers only.
- **Fix, or decide:** refuse de-escalation by the person who lowered the rating in the same day's review, or let a committee's review only confirm the current rating. At step 6, make sure "accepted" comes from a signed acceptance, never from `treatment`.

**L2. The effectiveness check can be made by the person who completed the action.**
- **Where:** `apps/api/src/actions/actions.service.ts:410-417` checks only `action.ownerId`, not `completedBy` (`movesFor` at `:128-131` likewise).
- **Scenario (proved, P2):** a manager completes Doer's action ("I did it"), then verifies it as `effective`: 200, with `completedBy === verifiedBy`. A risk owner who also owns the action can do the same: reopen, reassign, complete, verify.
- **Fix:** also refuse `same_person` when `completedBy === who.userId`.

**L3. A committee can be switched off while open risks are before it. They then become invisible to its members and can stay stuck there.**
- **Where:** `settings.service.ts:1033-1045` checks only the bands of the matrix in use and the draft.
  - `visibility.ts:71` counts active committees only.
  - `escalation.ts:129-133` lets a switched-off committee with a higher position block automatic escalation.
- **Scenario (proved, P3):** a new matrix version stops sending High anywhere, the risk committee is switched off (200), and the risk keeps `escalatedToCommitteeId` set to it. Its members get 404. Only a whole-organization manager can still clear it.
- **Fix:** refuse switching a committee off while open risks are before it (409 `committee_in_use`). Also ignore switched-off committees in `afterCurrentRating`.

**L4. M1 corrections do not reach every text that cannot otherwise be edited.**
- `register.service.ts:629-631` refuses editing closed or rejected risks, so the title, cause, event and consequence of a rejected proposal can never be cleaned.
- `actions.service.ts:327` refuses editing a finished action, so the title and description of a completed, verified or cancelled action can only be fixed by reopening it.
- The correction kinds (`risks/input.ts` `correctionSchema`, `actionCorrectionSchema`) do not cover these fields.
- **Fix:** add these fields to the corrections, audited as `{ field }` only.

**L5. Reasons are required but kept nowhere, which contradicts `docs/specs/actions.md`.**
- **Where:** escalation and de-escalation (`work.service.ts:238-242`, `:272`), due-day moves (`actions.service.ts:367`), reopening (`:469`), and owner, unit or category changes (`register.service.ts:649`). Each stores only `reasonGiven: true`; the text is dropped.
- So "a reason is required" cannot be checked by anyone, and the measure's safeguard (why a due day moved) is gone.
- `actions.md:93-95` ("the timeline keeps … the reason") and `:199` (`action_due_changed (from, to, reason)`) still say otherwise. Spec decision 7 chose this for escalation and due-day reasons.
- **Fix, or decide:** keep the reason on the record in a column a manager can correct, as is already done for cancel and reject reasons. Otherwise correct `actions.md`.

**L6. An action's owner keeps reading the action, and the risk's reference, title and current band through it, after the action is verified or cancelled.**
- **Where:** `register.service.ts:1001-1011` (`actionContext`) applies no status filter. `visibility.ts:121-125` stops at `completed`.
- **Proved (P2):** after verification, Doer gets 404 on `GET /risks/:id` but 200 on `GET /risks/actions/:id`, which includes the risk's current band as it changes later.
- **Fix:** apply the same statuses in `actionContext`.

### Also worth fixing (not security)

Rating `inherent` is refused with `target_above_current` while a re-banding has left the stored target above the current rating (`rateAll`, `register.service.ts:183`).

---

### Checked and sound

- **Review-15 fixes:**
  - M1: text fields are recorded as `{changed:true}` and reasons as `reasonGiven`. No rationale or comment appears in the audit trail or the timeline. Corrections are audited as `{kind, ratingId|reviewId|controlId}` or `{field}`, are for a manager of the risk, and give 404 for another risk's rating, review or control. The app role may update only `risk_ratings.rationale` and `risk_reviews.comment` (probed: score and `reviewed_by` are refused with 42501).
  - L1: `linkable()` uses the policies `visible()` rule, and a restricted document the reader may not open shows only as `restricted:true`.
  - L2: preview needs `covers(…, null)`.
  - L3: current below the stored target is refused, and `putInUse` counts and flags such risks.
  - L4: wording changes are recorded from and to.
  - Smaller items: `same_person` on accepting a proposal; the 0061 entry is per role and written before the update; the suspended rating refusal; the 12-domain cap on create and update.
- **Reviews:** owner, manager, or a member of the committee the risk is before (`committeeId` must match the risk's committee, else 403 `not_a_member`). Members are read live from `role_assignments` granted for the whole organization, for active committees only.
- **Escalation:**
  - Automatic escalation happens in the rating's or review's transaction and never repeats or goes lower (apart from M1).
  - De-escalation needs a member or a whole-organization manager and checks the threshold.
  - `{access:'none'}` reveals only the id and reference the member already had.
- **Committee lists:** members, or readers for the whole organization; 404 for another client's committee; rows filtered by `visible()`.
- **Reminders:**
  - Claimed with `FOR UPDATE SKIP LOCKED`, a `not exists` check and an insert with `on conflict do nothing`, per kind, subject and period.
  - Recipients are only the owner, the unit's managers and the committee members, who all read the risk.
  - The weekly email is counts only, worked out from each manager's own reach, and is held back while suspended.
  - The Extreme email gives the reference only, uses the `extreme` rule, and is in `SAFETY_WHILE_SUSPENDED`.
  - Digest sections list only references from visibility-filtered queries.
  - Logs give the client id and the error kind only.
- **Notifications:** all 12 kinds belong to the `risks` module and carry references, `serious`, band, day or committee id only, never text. A title is listed only to someone who reads the risk in full. `notifications_risk_fk` and `notifications_action_fk` refuse another client's risk (probed).
- **Actions engine:**
  - An action owner gets the summary only.
  - The owner may change only `status` and `dueOn`.
  - Writes other than completing are closed while suspended.
- **Database (probed as `trustline_app`):**
  - Changing `original_due_on` or `created_by` is refused by `actions_history_kept`. An insert's `original_due_on` is forced to the due day.
  - An action pointing at another client's risk is refused by the composite key.
  - No DELETE on `actions`, `action_events`, `risk_reviews` or the reminder tables; no UPDATE on events or `audit_log`.
  - The 5 new tables have RLS and one `tenant_isolation` policy each; `trustline_platform` has no grant on them.
  - Trigger functions set `search_path = pg_catalog, public, pg_temp` and are not `SECURITY DEFINER`.
  - All new links are composite keys with the tenant.

### Not checked

- The web screens.
- The email worker's preference handling beyond `kinds.ts` and `render.ts`.
- The uncommitted step-6 work in the worktree.
- `audit/actions.spec.ts` against an `audit_log` with rows.
