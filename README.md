# Trustline

Quality, risk and incident management for hospitals. One codebase, deployable
as shared SaaS, with a dedicated database, or single-tenant.

This repository is at the start of the Foundation phase: the project skeleton,
tenant isolation, and the bilingual web shell.

## Layout

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS API. Postgres through Drizzle, migrations in `apps/api/drizzle`. |
| `apps/web` | Next.js web app, in English, Arabic (right-to-left) and French. |
| `docker-compose.yml` | Postgres for local development. |

## Web app structure

Every signed-in screen sits inside one shell: a sidebar, a top bar with the
"Report an incident" button, and the page.

| Path under `apps/web/src` | What it holds |
| --- | --- |
| `config/navigation.ts` | The sidebar: groups, order, routes, icons, delivery phase. |
| `app/[lang]/(app)/` | One folder per area: `dashboard`, `incidents`, `investigations`, `actions`, `policies`, `risks`, `training`, `reports`, `admin/*`. |
| `components/shell/` | Sidebar, top bar, language switcher. |
| `components/ui/` | Shared building blocks: page header, panel, badge, button. |
| `i18n/dictionaries/` | All interface text, one file per language. No text is written in components. |

Areas that are not built yet render `components/module-page.tsx`, which lists
what the area will cover. To build an area, replace its `page.tsx`. To add
one, add a folder, a `navigation.ts` entry, and its text in both dictionaries.

Layout uses logical properties (`start`/`end`, not left/right), so Arabic
mirrors without separate styles.

## Admin portal

Trustline's own staff manage every client at `/en/platform` (or `/ar/platform`):
add a hospital, edit its settings, suspend or reactivate it. It has its own
sign-in, separate from the hospitals' users.

- **Accounts** are created from the command line, never from the portal or
  the API:

  ```bash
  PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_NAME="Your Name" \
    PLATFORM_ADMIN_PASSWORD='at least 12 characters' pnpm platform:create-admin
  ```

  Running it again for the same email resets the password and clears a lock.
- **Sign-in** uses a session cookie that scripts cannot read. Five wrong
  passwords lock the account for 15 minutes. Sessions last 8 hours.
