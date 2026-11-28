## Steps 1 to 3 of the modules spec: done in the database and API, not committed

Steps 1 to 3 of `docs/specs/modules-and-subscriptions.md` are built in the database and the API. `pnpm --filter api lint`, `typecheck` and `test` pass: **585 tests pass, 26 files** (the 552 from before plus 33 new ones in `apps/api/test/modules-and-subscriptions.e2e-spec.ts`). `pnpm db:seed` works and is safe to run twice, `pnpm --filter api build` passes, and a test run leaves nothing behind in the database. I did not run the web build; nothing in the web changed.

I checked that the guard test really fails: with `@ForModule` removed from one incidents controller, the new test file fails.

Since this touches permissions, tenant data and the database roles, `security-reviewer` should look at it before `quality-reviewer`.

## Contract for the web engineer

### `GET /auth/me` (changed)
- `tenant.modules: ModuleCode[]`: the modules switched on, in this order: `incidents`, `investigations`, `actions`, `policies`, `risks`, `training`, `ai_assistant`. Core is never listed. Existing clients get all seven, but only `incidents` is built, so show only built modules.
- `tenant.subscription: { status: 'trial'|'active'|'past_due'|'suspended', notice: null|'past_due'|'suspended' }`.
  - `notice` is `'past_due'` only for users holding `settings.manage` for the whole organization, and null for everyone else.
  - `notice` is `'suspended'` for everyone.
  - A cancelled subscription never reaches this route (401).
- `permissions` and `scope` now leave out the permissions of modules that are off. Roles still hold them, and `GET /roles` still shows them.

### Routes of a module that is off
- **Signed-in incidents routes** answer 404 with Nest's unknown-route body: `{ "message": "Cannot <METHOD> <path as requested>", "error": "Not Found", "statusCode": 404 }`. The path includes `/api/v1` in production. This covers `/incident-categories`, `/incidents/*`, `/settings/reporting` and `/settings/response-rules`. Without a session the answer is still 401.
- **Public routes** answer exactly as for a hospital that does not exist: the same 404, on the same 50 ms step.
- **Notifications** of a module that is off are not sent. They are also not listed, counted or markable: `POST /notifications/:id/read` answers 404. They come back when the module is switched on again.

### `GET /settings/subscription` (new)
- Needs `settings.manage` for the whole organization. 401 without a session, 403 `{ code: "missing_permission", permission: "settings.manage" }` without the permission.
- Response:
  ```
  { plan: { code, name: Localized }, status, startsOn: "YYYY-MM-DD",
    renewsOn: string|null, trialEndsOn: string|null,
    modules: [{ code, enabled: boolean, from: "plan"|"add_on"|null }],
    limits: { users: { max: number|null, used: number },
              sites: { max, used },
              storageMb: { max, used: null },
              aiCreditsPerMonth: { max, used: null } } }
  ```
- `modules` lists all seven, in order. No price and no note are ever included.

### New error codes on existing routes
- **`409 { code: "limit_reached", limit: "users"|"sites", max }`** on:
  - `POST /users`
  - `PATCH /users/:id` when it re-enables a disabled user
  - `POST /org-units` with `type: "facility"`
  - `PATCH /org-units/:id` with `active: true` on a facility
  - `POST /platform/tenants/:id/administrators`
- **`403 { code: "subscription_suspended" }`** on every signed-in non-GET route while the subscription is suspended. The exceptions are `POST /incidents`, `POST /auth/logout`, `POST /notifications/read-all` and `POST /notifications/:id/read`. Public routes stay open.

### Platform routes (all need `PlatformAuthGuard`; 401 without the platform cookie)

**Plan object:**
```
{ id, code, name: Localized, description: Localized|null, modules: ModuleCode[],
  limits: { users, sites, storageMb, aiCreditsPerMonth: number|null },
  extras: { sso, publicReporting, clinicalAiSuggestions: boolean },
  prices: [{ currency: "SAR", amountMinor: int, term: "monthly"|"yearly", basis: "flat"|"per_user"|"per_site" }],
  active, position, createdAt, updatedAt, subscribers: number }
```

