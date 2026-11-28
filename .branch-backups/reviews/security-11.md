# Security review 11: business decisions after quality review 3 (af26759..4b020a8)

## Decisions: fix everything
1. Owner confirmation: record whom it is due from (due_from); an owner change while awaiting makes it due from the new owner (and reminds them); refuse an owner change that makes the importer the owner while awaiting; refuse confirmedBy = importedBy unless byImport was set at import time; byImport is never inferred later. Fix the 0054 backfill with a follow-up migration (compare with the owner at import time from the audit/import row; where unknown, set awaiting and due 30 days from now) and audit it per client. The Administrator creating a stand-in Quality officer is reported to the business; it stays audited.
2. PIN lockout: failures count cumulatively and reset only on success; after 10 failures PIN signing is locked until an administrator resets the PIN (the person then sets a new one); the session that triggers the lock is revoked; the person is told in the app and by a compulsory email. Wider blocklist: repeated pairs/triples, mirrored, dates (DDMMYY, YYYYMMDD and the like), a top-N common list.
3. Changing a PIN needs the current PIN; set, change and reset send a compulsory email and revoke the person's other sessions. The spec states that when single sign-on is built, "fresh" must come from the identity provider's auth_time after forced re-authentication, and session.method must be 'sso'.
4. Trigger: once acknowledged_at is set, it and signature_id stay fixed; retention test covers UPDATE.
5. Keep-decision trigger on document_review_approvals.
6. Cheap checks before hashing in PUT /me/signing-pin.
7. Server-held pepper (HMAC with a secret from configuration) before scrypt for PINs; documented in .env.example without a value.
8. Refuse invitations (password setting) for a person who has a PIN; say so plainly.
9. Audit the 0054 confirmation backfill per client; follow-up backfill for confirmation_due_on NULL.
10. Fix the assertWithinOwn comment; web shows import only with policies.import for the whole organization.
11. Turning noChangeNeedsApproval off for a type notifies the Approving authorities and Administrators (in-app), audited; fall back to Administrators when the only Approving authority is the requester.

Security review of `git diff af26759..4b020a8 -- apps/api docs/specs` (Rima)

I found no critical problems and no tenant-isolation holes. There are four medium findings and several low ones. I proved findings 1 and 2 with a probe test I wrote outside the repo, and finding 4 with a SQL update that I rolled back. The suite file `test/policies-decisions-q3.e2e-spec.ts` passes (20/20). I changed no repository files.

Probe test: /tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/probe/probe.e2e-spec.ts
Its output: /tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/probe/log.txt

## Findings

### 1. Medium: changing the owner gets around the owner's confirmation of an import
- **Where:**
  - `apps/api/src/policies/imports.service.ts:318`: `byImport` is fixed when the document is imported.
  - `apps/api/src/policies/documents.service.ts:1434`: `PATCH` changes `ownerId` and never touches `document_imports`.
  - `documents.service.ts:2881`: `confirmable` checks only the current owner.
- **Proved, scenario A:** the Quality officer imports with `ownerId` set to themselves, which sets `byImport: true`. They then `PATCH` the owner to the real department head. That owner's `GET` returns `importConfirmation: {state:'confirmed', byImport:true, confirmedBy: Quality officer}` and no `confirm_import` move. The web will say "Confirmed by the import: the owner imported it", which is false. The real owner is never asked or reminded.
- **Proved, scenario B:** the Quality officer imports for X, `PATCH`es the owner to themselves (they hold `policies.manage` everywhere), then `POST /confirm-import`. The answer is 200. They have confirmed their own import with a second signature, and X never sees it.
- **Chained:** an Administrator can create a stand-in Quality officer account. `POST /users` with roles is allowed by `mayGrant`, and `POST /users/:id/invite` returns the raw token to the admin (`users.controller.ts:565`). Through that account they can import a document that is "approved before Trustline" and already confirmed, then hand it to a real owner. Every step is audited, but nothing stops it. Decision 1 ("not the Administrator") is therefore advisory only. The business should know this.
- **Migration 0054 makes it worse** (`drizzle/0054…sql:44`): its backfill compares the importer with the owner *at migration time*, not at import time.
- **Fix:** while an imported version is still awaiting confirmation, refuse an owner change that makes the importer the owner. When the owner changes, record the confirmation against the owner it was due from (for example a `due_from` column) and require a new one from the new owner, or at least word it as "confirmed by <name>, the owner then". In confirmation, refuse `confirmedBy === importedBy` unless `byImport` was set when the document was imported.

