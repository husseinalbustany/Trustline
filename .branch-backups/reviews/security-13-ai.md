# Security review 13: AI foundation (worktree, 8cbffe4..7ee2bac)

## Decisions: fix everything
- H1: anchored, bounded email pattern; single-pass masking; per-message cap (say 20,000 characters; total per request 60,000); test that 400,000 characters of adversarial input finish within about 1 s.
- H2: state the limit in the spec; features must pass every person field of the record; heuristics (title and relationship words in en/fr/ar followed by a capitalised word or Arabic name, lowercase matching of known name parts of 4+ letters, record-like numbers of 6+ digits near patient/file/MRN words and equivalents); insights and the assistant may not ship until entity recognition is added or the legal review accepts the remaining risk in writing (recorded in the spec).
- M1: search_path with pg_temp last and public. qualified names on both new definer functions; drop p_since; a test that every SECURITY DEFINER function's proconfig ends with pg_temp (the 0058 functions are already being fixed on the main branch).
- M2 to M7: as proposed (M4: cap 20 requests per draft, count again each new month, revision decided on the server, unit must be a UUID).
- L1 to L6: as proposed (L6 noted in the assistant spec).

I reviewed `git diff 8cbffe4..7ee2bac` in /home/user/Trustline/.claude/worktrees/agent-a401760666624b587 (commit 7ee2bac), alongside the spec's "Built" section and the web contract. I found 2 high, 7 medium and 6 low problems. All file paths below are relative to that worktree.

The credential, endpoint and real/fake-switch protections you asked about hold. The serious problems are in name removal and in cost control.

Tests: I ran them against `trustline_ai` only. `src/ai`, `test/ai-foundation.e2e-spec.ts` and `src/database/tenant-isolation.spec.ts` pass (86 + 9 tests). I changed no files. My proofs were scripts in the scratchpad and psql transactions that I rolled back.

## High

**H1. Name removal can freeze the whole API for every hospital** (`apps/api/src/ai/redaction.ts:361`, the email pattern, applied at :474; the 400,000-character input limit is at `apps/api/src/ai/ai.service.ts:126`).
- **Cause:** the email pattern `[\p{L}\p{N}._%+-]+@…` has no start anchor and no length limit. On a long run of letters with no `@`, its work grows with the square of the length. It runs synchronously, after the request has already been admitted.
- **Measured:** the pattern alone takes 1.0 s on 40,000 characters and 4.1 s on 80,000. The whole `redact()` takes 6.2 s on 100,000 and 25.8 s on 200,000. At the allowed 400,000 that is roughly 100 s. While it runs, the Node process answers nobody, from any hospital.
- **Second cost:** the masking loop (:491-494) rebuilds the whole text once per identifier found, so it grows with identifiers × length.
- **Scenario:** once step 3, 4 or 5 passes a user's text (or, for insights, a public-form narrative), one request such as `"a".repeat(400000)` stalls the API. A few in parallel keep it down.
- **Fix:**
  - Bound and anchor the pattern: `(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}`.
  - Build the masked text in one pass.
  - Cap each message far below 400,000 characters.
  - Add a test: 400,000 characters redacted within about 1 s.

**H2. Name removal only knows names it is given, so patient and public names go out unchanged** (`apps/api/src/ai/redaction.ts:251-355`, `apps/api/src/ai/ai.service.ts:214`). Decision 4 promises that patient names are removed. In practice only the client's users and the `people` the feature passes are removed. Probed with users `Mohammed Al-Rashid`, `Li Na`, `Jo Smith`, `Sarah Connor`:
- `Patient Aisha Rahman (bed 4) fell; her son Omar called` is sent unchanged: patients and relatives in free text are never caught.
- `spoke to mohammed …` is sent unchanged: a lowercase single name in Latin script is not caught (common in reports typed on phones).
- `Muhammad [PERSON_1]`: the spelling variant of the first name leaks.
- `Nurse Li …; Jo was on shift`: parts under 3 letters are never caught alone.
- `Sa­rah` (with a soft hyphen) leaks.
- `patient 654321`, `file 445566`: bare 6-digit record numbers, and record numbers after words not on the list, leak.

None of this is said in the spec. The insights step (incident narratives, including the public form) would send patient names abroad, which is the exact legal question still open.

**Fix:**
- State the limit in the spec.
- Make features pass every person field of the record.
- Add heuristics: a capitalised word after a title or relationship word (Patient, Mr, son, wife, and the French and Arabic equivalents), lowercase matching of known name parts of 4 letters or more, and 6-digit numbers near the word patient.
- Before insights or the assistant ship, either add entity recognition or have the legal review accept the remaining risk in writing.

## Medium