**Plan routes:**
- **`GET /platform/plans`** returns `Plan[]`, retired ones included, ordered by position then code.
- **`GET /platform/plans/:id`** returns a Plan. 404 if unknown or not a uuid.
- **`POST /platform/plans`** returns 201 Plan.
  - Body: `code` (`^[a-z0-9][a-z0-9_-]{1,39}$`, fixed once created), `name`, `modules`, `limits` (all four keys), `extras` (all three keys).
  - Optional: `description`, `prices` (default `[]`), `active` (default true), `position` (default 0).
  - Errors:
    - 400 (invalid body)
    - 400 `{ code: "language_mismatch" }`: name or description is missing any of en, ar, fr
    - 400 `{ code: "module_dependency_missing", module, requiresAnyOf }`
    - 409 `{ code: "code_taken" }`
- **`PATCH /platform/plans/:id`** takes any of the fields above except `code` and returns the Plan. Retiring is `{ active: false }`. There is no delete route.
  - Errors: 400 (empty or invalid body), 404, `language_mismatch`, `module_dependency_missing`. The last one includes `tenantId` when a client's add-on would lose what it needs.

**Subscription routes:**
- **`GET /platform/tenants/:id/subscription`** returns:
  ```
  { tenantId, plan: { id, code, name, active }, status, startsOn, renewsOn, trialEndsOn,
    addOnModules, limitOverrides, note, createdAt, updatedAt,
    effective: { modules, limits, extras }, usage: { users, sites } }
  ```
  404 if the client is unknown or the id is not a uuid.
- **`PATCH /platform/tenants/:id/subscription`** returns the same shape.
  - Body, all optional, at least one: `planId`, `status` (`trial`|`active`|`past_due`|`suspended`|`cancelled`), `startsOn`, `renewsOn|null`, `trialEndsOn|null`, `addOnModules`, `limitOverrides` (any subset of the four keys; int ≥ 0 or null), `note|null`.
  - Errors:
    - 400 (invalid body)
    - 404
    - 400 `unknown_plan`
    - 400 `plan_retired`: moving to a retired plan; staying on one is fine
    - 400 `trial_end_required`
    - 400 `invalid_dates`: renewal or trial end before the start
    - 400 `module_dependency_missing`
  - Cancelling revokes every session of the client.

**Changes to existing tenant routes:**
- **`POST /platform/tenants`**: new optional `planId`. `plan` is now optional and deprecated: still stored, read by nothing.
  - Without `planId`, the client starts on the `everything` plan, so the portal's current screens keep working.
  - New errors: 400 `unknown_plan`, `plan_retired`, `plan_required`.
- **`GET /platform/tenants`** and **`GET /platform/tenants/:id`** gain `subscription: { status, plan: { id, code, name } } | null`.
- **`POST /platform/tenants/:id/administrators`**: new 409 `{ code: "subscription_cancelled" }`.

**Audit entries:**
- Platform audit log: `plan_created`, `plan_updated` and `subscription_updated`, each with the changed fields and their old and new values.
- The client's own `audit_log` gets `subscription_changed` (no actor), with `plan`, `status`, `modules {on, off}`, `limits`, `platformAdminId` and `platformAdminEmail`. It is written in the same transaction as the change, including for every client affected by a plan edit (with `planUpdated`).

## Migrations
- `apps/api/drizzle/0032_modules_and_subscriptions.sql` (generated): the `plans` table, the `subscription_status` enum, and the `subscriptions` table with `tenant_isolation` and a policy letting the platform role write it. It also adds an insert-only policy on `audit_log` for the platform role.
- `apps/api/drizzle/0033_subscriptions_grants_and_existing_clients.sql` (custom):
  - Grants:
    - **Platform role:** read, add and change `plans` and `subscriptions`; no delete.
    - **Application role:** reads only some columns: on `plans`, everything except prices; on `subscriptions`, everything except the note. It writes nothing.
    - **Platform role on `audit_log`:** can add entries but not read the log.
  - Data: creates the `everything` plan (all modules, no limits, extras `sso` and `publicReporting` true, `clinicalAiSuggestions` false). Puts every existing client on an active subscription on it, starting on the day the client was created, in its own time zone.
