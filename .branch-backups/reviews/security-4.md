Security review of a7e7399 ("Make the product modular, with plans, subscriptions and limits"), range 30c2277..a7e7399, apps/api, docs and README. I changed no files. I did not run tests or start a server. All SQL ran in read-only sessions (`PGOPTIONS=-c default_transaction_read_only=on`), as the owner, `trustline_app` and `trustline_platform`.

## Findings, most severe first

### 1. High: while a subscription is suspended, a hospital cannot cut a leaver's access, but the leaver can still read everything
**Confirmed in the code, and the new test asserts the refusal** (`apps/api/test/modules-and-subscriptions.e2e-spec.ts:633`).

- **What happens.** `SessionGuard` refuses every signed-in non-GET route with 403 `subscription_suspended` unless the route is marked `@OpenWhileSuspended()` (`/home/user/Trustline/apps/api/src/identity/session.guard.ts:76-87`). Only these are marked: `POST /incidents`, logout and the two notification routes. Nothing that removes access is marked:
  - `PATCH /users/:id` with `{status:"disabled"}` (`users.controller.ts:333`)
  - `PUT /users/:id/roles` (`users.controller.ts:442`)
  - `PATCH` and `DELETE /roles/:id`
- **Reading stays open.** `GET /incidents`, `GET /incidents/:id` and the rest keep working, including patient details for anyone with `incidents.view`.
- **What someone can do.** A dismissed or compromised staff account keeps signing in and reading patient-safety records for the whole suspension, which can last weeks during a billing dispute. The hospital's administrators cannot disable the account or take its roles away.
- **The only workaround** is for Trustline staff to suspend the whole client. That ends every session and closes reporting for everyone.
- **Why it matters.** The spec's "nothing else can be created or changed" was applied to protective actions too.
- **Smallest fix:**
  - Mark `PATCH /users/:id` and `PUT /users/:id/roles` `@OpenWhileSuspended()`.
  - In each handler, when `req.auth.tenant.subscription.status === 'suspended'`, accept only reductions: `PATCH` with exactly `{status:"disabled"}`, and a role set that is a subset of the user's current grants. Refuse anything else with 403 `subscription_suspended`.
  - Add both cases to the suspended test.

### 2. Medium: suspension can quietly close incident reporting for staff without a working password
**Confirmed in the code.** This is safety availability rather than confidentiality.

- **What happens.** While suspended, these are all refused:
  - `POST /users/:id/invite`, which issues a reset or invitation link
  - `PUT /settings/reporting`, which switches on reporting without sign-in
- **Who is cut off.** In a hospital with public reporting off, these staff cannot report at all:
  - anyone who forgot their password
  - anyone whose 72-hour invitation link has expired
- **Why it matters.** The spec says a lapse "never silently closes incident reporting".
- **Smallest fix:** mark `POST /users/:id/invite` `@OpenWhileSuspended()`. It changes no record except the link, and is audited. Alternatively, record in the spec that this is accepted.
- **For `quality-reviewer`, not a security issue:** triage and status changes are also closed while suspended, but the deadline check keeps raising "overdue". So serious reports can neither be handled nor stop alarming.

### 3. Low: the platform role can write forged or backdated entries into any hospital's audit log
**Confirmed in the database.**

- **The grant and policy.** Migration 0033 grants `INSERT` on every column of `audit_log` to `trustline_platform`, including `actor_id`, `occurred_at`, `id` and `ip_address`. The policy `audit_log_platform_insert` is `WITH CHECK (true)` (`apps/api/drizzle/0032_modules_and_subscriptions.sql:36`; `0033_subscriptions_grants_and_existing_clients.sql:21`).
- **Proof.** As `trustline_platform`, `EXPLAIN INSERT INTO audit_log(tenant_id, actor_id, action, occurred_at) VALUES (<tenant>, <any uuid>, 'incident_signed_off', '2020-01-01')` passed the permission checks.
- **What someone can do.** Whoever compromises the admin portal's API or its credentials can add entries to any hospital's log that look like the hospital's own staff did something, at any date in the past.
- **What is fine.** The role cannot read, update or delete entries: no SELECT or UPDATE grant, and `INSERT … RETURNING` was refused.
- **Before this change** the platform role could not touch hospital audit logs at all.
- **Smallest fix:**
  - Change the policy to `WITH CHECK (actor_id IS NULL AND action = 'subscription_changed' AND ip_address IS NULL)`.
  - Grant INSERT on `(tenant_id, action, entity_type, entity_id, changes)` only, so `occurred_at` and `id` always take their defaults.

### 4. Low: cancelling does not fully end access if the subscription is later made active again
**Confirmed in the code.**

- **Sessions are revoked outside the transaction.** This happens after the platform transaction commits, in a separate app-role transaction (`platform-subscriptions.controller.ts:86-98`). It covers sessions only, not one-time links in `user_tokens`.
- **While cancelled, access is closed regardless.** This is checked live on every request:
  - `resolve()` and `findTenant()` refuse a cancelled subscription (`auth.service.ts:118` and `:267`), so cookies and mobile bearer tokens are refused.
  - `invite/check` and `invite/accept` answer as for an unknown hospital.
  - Follow-up codes get 404.
- **Two gaps appear on reactivation:**
  - If the revocation statement fails, or a sign-in that passed `findTenant` just before the commit writes its session after the revocation, that session comes back to life when the subscription is made active again.
  - Unexpired invitation and reset links issued before the cancellation also work again.
