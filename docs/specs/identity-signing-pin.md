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
  (`PUT /api/v1/me/signing-pin`, body `{ pin }`). A person with a password
  signs with it, and is answered 409 `signs_with_password`.
- **Its shape.** 6 to 12 digits (400 for anything else). It may not be all
  one digit, nor digits going up or down one at a time, such as 123456,
  987654 or 890123 (400 `pin_too_simple`).
- **Fresh sign-in.** It is set or changed only within ten minutes of
  signing in for the current session (403 `fresh_sign_in_required`).
- **Storage.** It is hashed as a password is (`users.signing_pin_hash`),
  with the day it was set. It is never shown and never logged.
- **Audit.** Setting or changing it is audited (`signing_pin_set`,
  `{ action: 'set' | 'changed' }`). The person is told in Trustline
  (notification `signing_pin_changed`, `data.action`), so that a change they
  did not make is seen.
- **Signing.** Wherever a password signature is asked, the same `password`
  field takes the PIN, for a person with no password. The refusals are the
  same: 401 `wrong_password`, and after five wrong attempts 401
  `password_locked` for 15 minutes, on the same counters as the password.
  A person with neither a password nor a PIN is refused with 403
  `signing_pin_required`.
- **`GET /api/v1/auth/me`** answers `signingMethod`: `password`, `pin` or
  `none`.
- **Reset by an administrator.** Whoever may manage the person
  (`users.manage` over them, and every permission they hold) resets it
  (`DELETE /api/v1/users/:id/signing-pin`, 204). It is audited as
  `signing_pin_reset`, and the person is told. They set a new one after
  signing in again.
  - 409 `no_signing_pin` when there is none.
  - 404 for a person of another client.
- **What an administrator cannot do.** No route lets an administrator set or
  see a PIN.

## Not built

Single sign-on itself: an OIDC or SAML sign-in that creates sessions with
`method: 'sso'`. Until it is built, policies are not offered to an
organization whose staff sign in only that way, as the decision says.
