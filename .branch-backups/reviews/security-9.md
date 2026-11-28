# Security review 9: fixes for reviews 7 and 8

## Decisions: fix all six findings and the notes
1. RCPT TO: permanent only for enhanced 5.1.x/5.2.x/5.3.x (or, with no enhanced code, 550/551/552/553). 530 and any 5.7.x at RCPT: retry and stop the run like EAUTH. Tests with the Postfix and Exchange replies.
2. On stopsSending, release the tested row too (no attempt counted); wait 5 minutes worker-wide before testing the login again.
3. Numbers: letters only from the scripts of the client's languages (Latin and Arabic for en/ar/fr); refuse others with invalid_number, reason 'script'.
4. migrate.ts pre-step only while 0050 is not applied; pg_advisory_lock around runMigrations; CHECK and FK in 0050 added NOT VALID and validated in a step after the migrations (a new migration if 0050 is already applied anywhere: it is only applied in dev, so editing 0050 is acceptable only if the hash mismatch is handled; prefer a new additive migration 0051 for the VALIDATE).
5. Trigger: fill authoritative_locale on draft->in_review when NULL (from document settings / tenant), and allow NULL->value while signs_authoritative_locale is false.
6. Keep contextIn private; a dedicated background method with no token and no issuedAt; lint rule restricting it to identity/ and email/.
Notes: import parser also checks the policies module and not suspended before allowing 2 MB; the import window fails closed when no module_starts row; freeze the legacy unsubscribe lifetime as its own constant; move the misplaced doc comment in provisioning.service.ts. The WeakMap to avoid the double lookup is optional: do it if simple.

# Security re-review 9: fixes for reviews 7 (import) and 8 (email), 658a486..e45aa9c

## What I did
- Read the whole diff for `apps/api` and `docs/specs`, then the code around it.
- Checked the database read-only. The stored hashes of migrations 0048, 0049 and 0050 match the committed files. I checked row-level security, policies, grants, the trigger function's owner and settings, indexes and foreign keys in the database itself.
- Ran the relevant tests: `policies-import-safeguards`, `policies-import`, `email`, `src/email`, `src/policies`, `tenant-isolation.spec`, `platform`, `modules-and-subscriptions`, `cleanup`, `policies-migration`. All passed: 18 files, 223 tests.
- Ran small read-only scripts against the repository's own functions. They are in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r9/` (`num.ts`, `smtp.ts`, `paths.mts`).
- Changed no files.

**Overall:** tenant isolation and authorisation hold. I found one medium problem in the email fix and five low ones. Below them are four notes.

---

## 1. Medium: a relay refusal at RCPT TO still fails every email at its first attempt (M1 not fully closed; confirmed)
**Where:** `apps/api/src/email/sender.ts:86-89`

**What is wrong:** an email counts as permanently refused whenever the reply to RCPT TO is a 5xx (`EENVELOPE` with command `RCPT TO`). Many 5xx replies at RCPT are about the configuration, not the recipient. `SMTP_USER` is optional (`config.ts:144`), so relaying by IP address with no login is a supported setup, and it is common for a hospital's internal relay.

I ran the repository's `classifySmtpError`:
- `554 5.7.1 Relay access denied` (Postfix) gives `permanent`.
- `530 5.7.0 Authentication required` at RCPT gives `permanent`. The decision listed 530 as one to retry.
- `550 5.7.54 Unable to relay` (Exchange) gives `permanent`.
- `550 5.1.1 User unknown` gives `permanent`. This one is correct.

**Scenario:** the API's address changes after a redeploy, or the relay's allow list is edited. Every email is then refused at RCPT with 5.7.1 and marked `failed`/`refused` after one attempt, sentinel safety alerts included. That is the M1 harm by another route.

**Smallest fix:**
- On RCPT, make a 5xx permanent only when its enhanced status class is 5.1.x, 5.2.x or 5.3.x. With no enhanced code, only 550, 551, 552 and 553 are permanent.
- Treat 530 and any 5.7.x on RCPT as a configuration refusal: retry, and stop the run (`stopsSending`) as for EAUTH.
- Reading the leading `d.d.d` code from `err.response` is safe because nothing of the text is logged.
- Add test cases with the Postfix and Exchange replies above.

## 2. Low: during a refused login, the email used to test the login is still charged an attempt, so a long outage gives up the first client's emails
**Where:** `email-worker.service.ts:523-529` together with `failed()` at `:546`. The e2e test `email.e2e-spec.ts:655` confirms the attempt is counted.

**Scenario:**
- The run happens every 30 s, and clients are handled in `tenants.id` order.
- Each run tries one email of the first client, which fails with EAUTH and is counted. The rest go back to the queue uncounted.
- After about 1 + 5 + 30 + 120 minutes of a credential outage (longer with a big queue), each of that client's queued emails reaches 5 attempts and is `gave_up`, including sentinel alerts.
- Other clients' emails stay queued and go out once the login is fixed.
- The loss therefore falls on whichever client has the lowest id. It also sends a wrong password every 30 s, which can trigger the mail provider's lockout.

