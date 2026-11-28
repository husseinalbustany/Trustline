Sections 1, 2 and 3 are built in the API and schema, plus the four additions sent mid-task. Lint, typecheck and tests pass: **309 tests** (213 before), and `pnpm db:seed` still works. I did not run `pnpm build`, did not touch `apps/web`, and did not commit.

Git state: a checkpoint commit `17ca28e` (author "Claude", not made by me) holds the first part of this work. The four additions and their tests are uncommitted on top of it, in 9 files under `apps/api` and the spec.

## New routes

**`GET /settings/reporting`** and **`PUT /settings/reporting`** (session; `settings.manage` for the whole organization)
- PUT body: `{ publicReporting: boolean }` (strict).
- Both answer `{ publicReporting, slug }`.
- 401 without a session, 403 `missing_permission`, 400 for a bad body.
- Audited as `public_reporting_changed` `{ from, to }`; asking for what is already so writes nothing.

**Public routes** (no session, under `/public`; all answer the same 404 `{ statusCode: 404, message: "Not Found" }` when the hospital is unknown, suspended or has it off)

| Route | Body | Answer |
|---|---|---|
| `GET /public/reporting/:slug` | none | 200 `{ name, locales, defaultLocale, orgUnits: [{ id, parentId, type, name }], categories: [{ id, code, name }] }`, active ones only |
| `POST /public/reporting/:slug` | as `POST /incidents` without `anonymous` (sending it is 400) | 201 `{ reference, followUpCode }`, no `id` |
| `POST /public/follow-up/:slug` | `{ reference, code }` | 200, the same fields as `GET /incidents/:id` with `access: "reporter"`, `reporter: null`, `reporterShown: true`, `moves: []` |
| `POST /public/follow-up/:slug/comments` | `{ reference, code, body }` (body 1 to 2000) | 201 `{ id, visibility: "everyone", createdAt }` |

- **Report errors:** the same 400 codes as `POST /incidents` (`occurred_in_future`, `occurred_too_long_ago`, `harm_not_applicable`, `unknown_category`, `unknown_org_unit`).
- **Follow-up errors:** 400 only when the body is not two strings. Any wrong pair is the same 404, including a named report, another hospital's pair, or the right pair under a hospital that is off.
- **Limits:** 429 `{ statusCode: 429, code: "too_many_requests" }` with a `Retry-After` header. 10 reports an hour per address; 30 follow-up attempts an hour per address, opening and commenting together. Every attempt counts, including refused ones.
- **Code input:** letter case, hyphens and spaces are ignored in the code; case and outer spaces in the reference.

## Changed routes

**`POST /incidents`**: answers `{ id, reference, followUpCode }` when `anonymous` is true; unchanged otherwise.

**`POST /incidents/:id/status`**
- Body is now `{ to, kind?, note?, revision? }`.
- The kinds are exactly: `start`, `close`, `reject`, `reopen`, `request_sign_off`, `sign_off`, `send_back`, `withdraw`.
- `kind` is required from `awaiting_sign_off` to `in_progress` (400 `kind_required`). Elsewhere it is checked when sent (409 `invalid_transition` if no move of that kind leads there).
- New `to` value: `awaiting_sign_off` (note required; it is the proposed closure summary).
- New errors:
  - 409 `sign_off_required`: closing a sentinel event or a death outright.
  - 403 `same_person`.
  - 403 `missing_permission` with `permission: "incidents.sign_off"`.
- The route no longer checks `incidents.triage` up front, because the right depends on the move; the service checks it first thing on the incident. The only visible change: someone with no rights now gets 404 instead of 403 on an incident they cannot see.

**`GET /incidents`**
- `open=true`: every status the summary counts as open.
- `serious=true`: severe, death or sentinel, any status.
- `false` means not set for both. `open=true`, `open=true&serious=true` and `open=true&assignedToMe=true` give the same totals as the summary's `open`, `serious` and `assignedToMe`; this is tested for five kinds of caller.
- `reference` made only of digits also matches the end of a reference (`42` finds `INC-2026-00042`, and `INC-2026-00142`). Validation is unchanged.
- `status=awaiting_sign_off` is accepted.

**`GET /incidents/summary`**: `open`, `serious` and `assignedToMe` now include `awaiting_sign_off`.

**`GET /incidents/:id`** (and the answers of triage and status, which return the same view)
- New fields:
  - `reporterShown`.
  - `channel`: `"app"`, `"public"`, or null when the reporter is not shown.
  - `needsSignOff`.
  - `closureRequestedBy` (`{ id, name }`) and `closureRequestedAt`: both null without full access.
- `moves[]` is `{ to, noteRequired, kind }`.
- `events[]` gain `byReporter` (always present).
- `comments[]` gain `byReporter`, and `author` may be null.
- New event kinds: `sign_off_requested` (`details.note`), `signed_off` (optional note), `sent_back` (`details` is null for a reporter-only reader).
- A withdrawal is `status_changed` with `details: { note, withdrawn: true }`.
- While awaiting sign-off, `closureSummary` is the proposed one and `closedAt` is null.

**`GET /auth/me`**: `tenant.publicReporting` added, so the Organization page can know without `settings.manage`.

**`GET /roles`**: `permissions` now lists `incidents.see_reporter` and `incidents.sign_off`.

