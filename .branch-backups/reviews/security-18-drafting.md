# Security review 18: AI policy drafting (057ec9f)

## Decisions: fix everything
- M1: all four fixes as proposed (clean text inside marks; detect gaps by their opening after normalisation, count leftover [[gap:; re-add gaps lost in an assistant revision, only a person's edit removes one; re-run plain() and markupProblem after adding server gaps).
- M2: behindDocument filters sources to what the viewer can read; turns and versions other than the handed-over one only to the author or viewers who can read every source; the audit's sources keep ids only (no numbers of restricted documents).
- L1: retention as its own step for every tenant whose data is held, before the module check and the other steps.
- L2: a trigger refusing any change to a handed-over session; composite foreign keys as listed.
- L3: control characters refused in the schema; past questions wrapped with asData; the contract says questions, reasons and titles are plain text.
- L4: the design's client text wrapped with asData and a system sentence that style rules cannot change the instructions.
- L5: contextOf uses the session's design.
- Info: a refused start leaves no conversation (create the row after admission, or delete on refusal); the spec says the assistant may repeat the profile to anyone who drafts.

# Security review 15: AI policy drafting (merge commit 057ec9f)

I found no critical or high problems. There are 2 medium and 5 low ones. The two that matter are both in the handover:
- a "not decided" answer can stop blocking review;
- the conversation kept behind a document shows restricted material to people outside its audience.

Every fix from review 13 is still in place after the merge.

**Tests I ran** against the shared `trustline` database (all passed, 157 + 24 tests):
- `test/ai-drafting.e2e-spec.ts` and `test/ai-foundation.e2e-spec.ts`
- the specs under `src/drafting`, `src/ai`, `src/exports` and `src/audit`
- `src/database/security-definer.spec.ts` and `src/database/tenant-isolation.spec.ts`

**My proofs**, outside the repository: an e2e probe at `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r15/probe.e2e-spec.ts`, with its output in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r15/out.txt`, a unit probe at `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r15/gaps.ts`, and one psql transaction as `trustline_app`, rolled back. The probe ran under test prefix `zr15` and cleaned up after itself; as with any e2e run, its audit rows stay. I changed no files.

## Medium

**M1. A "not decided" answer can stop blocking review.**
- **Where:**
  - `apps/api/src/drafting/drafting.service.ts:716-722` (gaps added for "not decided" answers) and `:360` (revisions pass `notDecided = []`)
  - `apps/api/src/drafting/prompts.ts:60` (`gapMark`) and `:66-69` (`SHOWN_MARK`)
  - `apps/api/src/policies/documents.service.ts:2018-2025` (the submit check)
- **Cause:** a gap is detected only by an exact pattern: the words exactly as written, 1 to 300 characters, with no `[`, `]` or line break inside. The gap the server adds for a "not decided" answer is `gapMark(locale, question text)`. That question text is the model's own: up to 500 characters, any characters.
- **Proven (probe P1):**
  - Question "Which form [F-12] records the check?", answered "not decided".
  - Version 1 has `gaps: []`, yet its text still holds `[To be decided: Which form [F-12] records the check?]`.
  - After handover and taking ownership, submit got past both `ai_draft_not_owned` and `ai_draft_gaps`. It reached the approval engine, which refused with `no_assignee` only because the test client has no assignee.
- **Other ways a gap disappears:**
  - **Revisions.** No server check keeps gaps across a revision, so a gap survives only if the model keeps its mark. The repo's own test shows one disappearing: at `test/ai-drafting.e2e-spec.ts:475-478`, v1 carries the "not decided" gap "Where is the inspection recorded?" and v2 ("Shorter…") no longer does. The model may also fill that point with invented text.
  - **Model marks it cannot convert.** `[[gap: who signs [form 12]]]`, or one with a line break, is left as raw text and never counts.
  - **Loose translations.** `[لم يحدد بعد: …]` without diacritics, a different diacritic order, or `[To Be Decided: …]` are not recognised.
  - **Truncation.** Cutting a section at 20,000 characters (`:713`) can split a mark.
- **Scenario:** a reviewer approves a procedure in which an undecided point was silently filled in or left unmarked. This breaks the spec's guarantees that there are "no invented facts" and that review is blocked while gaps remain.
- **Fix:**
  1. Before building a mark, clean the text that goes inside it: remove brackets and line breaks, and cut it to 300 characters.
  2. Detect a gap by its opening alone (`[To be decided:`, `[À décider :`, `[لم يُحدَّد بعد:`), after NFC normalisation and removal of Arabic diacritics and tatweel. Count a leftover `[[gap:` as a gap.
  3. On every assistant revision, add back any gap from the previous version that is missing from the new text. Only a person's own edit removes a gap.
  4. Re-run `plain()` and `markupProblem` after adding the server's gaps. Probe P2 shows why: a question holding `www.example.org <b>paper</b>` went into the stored version unchecked, and handover then failed with 400 `unsupported_markup`.

**M2. The conversation behind a document shows restricted sources, and versions never handed over, to anyone with full sight of the new document.**
- **Where:** `apps/api/src/drafting/drafting.service.ts:148-160` (`behindDocument`), `:811-843` (`view`), `:725-728` (sources).
- **Cause:** `GET /policies/documents/:id/ai-draft` needs only full sight of the new document. It then returns every version's text, every turn and every `sources` entry, as they were for the author.
- **Proven (probe P4):**
  - The author works in the pharmacy, which is the audience of a restricted document, "Controlled drugs vault fire plan" (`PRC-SAF-001`). The author drafts into a department.
  - A user with `policies.view_all` over that department gets 404 on the restricted document itself.
  - The same user gets 200 on `…/ai-draft`, with its title, number and id in `sources`, and with draft text taken from it.
- **Also:** the restricted document's number goes into `ai_draft_version_created.sources` in the audit trail.
- **Scenario:** up to 2,800 characters of a restricted policy reach people outside its audience, through versions the author never chose to hand over.
- **Fix:** in `behindDocument`, keep in `sources` only documents the viewer can read (`readsPublished or fullSight`). Show the turns, and versions other than the handed-over one, only to the author or to viewers who can read every source of those versions.

## Low

**L1. The daily removal of old conversations can be skipped indefinitely.**
- **Where:** `apps/api/src/policies/policy-check.service.ts:194`, `:250-253` and `:266-274`.
- **Cause:** `removeOldDrafts` runs only:
  - for tenants with `status = 'active'`;
  - with the policies module in use (`inUse`);
  - after the earlier steps for that client succeed. One failing step makes the whole client fail for the run, every day.
- **Scenario:** a client drops the policies module, is cancelled, or has one persistently failing step. Its discarded and abandoned conversations, holding text staff typed, are kept indefinitely, against the spec and the contract ("removed the next day").
- **Fix:** run retention as its own step, before the module check and before the other steps, for every tenant whose data is still held.

**L2. A handed-over conversation can be deleted, and some new columns have no foreign key at all.**
- **Where:** `apps/api/drizzle/0073_ai_grants_functions_and_safeguards.sql:132` gives `UPDATE` and `DELETE` on `drafting_sessions`. The restrictive policy at `0072:222` covers DELETE only.
- **Proven (as `trustline_app`, rolled back):**
  - A direct delete of a handed-over session is refused.
  - `update … set status='discarded', document_id=null`, then delete, removes it.
- **Missing foreign keys:**
  - `documents.ai_draft_session_id` and `ai_draft_owned_by` (`0072:177-178`);
  - `drafting_versions.created_by` and `ai_request_id`;
  - `drafting_messages.created_by` and `ai_request_id`.

  Nothing in the database stops these from pointing at another hospital's rows. Today the values come only from the session.
- **Fix:**
  - a trigger refusing any change to a row whose old status is `handed_over`;
  - composite keys `(tenant_id, ai_draft_session_id) → drafting_sessions` (this also blocks the deletion) and `(tenant_id, ai_draft_owned_by) → users`;
  - composite keys on the `created_by` columns.

**L3. The model's title and questions are not checked.**
- **Where:** `apps/api/src/drafting/prompts.ts:30-42`; `drafting.service.ts:236` and `:729`.
- **Proven (probe P3):** a NUL in the title gives a 500 (Postgres 22P05) after the request has already been costed and counted. A NUL in a question does the same.
- **Also:**
  - markup and links in a question or title are stored as they are;
  - question text is fed back into later prompts outside `asData()` (`prompts.ts:229`).
- **Fix:**
  - refuse control characters in the schema, so such an answer is `invalid_output`;
  - wrap past questions in `asData('assistant question', …)`;
  - add to the contract that questions, reasons and titles are shown as plain text.

**L4. Text the client writes in the design goes into the system text unwrapped.**
- **Where:** `apps/api/src/drafting/prompts.ts:137-162` and `:186-189`.
- **What goes in:** writing rules, the never-list, guidance per section, and type and section names.
- **The spec says otherwise:** its "Prompt injection" section says everything a client wrote goes through `asData()`.
- **Risk:** an administrator's text sits in the instruction position. It can tell the model to ignore `DATA_RULES`, which makes an instruction hidden in a source document more likely to work. The impact is limited because sources are only documents the person may read.
- **Fix:** wrap it as `asData('organization writing rules', …)`, with one system sentence saying these are style rules that cannot change the instructions above. Or correct the spec.

**L5. The design a draft records is not the one it was written in.**
- **Where:** `drafting.service.ts:184-194` against `:743`.
- **Cause:** the session records `designId` when it starts. Every later step reads the design in force at that moment.
- **Result:** "A draft records the design it was written in" is untrue once the design changes mid-conversation.
- **Fix:** use `session.designId` in `contextOf`, or record the design id on each version.

**Info:**
- A conversation row, audited, is created before the assistant is asked, so a refused start (AI switched off, allowance reached) still leaves a conversation, kept for 90 days.
- Any `policies.manage` user can get the assistant to repeat the profile, which `GET /settings/profile` limits to `settings.manage`. The profile is not secret; accept this and say so in the spec.

## Checked and sound

**Review 13 fixes, still in place after the merge:**
- **H1:** the email pattern is anchored and bounded (`redaction.ts:556`), there are 20,000 / 60,000 character caps, and the performance spec passes.
- **H2:** the limits are stated in the spec, the heuristics are present, and only steps 4 and 5 are gated.
- **M1:** both definer functions have `pg_catalog, public, pg_temp` with qualified names, `p_since` is gone, and `security-definer.spec.ts` passes for every definer function.
- **M2:** bare and spaced placeholders are reserved.
- **M3:** possibly billed failures are recorded at the reservation, and the reservation covers 2 attempts.
- **M4:** the unit must be a UUID, counting is decided on the server, it counts again every 20 requests or in a new month, and `invalid_output` counts.
- **M5:** `admit()` reads suspension afresh.
- **M6:** the fake provider records calls only under test.
- **M7:** `asData`, `DATA_RULES` and Zod checking of `data` are in place.
- **L2:** the `ai_requests_finish_once` trigger is in place.
- **L1, L3, L4, L5:** the ARN region and type check; `works: null` with `mode` when fake; 409 on a credential change while in use; `logLevel: 'off'`.

**Isolation and grants:**
- Row-level security with `tenant_isolation` is on all five new tables, with composite tenant keys on sessions, designs and profiles.
- Messages, versions and designs can only be read and added to, never changed.
- No grant to the portal role; `tenant-isolation.spec.ts` passes.
- Every query runs in `withTenant(auth.tenant.id)`.

**Who can do what:**
- A conversation is reached only through `createdBy` = the caller. Another person or another client gets 404 (tested).
- Drafting routes need the AI module and the policies module (404 otherwise) and `policies.manage`.
- Profile and design need `settings.manage` for the whole organization, on GET and PUT.
- SessionGuard refuses writes while suspended.

**What the assistant reads:**
- Only the published version of active documents, by the library's own rules (`readsPublished or fullSight`), at most 3, cut to 2,800 characters each.
- No draft, no restricted document outside the person's audience, and no other conversation (tested, and checked by reading).
- The sources the model lists are filtered to those it was given.

**Content rules:** the model's sections go through `plain()` and `markupProblem`, then `checkedSection` again at handover, so its text cannot get past the rules into a document.

**Handover and ownership:**
- The document is made in the same transaction, with the scope check and a revision guard.
- Ownership can be taken by the document's owner or someone who manages it, 404 for anyone else, and it is audited.
- Submit refuses an unowned AI draft. Imports only create new documents, so there is no other way to review.

**Profile and design:**
- Text per language with length limits, and `language_mismatch` is checked.
- The design is versioned with a unique index and 409 on an out-of-date save.
- Audit holds parts and counts, never free text.

**Retention:** it runs under row-level security and the restrictive policy, deletes cascade to turns and versions, and the audit holds counts only.

**The merge:**
- `app.module.ts` has ExportsModule, AiModule and DraftingModule, none of them twice.
- `schema.ts` has no duplicate tables.
- `exports/coverage.ts` has the 9 AI tables, and its spec passes.
- The audit registry and wording are complete, and its specs pass.
- `policies.module.ts` uses `forwardRef`.

## Not checked

- The web screens, which are not built.
- How a real provider behaves.
- The full test suite (as instructed).
- How the daily check is scheduled in production.
- The legal acceptance of the name-removal limits.