- **Database access** goes through a third role, `trustline_platform`
  (`PLATFORM_DATABASE_URL`). It can manage client records, plans and
  subscriptions but cannot read hospital data, and it can add to the audit
  logs (its own, and a client's when it changes what the client may use) but
  not change them.
- **Every change** is recorded in `platform_audit_log` and shown on the
  client's page.
- **Plans and subscriptions** are managed here too: see "Modules, plans and
  subscriptions" below.

Not built yet: a second sign-in factor for admins.

## Hospital sign-in, users and roles

Hospital staff sign in at `/en/login` with their organization's identifier,
email and password. A hospital can share `/en/login?org=<identifier>` so the
first field is already filled.

- **First administrator:** created from the admin portal, on the client's
  page. The portal can create only the first one; it is refused once the
  hospital has an administrator, and the hospital's audit log names the
  Trustline staff member who created it. Everyone else is added by a hospital administrator under
  Administration, Users and roles.
- **Passwords are never set by an administrator.** Adding a user produces a
  one-time link (valid 72 hours) that the person opens to choose their own
  password. The same mechanism resets a password, and a reset signs the user
  out everywhere. There is no email sending yet, so the administrator passes
  the link on.
- **Roles** are sets of permissions. Every client starts with five built-in
  roles (Administrator, Quality officer, Department manager, Approving
  authority, Reporter) and can add its own. A role is granted for the whole organization or one department.
- **Safeguards:** five wrong passwords lock an account for 15 minutes; nobody
  can change their own roles, edit a role they hold, or disable themselves;
  nobody can give a role that allows more than they may do, or act on a user
  who may do more than they may; a disabled user and a
  suspended client are signed out at once, its open set-password links end,
  and none of either comes back when it is made active again.
- **Audit:** sign-ins and every account or role change go to `audit_log`,
  which the application can add to but not change.

Permissions are checked in the API (`requirePermission` in
`apps/api/src/identity/session.guard.ts`). The menu hides what a user cannot
open, but that is a convenience, not the protection.

A role granted for one department reaches that department and everything
under it, and no further. This applies to managing users too: a user manager
for one ward cannot grant access beyond the ward or act on an account outside
it. Creating and editing roles, and changing the hospital structure, need the
permission for the whole organization.

Not built yet: rate limiting on sign-in, single sign-on, a second sign-in
factor, and self-service "forgot password" by email.

## Hospital structure and incident reporting

- **Structure:** an administrator builds the tree of facilities, departments
  and units under Administration, Organization. A unit is switched off, never
  deleted, so old records keep its name.
- **Reporting:** any member of staff reports an incident, near miss or hazard,
  optionally without their name. An anonymous report stores no reporter at
  all. Each report gets a reference such as `INC-2026-00042`.
- **Handling:** a quality officer or department manager triages the report
  (harm level, sentinel or not, handling department, assignee), moves it to in
  progress, and closes it with a summary. A report can be set aside with a
  reason, before or after triage, unless it is severe, fatal or sentinel (or
  has been, and so needs a second signature). A closed report can be
  reopened, and then has a new deadline to close by.
- **Timeline and comments:** every step is written to the incident's timeline
  by the system, with the previous and new values. Comments are either visible
  to the reporter or internal to those handling the incident.
- **Who sees what:** a reporter sees their own reports; a handler sees the
  incidents that happened in, or were handed to, the departments their role
  covers; an assignee sees what is assigned to them.
- **Who sees the reporter:** the reporter, and those holding
  `incidents.see_reporter` for the incident's unit or handling department
  (built in: Administrator and Quality officer). Everyone else who handles the
  incident, its assignee included, gets no name and is not told whether the
  report was named or anonymous.
- **Reporting without sign-in:** off for every hospital until someone holding
  `settings.manage` for the whole organization switches it on. While it is
  on, anyone with the hospital's link can report, always anonymously. The two
  report routes are under `/api/v1/public` and answer 404 for a hospital that
  does not exist, is suspended, has it off, or whose subscription is
  cancelled or does not include incidents. A public report is answered
  with a follow-up code and nothing else: not the incident's number, which
  would tell the sender how many incidents the hospital has had.
- **Follow-up code:** every anonymous report, made signed in or not, is
  answered once with a code such as `K7QM-2RXD-9FHT-WB3N`. The code alone
  opens the reporter's view of the report and lets them add a comment. Only
  its hash is stored; it cannot be shown again or reissued. It works for
  every active hospital, whether or not that hospital takes reports without
  sign-in. Whoever reads with a code is given no name or id of anyone working
  at the hospital, and neither the incident's id nor its number. When it is
  typed or pasted back, only the characters a code is made of are read:
  letter case, hyphens, spaces, punctuation and invisible direction marks
  make no difference. A wrong code, an unknown hospital and a suspended one
  are all answered with the same 404 on the same 50-millisecond step.
- **What a code may write:** comments, while the incident is open. An
  incident takes at most 10 comments by code in 24 hours, whatever addresses
  they come from (429 after that), and none once it is closed or was not
  taken forward (409 `incident_ended`); the code still reads it, and a
  reopened incident takes comments again. Both are counted and checked in the
  database, and both are answered only to someone holding the right code.
- **Limits on the public routes:** one address may open the public form 60
  times, send 10 reports and make 30 follow-up attempts an hour; more are
  answered 429. An IPv6 address is counted as its /56 network, which is what
  one home connection is handed. The count is kept in the memory of each API
  process: with several processes the real limit is that many times higher,
  and a restart clears it. Besides that, each hospital takes at most 60
  public reports an hour whatever addresses they come from; this is counted
  in the database, so it is the same for every process. Two reports that
  reach one hospital at the same instant do not wait for each other: the
  second is answered 429 with `Retry-After: 1` and is sent again. **The
  limit per address is only as good as the address**: see "In front of the
  web app" below.
- **When the public form is held shut:** the first time in an hour that a
  hospital's ceiling turns a report away, the hospital's audit log gets an
  entry `public_reporting_limit_reached` (no actor, nothing about any
  sender) and the server log a warning with the hospital's id, and whoever
  holds `settings.manage` or `incidents.triage` for the whole hospital gets
  an in-app notification (`public_form_paused`). Nothing is emailed yet.
- **Second sign-off:** a sentinel event, or an incident with harm level
  death, is not closed by one person. Whoever handles it asks for closure
  with the summary they propose; someone else holding `incidents.sign_off`
  signs it off, saying which revision they read, or sends it back. An
  incident that has once needed this keeps needing it, whatever its harm
  level is changed to afterwards.
- **Deadlines:** each hospital sets, per harm level, how many hours it allows
  itself to triage an incident and how many days to close it (Settings; the
  starting values are 72 hours and 30 days, 24 hours and 45 days for severe
  harm and death). Every incident gets both deadlines when it is reported.
  Whether it is overdue is worked out when it is read; lists can be filtered
  to what is overdue and ordered by deadline, and the dashboard counts it.
  Someone who sees an incident only as its reporter is not shown deadlines.
- **The hospital's own day:** each client has a time zone (an IANA name such
  as `Asia/Riyadh`, UTC unless set), set by Trustline staff in the admin
  portal. Every day the API works out is a day there: the day a report was
  made, "the last 30 days", a deadline counted in days. The session tells the
  screens which time zone it is.