- **Smallest fix:**
  - Revoke sessions and set `used_at` on open `user_tokens` in the same `withTenant` block.
  - Have `resolve()` refuse sessions created before the subscription's last change to `cancelled`, for example by comparing with `subscriptions.updated_at`, so revocation does not depend on a second write succeeding.

### 5. Low: every staff member is shown that the client is behind on payment
**Confirmed in the code.**

- **What happens.** `/auth/me` returns `tenant.subscription.status` to every user (`auth.service.ts:285-293`). The spec and the engineer limit the past-due notice to settings managers, but anyone signed in sees `status: "past_due"`, and `"trial"` too.
- **Why it matters.** The client's commercial state reaches every nurse's browser, which defeats the "administrators see a notice" rule.
- **Smallest fix:** for users without `settings.manage` everywhere, report `past_due` as `active`. `suspended` must stay visible, because it changes what works.

## Checked and found sound

**Module check (`@ForModule` and `SessionGuard`)**
- Every controller is decorated: 16, including health, platform and public.
- A controller without a module throws before the session is read, giving a 500. It fails closed, and there is a unit test.
- The module is checked after the session, so without a session the answer is 401.
- The 404 text is the same as Nest's own: both use `Cannot ${method} ${req.originalUrl}`, and I checked this in `@nestjs/core` and the express adapter.
- Timing differs from a truly unknown route only by the session lookup. That is documented, and the signed-in caller already learns the same from `/auth/me`.
- A route of a module that is off returns 404 before the suspension check, so it stays consistent with an unknown route.

**Incidents with the module off.** I found no route, service or notification that reaches incidents data:
- Every `Notifier` call is in `IncidentsService` or `DeadlineCheck`. `IncidentsService` is used only by the incidents and public controllers. No core file imports incidents code apart from the default response rules.
- There is no audit-log read route, no export and no core dashboard; `/incidents/summary` is behind the module check.
- Notifications are filtered by kind in `mine()`, so list, count, mark-one-read and mark-all-read all leave them out.
- `/auth/me` filters `permissions` and `scope`. Core routes check only core permissions.
- The deadline check skips a client without incidents, or with a cancelled subscription, before doing any work.
- A tenant with no subscription row gets core only, so this fails closed too.
- Nothing in incidents visibility (`visibility.ts`, `incidents.service.ts`) changed.

**Public routes**
- All four go through `findTenant(…, 'incidents')`. Without the module, or with a cancelled subscription, they return the same 404 inside `refusedAlike` on the 50 ms step.
- The follow-up routes still do the code lookup with a null tenant, so they take the same steps.
- Sign-in and invitation links use `'core'`. A cancelled client's sign-in falls back to `burnTime`, like an unknown one.

**Grants and row-level security (all confirmed in the database)**
- The application role reads `plans` only through `id, code, name, modules, limits, extras`. `SELECT prices` is refused.
- It reads `subscriptions` on every column except `note` (`SELECT note` and `SELECT *` are refused) and writes neither table.
- `subscriptions` is under row-level security with `tenant_isolation`. As `trustline_app`, no tenant set gives 0 rows, and a tenant set gives only its own row.
- On `tenants` the application role can update only `public_reporting`.
- The platform role has no grant on `users`, `incidents` or `audit_log` reads (each refused). It has SELECT, INSERT and UPDATE on `plans` and `subscriptions`, with no DELETE.
- No role has UPDATE or DELETE on `audit_log`.
- Every tenant has a subscription: 3, all active on `everything`. The migration's data step is correct.

**Plans and subscriptions**
- No client route writes plans, subscriptions or limits. The platform routes all sit behind `PlatformAuthGuard` with strict zod schemas.
- `GET /settings/subscription` needs `settings.manage` everywhere and contains no price or note.
- The client's `subscription_changed` audit entry leaves out the note and the dates.

**Limits**
- The users limit is checked in `createUser`, which covers both `POST /users` and the platform's first administrator, and when a disabled user is enabled again.
- The sites limit is checked when a facility is created or switched back on.
- A role change, an invite, or accepting an invite does not change the count. A unit's `type` cannot change, and a facility has no parent, so no move can turn a unit into a facility.
- Concurrency: the transaction-level advisory lock is per client and per limit. The database runs at read committed (no role overrides it), so the count after the lock sees what a competing transaction committed. Under contention the app role's `lock_timeout=5s` gives an error, not a bypass.
- Counts are scoped to the client by row-level security, so one client's usage cannot affect another's. A full limit can block the first administrator only until Trustline staff set an override.

**Suspended and cancelled**
- Suspended leaves public routes, sign-in and invitation acceptance open, as the spec says. Platform routes are not affected.
- Cancelled refuses sign-in, cookies, bearer tokens, invitation and reset links, and follow-up codes, all live on each request.
- A client Trustline has suspended is checked first and stays closed whatever its subscription says.

**Other**
- No secrets or real names in the seed. Tests use `test.invalid` addresses.

## Not checked
- **Timing.** I did not measure response times, so the timing claims are read from the code.
- **Engineer's test claims.** I did not re-run the suite or the engineer's experiment of removing a decorator to see the test fail.
- **Web.** The web app's use of `/auth/me` and the new error codes is not covered.
- **Earlier work.** I did not re-review `PlatformAuthGuard` or the rate limiter (both unchanged here).
- **Migration snapshots.** I did not compare the drizzle snapshot JSON with the SQL. I checked the live database instead.

**Verdict:** no tenant-isolation, module-off or privilege-escalation hole. Fix the suspended-subscription access-revocation gap (1) before release, and tighten the platform audit-log grant (3) in the next migration.