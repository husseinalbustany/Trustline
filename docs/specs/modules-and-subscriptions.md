# Modules, subscription plans and AI limits

Status: steps 1 to 3 of "Order of work" are built in the database and the
API: module switches with one entitlement check, plans and per-client
subscriptions managed by Trustline staff, and the limits on users and sites.
The admin portal's and the client's screens for them are not built yet.
Steps 4 (AI metering) and 5 (self-service and payment) are not started. The
"Decisions needed" at the end are still open: everything they decide is data
(plans, their modules, limits, extras and prices) or a status set by
Trustline staff, so none of them needs code to change. What was decided while
building, where this document was silent, is in "Built: steps 1 to 3".

It says how Trustline becomes a product a client can buy in parts, on a
plan, with a limit on AI use, and what has to be decided before building the
rest.

Trustline's clients are any organization, not only hospitals.

## What was asked

1. **Modular.** One client may want only policies and procedures, another
   only training, another everything.
2. **Subscriptions with several plans.**
3. **A limit on how much AI each client may use.**

## What existed before

- Each client had a `plan` (starter, professional, enterprise), set in the
  admin portal. Nothing read it: every client got everything that was built.
  It is now replaced by the subscription (see "Built: steps 1 to 3"); the
  column stays until the portal's screens stop showing and sending it.
- No billing, no usage metering, no AI. Still true.

## The modules

A module is a part of the product that can be sold, switched on and switched
off on its own.

| Module | Contains | Needs |
|---|---|---|
| **Core** (always on) | Sign-in, users, roles, organization structure, languages, notifications, audit trail, settings | Nothing |
| **Incidents** | Reporting (signed in, public link, QR), triage, deadlines, sign-off, the incident dashboard | Core |
| **Investigations** | Root cause analysis, findings, the investigation report | Incidents |
| **Actions** | The tracker of corrective and preventive actions | Core; fed by any other module that is on |
| **Policies and procedures** | Library, versions, approval and signature, acknowledgement, the client's document design | Core |
| **Risk management** | Registers, scoring, controls, reviews | Core; links to incidents when both are on |
| **Training and awareness** | Catalog, matrix, sessions, attendance, quizzes, certificates | Core; links to policies when both are on |
| **AI assistant** (add-on) | Drafting policies and procedures (`ai-policy-drafting.md`); insights and suggestions on incidents, investigations, actions and risks (`ai-insights.md`); a chat and voice assistant (`ai-conversational-assistant.md`) | The module it assists |

Two rules make "only policies" or "only training" work:

- **A module never requires another sold module, except where the table says
  so.** Policies alone is a complete product; so is training alone.
- **Links are optional.** Where two modules are both on, they connect (a
  changed policy triggers training; an incident is linked to a risk). Where
  one is off, the other shows nothing about it: no dead buttons, no empty
  tabs.

### What "off" means

- **Menu and pages:** the module does not appear.
- **API:** its routes answer as if they did not exist. Hiding the menu is not
  the protection; the check is in the API, like permissions.
- **Permissions:** a role keeps its permissions for a module that is off, so
  switching it back on restores everything; they simply do nothing meanwhile.
- **Data:** switching a module off never deletes anything. The records stay,
  unreachable in the app, until the module is on again or the client asks for
  an export or deletion under its contract.
- **Notifications, dashboard tiles, background checks:** none for a module
  that is off.

## Plans

A plan is a named bundle: which modules, what limits, which extras. Plans are
data, defined by Trustline in the admin portal, so a new plan needs no code.

A plan sets:

| Part | Examples |
|---|---|
| Modules included | Policies only; training only; everything |
| Limits | Named users (reporters free or counted), sites, storage, public reports a month |
| AI allowance | Units a month; see below |
| Extras | Single sign-on, number of languages, dedicated hosting, API access, support level, AI suggestions on clinical incidents (needs a signed agreement; see `ai-insights.md`) |
| Term and price | Monthly or yearly; price per user, per site or flat |

A client's **subscription** is its plan plus what was agreed for that client:

- **Add-on modules** on top of the plan (a "policies" client adds training).
- **Overrides** of a limit (more users, a larger AI allowance).
- **Dates:** start, renewal, end; a trial with an end date.
- **Status:** trial, active, past due, suspended, cancelled.

