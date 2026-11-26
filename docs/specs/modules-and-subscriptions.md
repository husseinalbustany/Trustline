# Modules, subscription plans and AI limits: preparation

Status: preparation only. Nothing here is built. It says how Trustline
becomes a product a client can buy in parts, on a plan, with a limit on AI
use, and what has to be decided before building.

Trustline's clients are any organization, not only hospitals.

## What was asked

1. **Modular.** One client may want only policies and procedures, another
   only training, another everything.
2. **Subscriptions with several plans.**
3. **A limit on how much AI each client may use.**

## What exists today

- Each client has a `plan` (starter, professional, enterprise), set in the
  admin portal. Nothing reads it: every client gets everything that is built.
- The data design has a `tenant_modules` table (which modules a client has
  switched on). It is not built.
- No billing, no usage metering, no AI.

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
| **AI assistant** (add-on) | Drafting policies and procedures (`ai-policy-drafting.md`); insights and suggestions on incidents, investigations, actions and risks (`ai-insights.md`) | The module it assists |

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
- **Suspended (after a grace period):** read-only. Staff can read documents
  and their own records; incident reporting stays open; nothing else can be
  created or changed.
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

## Order of work

1. Module switches and the entitlement check (makes "policies only" real).
2. Plans and subscriptions in the admin portal, managed by Trustline staff.
3. Limits and the notices at each limit.
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
