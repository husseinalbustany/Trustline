## Decisions (taken by the lead)

1. Fix as proposed: verify the session before reading a large body, anchor the path, limit nesting.
2. Imports are for migration only. An imported document's approval date must be before the day the
   client's policies module was first switched on, and imports are accepted only while an import
   window is open, set by Trustline staff in the admin portal (open by default for 90 days from the
   module's first switch-on; Trustline staff can reopen it with a reason, audited). No second-person
   confirmation for now (it would slow a migration of hundreds of documents); the business can add it.
3. Record the authoritative language on the version when it is sent for review; every version that
   is no longer a draft uses its recorded language for checks, flags and fallback. New signatures
   cover it; existing signatures stay valid (the hash of a version signed before keeps its old form).
4. Normalise numbers (NFKC, any digit to ASCII) before the taken check and the series, backed by the
   unique key; refuse numbers that mix scripts.
5. Never create a starting route without an approval step: fall back to the Administrator step when
   the Approving authority role is missing, and say so in the audit entry.

---

## Security review of 684fa5b: importing documents, the Approving authority, the authoritative language

I reviewed the committed state. The working tree was clean and every file I ran matched 684fa5b. Both migrations are applied in the local database, and their stored hashes match the committed 0044 and 0045 files exactly. I ran no tests, server, migration or seed. I used only read-only SQL sessions, plus read-only scripts in the scratchpad that import the repository's own functions.

I found no tenant-isolation or authorisation hole. I found three medium findings and two low ones.

### 1. Medium: a request with no real session gets a 2 MB body read and parsed before anything refuses it (confirmed)

`apps/api/src/security/import-body.ts:46-52` only checks that some credential is present: `/^Bearer .+$/` or any `tl_session` cookie. It never checks that the session is real. The comment "a caller without a session cannot send more than that anywhere" is wrong.

**What someone can do:** anyone on the internet, through the web app's `/api/:path*` rewrite (`apps/web/next.config.ts:11`), can send `Authorization: Bearer x` with up to 2 MB of JSON. The API buffers it and runs `JSON.parse` before the SessionGuard answers 401. Measured on this machine (Node 22):
- 2 MB of nested arrays `[[[…]]]`: about 130 to 250 ms of blocked event loop and about 58 MB of heap per request.
- `{}` objects: 65 ms and 45 MB.

There is no rate limit on these routes (only the public incident routes have one). A handful of requests per second keeps an API process busy, and parallel requests push memory up. Every other route stops at 100 kB, so this is 20 times the work per request.

**A second gap:** `IMPORT_PATHS` (line 18) is not anchored at the start. Any path ending in `/policies/imports` gets the 2 MB parse, for example `/api/v1/x/policies/imports`, which then answers 404.

**How I know:** I passed mock requests through the repository's `importBodyParser`:
- no credentials: left to Nest's 100 kB parser;
- `Bearer x`: parsed by the import parser, 132 ms;
- cookie `tl_session=x`: parsed, 253 ms;
- `/api/v1/anything/policies/imports`: parsed, 119 ms.

The e2e test (`test/policies-import.e2e-spec.ts:615`) only covers a request with no credentials at all.

**Smallest fix:**
- Before reading the body, look the token up in the middleware, the same way SessionGuard does (hash it, check the session is live and the user is active), and fall through to the 100 kB parser if it fails.
- Anchor the pattern as `^/api/v1/policies/(?:imports(?:/check)?|documents/import)$`.
- Optionally, scan the bytes before `JSON.parse` and refuse nesting deeper than about 64.

### 2. Medium: an import can publish new text at any time, never approved by anyone (read from the code; the business should decide)

Nothing ties an import to documents that existed before Trustline. The date checks in `imports.service.ts:492-510` only refuse dates in the future:
- `approvedOn` may be today;
- `approvedBy` is free text;
- confidentiality, audience and acknowledgement are the importer's choice, and `acknowledgementRequired` defaults to false.

**What someone can do:** any `policies.manage` holder for the whole organization can, at any time and alone, put new or changed text in force as an active controlled document. Examples:
- a change to a dosing step, labelled "approved before Trustline by Medical Director";
- the text of a retired document, brought back under a new number or a number Trustline gives.

It stays in force until the review date they choose, which can be up to the client's longest review period. No reviewer or Approving authority ever sees it, and readers are not told unless the importer asks for acknowledgement.

It is signed with a password, audited (`document_imported`) and shown as "Approved before Trustline", so it can be found afterwards; it is not hidden. Decision 1 describes migrating existing libraries. It neither forbids nor intends a lasting way around the route.

**Smallest fix:** refuse `approvedOn` and `effectiveOn` on or after the day the client started using the policies module (or an import window the platform sets). Ask the business whether a second person should confirm a batch.

### 3. Medium: the authoritative-language setting is read live for every version, including signed ones, so changing it rewrites their flags (confirmed for the flags)

Nothing records which language was authoritative when a version was sent, approved or published. Every place reads the current setting: `documents.service.ts:876` (language status of any version), `documents.service.ts:1756` (submit), and `languages.ts:61`.

**Confirmed:** I ran the repository's `languageStatus` on a version whose English steps changed from "Use 5 ml" to "Use 2 ml" while the Arabic was left as before.
- With English authoritative: `lagging: true`, Arabic shown as `lagging`.
- After switching to Arabic: `lagging: false`, both languages `written`.

So a published, signed version loses its "translation not updated" flag. The out-of-date Arabic becomes the text that "stands when two languages disagree", with nothing to show for it.

**Read from the code:**
- A manager can switch the language so a draft whose required sections exist only in French passes the submit check, then switch it back. The audit records each change.
- After a switch, required sections that were only ever written in the old language show as `empty` in the new authoritative one. Readers of that language are no longer shown the other language's text instead.

Who may change the setting is sound: `policies.manage` for the whole organization, a revision check, the language validated against the client's languages, and an audit entry.

**Smallest fix:** store the authoritative language on the version when it is sent for review, and include it in `signedVersion`. Only drafts follow the setting. Use the stored language for the checks and language status of every version that is no longer a draft.

### 4. Low: a number that looks like an existing one, or like one Trustline will give later, is accepted (confirmed)

`input.ts` `legacyNumber` (around line 352) accepts letters and digits of any script. `seriesOf` (`numbering.ts:61-80`) only recognises ASCII. Run on the repository's own `seriesOf`, these all return null:
- `POL-GOV-٠٠٧` (Arabic-Indic digits, plausible on Arabic originals);
- `ＰＯＬ-ＧＯＶ-００７` (fullwidth);
- `РОL-GOV-007` (Cyrillic Р and О).

The `upper()` unique index treats each as a different number from POL-GOV-007. So each one passes `number_taken` and does not advance the counter. Trustline can later give the real `POL-GOV-007` to another document that reads the same.

**Smallest fix:** apply NFKC normalisation and map every `\p{Nd}` digit to ASCII before `seriesOf` and before the taken check. Back this with a unique index on that normalised key, or refuse numbers that mix scripts.

### 5. Low: a starting route without an approval step can be created in one corner case (read from the code; not reachable in the local data)

`provisioning.service.ts:257` (`ensurePolicyDefaults`, also run for existing clients from `platform-tenants.controller.ts:337`) keeps only the steps whose role exists as a built-in. Since 0045 leaves a client's own `approving_authority` role alone, a route made later for that client would have the review step only. That breaks the `last_step_must_approve` rule that `settings.service.ts:404` enforces elsewhere.

Locally, no tenant has its own role with that code (0 of 4).

**Smallest fix:** create no route, or fall back to the Administrator step, when the approval step's role is missing.

### What is sound
- **Row-level security** (confirmed in the database): both new tables have RLS on and the `tenant_isolation` policy for `trustline_app`.
- **Foreign keys:** all of them are composite with `tenant_id`, so none can point into another hospital.
- **Ids in a body:** they are resolved under row-level security, so another client's ids answer 400 `unknown_*`. All access runs inside `withTenant` with the tenant from the session.
- **Grants** (confirmed): `SELECT` and `INSERT` only on both import tables. `trustline_platform` gets nothing. `audit_log` and `signatures` have no `UPDATE` or `DELETE`, and no grant was widened.
- **Database rules** (confirmed): the triggers `documents_number_fixed` and `document_versions_source_fixed` are enabled. `documents_number_any_case_key` and `document_versions_imported_first` exist. The application role owns no table and is not a superuser.
- **Who may import:** `requireEverywhere('policies.manage')` in the controller, checked again in the service. Imports are refused while the subscription is suspended.
- **Password:** asked only after every other check, and counted under a row lock like every other signature.
- **Batches:** all or nothing in one transaction. Counters are locked in a fixed order and the checks run again under the lock, so a document committed meanwhile is seen. A unique violation answers 409.
- **Numbers:** capitals and leading zeros are handled for ASCII, and the counter is advanced. The regular expression in the taken check is built only from validated `[A-Z0-9]` text, and all SQL is parameterised.
- **Text:** imported text gets the same `checkedSection` checks for markup, size and languages as written text. Schemas are strict, and `invalid_document` lists field names only.
- **What is signed:** the `imported` signature covers the version and the original's details.
- **Re-issue:**
  - the importer is kept as a contributor, and the test covers 403 `same_person`;
  - `confirm_review` is not offered, and `POST …/review` answers 409 before the password is asked;
  - a review-period change does not move the imported review date.
- **Migration 0045:** only routes that are exactly the starting route change. A client's own role is left alone, `ensureSystemRoles` no longer takes such a role over, everything is audited, and nobody holds the new role. Nobody gains a permission.
- **Body parser:** capitals, a trailing slash, encoded paths and other methods all fall back to 100 kB. Compressed bodies and other character sets are refused. Over 2 MB is answered 413 early. Nest's own parser skips a body already read.
- **Privacy and secrets:** no patient data, audit entries hold no document text, and the seed is fictitious. No secrets in the diff.

### What I could not check
- Anything end to end, under the constraints: real concurrency, and a possible deadlock if a type's prefix changes between the two passes of a batch.
- How the web app shows the fallback text (not built yet).
- The body limits of the Next.js rewrite.
- The measures code beyond the diff and its test.
- That an importer can push a series' counter to 999,999,999 permanently. It is audited; I only noted it.

**Verdict:** tenant isolation and authorisation hold. Fix finding 1 before release, and take findings 2 and 3 to the business and the engineer.