- **Notifications:** stored for each person who should know (a new report for
  those who may triage it, an assignment, a handover, a comment, a closure, a
  request for sign-off and its outcome, a deadline coming up or missed), and
  only ever for someone who can open the incident. A notification carries the
  incident's reference and no name or text. Nothing is sent by email yet.
- **The deadline check:** every API process looks every five minutes for
  deadlines that have entered their last quarter or have passed, and writes
  those notifications, each once. It needs no configuration: any number of
  processes may run it at once, and it stops with the process. Deadlines that
  were already past when this release was installed are shown as overdue but
  not announced. A run that did something writes one line to the server log;
  a hospital whose check failed is named there with the kind of failure
  (never anything from a record), and is tried again at the next run. No
  statement of the check may take longer than 30 seconds, so one that hangs
  cannot stop it.

The rules are in `docs/specs/incident-reporting.md` and
`docs/specs/incident-safeguards-and-deadlines.md`.

Not built yet: sending notifications by email, working-hours calendars for
deadlines, attachments, investigations and actions.

## Modules, plans and subscriptions

The product is sold in modules: `incidents`, `investigations`, `actions`,
`policies`, `risks`, `training` and `ai_assistant`, besides core (sign-in,
users, roles, structure, notifications, audit, settings), which every client
has. Incidents and policies are built. The list is a constant in
`apps/api/src/subscriptions/modules.ts`, with what each needs
(investigations needs incidents; the AI assistant needs another module).

- **Plans** are data: Trustline staff create and edit them in the admin
  portal (`/api/v1/platform/plans`): name and description in every
  language, modules, limits (users, sites, storage, AI credits a month; none
  meaning no limit), extras, prices, order. A plan is retired, never deleted.
  The seed adds four illustrative ones (Documents, Learning, Safety,
  Complete).
- **A subscription** is one per client: its plan, status, dates, add-on
  modules, limit overrides and a note for Trustline only. Staff change it on
  the client's page (`/api/v1/platform/tenants/:id/subscription`); the
  change is audited in the platform's log and, for what the client sees
  (plan, status, modules, limits), in the client's own. Every client that
  existed before plans is on `everything` (every module, no limit), so
  nothing changed for anyone.