**M1. Both new SECURITY DEFINER functions can be fooled by a temporary table** (`apps/api/drizzle/0061_ai_foundation_grants_and_functions.sql:37` and `:53`).
- **Cause:** their search path is `pg_catalog, public`, without `pg_temp` last. When `pg_temp` is not listed, PostgreSQL searches it first for tables. `trustline_app` holds TEMP on the database (checked).
- **Proven as `trustline_app` (rolled back):**
  - A temporary `ai_requests` holding one row of 123456789 made `ai_platform_spend_since()` return 123456789.
  - A temporary `platform_audit_log` captured the `ai_report_spending_limit()` insert, so the real log received nothing.
- **Scenario:** any SQL running as the app role (an injection anywhere) can make the platform-wide spending limit see zero and silence the notice to staff.
- **Side channel:** `p_since` is free, so calling it with "1 second ago" over and over shows when other hospitals use AI.
- **Fix:** `SET search_path = pg_catalog, public, pg_temp`, write `public.` before each table name, drop `p_since` and compute the UTC month start inside the function, and add a test that every `prosecdef` function's `proconfig` ends with `pg_temp`. The older functions in `0058_audit_chain_seal.sql` (lines 59, 95, 154) have the same flaw; it is outside this range but needs the same fix.

**M2. A placeholder typed without brackets is restored as a real person's name** (`apps/api/src/ai/redaction.ts:457-461` against `:541-546`). `reserve()` only notes bracketed placeholders, but `restore()` also replaces the bare form `PERSON_2`.
- **Proven:** input `Sarah Connor met Fatima Zahra. Note: PERSON_2 is the code of ward 7` came back as `… Note: Fatima Zahra is the code of ward 7`.
- **Scenario:** a reporter writes "PERSON_1 gave the wrong dose". The AI summary shown to the handler then names a real member of staff who appears in the same request. That is a misattribution in a patient-safety record.
- **Fix:** reserve the bare and spaced forms too; better, replace look-alikes in the input with an escape before sending and put them back literally.

**M3. Spending limits under-count real cost** (`apps/api/src/ai/ai.service.ts:237-244`, `:133-138`).
- A timeout or lost connection records a cost of 0, though the provider may still bill.
- The first attempt of a retry is never recorded.
- The reservation covers one attempt, but two are allowed.
- **Scenario:** with a large answer ceiling, aborted requests record nothing, so neither spending limit ever trips.
- **Also:** `invalid_output` failures cost money but do not count against the allowance (`live` excludes failed requests). A prompt that makes the model answer in prose burns spending without using allowance.
- **Fix:** on failure, record at least the reservation times the attempts made, and reserve for 2 attempts.

**M4. The drafting allowance can be bypassed** (`apps/api/src/ai/ai.service.ts:383-406`, `:157`).
- Requests in a draft that are not marked as revisions never count, with no ceiling.
- A draft opened once carries into every later month at no charge.
- `unit` and `revision` are whatever the feature passes; `unit` can be any text of 1 to 200 characters, so a title could end up stored in `ai_requests.unit_key`.
- **Fix:** cap the total requests per draft (for example 20), count the draft again in each new month or after N days, decide `revision` on the server, and require `unit` to be a UUID.

**M5. `run()` ignores suspension** (`apps/api/src/ai/ai.service.ts:204-290`). The caller passed to `run()` carries no subscription status. The incidents module's routes stay open while suspended (`apps/api/src/subscriptions/module.decorator.ts:22`), so an insights route would keep spending for a suspended client. **Fix:** pass the subscription status in and refuse while suspended.

**M6. The fake provider keeps every request in memory** (`apps/api/src/ai/fake-provider.ts:63`). `fakeAi.calls.push(...)` runs in every process, not only tests, and fake is the production default. The redacted clinical text accumulates forever and the memory grows without limit. **Fix:** record only when `underTest()`.

**M7. Prompt injection is not addressed** (the spec, the code and `apps/api/src/ai/provider.ts:111-120`). The structure is right: the system text is separate from the messages. But nothing documents the risk, gives a helper to wrap record text as data, or says that output is untrusted. `parseStructured` never checks the answer against the schema, so `data` reaches features unvalidated. **Fix:** a spec section requiring that:
- record text is wrapped in delimiters and labelled as data;
- the model gets no tools and its output takes no action;
- output is shown as plain text;
- `data` is checked against a Zod schema, with failure treated as `invalid_output`.

## Low