**Users** (`GET /users`, `GET /users/:id`, and the answers of create, update and set roles): `orgUnit` and each `roles[].orgUnit` are now `{ id, type, name, active }`.

## What breaks the current web code (checked against 1a2f242)

- **`comments[].author` can be null.** `incident-detail.tsx:408` reads `comment.author.name` and will throw. Use `byReporter`.
- **`reporter: null` no longer means anonymous.** Line 143 would say "anonymous" for a named report. Show the reporter only when `reporterShown`.
- **A null `event.actor` with `byReporter: true` is the reporter**, named or not.
- **A sentinel event or a death is no longer offered `closed`.** It gets `awaiting_sign_off`, and the status, three event kinds and eight move kinds need wording.
- **`moveAction()` should be replaced by `kind`.** It guesses from `to`, so it would label a sign-off "close".
- **Sending `to: "in_progress"` from `awaiting_sign_off` without `kind` is a 400.**
- **The two new permissions need labels** in the three dictionaries.

## Migrations

- `0017_incident_sign_off_values`: the new status and three event kinds.
- `0018_incident_safeguards`: columns, check constraints and row-level security on `tenants`.
  - Columns: `tenants.public_reporting`; `incidents.channel`, `follow_up_code_hash`, `closure_requested_by` and `closure_requested_at`; `incident_comments.author_id` nullable plus `by_reporter`.
  - Three check constraints: a public report has no reporter, a follow-up code implies no reporter, and a comment has an author or is the reporter's.
- `0019_incident_safeguards_grants`: `trustline_app` may update `tenants.public_reporting` and no other column.
- `0020_built_in_roles_reporter_and_sign_off`: adds the two permissions to the built-in Administrator and Quality officer of every existing client.

All four were also applied from zero on a scratch database in one run.

On built-in roles: nothing in the code updated them for existing clients. `ensureSystemRoles` only reaches a new client, and the call during administrator creation is rolled back when one exists. Without `0020`, quality officers would have lost reporter names on deploy.

## Decisions where the spec was silent

- **Row-level security on `tenants`.** The application role reads every row but can update only the row of the hospital it acts for, and only the one column. One hospital can therefore never switch another on, even through a bug. This is the largest change nobody asked for; the security reviewer should look at it.
- **Reporter comments.** Every comment by the reporter is shown as "the reporter" to those without the right, including ones they wrote as a handler. What they did as a handler otherwise (triage, sign-off request) stays under their name.
- **`channel` is hidden with the reporter**, because "public" would reveal the report was anonymous.
- **Withdrawal.** It is open to the requester (even after losing triage) and to anyone who may triage, as the spec says. A second quality officer is therefore offered both `send_back` and `withdraw`.
- **`incidents.sign_off` gives no sight of an incident on its own.** The signer still needs view or triage.
- **Audit rows.**
  - A public report: `{ reference, type, anonymous: true, channel: "public" }`, no actor, no address.
  - A code comment: no actor, `byReporter: true`.
- **The limiter counts an IPv6 /64 as one address.**
- **`GET /public/reporting/:slug` is not rate limited.**
- **Follow-up refusal paths take the same steps.** An unknown hospital runs the same lookup and comparison as a wrong code. Over 450 requests each, the medians of the four refusal paths were 1.91 to 1.95 ms.

## Problems in the spec

- **Follow-up codes are dead while public reporting is off.** The spec says every public route is 404 when off, and also that every in-app anonymous report gets a usable code. I kept the 404 literally, so a code issued in a hospital with the switch off works only once it is switched on. Either the web hides the code there, or the business lets follow-up work regardless.
- **The limit is per address.** A whole hospital behind one address shares 10 reports an hour.
- **The public follow-up view shows staff names and user ids** (who triaged, who commented), exactly as the reporter view does. That may not be wanted for a member of the public.
- **The `people` map needed no hiding.** I marked this in the spec, along with a note on `kind`.
- **Roles a hospital made itself are untouched.** Their holders lose reporter names and cannot sign off until an administrator adds the permissions.
- **A hospital with one person holding sign-off cannot close a sentinel event.**
- **An internal comment by "the reporter" tells a handler the reporter is one of the handlers.** This follows from the spec's rule.

## Your question on `from` and `to`

They should use the hospital's own day. I would add `tenants.time_zone` (an IANA name, set in the admin portal, defaulting to UTC) and compute the day bounds from it in the API. I would not accept an offset from the client: two users would then see different days for the same filter. It is worth doing before the deadline screens, since "overdue" and "last 30 days" will raise the same question.

Files are in `/home/user/Trustline/apps/api`:
- `src/incidents/status.ts` (all status rules in one place, for deadlines)
- `src/incidents/incidents.service.ts`
- `src/incidents/public.controller.ts`
- `src/incidents/public-limits.ts`
- `src/incidents/settings.controller.ts`
- `src/incidents/follow-up-code.ts`
- `src/incidents/report-input.ts`
- `src/security/rate-limiter.ts`
- `src/identity/tenant-settings.service.ts`
- `src/identity/users.controller.ts`
- `src/database/schema.ts`
- `test/incident-safeguards.e2e-spec.ts`
- `src/database/safeguards.spec.ts`

Outside the API: `/home/user/Trustline/README.md` (limiter is per process) and `/home/user/Trustline/docs/specs/incident-safeguards-and-deadlines.md`.