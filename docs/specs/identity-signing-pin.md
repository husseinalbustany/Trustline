# Signing PIN for people who sign in through single sign-on

Business decision 9 (`policies-and-procedures.md`, "Decided by the business
after quality review 3"): people who sign in through their organization's
single sign-on set a separate signing PIN in Trustline. They use it wherever
a password signature is asked: approving a version, acknowledging a
document, confirming a review or an import, signing off an incident.

## How sign-in works today

Single sign-on is not built yet. A client set to `signInMethod: 'sso'` is
refused password sign-in (`AuthService.findTenant`), and no route creates a
session through single sign-on. So, in this API:

- **"Signs in only through single sign-on"** means **has no password**
  (`users.password_hash` is null).
- **"A fresh sign-in"** means **the current session was created in the last
  ten minutes**. Each session records how the person signed in
  (`sessions.method`): `password` today, `sso` once single sign-on creates
  sessions. For a person with no password, only single sign-on can create a
  session.

## Rules

- **Who has a PIN.** Only a person with no password sets a PIN
  (`PUT /api/v1/me/signing-pin`, body `{ pin, currentPin? }`). A person with
  a password signs with it, and is answered 409 `signs_with_password`.
- **Its shape.** 6 to 12 digits (400 for anything else). It may not be easy
  to guess (400 `pin_too_simple`), meaning any of:
  - fewer than three different digits;
  - digits going up or down one at a time, such as 123456, 987654 or 890123;
  - a block repeated, such as 121212 or 123123;
  - each digit doubled, such as 112233;
  - the same read both ways, such as 123321;
  - a day, such as 311290 (DDMMYY, MMDDYY, YYMMDD) or 19800521 (the
    8-digit forms with a year 1900 to 2099);
  - one of the most common PINs.
- **Fresh sign-in.** It is set or changed only within ten minutes of
  signing in for the current session (403 `fresh_sign_in_required`).
- **Changing it needs the current PIN** (400 `current_pin_required`). The
  current PIN is checked and counted as any signature, so it can lock.
- **Cheap checks first.** The shape, the person, the session and the
  current PIN are checked before the new PIN is hashed.
- **Storage.**
  - It is hashed as a password is, but of an HMAC of it with the server's
    pepper (`SIGNING_PIN_PEPPER`, 32 characters or more, from the
    environment, documented in `.env.example` without a value). A copy of
    the database alone does not give the PINs up to guessing.
  - Without a pepper no PIN is set or checked (503
    `signing_pin_unavailable`).
  - It is never shown and never logged.
- **When it is set, changed or reset:**
  - every other session of the person ends (a reset ends all of them);
  - it is audited (`signing_pin_set` with `{ action }`, or
    `signing_pin_reset`);
  - the person is told in Trustline and by an email they cannot switch off
    (`signing_pin_changed`, `data.action`).
- **Signing.** Wherever a password signature is asked, the same `password`
  field takes the PIN, for a person with no password. The refusals are:
  - 401 `wrong_password`;
  - 401 `password_locked` for 15 minutes after five wrong attempts, on the
    same counters as the password;
  - 403 `signing_pin_required` for a person with neither a password nor a
    PIN.
- **The lock** (security review 11):
  - Wrong PINs are counted in all, whatever the short locks between, and
    only a right one sets the count back.
  - At ten, signing with the PIN is locked (403 `signing_pin_locked`, even
    with the right PIN, and changing the PIN too) until an administrator
    resets it.
  - The session the tenth was entered in is ended.
  - The person is told in Trustline and by an email they cannot switch off
    (`signing_pin_locked`).
  - It is audited (`signing_pin_locked`, with the count).
- **`GET /api/v1/auth/me`** answers `signingMethod`: `password`, `pin` or
  `none`.
- **Reset by an administrator.** Whoever may manage the person
  (`users.manage` over them, and every permission they hold) resets it
  (`DELETE /api/v1/users/:id/signing-pin`, 204).
  - The PIN, the count and the lock go, and every session of the person
    ends.
  - It is audited as `signing_pin_reset`, and the person is told.
  - They set a new one after signing in again.
  - 409 `no_signing_pin` when there is none; 404 for a person of another
    client.
- **What an administrator cannot do.** No route lets an administrator set or
  see a PIN. Nor may they give a person with a PIN, or an SSO identity, a
  password through a sign-in link they hold (`POST /users/:id/invite`, 409
  `signs_with_pin`): whoever held the link could sign as the person.

## When single sign-on is built

These are requirements, not options (security review 11):

- **"Fresh" must come from the identity provider.** It is the provider's
  `auth_time`, after a forced re-authentication (`prompt=login` or
  `max_age` in OIDC, `ForceAuthn` in SAML), recorded on the session. It is
  not the time the session row was created: a silent single sign-on while
  the provider's session is alive would otherwise count as fresh.
- **The session must be one of single sign-on** (`sessions.method =
  'sso'`) for setting or changing a PIN.
- **`assertFreshSignIn`** in `auth.service.ts` is the one place to change.

## Not built

Single sign-on itself: an OIDC or SAML sign-in that creates sessions with
`method: 'sso'`. Until it is built, policies are not offered to an
organization whose staff sign in only that way, as the decision says.