### 2. Medium: the PIN lockout does not stop slow, steady online guessing
- **Where:** `apps/api/src/identity/auth.service.ts:448` (`failedAttempts` goes back to 0 at each lock) and `pinTooSimple` at `:50`.
- **Proved:** three lock windows allowed 15 guesses; each window gives 5 wrong attempts and then `password_locked`. The person gets no notice of failures or locks, only `password_confirmation_failed` audit rows. `121212`, `112233`, `123123`, `000123` and `696969` were all accepted as PINs.
- **What is sound:** the counter is per person, under a row lock, so it is shared across sessions. Every signing route goes through `confirmPassword`, so it is shared across routes. A PIN cannot be used to sign in: `login` needs `passwordHash`.
- **Scenario:** anyone holding a stolen session, or sitting at an unattended shared ward workstation, gets 20 guesses an hour, which is 160 in one 8-hour session and 480 a day, without end. Against PINs people actually choose, the top few hundred cover a meaningful share. Success lets them sign approvals and acknowledgements as the victim.
- **Fix:**
  - Count failures cumulatively and reset only on success. After about 10 to 15 failures, lock PIN signing until the person signs in fresh, or until an admin reset.
  - Revoke the session that triggers a lock.
  - Tell the person, in the app and by email, when a lock happens.
  - Widen the blocklist: repeated pairs and triples, mirrored PINs, dates, and a top-N list. Or require 8 digits.

### 3. Medium (latent; high once SSO ships): a "fresh sign-in" is just session age, and changing a PIN does not need the old one
- **Where:** `apps/api/src/identity/auth.service.ts:507-535`.
- **Why it is safe today:** no code path creates a session for a person without a password. `login` needs a hash, and `acceptInvite` sets one. Only the tests create such sessions, by nulling the hash.
- **What the check does:** it reads `sessions.createdAt` only. It never reads `sessions.method`. The `changed` path does not ask for the current PIN.
- **When SSO arrives:**
  - SSO sign-in is usually silent while the identity provider's session is alive. Anyone at the victim's browser can sign out and in, get a session less than 10 minutes old, replace the PIN without knowing the old one, and sign as the victim.
  - A token stolen in its first 10 minutes allows the same.
  - The only warning is an in-app notification (`provisioning.service.ts` `tellAboutSigningPin`). It is not emailed, and the attacker can mark it read (`POST /notifications/:id/read`).
  - Other sessions are not revoked on a PIN change or on an admin reset.
- **Fix:**
  - Require `session.method === 'sso'`, plus an `authenticated_at` taken from the identity provider's `auth_time` after a forced re-authentication (`prompt=login` / `max_age`). Do not use the session row's creation time.
  - Require the current PIN for `changed`.
  - Email the person on `set`, `changed` and `reset`, as a compulsory security notice.
  - Revoke the person's other sessions on change and on reset.

### 4. Medium: retention. The application role can erase an acknowledgement without deleting it
- **Where:** column grant `UPDATE (acknowledged_at, signature_id)` on `document_acknowledgements`. There is no trigger like the new `document_imports_keep_confirmation`.
- **Proved:** as `trustline_app`, inside the client's RLS context, `update document_acknowledgements set acknowledged_at=null, signature_id=null where id=…` returned `UPDATE 1` (rolled back).
- **What is sound:** DELETE is truly denied on `document_acknowledgements`, `signatures`, `document_reviews`, `documents` and `users`. No `ON DELETE CASCADE` reaches those tables; the cascades from `users` go only to sessions, tokens, notifications, email and role assignments. `trustline_platform` has no DELETE on `tenants`. `test/cleanup.ts` runs as the owner role.
- **Scenario:** a bug, or SQL access as the application role, turns an acknowledged record back into a pending one, and the link to its signature is lost. Decision 8's claim covers deletion only, and the new test checks only DELETE.
- **Fix:** add a BEFORE UPDATE trigger: once `acknowledged_at` is set, it and `signature_id` stay fixed. Add an UPDATE case to the retention test.

### 5. Low: a decided "no change" review can be rewritten
- **Where:** `document_review_approvals` grants UPDATE on status, decision and signature columns (`0054…sql`, section 1), with no trigger.
- **Scenario:** the application role can turn `returned` into `approved`, pointing at any signature id, or reset a decision to `pending` (the CHECK constraint allows it if `decided_*` are nulled).
- **Fix:** a keep-decision trigger, as for `approval_run_steps` and imports.

### 6. Low: setting a PIN costs the server before it refuses
- **Where:** `auth.service.ts:499` runs scrypt (N=2^17, about 128 MB) before the `signs_with_password` and `fresh_sign_in_required` checks. Authenticated routes have no rate limit.
- **Scenario:** any session can send `PUT /me/signing-pin` in parallel to exhaust memory and CPU.
- **Fix:** run the cheap checks first, hash, then check again under the lock.

### 7. Low: a stolen database dump gives up PINs offline
- **Scenario:** about 10^6 scrypt attempts recover any PIN in core-hours.
- **Fix:** add a server-held pepper (HMAC) before scrypt, for PINs at least.