- **L1. "In region" can be untrue for Bedrock ARNs** (`apps/api/src/ai/ai-input.ts:83-96`). Any ARN is accepted for in-region, including one for another region or an application inference profile that wraps a global profile. Regional prefixes are not matched to the region's geography (for example `us.` on `me-central-1`). **Fix:** check the ARN's region and type, and map region to allowed prefix.
- **L2. The app can rewrite finished request records** (`apps/api/drizzle/0061_ai_foundation_grants_and_functions.sql:27`). The column grants allow `UPDATE outcome` on any row of the client and there is no trigger, so a compromised app can mark past requests failed and reset its usage. The spec says these rows cannot be rewritten. **Fix:** a trigger allowing updates only while the outcome is `pending` and `finished_at` is null.
- **L3. "Test connection" says it works in fake mode** (`apps/api/src/platform/platform-ai.controller.ts:215-230`). It answers `works: true` through the fake provider without saying so. **Fix:** return `mode`, or `works: null` when fake.
- **L4. A connection's credential variable can be changed while clients use it** (`apps/api/src/platform/platform-ai.controller.ts:161-178`). This switches the provider account, and with it the retention terms (decision 3), without telling clients. A connection can also name another kind's variable, for example a Bedrock key sent to api.anthropic.com. **Fix:** treat a credential change like a region change (409 while in use), or notify clients.
- **L5. The SDK still reads two environment variables.** `ANTHROPIC_LOG` (debug writes request bodies to stdout) and `ANTHROPIC_CUSTOM_HEADERS` still take effect. **Fix:** pass `logLevel: 'off'` in both adapters.
- **L6. Future anonymity risk (step 5).** `ai_requests.user_id` plus its time could be matched with an anonymous report if the assistant ever helps someone write one. Settle this in the assistant spec.

## Checked and sound

- **Credentials:**
  - Variable names are limited to `^AI_CREDENTIAL_[A-Z0-9_]{1,50}$` in the input schema, in a database CHECK, and again in `credentialsPresent` (`apps/api/src/ai/providers.ts:49`). `DATABASE_URL`, `SIGNING_PIN_PEPPER` and `AUDIT_SIGNING_KEY` cannot be named.
  - The value never reaches the database, an answer or a log. Test answers are only `{works, credentialsPresent}`, and failures are recorded and logged by kind only.
- **SDKs:** both adapters fix the base URL and pass credentials explicitly. I read the Bedrock SDK source: `apiKey: null` blocks the `AWS_BEARER_TOKEN_BEDROCK` fallback, and an explicit base URL beats `ANTHROPIC_BEDROCK_BASE_URL`. The Anthropic adapter sets `authToken: null`.
- **SSRF:** there is no URL field. Regions are `[a-z0-9-]`, and Bedrock regions must look like an AWS region code. Hosts are only `bedrock-runtime.<region>.amazonaws.com` or `api.anthropic.com`.
- **Real/fake switch:** it needs exactly `real` and exactly `production`, is always fake under test, and anything unexpected falls back to fake with a log line. `RealProviderUnderTestError` is not swallowed.
- **Mapping and records:** the name mapping lives only in the `Redaction` object and is never logged. `ai_requests` has no text column (apart from the `unit_key` point in M4).
- **Allowance counting across processes:**
  - Database advisory locks, per client and feature, then per client spending, then platform spending, always in that order.
  - Under READ COMMITTED, the count after the lock sees committed rows, and pending rows hold their place.
  - A request goes stale after 15 minutes only if its process dies or recording its end fails; normal requests finish within about 6 minutes.
- **Tenant isolation:**
  - Row-level security with `tenant_isolation` is on all four client tables.
  - Foreign keys to users are composite (tenant and user).
  - The platform tables hold no client data.
  - The grants in the database match the migration, and the platform role's audit insert policy was widened by one action only.
- **Order of checks in `run()`:** module, offered, configured, connection active, plan, then the client's switch, allowance and spending. Checking configuration before the switch reveals nothing.
- **Portal routes:**
  - Every route is behind `PlatformAuthGuard`, and bad ids give 404.
  - Changes are audited in the platform log in the same transaction, and in the client's log through the narrow policy. The spending limit is left out of the client's log, as chosen.
  - The usage overview shows only what staff need.
- **Client routes:**
  - A client without the AI module gets 404.
  - The short and full answers are split by `settings.manage` for the whole organization.
  - `PUT` checks the permission, uses a strict schema, and while suspended allows switching off only.
  - `ai_use_changed` is audited in the same transaction, and one client cannot read another's usage (row-level security plus an e2e test).
- **Plans:** the allowances schema is strict, and changes appear in `subscription_changed`.
- **Secrets and test data:** no secrets in the diff, and the test names are invented.

## Not checked

- Real provider behaviour, such as billing on aborted calls; no network.
- Allowance races under real parallel load: no test exists, so this is by reading only.
- The web screens, which are not built yet.