- `tenants.plan` and its enum are kept, because the web still reads and sends them. Nothing reads them now; drop them in a later migration once the portal stops.

## Decisions I took (also written into the spec)
- **Where the check lives:** `@ForModule(...)` on every controller, enforced in `SessionGuard`. A signed-in controller without one is refused with a 500, and the test fails. Public routes must name their module through `AuthService.findTenant(slug, forPassword, module)`. The test walks every incidents route automatically.
- **Timing:** the module-off answer has the same shape as an unknown route, but a signed-in one also takes the time of the session lookup. That tells the caller nothing `/auth/me` doesn't already tell them.
- **Notifications are core**, not part of incidents. Each kind of notification is mapped to its module.
- **`reports.view` is core.** `ai_assistant` "needs another module" is read as any other module.
- **Extras are stored, not enforced:** SSO and AI aren't built, and whether public reporting is a paid extra is still an open decision.
- **Prices** are stored as data and never shown to clients or readable by the application role.
- **Add-ons and overrides** live on the subscription row, with their history in the audit logs, instead of the dated `subscription_items` and `tenant_modules` tables in the spec's outline.
- **Dates never change a status on their own.** A trial needs an end date.
- **Suspended subscription:** public routes stay open, follow-up comments by code included. The deadline check keeps running. New write routes are closed by default unless marked `@OpenWhileSuspended()`.
- **Cancelled subscription** behaves like a client Trustline has suspended, and ends sessions. The client's own status is checked first, so a client Trustline has suspended stays closed whatever its subscription says.
- **Disabled users don't count** towards the users limit, so disabling a leaver frees a place; re-enabling one takes a place.
- **Limits are serialized** per client and limit with a transaction-level advisory lock, so the application role needs no write access to the subscription.
- **Plan names and descriptions** must be written in every language the product has.

## Files
- New:
  - `/home/user/Trustline/apps/api/src/subscriptions/` (`modules.ts`, `entitlements.service.ts`, `module.decorator.ts`, `plans.service.ts`, `subscriptions.service.ts`, `subscription-input.ts`, `subscription-settings.controller.ts`, `subscriptions.module.ts`)
  - `/home/user/Trustline/apps/api/src/platform/platform-plans.controller.ts`
  - `/home/user/Trustline/apps/api/src/platform/platform-subscriptions.controller.ts`
  - the test file above
- Main changes:
  - `/home/user/Trustline/apps/api/src/identity/session.guard.ts`, `auth.service.ts`, `auth.controller.ts`, `permissions.ts`, `provisioning.service.ts`, `users.controller.ts`
  - `/home/user/Trustline/apps/api/src/organization/org-units.service.ts`
  - `/home/user/Trustline/apps/api/src/incidents/public.controller.ts`, `notifier.ts`, `notifications.service.ts`, `deadline-check.service.ts`
  - `/home/user/Trustline/apps/api/src/platform/platform-tenants.controller.ts`
  - `/home/user/Trustline/apps/api/src/database/schema.ts`, `seed.ts`
  - `/home/user/Trustline/apps/api/test/cleanup.ts` (now also removes subscriptions and test plans)
- Docs: `/home/user/Trustline/docs/specs/modules-and-subscriptions.md` (new section "Built: steps 1 to 3"; the "Decisions needed" stay open) and `/home/user/Trustline/README.md`.

No new permissions, so the web dictionaries are unchanged. The web will need wording for the new error codes and notices.

During my first test run, cleanup failed because the subscriptions table blocked deleting test clients. That left 40 test hospitals and 10 test admins, all created in that run; I deleted them by SQL as the owner role and fixed `cleanup.ts`.