- **A module that is off** answers as if it did not exist: its routes are
  404 like an unknown address, its public routes 404 like an unknown
  hospital, its notifications are neither sent nor shown, its background
  checks skip the client, and `/auth/me` lists neither the module nor its
  permissions. Nothing is deleted, roles keep their permissions, and
  switching it back on restores everything. Every controller declares its
  module with `@ForModule()`; the session guard enforces it, and
  `modules-and-subscriptions.e2e-spec.ts` fails for a controller that does
  not declare one.
- **Status:** `trial` and `active` work normally; `past_due` too, with a
  notice for the client's administrators (to anyone else `/auth/me` says
  `active` for `trial` and `past_due`). `suspended` is read-only (403
  `subscription_suspended`), except: all of the incidents module (signed in
  or not), issuing a sign-in link, taking access away (disabling a user,
  taking roles or permissions away, deleting a role), signing out and
  reading one's notifications. `cancelled` is like a client Trustline has
  suspended: nobody signs in, and no session or link from before comes back
  if it is made active again. A client Trustline has suspended stays closed
  whatever its subscription says.
- **Limits** on named users (invited or active; a disabled account frees its
  place) and sites (facilities switched on) are checked in the transaction
  that adds one, so two requests cannot both take the last place: 409
  `limit_reached`. Nobody already there is affected. Storage and AI credits
  are stored, not yet enforced.
- **The client sees** its modules and subscription status in `/auth/me`,
  and its plan, modules, limits with usage, status and dates under
  `GET /api/v1/settings/subscription`. Never a price.

The rules and what was decided are in `docs/specs/modules-and-subscriptions.md`.

Not built yet: the portal's and the client's screens for this, AI metering,
and self-service or online payment.

## Policies and procedures

The `policies` module: one library of each client's controlled documents
(policies, procedures, work instructions), each with a number for life
(`PRC-SAF-014`), versions, approval with signatures, publication,
acknowledgement by the people it applies to, and periodic review. The
database and the API are built; the screens are not.