**Can one client abuse it?** No. The SMTP configuration is global, and nothing in a message can make nodemailer answer `EAUTH` or `ENOAUTH`.

**Smallest fix:** when `stopsSending`, release the tested row as well (`attempts - 1`, as `release()` does) so a login refusal never counts toward `MAX_ATTEMPTS`; the 24-hour expiry stays the only limit. Also wait longer before testing the login again after a refusal (for example 5 minutes, worker-wide).

## 3. Low: numbers written entirely in another script that looks like Latin still pass (residual of finding 4; confirmed)
**Where:** `numbering.ts:172` (`mixesScripts`) and `input.ts` (`legacyNumber`)

**What still passes:** a number whose letters are all from one non-Latin script is not mixed, so it is accepted. With the repository's functions, each of these is accepted, has no series, does not equal `POL-GOV-007` under `upper()`, and does not move the counter:
- `ꓑꓳꓡ-ꓖꓳꓦ-007` (all Lisu);
- `ᏢᎾᏞ-ᎶᎾᏙ-007` (all Cherokee);
- `ЅОР-001` (all Cyrillic, which reads as SOP-001).

Trustline can later give the real number to another document. Lisu and Cherokee both fall into the single `'other'` bucket, so even mixing them is not caught.

**Handled correctly:** zero-width characters and lone combining marks are refused by the regex. NFKC folds fullwidth and mathematical letters, and digits of every script become ASCII.

**Smallest fix:** accept only letters of the scripts of the client's languages: Latin and Arabic for en/ar/fr. Refuse others with `invalid_number`, `reason: 'script'`. Alternatively, compare a UTS #39 confusable skeleton in the taken check.

## 4. Low: the migrate.ts pre-step runs on every migrate, takes no lock, and 0050 still locks `notifications` for a full scan
**Where:** `migrate.ts:35` and `:73-85`; `0050_email_review_fixes.sql:17`

**What I found:**
- **It never retires.** `buildConcurrently` runs on every `runMigrations()` from now on. If a later migration drops or renames `notifications_tenant_id_id_key`, every later run recreates it before the migrations.
- **Two runs at once can collide.** There is no advisory lock. While a `CREATE INDEX CONCURRENTLY` is building, the index shows `indisvalid = false`. A second migrate run would then drop the index the first is building. After that, 0050's `IF NOT EXISTS` either does a blocking build inside the migration or finds an invalid index, and the foreign key fails.
- **The lock problem is only partly solved.** Building the index concurrently is right. But in the same transaction 0050 drops and re-adds the `notifications_about_one_thing` CHECK, which holds ACCESS EXCLUSIVE on `notifications` while every row is validated. Drizzle runs all pending migrations in one transaction, so that lock lasts until commit.

**Is the hand edit correct?** Yes. The indexes must come before the foreign keys. `IF NOT EXISTS` is correct on both a new and an existing database (verified locally: both indexes are valid and both keys are composite). Dropping and rebuilding an invalid unique index is safe.

**Would splitting it help?** A separate migration file does not help, because the migrator wraps every migration in a transaction and `CONCURRENTLY` cannot run in one. The pre-step is the right shape.

**Smallest fix:**
- Run the pre-step only while 0050 is not yet applied (check `drizzle.__drizzle_migrations`).
- Wrap `runMigrations` in `pg_advisory_lock`.
- In 0050, add the CHECK as `NOT VALID`. It is strictly looser than the old one, so existing rows already satisfy it. Add the foreign key `NOT VALID` too, and `VALIDATE` both in a step after the migrations.

## 5. Low: a version sent for review by the old release after 0049 keeps no language and keeps following the setting
**Where:** `languages.ts:31-37` (`versionAuthoritative`), and the 0049 trigger section 5

**Scenario:**
- During a rolling deploy, the old release sends versions with `authoritative_locale` NULL.
- `versionAuthoritative` then falls back to the live setting for them. That is finding 3's behaviour, permanently, for those versions.
- The 0049 trigger refuses any later change of `authoritative_locale` outside draft, for every role. So a follow-up backfill would need the trigger disabled.

**Smallest fix:** let the trigger allow NULL to a value while `signs_authoritative_locale` is false. Or fill `NEW.authoritative_locale` from `document_settings`/`tenants` in the trigger on draft to in_review when it is NULL. Then backfill once the old release is gone.

## 6. Low: `AuthService.contextIn` is now public on a `@Global` module, so the BackgroundContext scoping is not enforced
**Where:** `auth.service.ts:281`

**What is wrong:**
- Any module can inject AuthService and call `contextIn(tx, tenant, user, '', null)`. That builds a context with no session, and `issuedAt: null` also skips the `issuedBeforeReset` check.
- Any module could also list `BackgroundContext` among its own providers.

Nothing reachable from a request does this today. The only callers are `resolve` and `email/background-context.ts`.

**Smallest fix:** keep `contextIn` private and give the background path its own method, taking no token and no `issuedAt`, so a null cannot be passed by accident. Add an ESLint `no-restricted-syntax` rule that allows `.contextIn(` / `BackgroundContext` only in `identity/` and `email/`.

---