So "multi-plan" means two things, and both are covered: Trustline offers
several plans, and one client's subscription can combine a plan with add-ons.

Illustrative plans, to show the shape (names, contents and prices are for the
business to set):

| Plan | Modules | AI |
|---|---|---|
| Documents | Core, policies and procedures | Add-on |
| Learning | Core, training and awareness | Add-on |
| Safety | Core, incidents, actions | Add-on |
| Complete | All modules | An allowance included |
| Enterprise | All modules, dedicated hosting, single sign-on | A larger allowance, or the client's own model |

### When a limit is reached

Each limit says what happens at the edge, chosen so that safety work is never
blocked by a billing matter:

| Limit | At the limit |
|---|---|
| Named users | No new user can be added; existing users are unaffected |
| Sites | No new site can be added |
| Storage | No new attachment; everything else works |
| AI allowance | The assistant stops; writing by hand always works |
| Incident reports | **Never limited.** Reporting an incident is not a paid quantity |

### When a subscription lapses

- **Past due:** everything works; administrators see a notice.
- **Suspended (after a grace period):** a billing matter never blocks safety
  work, nor keeps a hospital from cutting someone's access. So:
  - **Incidents stay open, all of them:** reporting, triage, status changes,
    comments, sign-off, and the settings of reporting and response rules.
  - **Getting staff in stays open:** an invitation or a reset link can still
    be issued, so that anyone can get in to report.
  - **Taking access away stays open:** disabling a user, taking roles from
    a user, taking permissions from a role, deleting a role.
  - **Document safety work stays open** (policies module): acknowledging a
    document, publishing a version already approved, and retiring a
    document.
  - **Everything else is read-only:** nothing else can be created or
    changed.
- **Cancelled:** access ends on the agreed date; the client can export its
  data first; deletion follows the contract's retention period.

A lapse never deletes data by itself and never silently closes incident
reporting.

## AI limits

### What is counted

Use is counted in **credits**, not in the provider's own units, so a plan
reads "500 credits a month" and stays stable if the provider or its prices
change. Each kind of AI action costs a stated number of credits, roughly in
proportion to what it costs Trustline: a draft of a procedure costs more than
a rewrite of one paragraph. The real cost (provider tokens) is recorded
beside each use, so the credit prices can be checked against cost.

### The allowance

- A monthly allowance per client, from the plan, reset on the subscription's
  monthly date. Unused credits do not carry over (simplest; a decision).
- Optional caps inside the client, set by its administrator: per department
  or per user per month, so one team cannot use everything.
- Optional top-ups: a block of credits bought when the allowance runs out,
  used after the monthly allowance and valid until the term ends.

### Behaviour

- **Before an action:** the assistant shows roughly what it will cost when
  the action is large.
- **At 80%:** the client's administrators are told.
- **At 100%:** the assistant stops with a clear message saying when the
  allowance resets and how to get more. Drafts already made stay. Nothing
  else in the product is affected.
- **Hard stop or overage:** per plan. A hard stop is the default; a plan may
  instead allow use beyond the allowance, billed per credit, up to a ceiling
  the client sets.
- **Fairness and abuse:** a rate limit per user (actions a minute) apart from
  the monthly allowance.

### What administrators see

- **The client:** credits used and left this month, by module, by department
  and by user; a history by month.
- **Trustline staff:** the same for every client, the real cost beside it,
  and clients close to or over their allowance.

### A client using its own model

An enterprise client that runs the model itself (for data residency) is not
charged credits for provider cost. Its use is still counted, for its own
administrators and for capacity.

## Billing

Two stages, so plans and limits do not wait for a payment provider:

1. **Managed by Trustline staff.** Plans, subscriptions, add-ons, overrides
   and dates are set in the admin portal. Invoices are issued outside the
   product. This is enough for the first clients, who buy on contract.
2. **Self-service and online payment, later.** A client changes plan, adds a
   module, buys AI credits and pays by card. This needs a payment provider
   that works in the countries Trustline sells in; that is a decision.

Either way the product records what a client is entitled to and since when,
and every change to a subscription is audited with who made it.

## Data to add (outline, not a schema)

What was built is in "Built: steps 1 to 3": `plans` and `subscriptions`,
with add-ons and overrides on the subscription and their history in the
audit logs. The rest of this outline is for steps 4 and 5.