### 8. Low: an admin can give a PIN person a password they chose
- **Where:** `users.controller.ts` invite, `:565`.
- **Scenario:** for a PIN person in a client whose `signInMethod` is `both`, the admin gets an `invitation` token, sets the password, and signs as the person. The PIN stays stored but unused (`passwordHash ?? signingPinHash`). Clients set to `sso` refuse this at `acceptInvite`.
- **Fix:** refuse invites for people with a PIN or SSO subject, or clear the PIN and notify them when a password is set.

### 9. Low: migration 0054 and the rolling deploy
- The confirmation backfill (step 3) writes confirmations attributed to people without an audit entry.
- Imports made by the old release after the migration get `confirmation_due_on = NULL`. They stay `awaiting` forever and are never reminded (the reminder query uses `<=` on null).
- **Fix:** audit the backfill per client, and add a follow-up backfill, or make the column NOT NULL once the deploy is done.

### 10. Low: the grant exception is harmless but untidy
- `mayGrant` (`scope.ts:106-120`) lets someone who manages documents for one department grant `policies.import` for that department. That grant does nothing, because the routes need the whole organization, but `/auth/me.permissions` lists it. The contract tells the web to show the import screens from that list, so the screens would appear and then 403. The web should check scope for the whole organization.
- A custom role holding `policies.import` can be created by anyone with `roles.manage` and `policies.manage` everywhere. Combined with other permissions, it could make an IT admin colleague an importer. The comment on `assertWithinOwn` ("each permission must be one the actor holds") is now wrong.
- Self-escalation is blocked: `cannot_change_self`, and roles you hold cannot be edited (`cannot_change_own_role`).

### 11. Low: the "no change" review rules
- Whoever manages documents everywhere, the Quality officer included, can `PATCH /types` to turn `noChangeNeedsApproval` off for policies and then confirm alone. It is audited, but one person can remove the second signature.
- If the only Approving authority over the unit is the requester, there is no fall back to Administrators; the answer is 409 `no_review_approver`.
- The same-person rule covers the requester only. If a manager asks, the owner may approve if they are an Approving authority. That is still two people.

## Checked and sound
- **Tenant isolation:**
  - `document_review_approvals` has RLS and the `tenant_isolation` policy.
  - Every new foreign key is composite with `tenant_id`: imports `confirmed_by` and its signature, reviews `approved_by` and its signature, and the requester, decider and signatures of review approvals.
  - Every new route runs inside `withTenant` with the tenant from the session. Records of another client answer 404: the PIN reset, documents through `find`.
- **Permissions:**
  - All three import routes need `policies.import` for the whole organization, and so does the 2 MB body (`import-body.ts`).
  - The register stays with `policies.manage`.
  - The built-in Administrator lacks `policies.import`; the Quality officer has it, and its 0054 backfill is audited and safe to repeat.
- **Confirm-import:**
  - Owner only; checks revision and `not_active`; locks the import row.
  - The password is checked before the lock and the state again under it.
  - A replay gets 409, and the trigger plus the column grants keep a confirmation once given. `confirmed_by_import` and the due date are not writable by the application.
- **Review approve and return:**
  - Both need `policies.approve`. The approvers are recomputed under the document and pending-row locks, with RLS.
  - A pending review is not offered `confirm_review`, and a partial unique index allows only one pending review.
  - `nextReviewOn` and `lastReviewedOn` move only when the approval is signed. The signatures are chained by content hash.
  - Comments are limited to the owner, managers, full viewers and approvers. Approving authorities and Administrators hold `view_all`, so "Awaiting me" leaks no titles.
- **The PIN:**
  - scrypt hashing; never returned (tested).
  - A password holder gets 409 `signs_with_password`; there is no route to downgrade.
  - `signing_pin_required` comes before any count and only for oneself.
  - The admin reset needs `users.manage` and the right to manage the person; it is audited and the person is told. No route sets or reveals a PIN.
  - `signingMethod` reveals only the caller's own method.
- **Emails:**
  - The organization switch is checked first and still stops everything.
  - The compulsory override applies only to the listed immediate kinds, so unsubscribing cannot switch them off.
  - The unsubscribe page wording is the same for everyone, and `alwaysOn` is built from the caller's own permissions.
- **Language per document:**
  - Set through `forManager`, validated against the client's languages (400 `language_mismatch`), and audited with `authoritative` and `versionsInProgress`.
  - Versions already sent keep their recorded language, and drafts and submissions use the document's.
- **Database grants:** nothing was widened beyond new SELECT/INSERT and column-level UPDATEs, and the application role has no DELETE on audit rows.

## Could not check
- Single sign-on itself, which is not built; findings 3 and 8 depend on how it is built.
- The web screens.
- Timing under load.
- Whether the business accepts that an Administrator can make Quality officers, including a stand-in account (finding 1).