## Notes (no change required)
- **Import parser, double lookup:** the parser resolves the session and the guard resolves it again. That doubles the database work only for POST JSON with a token on the three paths. A forged token whose first part is not a UUID costs nothing; with a UUID it costs one tenant query, plus one transaction if the tenant is active. Acceptable. A WeakMap keyed by `req` (never a property a client can set) would remove the second lookup.
- **Import parser, who gets 2 MB:** a manager whose client is suspended, or has no policies module, still has 2 MB read before the guard answers 403 or 404. They are authorised users, but you could also check `allows(modules,'policies')` and that the client is not suspended.
- **Import window fails open:** `import-window.ts:60` treats a missing `module_starts` row as starting today, with the window open. I found no way to reach that: the trigger records the start on insert and status change, and the route 404s without the module. Failing closed would be safer.
- **Old unsubscribe links:** their issue time is derived from `UNSUBSCRIBE_DAYS`. It is safe today (90 days both before and now, the expiry is signed, and the result is floored, so it errs towards refusing). Freeze it as a separate legacy constant so a future change of the link lifetime cannot move it.
- **Cosmetic:** `provisioning.service.ts:486-507`. `auditImportWindowChange` was inserted between `auditSubscriptionChange`'s doc comment and that function, so the comment now sits above the wrong method.

---

## What I found sound
- **Import parser:**
  - It resolves the session before reading a byte of the body and has no side effects (`resolve` only reads).
  - It needs `policies.manage` for the whole organization.
  - Errors fall through to the guard.
  - No new way to tell a real token from a fake one: an invalid token and a session that may not import both get 413 over 100 kB, else the guard's 401 or 403.
  - The guard is still the authority, so a session revoked mid-upload is refused.
  - Under the production prefix, the three `/api/v1/...` paths match. A missing prefix, a prefix inside the path, a trailing slash, capitals and a double slash all fall back to 100 kB (probed).
  - The depth scan handles strings and escapes. Negative depth from stray closers is no bypass, because `JSON.parse` fails at once.
- **`module_starts`:**
  - RLS with `tenant_isolation`, plus SELECT-only for the platform.
  - SELECT only for both roles. The application role cannot write subscriptions, plans or tenants, so a client cannot move its own start.
  - The trigger is SECURITY DEFINER with a fixed `search_path` (`pg_temp` last), no dynamic SQL, `REVOKE ... FROM PUBLIC`, and `ON CONFLICT DO NOTHING`, so cancelling and re-enabling does not reset the start.
  - The backfill gives the expected values locally (2023-11-08 for all three demo clients).
- **Import window:**
  - The application has SELECT only.
  - The platform route sits behind `PlatformAuthGuard`, which reads the platform cookie only, so a hospital session gets 401.
  - Strict schema with a one-line reason; bounds are checked; 404 for an unknown or non-UUID id.
  - The client's row is locked during a change.
  - It is audited in the platform log and in the client's log, in the same transaction. The `audit_log` insert policy for the platform is widened only to `import_window_changed`, with no actor and no address.
- **`approved_after_start`:**
  - Both sides are `YYYY-MM-DD` dates on the client's calendar, compared as strings, so time zones offer no way around it.
  - The check route, the batch route and the single route all go through `plan()`, which is run again inside the writing transaction. `importOne` keeps the code.
  - No other path writes `source = 'imported'`.
- **Authoritative language:**
  - It is recorded at submit, inside the same transaction as the check.
  - Imported versions record it and set `signs_authoritative_locale`.
  - The hash includes it only when the flag is set. Backfilled versions keep the old form, so earlier signatures stay valid (test covers it).
  - The 0049 trigger keeps every 0041 condition and adds both columns.
  - The `signs implies not null` CHECK is present.
  - A version returned to draft follows the setting and is recorded again when sent.
- **Number normalisation:** fullwidth, mathematical and other digit scripts become one ASCII form. Zero-width characters and combining marks are refused. No local document has a non-ASCII number, so the `upper()` unique key holds over what is stored.
- **Administrator fallback:** an approval step is always present, positions are renumbered, and the fallback is audited. With neither role, no route is made (409 `no_route`), where before an empty route could be created. The Administrator holds every permission.
- **Email:**
  - L1: the organization switch and entitlements are read for each email, and digests check the switch.
  - L2: links issued before a switch-on are refused on both the page and the POST. The in-app notice is written only when something changed, and does not trigger an email.
  - L3: both keys are composite in the database and declared in `schema.ts`, and `drizzle-kit check` is clean.
  - L4: digests, sending and purge are separate steps, and purge runs in `finally`.
  - Claims use the database's clock (`clock_timestamp()`, a constant interval).
  - `release()` is conditional on the claim still being held.
  - The real nodemailer shape for EAUTH is tested.
  - nodemailer 10's error codes match the classification: EENVELOPE with `RCPT TO`, EMESSAGE with `DATA`.

## What I could not check
- A live SMTP server or relay.
- Concurrent migrate runs and lock times on a large `notifications` table.
- The production Express path matching end to end: the tests serve no prefix, and I probed the middleware directly.
- The web screens for the new fields.