Platform tables (Trustline's own, not tenant data):

- `plans`: name per language, modules, limits, AI allowance, extras, term,
  price, active or retired.
- `ai_action_prices`: credits per kind of AI action, with dates, so a price
  change does not rewrite history.

Tenant tables (under row-level security like everything else):

- `subscriptions`: the client's plan, status, dates, trial end.
- `subscription_items`: add-on modules and limit overrides, each with dates.
- `tenant_modules`: what is on now, derived from the subscription, with the
  date of each change (already in the data design).
- `usage_counters`: per period, the counted quantities (users, storage, AI
  credits used).
- `ai_usage`: one row per AI action: who, which module, credits, provider
  cost, when. No prompt or document text.
- `ai_allowance_caps`: the client's own caps per department or user.

## How the code changes

- **One place answers "may this client use X?"**: an entitlement service that
  reads the subscription, like `requirePermission` answers for a user. Every
  module's routes ask it; the web asks it once at sign-in to build the menu.
- **Each module declares itself**: its routes, menu items, permissions,
  dashboard tiles, notification kinds and background checks, so that
  switching it off removes all of them together.
- **Limits are checked where the quantity grows** (adding a user, starting an
  AI action), in the same transaction, so two requests cannot both take the
  last one.
- **Existing clients** are given a subscription that includes everything
  built today, so nothing changes for them on the day this is deployed.
- The existing `plan` column on clients is replaced by the subscription.

## Built: steps 1 to 3

What the API does now, and what was chosen where the sections above were
silent. Each choice is marked **Chosen**.

### Modules and the entitlement check

- The modules are a constant in the code (`apps/api/src/subscriptions/modules.ts`):
  `incidents`, `investigations`, `actions`, `policies`, `risks`, `training`,
  `ai_assistant`. Core is not on the list: every client has it.
  `incidents` and `policies` are built (policies: see
  `policies-and-procedures.md`); the others exist so that plans and
  subscriptions can name them.
- What each needs: `investigations` needs `incidents`; `ai_assistant` needs
  at least one other module. **Chosen:** "the module it assists" is read as
  "any other module", since the assistant serves several. A subscription
  whose plan and add-ons break this is refused (400
  `module_dependency_missing`, with `module` and `requiresAnyOf`); so is a
  plan, and an edit of a plan that would leave a client's add-on without
  what it needs (the same code, with the client's `tenantId`).
- One service, `EntitlementsService`, answers "may this client use module
  X?" and "what is this client's limit for Y?" from the subscription, read
  afresh on every request (never cached), so a switch takes effect at once
  in every API process.
- **Where the check sits.** Every controller declares its module with
  `@ForModule(...)` (`'core'` for what every client has). The session guard
  reads it on every signed-in route: a route of a module the client does not
  have answers exactly as a route that does not exist (404, Nest's own
  `Cannot GET /...` body), after the session (without one: 401, as before,
  since whose client it is cannot be known). A signed-in route whose
  controller declares nothing is refused (500), and a test fails for it. The
  routes without sign-in find the client through `AuthService.findTenant`,
  which must be told which module it is for: a client without it is
  answered like one that does not exist, with the same 404 on the same
  50 ms step. `modules-and-subscriptions.e2e-spec.ts` walks every route of
  every incidents controller, so a new one is checked without being named.
- **Timing.** The answer has the shape of an unknown route; a signed-in one
  also takes the time of reading the session, which an unknown route does
  not. It tells the caller nothing they are not told by `/auth/me`.
- **Notifications are core**, not incidents: every module will notify. Each
  kind of notification belongs to a module; a client without the module is
  sent none (its routes and its deadline check do not run) and is not shown,
  counted or able to mark the ones it had. They are back with the module.
- **Permissions stay on roles.** `/auth/me` lists only the permissions of
  modules the client has; the roles keep the others, and nothing about them
  changes. Each permission's module is in `identity/permissions.ts`.
  `reports.view` is core: reports draw on whatever is on.
- Switching a module off deletes nothing. Switching it back restores
  everything, including deadline notifications that fell due meanwhile,
  which are announced once.

### Plans

- Trustline's own data (`plans`): code, name and description in every
  language the product has (**Chosen:** all of them, since any client may be
  shown a plan; refused otherwise with `language_mismatch`), modules, limits
  (`users`, `sites`, `storageMb`, `aiCreditsPerMonth`; null is no limit),
  extras (`sso`, `publicReporting`, `clinicalAiSuggestions`), prices, active
  or retired, display order.
- **Chosen: prices** are stored as a list of `{ currency, amountMinor, term,
  basis }` (ISO currency, amount in the smallest unit, monthly or yearly,
  flat or per user or per site), so decisions 3 and 8 are data. Nothing
  charges them; clients and the application role cannot read them.
- **Chosen: extras are stored, not enforced.** Single sign-on and AI are not
  built; whether reporting without sign-in is a paid extra is decision 3, so
  it stays the hospital's own switch for now.
- A plan is retired, never deleted: there is no route that deletes one, and
  the platform role cannot. A retired plan keeps its clients and can be
  given to no other.
- The seed adds four illustrative plans (Documents, Learning, Safety,
  Complete), marked as such in their description. The migration adds
  `everything` (every module, no limit), the plan every existing client is
  moved to.

### Subscriptions

- One per client (`subscriptions`, tenant data under row-level security):
  plan, status, start, renewal and trial-end dates (days), add-on modules,
  limit overrides (a key present replaces the plan's value, null meaning no
  limit) and Trustline's note. Written only by the platform role; read by the
  application role, every column but the note.
- **Chosen:** add-ons and overrides are kept on the subscription itself, not
  in separate dated rows (`subscription_items`, `tenant_modules` in the
  outline below). The date and author of every change are in the audit
  logs: the platform's (every field, with old and new values) and the
  client's own (`subscription_changed`: plan, status, modules switched on and
  off, limits; never the note or dates), in the same transaction. An edit of
  a plan writes the same entry for each client it changes something for.
- That entry is all the platform role can write in a client's audit log.
  It may set only the tenant, action, entity and changes, so the id and the
  time are always the database's; the row-level policy takes only
  `subscription_changed`, with no actor and no address. It cannot read the
  log, pass an entry off as one of the client's staff, or backdate one.
- Effective entitlements are plan plus add-ons plus overrides, with the
  dependencies above enforced when saved and again when read.
- Every client that existed was given an active subscription on
  `everything`, started on the day it was created. A client created from
  the portal without naming a plan is put on the same plan, so the portal's
  current screens keep working; **chosen** as a bridge until the portal
  sends `planId`.
- **Chosen:** a trial needs an end date; no renewal or trial end may come
  before the start. Dates do nothing by themselves: no status changes when
  a trial ends or a renewal passes. Trustline staff change the status
  (stage 1 of "Billing"), so a lapse never happens silently.
- The old `tenants.plan` column and its enum are dropped (migration 0036),
  now that the portal neither shows nor sends them. `plan` is no longer a
  field of the client routes: sent, it is refused with 400 as any unknown
  field is.

### Status

- `trial`, `active`: everything the subscription includes works.
- `past_due`: everything works. `/auth/me` gives `notice: "past_due"` to
  those who hold `settings.manage` for the whole organization (the client's
  administrators), and no notice to anyone else.
- **What `/auth/me` says of the status:** the status as it is to those who
  hold `settings.manage` for the whole organization. To anyone else,
  `suspended` as it is (it changes what works), and `trial` and `past_due`
  as `active`: what is commercial is not every member of staff's to know.
- `suspended`: read-only, except what is listed here. Every other signed-in
  write is refused with 403 `subscription_suspended`. Open:
  - **Every route of the incidents module:** reporting, triage, status
    changes, comments, sign-off, `PUT /settings/reporting` and
    `PUT /settings/response-rules`. A billing matter never blocks safety
    work, and the deadline check goes on, so what it raises can be dealt
    with.
  - **`POST /users/:id/invite`:** an invitation or a reset link, so that
    staff can always get in to report. It changes nothing but the link, and
    is audited.
  - **Taking access away, and only that:**
    - `PATCH /users/:id` with exactly `{ "status": "disabled" }`;
    - `PUT /users/:id/roles` with a list among the grants the user holds
      now (same role, same place);
    - `PATCH /roles/:id` with `permissions` alone, among those the role has
      now;
    - `DELETE /roles/:id`.

    The same request with anything more (another field, a role added, a
    grant moved to another place, a permission added) is refused with 403
    `subscription_suspended`. Every other check of these routes applies as
    at any time.
  - **The safety work of the policies module:** `POST …/acknowledge`,
    `POST …/publish` (a version already approved, now or on a later day)
    and `POST /policies/documents/:id/retire`. The `moves` of documents and
    versions offer only these while suspended
    (docs/specs/policies-and-procedures.md).
  - **What is not a change to the client's records:** signing out and
    marking one's own notifications read.
  - **The routes without sign-in** (public reporting and following up a
    report with its code, comments included): an anonymous reporter cannot
    be told of a billing matter.

  Everyone is told `notice: "suspended"`. **Chosen:** a new write route
  outside the incidents module is closed by default while suspended; it is
  opened only by marking it `@OpenWhileSuspended()`, and one that takes
  more than a reduction of access refuses the rest itself.
- `cancelled`: like a client Trustline has suspended: nobody signs in, every
  session and every open invitation or reset link ends with the change, the
  public routes answer as for a client that does not exist, the deadline
  check leaves it alone, and the portal cannot create its first
  administrator (409 `subscription_cancelled`). Nothing is deleted.
  - **Made active again, nothing issued before comes back.** The time a
    subscription last went to or from cancelled is kept
    (`access_reset_at`), and a session or link issued before it is refused
    whenever it is used. So none comes back, even one whose ending was never
    written, or one written by a sign-in under way at the moment of
    cancelling. Staff sign in again, and are sent new links.
- **How it combines with the client's own status** (active or suspended by
  Trustline): the client's status is checked first. A suspended client is
  closed whatever its subscription says; an active client is as its
  subscription's status says.
  - **The client's own suspension ends access the same way.** Suspending a
    client (`PATCH /platform/tenants/:id` with `status: "suspended"`) ends
    every session and open link in the same change, and the time a client
    last went to or from suspended is kept (`tenants.access_reset_at`). A
    session or link issued before either reset, the client's or its
    subscription's, is refused whenever it is used, so reactivating a
    client brings none back. A change that leaves the status as it is
    resets nothing.