- **The cycle:** a manager drafts a version, section by section in each of
  the client's languages (Markdown limited to paragraphs, lists, bold and
  headings), sends it for review, and its approval route runs: each step
  is decided in order by an assignee (a named person or a role held over
  the document's unit), who approves with a signature or returns it with a
  comment. An approved version is published now or on a later day; the one
  before it is superseded. Nothing is deleted: a document is retired, a
  version withdrawn or superseded.
- **Signatures:** every approval, review sign-off and acknowledgement takes
  the password again in the same request, counted against the same lock as
  sign-in (`401 wrong_password` without ending the session), and keeps a
  SHA-256 hash of exactly what was signed. The application role can add
  signatures and read them, never change or delete one.
- **Who sees what:** published documents are read by all staff, or, when
  restricted, by their audience; drafts and versions in review only by
  those who manage the document or see all documents (`policies.view_all`)
  and by the assignees of its run. Lists, counts, search over the text,
  notifications and the summary all keep to this (`policies/visibility.ts`).
  Whoever prepared a version decides no step of it.
- **The daily check** (every 15 minutes, beside the incident deadline check
  and as safe with several processes) publishes what is scheduled, reminds
  owners of reviews 60, 30 and 7 days ahead and when overdue, asks people
  who joined an audience to acknowledge, and reminds those who have not.
- **The summary** gives the two measures the business named: documents
  past their review date as a share (target under 5%) and acknowledgement
  completion as a share of the people asked (target 90% or more).
- **The approval engine** (`apps/api/src/approvals/`) is generic: the
  document code calls it, and investigations will.
- `pnpm db:seed` gives each demo client five example documents in
  different states and three fictional members of staff who wrote,
  reviewed and approved them (invited, never signed in).

The rules, what was decided while building, and every route are in
`docs/specs/policies-and-procedures.md` ("Built: database and API").

Not built yet: the screens, an owner asking to retire, notifications for
an overdue approval step, and everything the spec leaves out of this
release (uploads, attachments, delegation, email, a server-made PDF).

## API

The API is served under `/api/v1`. The web app forwards `/api/*` to it, so the
browser only ever talks to one origin. The version in the path is there so
that a future mobile app on an older release keeps working.

### In front of the web app

The API learns a caller's address from the `X-Forwarded-For` header. The web
app passes that header on as it received it: it does not replace it and, as
far as its code shows (this was read, not measured), does not add one. The
limits per address on the public routes, and the address stored with each
sign-in, are true only if all three of these hold in production.

**1. A reverse proxy in front of the web app writes the header.**

- The **outermost** proxy, the one the internet connects to, sets
  `X-Forwarded-For` to the address of whoever connected to it, replacing
  anything the sender wrote there. nginx:
  `proxy_set_header X-Forwarded-For $remote_addr;`. (One that adds that
  address after the sender's entries works too.)
- **Every proxy behind it** adds the address of whoever connected to it,
  which is the proxy in front of it, after what is already there. It must
  not replace the header. nginx:
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. An inner
  proxy that replaces the header makes every caller the proxy in front of
  it, and all of them share one allowance.

**2. The web app and the API can be reached only through that proxy.** The
web app's port must accept connections from the proxy only, and the API's
port from the web app only. Whoever can reach either of them directly sends
their own `X-Forwarded-For`, chooses the address they are counted by, and
has every limit per address to themselves.

- The API listens on `127.0.0.1` unless told otherwise, so only the machine
  it runs on can connect. Where the web app runs on another machine or in
  another container, set `API_HOST` to the address the web app reaches it on
  (`0.0.0.0` for all of them) and let the network (a firewall, a private
  container network with no published port) allow the web app alone. The web
  app finds the API at `API_URL` (`http://localhost:3001` unless set).
- The web app listens on every address unless told otherwise. Where the
  proxy runs on the same machine, start it with `next start -H 127.0.0.1`;
  elsewhere, close its port to everything but the proxy.

**3. `TRUST_PROXY_HOPS` says how many proxies in front of the web app write
the header.**

| Deployment | `TRUST_PROXY_HOPS` |
|---|---|
| one proxy, web app, API | `1` (the default) |
| CDN, load balancer, web app, API (each adds its entry) | `2` |
| the API reached directly, with no web app or proxy | `0` |

The API does not start on a value that is not a whole number from 0 to 9.

Without such a proxy no setting is right. Left at 1, anyone can send their
own `X-Forwarded-For` with each request and get a fresh allowance every time,
so the limit per address on the public routes is bypassed. With no header at
all, or at 0, every caller is counted as the web app and shares one
allowance, so one person can use it up for everybody. Anything in the header
that is not an IP address is counted as one caller, and the ceiling of 60
public reports an hour per hospital holds whatever the header says. The
address stored with each sign-in in the audit log comes from the same
header, and is only as true.

**Check it on the host, before a hospital switches public reporting on.**
When it starts, the API writes one line to its log with the address it
listens on and the trust it places in the header, and a warning if other
machines can connect to it; compare both with the deployment. Then, from a
machine outside, open the public form 61 times, claiming a different address
each time. Nothing is stored by this, and the hospital need not exist:

```bash
for i in $(seq 1 61); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    -H "X-Forwarded-For: 198.51.100.$i" \
    https://<your host>/api/v1/public/reporting/no-such-hospital
done | sort | uniq -c
```

The answer must be 60 times `404` and once `429`: the addresses claimed were
ignored and the sender was counted as one. 61 times `404` means the sender's
header is believed (the outermost proxy is not replacing it, or the web app
or the API was reached past it). Then open it once more from another
network: it must be `404`. A `429` there means every caller is counted as
one (an inner proxy replaces the header, or `TRUST_PROXY_HOPS` is too low).

### What the database gives up on

Every session of the application role (`trustline_app`) has limits set in the
database itself, so they hold for any release: a statement is given up after
15 seconds, a wait for a lock after 5, and a transaction left idle after 60.
A request waits at most 10 seconds for a database connection when all are in
use. All are far above what a request needs; a request that reaches one is
answered with a 500 and logged by its error class (57014 for a statement,
55P03 for a lock). Migrations and the seed run as the owner role and are not
limited.

## Run it locally

Needs Node 22, pnpm and Docker.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The web app is at http://localhost:3000 and the API at
http://localhost:3001/api/v1/health. The API accepts connections from this
machine only (`API_HOST`, see "In front of the web app"). To use the admin
portal, create an admin as described above.

`pnpm db:seed` creates three fictional hospitals, each with a facility,
departments and units: `demo-jci` (JCI, English and Arabic), `demo-cbahi`
(CBAHI, Arabic first) and `demo-fr` (French first, with Arabic and English),
and four illustrative plans. A demo hospital without a subscription is put
on the Complete plan.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` needs the database running. It migrates and seeds it first. The
API's tests create hospitals (and plans) of their own under a prefix of the
run and remove them afterwards; they may share the database with other hospitals,
and act on none they did not make, apart from the demo hospitals of the
seed, which the database-level specs use (rows they add there are marked
`ZZ` and removed).

## Tenant isolation

Every tenant's data lives in the same tables, separated by Postgres row-level
security:

- For hospital data, the API connects as `trustline_app` (`APP_DATABASE_URL`), a role that owns
  nothing and cannot bypass row-level security. Migrations and the seed run as
  the owner role (`DATABASE_URL`).
- Every table that holds tenant data has a `tenant_id` column and a
  `tenant_isolation` policy that matches it against the transaction's tenant.
- Application code reaches tenant data only through `TenantDb.withTenant()`,
  which sets that tenant for one transaction. With no tenant set, queries
  return no rows.

`apps/api/src/database/tenant-isolation.spec.ts` checks all of this, and fails
if a new table with `tenant_id` is added without a policy.

To add a table: define it in `apps/api/src/database/schema.ts` with the
`tenantIsolation()` policy, run `pnpm --filter api db:generate`, and add its
grants for `trustline_app` in a migration.

## Languages

The interface is available in English, Arabic and French, and a client can
work in any one or several of them.

- **Interface text** lives in `apps/web/src/i18n/dictionaries/<language>.json`.
  All files have the same entries.
- **Text a client writes** (the name of a department, a user, a role) is
  stored once per language in a single column, for example
  `{"en": "Pharmacy", "fr": "Pharmacie"}`. There are no per-language columns.
- **Each client chooses its languages** and a default. Its text must be
  written in the default language and only in languages it has switched on.
  A reader sees text in their own language, or in the client's default when
  there is no translation.
- **To add a language:** add it to `SUPPORTED_LOCALES` in
  `apps/api/src/i18n/locales.ts` and to `locales` in
  `apps/web/src/i18n/config.ts`, add its dictionary file, and translate the
  built-in roles in `apps/api/src/identity/permissions.ts`. No table changes.

## Settings that vary by tenant

What a client may use (modules, limits) is its subscription, not a setting:
see "Modules, plans and subscriptions". A client has no `plan` of its own
any more (dropped in migration 0036): the portal names a plan with `planId`
when it creates a client, and changes it on the subscription.

- `accreditation_standard`: `JCI` or `CBAHI`.
- `locales`: the languages the client works in, in its own order.
- `default_locale`: one of those. Every name the client writes must exist
  in it.
- `data_region`: where the tenant's data must be hosted. Empty until launch
  regions are decided.
- `public_reporting`: whether incidents can be reported without sign-in. The
  only one of these the hospital changes itself; the rest belong to the admin
  portal, and the database lets the application role write no other column.