### Limits

- Checked where the quantity grows, in the same transaction, under a lock
  of the client and the limit, so two requests cannot both take the last
  place. At the limit: 409 `{ code: "limit_reached", limit, max }`.
- **Named users** are users invited or active. **Chosen:** a disabled
  account holds no place: it cannot sign in, and disabling someone who has
  left must free their place. So enabling a disabled account again takes a
  place, and is refused at the limit. Adding a user from the portal (the
  first administrator) counts the same way.
- **Sites** are facilities that are switched on. Creating a facility, or
  switching one back on, takes a place; departments and units do not.
- A limit lowered below what there is affects nobody already there: only
  what would add one more is refused.
- `storageMb` and `aiCreditsPerMonth` are stored, and shown, but not
  enforced: nothing uses them yet.

### What a client sees

- `GET /auth/me`: `tenant.modules` (the modules on) and
  `tenant.subscription` (`status`, `notice`). Nothing commercial.
- `GET /settings/subscription`, for `settings.manage` over the whole
  organization: the plan's code and name, each module on or off and whether
  it comes from the plan or an add-on, each limit with what is used of it,
  the status and the dates. No price, no note.

## Order of work

1. Module switches and the entitlement check (makes "policies only" real).
   Built in the API.
2. Plans and subscriptions in the admin portal, managed by Trustline staff.
   Built in the API; the portal's screens are not.
3. Limits and the notices at each limit. Built in the API for users and
   sites; the screens are not.
4. AI metering and allowance, built together with the AI assistant.
5. Self-service changes and online payment.

Step 1 is worth doing before more modules are built: each new module is then
built switchable from its first day.

## Decisions needed

1. **The list of modules.** Is the split above right? In particular: are
   actions sold with incidents or on their own; are investigations a module
   or part of incidents.
2. **The plans.** Names, which modules each holds, and the limits.
3. **What is charged for.** Per named user, per site, flat per module, or a
   mix; and whether people who only report or only read stay free.
4. **AI: included or add-on,** the size of the allowances, hard stop or paid
   overage, and whether unused credits carry over.
5. **Lapse rules.** How long the grace period is, and whether the read-only
   state above is acceptable to sell.
6. **Trials.** Whether there is one, how long, and with which modules.
7. **Payment.** Contract and invoice only at first (recommended), and which
   payment provider later.
8. **Currency and tax.** Which currencies, and VAT handling per country.
