# Risk management: specification

Status: steps 1 to 5 built in the API (see the "Built" sections
at the end); the rest proposed. Read `CLAUDE.md`, `README.md`,
`docs/business-requirements.md` and `modules-and-subscriptions.md` first.
This spec also has to fit `audit-trail.md`, `reports-and-measures.md`,
`data-export.md`, `email.md` and `ai-insights.md`. If something here is
impossible or wrong, say so in your report rather than quietly doing
something else.

This is the `risks` module. Everything in it switches on and off with that
module (`modules-and-subscriptions.md`, "What 'off' means").

Trustline's clients are any organization, not only hospitals. Write every
rule and every sentence so that it reads correctly for a factory, a logistics
company or a school as well as a hospital. Say "the people we serve", "staff"
and "unit". Do not say "patient", "ward" or "hospital", except in examples.

Each choice made here where the business has not decided is marked
**Recommended**. What the business must decide is listed at the end.

## What was asked

The business document (`docs/business-requirements.md`) says:

- **Module table:** "Risk management: see and control the organization's top
  risks. Enterprise and department registers, configurable 5×5 matrix,
  controls, reviews, heat maps, incidents linked to risks."
- **Executive summary:** "Risk management with risk registers and a 5×5 risk
  matrix."
- **Roadmap:** risk management is in Phase 2 (Professional), and the
  Professional plan includes it.
- **Standards table:** ISO 31000, ISO 9001 and ISO 45001 under "Quality &
  risk"; JCI and CBAHI expect "risk management" as accreditation evidence.
- **Research:** "linking incidents to investigations and risks" is listed
  among what competitors offer and Trustline must match.
- **Success measure:** "Overdue corrective actions: under 10% of open
  actions". Risk treatment actions are corrective and preventive actions, so
  this module is where that measure first gets data.

This spec covers:

1. **A risk register**:
   - risks per unit and for the whole organization;
   - each with a category, a cause, a consequence and an owner;
   - the existing controls;
   - likelihood and impact on a configurable matrix (5×5 by default), with
     the organization's own descriptors per level and per language, and
     colour bands that use the status colours correctly;
   - inherent, current and target ratings;
   - risk appetite and tolerance per category.
2. **Treatment:**
   - actions with owners and due dates;
   - a review frequency set by rating, with every review kept;
   - escalation of high and extreme risks to a committee or the governing
     body.
3. **Links:**
   - to incidents (an incident can raise a risk, or support one);
   - to documents as controls;
   - to training later;
   - assessments (an area risk assessment, a HIRA or a JHA) that feed the
     register.
4. **Approvals:**
   - accepting a risk above tolerance needs a signed approval, through the
     approval engine;
   - closing a risk.
5. **Screens:**
   - the register with filters, the heat map and the risk page;
   - "my risks and my actions" and reviews due;
   - CSV export and print;
   - dashboard tiles and measures over time.
6. **Standards, reminders, notifications and email,** the order of build,
   and the decisions needed.

## What exists today

The module has a name and a placeholder. Nothing else is built.

- **The module key.**
  - `risks` is in `MODULES` (`apps/api/src/subscriptions/modules.ts`) with
    `built: false` and `requiresAnyOf: []`. It stands on core alone.
  - The web app has the same list (`apps/web/src/config/modules.ts`).
  - `modules-and-subscriptions.md` says: "Risk management: registers,
    scoring, controls, reviews. Core; links to incidents when both are on."
- **The menu.**
  - `apps/web/src/config/navigation.ts` has a `risks` item under
    "governance", with `phase: 2`, `module: "risks"` and no permissions.
  - Its page (`apps/web/src/app/[lang]/(app)/risks/page.tsx`) shows
    `ModulePage` with the text in `modules.risks` of the dictionaries.
  - **Investigations** carries `phase: 2` too. **Actions** does not, since it
    is in the MVP of the roadmap, but it is not built either: its page also
    shows `ModulePage`, and `actions` has `built: false`.
- **Permissions** (`apps/api/src/identity/permissions.ts`):
  - there is no `risks.*` permission;
  - `actions.manage` exists, belongs to the `actions` module, and is held by
    the Quality officer and the Department manager. No route checks it.
  - The dashboard already has an `overdueActions` tile for the `actions`
    module (`dashboardTiles` in `navigation.ts`), and
    `reports-and-measures.md` defines `actions.overdue` "once the actions
    module exists".
- **Scope** (`apps/api/src/identity/scope.ts`):
  - `buildScope()` gives, for each permission, `"all"` or the units the
    grants cover with everything beneath them;
  - `covers(auth, permission, unitId)` answers for one unit. With no unit
    (`null`) only a grant for the whole organization counts, which is exactly
    the rule wanted for risks of the whole organization;
  - `reachOf()` builds the query condition.
- **The structure:** `org_units` (`apps/api/src/database/schema.ts`) has
  facilities, departments and units. A unit is switched off, never deleted.
- **The approval engine** (`apps/api/src/approvals/approval-engine.service.ts`)
  is generic in its code:
  - routes, runs, one step at a time;
  - assignees by person or by role over the subject's unit;
  - each step decided by a different person (`firstUncoveredStep`);
  - the people who prepared the subject excluded.

  The database still ties it to documents:
  - `approval_routes_subject` allows only `document`;
  - `approval_runs_subject_type` allows only `document_version`;
  - `signatures_subject_type` allows only `document_version` and `document`;
  - `routeFor()` chooses a route by `document_type_id`;
  - `SubjectContext.unitId` is a string, so it cannot carry "the whole
    organization".
- **Signatures** (`apps/api/src/approvals/signatures.ts`):
  - `canonicalJson()` and `contentHash()` hash exactly what was signed;
  - `SignatureService.sign()` is called after
    `AuthService.confirmPassword()`, which also takes the signing PIN of
    people who sign in through single sign-on
    (`docs/specs/identity-signing-pin.md`).
- **Notifications:**
  - the kinds are the `notification_kind` enum in `schema.ts`, each mapped to
    a module in `NOTIFICATION_MODULE` (`apps/api/src/incidents/notifier.ts`);
  - a notification names one thing, `incident_id` or `document_id`, under the
    check `notifications_about_one_thing`.
- **Email** (`apps/api/src/email/kinds.ts`):
  - `IMMEDIATE`, `WEEKLY`, `SAFETY_WHILE_SUSPENDED` and the `COMPULSORY_*`
    lists say what is sent, when, and what cannot be switched off;
  - `digest.service.ts` builds the sections of the morning digest.
- **Background checks:**
  - the policies daily check (`PolicyCheck`,
    `apps/api/src/policies/policy-check.service.ts`) runs every 15 minutes.
    It sends review reminders at 60, 30 and 7 days and when overdue
    (`REVIEW_NOTICES`), and claims each reminder once in `policy_reminders`;
  - the incident deadline check (`DeadlineCheck`) runs every 5 minutes;
  - both are started by `apps/api/src/main.ts` and are safe with several API
    processes.
- **References:** `nextReference()` (`apps/api/src/incidents/reference.ts`)
  gives gap-free yearly numbers, such as `INC-2026-00042`, for any prefix of
  two to six capital letters.
- **Audit:**
  - every change is written with `ProvisioningService.audit()`
    (`apps/api/src/identity/provisioning.service.ts`) in the same
    transaction;
  - every action is registered in `AUDIT_ACTIONS`
    (`apps/api/src/audit/actions.ts`). Its `AuditModule` knows only `core`,
    `incidents` and `policies`.
- **Text a client writes:**
  - `localizedText`, `optionalLocalizedText` and `fitsLanguages` are in
    `apps/api/src/i18n/locales.ts`;
  - `pick()` is in `apps/web/src/lib/localized.ts`.
- **Colours:**
  - `apps/web/src/app/globals.css` has `accent`, `danger`, `danger-soft`,
    `warn` and `warn-soft`, and no green;
  - `apps/web/src/components/ui/pill.tsx` has the tones `ok` (accent),
    `warn`, `danger`, `alert` (solid red) and `neutral`;
  - incidents map harm levels to tones in `harmTone`
    (`apps/web/src/lib/incidents.ts`): none and mild `neutral`, moderate
    `danger`, severe and death `alert` with a warning icon;
  - `design-guidelines-and-branding.md` says that status colours mean one
    thing each, are never used alone, and cannot be changed by a client.
- **Days:** `dayOf()` and `shiftDay()` (`apps/api/src/i18n/time-zones.ts`)
  work on the client's calendar.
- **CSV:** `apps/api/src/policies/csv.ts`. `reports-and-measures.md`
  recommends moving it to `apps/api/src/common/csv.ts`.
- **External reviewers:** `READ_ONLY_PERMISSIONS` and the built-in
  `external_reviewer` role are in `permissions.ts`.

## Words used here

The terms follow ISO 31000:2018 and its vocabulary. The screens use plain
words; the ISO word is given where it differs.

- **Risk:** something that may happen and would affect what the
  organization is trying to achieve. A risk is written as a **cause** (why it
  could happen), an **event** (what could happen) and a **consequence** (what
  it would lead to).
- **Likelihood:** how likely the event is, on the matrix's scale.
- **Impact:** how bad the consequence would be, on the matrix's scale. ISO
  31000 calls this the consequence.
- **Score:** likelihood times impact (1 to 25 on a 5×5 matrix).
- **Band:** the group a cell of the matrix belongs to (Low, Medium, High,
  Extreme by default). The band is what decides review frequency, escalation
  and colour.
- **Rating:** a likelihood, an impact, and the score and band they give.
  - **Inherent rating:** the risk as it would be with no controls in place.
  - **Current rating:** the risk as it is today, with the existing controls.
    Many registers call this the residual risk.
  - **Target rating:** the risk as it is expected to be once the planned
    treatment is done. ISO 31000 calls what remains after treatment the
    residual risk; the target is the residual risk the organization aims
    for.
- **Control:** a measure that keeps a risk down: a procedure, a check, a
  piece of equipment, a barrier, training.
- **Risk owner:** the person accountable for managing the risk.
- **Risk appetite:** how much risk of a kind the organization is willing to
  pursue or keep, written as a statement.
- **Tolerance:** the highest current rating of a kind of risk the
  organization accepts without a formal decision. This is what Trustline
  checks.
- **Treatment:** what is done about a risk:
  - **reduce** it (change its likelihood or its consequences);
  - **avoid** it (stop the activity);
  - **share** it (insurance, a contract);
  - **accept** it (keep it by an informed, signed decision).
- **Action:** one task of a treatment, with an owner and a due date.
- **Review:** a dated check that the ratings, controls and treatment are
  still right.
- **Escalation:** putting a risk before a committee or the governing body,
  because of its band.
- **Committee:** a group that oversees risks above a unit: a risk committee,
  a quality committee, a health and safety committee, an executive team, a
  board.
- **Assessment:** a structured worksheet for one area or activity, such as
  an area risk assessment, a HIRA (hazard identification and risk
  assessment) or a JHA (job hazard analysis). Its findings feed the register.

## Out of scope for this release (do not build)

- **Attachments.** There is no file storage. Evidence is a written note.
- **Opportunities** (ISO 9001 6.1 speaks of "risks and opportunities").
  **Recommended:** later, as a kind of register entry scored on the same
  matrix (decision 18).
- **Quantitative risk:** money values, probabilities, simulations.
- **Key risk indicators.** These come with the KPI work (Phase 3).
- **Bow-tie diagrams.**
- **A shared library of controls.** Controls belong to one risk; a document
  can be a control for many risks.
- **FMEA** (failure mode and effects analysis) as an assessment form.
  **Recommended:** after HIRA (decision 21).
- **Links to training,** until the training module exists.
- **Links to investigations,** until that module exists.
- **AI suggestions** (see "AI, later").
- **A view across several clients,** such as a group or cluster register.

## How it works

### The register

- **One register per organization**, viewed by unit.
  - Every risk belongs to one unit (a facility, a department or a unit), or
    to the whole organization (`org_unit_id` null).
  - A unit's register is its risks and those of every unit beneath it, as a
    grant for a unit reaches what is beneath it (`scope.ts`).
  - The organization register is the risks of the whole organization, plus
    every risk escalated to a committee.
  - This gives the "enterprise and department registers" of the business
    document without two kinds of record.
- **Each risk has:**
  - a reference, `RSK-2026-00012`, from `nextReference()` with prefix `RSK`,
    numbered per client per year, never reused;
  - its unit, or the whole organization;
  - a category (see "Appetite and tolerance");
  - a title, a cause, an event and a consequence, written by the client
    (see "Languages");
  - an owner: an active member of staff, not an external reviewer;
  - its ratings (inherent, current, target);
  - its controls;
  - a treatment option and, for "reduce", its actions and a target date;
  - its next review day;
  - references to standards as free text (for example "ISO 45001 6.1.2"), as
    documents keep them. Trustline ships no standard text;
  - keywords.
- **Statuses:**
  - `proposed`: raised from an incident or an assessment, waiting for a
    manager to take it onto the register;
  - `open`: on the register;
  - `closed`: no longer on the register, kept with its history;
  - `rejected`: a proposal not taken onto the register (a duplicate, not a
    risk), with a reason.

  Nothing is ever deleted.
- **Where risks come from:**
  - written by a manager;
  - raised from an incident or a hazard report;
  - raised from a row of an assessment;
  - later, from an investigation, or from an AI suggestion that a person
    takes up.

  `source` records which. **Recommended:** staff raise concerns as hazard
  reports in the incidents module, which already has an anonymous option,
  QR codes and triage. A risk is then raised from the report by whoever
  handles it. There is one front door for staff, not two (decision 13).
- **The form warns:** "Describe the situation, not a person. Do not write
  names or details that identify a person served or a member of staff." A
  risk register is read by committees and printed.
- **Stale saves:** every change sends the `revision` it read. A mismatch is
  409 `stale_risk`, as for incidents and documents.

### The matrix

The matrix is the organization's own **risk criteria** (ISO 31000, 6.3.4).

- **Size.**
  - 5 levels of likelihood by 5 levels of impact by default.
  - **Recommended:** each axis may have 3 to 6 levels, chosen before the
    first risk is rated.
  - Once a risk has been rated on a matrix, its size cannot change. A
    client that wants another size starts a new matrix version and re-rates
    its risks (decision 3).
- **Levels.** Each level of each axis has:
  - a number (1 is the lowest);
  - a label, such as "Possible";
  - a descriptor, saying what the level means;
  - for likelihood, an optional frequency, such as "about once a year".

  Labels and descriptors are text the client writes, per language, starting
  from Trustline's wording (`apps/api/src/risks/defaults.ts`, built like
  `apps/api/src/policies/defaults.ts`).
- **Impact domains.**
  - Impact is described per **domain**, because "major" means something
    different for people's safety and for money.
  - Each domain has a name and a descriptor per level. The assessor reads
    the domains that apply and takes the highest level.
  - Starting domains:
    - safety of people (those served, staff and visitors);
    - service and operations;
    - compliance;
    - finance;
    - reputation.

    Each client edits them.
- **Starting wording,** for the `bilingual-reviewer` to settle:

  | Level | Likelihood (en / ar / fr) | Impact (en / ar / fr) |
  |---|---|---|
  | 1 | Rare / نادر / Rare | Negligible / ضئيل / Négligeable |
  | 2 | Unlikely / غير مرجّح / Peu probable | Minor / طفيف / Mineur |
  | 3 | Possible / ممكن / Possible | Moderate / معتدل / Modéré |
  | 4 | Likely / مرجّح / Probable | Major / كبير / Majeur |
  | 5 | Almost certain / شبه مؤكد / Quasi certain | Catastrophic / كارثي / Catastrophique |

  - The Arabic «جسيم» is avoided for "Major": the app already uses «حدث
    جسيم» for a sentinel event.
  - Likelihood descriptors, by frequency:
    - 1: less than once in five years;
    - 2: once in two to five years;
    - 3: about once a year;
    - 4: several times a year;
    - 5: monthly or more often.
  - Impact descriptors for the safety domain follow the incident harm
    levels, so that the two read alike:
    - 1: no harm, or first aid only;
    - 2: minor harm, recovered within days;
    - 3: harm needing professional treatment or time off, recovered within
      weeks;
    - 4: long-term harm or disability;
    - 5: death, or permanent harm to one or more people.
- **Bands.**
  - Each cell of the matrix belongs to a band.
  - The starting bands of a 5×5 matrix are:
    - **Low:** scores 1 to 3;
    - **Medium:** 4 to 6;
    - **High:** 8 to 12;
    - **Extreme:** 15 to 25.
  - A client may move single cells from one band to another (an
    asymmetric matrix), and may rename bands, but not add or remove them.
    **Recommended:** four bands, always (decision 4).
  - Starting names (en / ar / fr):
    - Low / منخفض / Faible;
    - Medium / متوسط / Moyen;
    - High / مرتفع / Élevé;
    - Extreme / بالغ الخطورة / Extrême.

    "Medium" and "Moderate" are kept apart on purpose, in each language, so
    that a band is never read as an impact level.
- **Colours of the bands.**
  - **Recommended:** the bands use the pill tones that exist
    (`pill.tsx`), in the same way incidents use them for harm
    (`harmTone`):
    - **Low:** `neutral`;
    - **Medium:** `warn`;
    - **High:** `danger`;
    - **Extreme:** `alert`, solid, with the warning icon.
  - Why:
    - a low risk is not "done", so it is not given the `ok` tone. That tone
      is the accent colour, which is for actions and links;
    - `alert` is kept for what must not be missed, as it is for severe harm;
    - there is no green in `globals.css`, although the design guidelines
      name a `good` token. The bands must not add one.
  - A band is never shown by colour alone: always its name, and its score
    where there is room ("High · 12").
  - The colours are fixed. A client renames bands but cannot recolour them
    (`design-guidelines-and-branding.md`, "What a client cannot change").
- **Per band, the client sets:**
  - the review interval;
  - the committee it is escalated to, if any;
  - whether accepting a risk in that band above its tolerance needs a
    signed approval (always yes for High and Extreme).
- **Versions.**
  - The matrix is versioned.
  - Correcting a label or a descriptor is a wording change: audited, and it
    applies at once.
  - Moving cells between bands, or changing a band's review interval or
    escalation, makes a new version.
  - The settings screen shows how many open risks would change band, and
    asks once before the version is put in use.
  - Every rating records the matrix version it was made on.
  - Since a rating keeps its likelihood and impact, a new band layout
    re-bands every risk at once, which is what an organization changing its
    criteria wants. Earlier ratings keep the band they had.

### Appetite and tolerance

- **Categories** are the client's own list.
  - Each has a code, a name per language, an order and whether it is in
    use.
  - Starting list (each client edits it):
    - safety of the people we serve;
    - staff health and safety;
    - service and operations;
    - compliance and regulation;
    - finance;
    - reputation;
    - information and data;
    - facilities, equipment and environment;
    - strategy.
- **Per category, the client sets:**
  - **Appetite:** a level, written as a statement in the client's languages.
    The level is one of averse, minimal, cautious, open and eager (starting
    wording in Arabic: «تجنّب»، «حدّ أدنى»، «حذر»، «انفتاح»، «إقبال»; in
    French: « aversion », « minimale », « prudente », « ouverte », « forte »;
    for the `bilingual-reviewer`).
  - **Tolerance:** the highest band of current rating accepted without a
    decision. **Recommended starting value:** Medium for every category
    (decision 6).
- **Where a risk stands against its tolerance** is worked out when it is
  read, never stored:
  - **within tolerance:** current band at or below the tolerance;
  - **above tolerance, being treated:** a treatment to reduce it, whose
    target is within tolerance, with at least one action open;
  - **above tolerance, accepted:** an acceptance in force (see
    "Acceptance");
  - **above tolerance, not addressed:** anything else. This is what the
    register, the dashboard and the measures make visible.
- **Before the first risk is rated,** the settings page asks the client to
  link the document that is its risk management policy or framework, if the
  policies module is on. The register then shows that document's number. A
  surveyor asks for it first.

### Ratings

- **Every rating is a new row,** never changed.
  - A rating has the kind (inherent, current, target), the likelihood, the
    impact, the score and band it gave, the matrix version, an optional
    rationale, who made it and when.
  - The risk keeps a copy of its latest rating of each kind, for lists.
  - The full history makes the trend on the risk page and the month-end
    figures, without reconstruction (see "Measures").
- **Which ratings are needed:**
  - **current:** always, before a proposed risk can be opened;
  - **target:** whenever the current rating is above tolerance;
  - **inherent:** **Recommended:** optional, with a client setting that
    makes it required, on by default (decision 5). Many organizations
    record it; some find it guesswork.
- **Checks:**
  - a target above the current rating is refused (400
    `target_above_current`);
  - a current rating above the inherent rating is accepted, with a warning
    on the screen, since new facts can show the inherent rating was too low.
- **Choosing a level:** the assessor sees each level's label and descriptor,
  and the impact domains, and picks. The score and band appear as they
  choose.
- **Raising a risk from an incident:**
  - the incident's harm level is offered as a starting impact in the
    safety domain (mild 2, moderate 3, severe 4, death 5);
  - the person confirms or changes it;
  - nothing is rated by itself.

### Controls

- **Each control has:**
  - a description per language;
  - a kind: preventive (stops it happening), detective (finds it early) or
    mitigating (limits the harm);
  - optionally, its place in the hierarchy of controls, for health and
    safety: elimination, substitution, engineering, administrative,
    protective equipment;
  - an owner;
  - an effectiveness: effective, partly effective, ineffective or not
    assessed, with the day it was last assessed;
  - optionally, a link to a controlled document (policies module) and,
    later, a training course.
- **A control linked to a document** shows on the risk page:
  - the document's number, its version in force and its review state;
  - its title, if the reader may open it.
- **The control is flagged** "the procedure behind this control is retired"
  or "is past its review date" when that happens. The flag comes back at the
  risk's next review and in its owner's digest.
- **A control is switched off,** never deleted, with a reason.

### Treatment and actions

- A risk's **treatment option** is reduce, avoid, share or accept (ISO
  31000, 6.5).
  - "Reduce", "avoid" and "share" are carried out by **actions**.
  - "Accept" above tolerance needs a signed acceptance.
- **Recommended: actions are one shared capability, built once and used by
  every module** (decision 1). The business document asks for "one tracker
  for every corrective and preventive action", and the actions placeholder
  says "actions from incidents, investigations, risks and policies in one
  place". So:
  - **One engine.** `apps/api/src/actions/` holds the `actions` table, its
    timeline and its rules. Like the approval engine, it has no routes of
    its own: each module calls it and tells it the action's source (`risk`
    now; `incident`, `investigation`, `document` and `assessment` later) and
    who may manage actions of that source.
  - **The risks module uses it from its first day.** Actions on a risk are
    created, shown and completed from the risk page and "My risks and
    actions", under `@ForModule('risks')`. A client with risks and without
    the actions module has everything it needs for its risks.
  - **The actions module adds:**
    - the tracker across every source (`/actions`);
    - actions not tied to any record;
    - `actions.manage`, which exists already;
    - the tracker's own settings.

    It gets its own spec, `docs/specs/actions.md`, written before step 4 of
    the order of build (decision 2). Incidents then attach actions through
    the same engine, and so will investigations.
  - This keeps the module rule: risks needs no other sold module.
- **Each action has:**
  - a reference, `ACT-2026-00031`;
  - its source;
  - a title and a description per language;
  - an owner and the unit responsible;
  - a due day on the client's calendar, and the first due day it was given
    (`original_due_on`);
  - a strength: stronger (changes the system or the equipment), intermediate
    (a checklist, a standard way of working) or weaker (a reminder, training
    alone). The screen says when every action of a treatment is weaker, as
    the business document's "action-strength check" asks;
  - a status:
    - `open`;
    - `in_progress`;
    - `completed` (with a note of what was done, as evidence);
    - `verified` (an effectiveness check was made, with its outcome:
      effective or not effective);
    - `cancelled` (with a reason).
- **Rules:**
  - Moving a due day needs a reason. It is written to the action's
    timeline with the old and new day, and the first due day is kept. So
    the overdue figure cannot be improved quietly by moving dates, as the
    lesson of `first_triage_due_at` in
    `incident-safeguards-and-deadlines.md` taught.
  - The effectiveness check is made by the risk's owner or a manager, not by
    the action's owner (403 `same_person`). A not-effective outcome opens a
    prompt to re-rate the risk.
  - Completing or verifying an action does not change a rating by itself.
    The owner re-rates at a review, or at once.
  - An action can be reopened (with a reason) from completed, verified or
    cancelled.

### Reviews

- **Frequency by band.** Starting intervals, which each client changes:
  - Extreme: 30 days;
  - High: 90 days;
  - Medium: 180 days;
  - Low: 365 days.
- **The next review day:**
  - is set when a risk is opened: the day plus the interval of its current
    band;
  - after a review, it is the review's day plus the interval of the band
    the review left it in;
  - when a rating outside a review puts the risk in a band with a shorter
    interval, it becomes the earlier of the day it had and today plus the
    new interval;
  - a manager may set an earlier day, never a later one (400
    `review_interval_too_long`), as documents have a longest review period.
- **A review is made by the owner or a manager.** It records:
  - the day and who made it;
  - the current rating, confirmed or changed (a new rating row either way,
    so the history shows it was looked at);
  - the target, if changed;
  - the controls' effectiveness, if changed;
  - an outcome: no change, re-rated, treatment changed, or closure proposed;
  - a comment (required);
  - the next review day;
  - whether it was made late.
- Reviews are kept for ever and never changed.
- **Recommended:** a routine review is not a signature. It is audited, and
  it names who and when, which is what a surveyor asks (decision 15).
- **A committee's review** of an escalated risk is a review too, made by one
  of its members, and records the committee's name. The risk page then
  shows "Reviewed by the risk committee on 12 March".

### Escalation

- **Committees** are the client's own list.
  - Each has a name per language and an order (higher means a higher level).
  - **Recommended:** a committee's members are the active holders of one of
    the client's roles, granted for the whole organization, and its chair
    optionally the holders of another (decision 11). Trustline already
    manages people through roles, and membership changes are already
    audited.
  - Starting committees: "Risk committee" and "Governing body", each with no
    role yet. The settings page warns until a role is set. Until then, their
    notices go to the holders of `risks.manage` for the whole organization.
- **Automatic.** **Recommended** (decision 10):
  - when a current rating puts a risk in a band that has a committee, the
    risk is escalated to it in the same transaction, unless it is already
    escalated to that committee or a higher one;
  - starting values: High to the risk committee, Extreme to the governing
    body;
  - the timeline and the audit trail say it was automatic, and the
    committee is told at once.

  No person has to remember to escalate an extreme risk.
- **By hand.** A manager may escalate any risk to any committee, with a
  reason.
- **Coming down.** De-escalation is never automatic:
  - a member of the committee, or a holder of `risks.manage` for the whole
    organization, takes a risk off the committee's list, with a reason;
  - this is allowed only once its band is below the committee's threshold
    (409 `still_above_threshold`).

  A committee should see a risk come off its list.
- **What a committee sees:**
  - the list of risks escalated to it;
  - each with its rating, its target, where it stands against tolerance,
    its overdue actions and its last review;
  - its section in the monthly committee pack (see "Measures and reports").

### Acceptance above tolerance

- **Accepting** a risk whose current rating is above its tolerance is a
  formal decision, signed through the approval engine.
- **The request,** by the owner or a manager, gives:
  - why the risk is kept (rationale);
  - any conditions ("while the second machine is on order");
  - the day the acceptance ends: at most 12 months later (decision 8).
- **The route** is chosen by band. Starting routes:
  - **High above tolerance:** one approval step by the Approving authority
    role, 7 days;
  - **Extreme above tolerance:** a review step by the Quality officer role,
    then an approval step by the Approving authority role, 7 days each;
  - each client edits them in the risk settings (decision 7).
- **The engine's rules hold as for documents:**
  - steps in order;
  - each step decided by a different person;
  - the requester and the risk's owner decide no step (403 `same_person`);
  - a route that cannot be covered by enough different people is refused
    when sent (409 `no_assignee`).
- **Each approval is a signature:**
  - the password, or the signing PIN, again in the same request;
  - meaning `risk_accepted` for an approval step and `reviewed` for a
    review step;
  - `content_hash` over the canonical JSON of what was signed:
    `{ riskId, reference, title, categoryId, orgUnitId, current: { likelihood,
    impact, score, band, matrixId }, tolerance, rationale, conditions, until }`.
- **A return** ends the run with a comment (required).
- **While the request is in approval, what was signed cannot change.** The
  rating, the category, the title, the rationale and the day are fixed by a
  database rule, as migration 0041 does for versions in review (409
  `acceptance_in_progress` for a change). The requester or a manager may
  withdraw it.
- **An acceptance in force ends** (status `lapsed`, by the daily check or in
  the transaction that causes it, audited, owner and managers told):
  - on its last day;
  - when the current score rises above the score it accepted;
  - when the risk's category changes.

  The owner is reminded 30 days before the last day.
- **Accepting a risk within tolerance** needs no approval: it is the
  treatment option "accept", recorded at a review.

### Closing and reopening

- **A risk is closed** when it no longer exists (the activity stopped, the
  equipment was removed) or when it is merged into another risk (named by
  its reference). The reason is always required.
- **Recommended:** a second person signs the closure of a risk that has
  ever been High or Extreme, escalated, or accepted above tolerance
  (decision 9).
  - The rule sticks, as an incident that once needed sign-off keeps needing
    it (`closure_sign_off_needed`).
  - The manager asks for closure, and the closure route runs through the
    engine. Starting route: one approval step by the Quality officer role,
    meaning `risk_closure_approved`.
  - Any other risk is closed by a manager alone.
- **On closure,** open actions must be completed or cancelled first (409
  `actions_open`), so that no task is left without its reason.
- **A closed risk** leaves the register for everyday readers and stays in
  its history.
- **Reopening:** a manager reopens a closed risk with a reason. It needs a
  current rating again, and a new review day is set.

### Links to other modules

Links show only where both modules are on. A link to a module that is off
is kept, and shown again when the module is back
(`modules-and-subscriptions.md`, "Links are optional").

- **Incidents:**
  - **The two kinds of link:**
    - **raised:** the incident led to the risk;
    - **supports:** the incident is evidence for an existing risk.

    Each link records who made it, when, and an optional note. Taking a link
    off needs a reason; it is kept in the timeline.
  - **Who links:** someone who sees the incident in full (`seenInFull()`,
    `apps/api/src/incidents/visibility.ts`) and may manage risks over the
    risk's unit.
  - **"Raise a risk"** on the incident page opens the risk form beside the
    incident. The unit and the category are offered from the incident.
    **The incident's description is not copied**: it may hold details of a
    person, and the risk is written in governance terms by the person
    raising it. The risk is `open` if its author may manage risks there and
    gives a current rating; otherwise it is `proposed`.
  - **On the risk page:**
    - the linked incidents the reader may open: reference, type, category,
      unit, day, harm level, status;
    - a count of those they may not open, with nothing else about them;
    - the number of linked incidents in the last 12 months, a plain signal
      for the owner at each review.
  - **On the incident page:** the linked risks the reader may open.
  - **Never shown, on either side:** who reported an incident, or whether it
    was anonymous. The rules of `incident-safeguards-and-deadlines.md`,
    section 1, hold on every risk screen.
- **Documents as controls.** See "Controls".
  - A document's page shows "Control for 3 risks" to those who may read
    those risks.
  - When a linked document is retired, the risks' owners are told
    (`risk_control_document_retired`).
- **Training (later).** A control of kind "training" will link to a course,
  and show the share of the audience trained.
- **Investigations (later).** A finding will raise a risk or support one,
  as incidents do.

### Assessments that feed the register

An assessment looks at one place or one activity in detail. The register
keeps what matters at the level of the organization.

- **Forms** are templates the client can adjust. **Recommended starting
  forms** (decision 21):
  - **Area risk assessment:** for one area (a ward, a workshop, a
    warehouse, a classroom). A list of hazards to consider, each answered
    "not present", "controlled" or "a risk" with a rating.
  - **HIRA:** for an activity or a process (ISO 45001, 6.1.2). One row per
    hazard, with:
    - the task;
    - the hazard;
    - who could be harmed;
    - the existing controls;
    - the rating;
    - the further controls needed, in the order of the hierarchy of
      controls;
    - the rating expected after them;
    - an owner.
  - **JHA:** for a job. The job's steps; for each step, its hazards and
    controls.
- **The life of an assessment:**
  - draft;
  - completed (by its assessor);
  - approved by a manager of the unit;
  - due for review (yearly by default);
  - superseded by the next one.

  It has a reference (`RAS-2026-00004`) and is kept for ever.
- **Feeding the register:**
  - each row rated in a band at or above a threshold (starting value: High)
    must be either raised to the register, as a proposed risk linked to the
    row, or linked to an existing risk. The assessment cannot be completed
    until each such row is (409 `rows_not_carried`);
  - rows below the threshold stay in the assessment, and their further
    controls become actions with the assessment as their source;
  - the register shows, on a risk, the assessments behind it, and the
    assessment shows what it raised.
- Assessments are built last of the core steps (step 10). A register is
  useful without them; assessments without a register are not.

## How it works for each role

| Who | What they do |
|---|---|
| **Any member of staff** | Reports a hazard as an incident, as today. Sees and completes the actions assigned to them, with the reference, title and current band of the risk they serve, nothing more. |
| **Action owner** | Updates progress, completes an action with a note of what was done, asks for more time with a reason. |
| **Risk owner** | Sees their risks in full. Rates them, reviews them, updates controls, proposes actions, asks for acceptance or closure. Cannot change a risk's owner, unit or category, accept it, or close it. |
| **Unit or department manager** (`risks.manage` over the unit) | Keeps the unit's register: creates risks, takes proposals onto the register or rejects them, names owners, manages controls and actions, escalates by hand, closes risks that need no second signature. Sees the unit's heat map, reviews due and overdue actions. |
| **Quality or risk manager** (`risks.manage` for the whole organization, `risks.approve`) | All of the above for every unit and for the organization's own risks. Keeps the settings: matrix, bands, categories, appetite, committees, routes. Decides acceptance and closure steps where the routes name them. Prepares the committee pack. |
| **Approving authority** (`risks.approve`) | Signs acceptances of risks above tolerance and closures where the routes name the role. Reads the risks it is asked to decide. |
| **Committee member or chair** | Sees the risks escalated to their committee. Records the committee's reviews. Takes a risk off the committee's list once its band allows. |
| **Administrator** | Holds everything. Gives the roles, including the committee roles. |
| **External reviewer** | **Recommended:** reads the register, the heat map and each risk, with no reporter's name anywhere, through `risks.view` added to `READ_ONLY_PERMISSIONS` (decision 17). |
| **Trustline staff** | Nothing in the client's risks. They put the module on a plan or a subscription. |

## Standards

Trustline helps clients comply. It does not certify them. The client
writes its own standard references on each risk, as on documents.

- **ISO 31000:2018** (the process):

  | Clause | What it asks | Where it is |
  |---|---|---|
  | 6.2 | Communication and consultation | Staff report hazards; committees are told; owners are named |
  | 6.3 | Scope, context and criteria | The matrix, bands, categories, appetite, tolerance, and the link to the risk management policy |
  | 6.4 | Assessment: identification, analysis, evaluation | Risks and assessments; ratings on the matrix; comparison with tolerance |
  | 6.5 | Treatment | Treatment options, actions, target ratings, signed acceptance |
  | 6.6 | Monitoring and review | Review intervals by band, reviews kept, reminders, overdue figures |
  | 6.7 | Recording and reporting | The register, its history, exports, committee packs, the audit trail |

- **ISO 9001:2015, 6.1** (actions to address risks and opportunities):
  - the register and its actions are the "actions", and their review is
    the evaluation of effectiveness;
  - **9.3.2** lists "the effectiveness of actions taken to address risks
    and opportunities" among the inputs to management review; the committee
    pack's risk section provides it;
  - opportunities come later (decision 18).
- **ISO 45001:2018** (occupational health and safety):
  - **6.1.2:** hazard identification and assessment of risks: HIRA and JHA;
  - **8.1.2:** the hierarchy of controls, kept on controls and actions;
  - **5.4:** consultation and participation of workers: hazard reporting
    open to all staff, anonymous if they wish.
- **Hospital accreditation (JCI-style and CBAHI-style expectations):**
  surveyors commonly ask for:
  - a risk management programme or plan approved by leadership: the linked
    policy document;
  - an organization-wide register, prioritised: the register, sorted by
    score, and the heat map;
  - action on the highest risks: treatment, actions and acceptance;
  - regular reports to leadership and the governing body: escalation,
    committee reviews and the pack;
  - links between incident reporting and risk: incident links;
  - proactive assessment of at least one high-risk process each year:
    assessments, with FMEA later;
  - specific assessments, such as the environment of care or infection
    control during building works: area assessments.

  Trustline ships no standard numbers; the client maps them (`references`).

## Screens

All wording lives in `apps/web/src/i18n/dictionaries/` under `risks.*`,
with the same keys in every file. Client text is shown with `pick()`.
Layout uses logical properties only. Lists are rows, not tables, as the
design guidelines ask.

- **Sidebar** (`navigation.ts`, group "governance"). The `risks` item loses
  `phase: 2` when step 2 ships, and gains permissions. Items:
  - Register;
  - Heat map;
  - My risks and actions;
  - Reviews due (managers);
  - Assessments (step 10);
  - Risk settings (`risks.manage`).
- **Register** (`/<lang>/risks`):
  - **Each row:**
    - reference and title;
    - unit (or "Whole organization") and category;
    - owner;
    - current band pill with score;
    - target band;
    - a trend mark, as an icon and words: "up since last review" or "down
      since last review";
    - where it stands against tolerance ("Above tolerance", "Accepted until
      30 Jun 2027");
    - review state ("Review due", "Review overdue");
    - escalation ("Risk committee").
  - **Filters:** search, unit, category, band, status, owner, "mine", above
    tolerance, not addressed, review due or overdue, escalated to a
    committee, linked to an incident.
  - **Sort:** score (default, highest first), next review, reference,
    recently changed.
  - The filters are in the address.
  - Empty, loading and error states.
- **Heat map** (`/<lang>/risks/heat-map`):
  - **The grid:**
    - likelihood rows, highest at the top;
    - impact columns, lowest at the inline start, so the grid mirrors in
      Arabic as the reports' charts do (`reports-and-measures.md`,
      decision 9, accepted);
    - each cell in its band's tone, with the number of risks in tabular
      figures;
    - the band named in the legend and in each cell's accessible name.
  - **The choices:** current, inherent or target rating. The register's
    filters apply.
  - **A cell opens the register** filtered to it.
  - **A table of the same figures** under the grid, for screen readers and
    print.
  - **On a phone,** the grid stays 5×5 with counts only, and the legend
    stacks under it.
- **Risk page** (`/<lang>/risks/[id]`):
  - **Header:** reference, title, status, band pills, the tolerance line.
  - **The risk:** cause, event, consequence, unit, category, owner,
    references.
  - **Ratings:** inherent, current and target on a small matrix, with their
    rationale, and the history as a step chart.
  - **Controls:** each with its effectiveness and linked document.
  - **Treatment and actions:** the option, the target day, and each action
    with its owner, due day, strength and status.
  - **Reviews:** newest first.
  - **Escalation and acceptance:** the committee, the approval run with its
    steps and signatures, and the day an acceptance ends.
  - **Linked incidents and assessments.**
  - **The timeline.**
  - **Actions** follow the API's `moves`: the screen keeps no copy of the
    rules.
- **Rating dialog:**
  - one card per level, with its label and descriptor;
  - the impact domains as a table;
  - the score and band shown live;
  - a rationale box.
- **My risks and actions** (`/<lang>/risks/mine`):
  - risks I own, with review due or overdue first;
  - actions I own, with due and overdue first;
  - acceptance and closure steps waiting for my signature.

  This is the "My tasks" panel of the dashboard for this module: the
  comment in `dashboardPanels` says "actions and reviews will join it".
- **Reviews due** (`/<lang>/risks/reviews`): due within 30 days and overdue,
  by unit, for managers.
- **Committee page:** the risks escalated to one committee, with "Record the
  committee's review".
- **Settings** (`/<lang>/risks/settings`):
  - the matrix: levels, descriptors per language, domains, the band of each
    cell, review intervals and escalation per band. The "put in use" step
    shows how many risks change band;
  - categories with appetite and tolerance;
  - committees and their roles;
  - acceptance and closure routes;
  - the link to the risk management policy;
  - whether the inherent rating is required.
- **Export:**
  - "Download CSV" of the register as filtered (see API);
  - "Print" of the register: A4 landscape, with the organization, the
    scope and filters, "printed on <day>", page numbers, and the heat map
    with its table;
  - "Print" of one risk.
- **Incident page:** a "Risks" panel with the linked risks, and "Raise a
  risk" and "Link to a risk" for those who may.
- **Document page:** "Control for N risks".
- **Dashboard tiles** (`dashboardTiles`, module `risks`):
  - "High and extreme risks";
  - "Risks above tolerance, not addressed";
  - "Risk reviews overdue".

  The existing `overdueActions` tile counts actions on risks too
  (decision 1).

## Data outline (not a schema)

Every table below is tenant data:

- it has `tenant_id` and the `tenantIsolation()` policy;
- it has composite foreign keys on (`tenant_id`, id), as the other tables
  do;
- it gets its grants for `trustline_app` in a migration;
- it is read and written only inside `TenantDb.withTenant()`;
- `tenant-isolation.spec.ts` covers it.

Insert-only tables get SELECT and INSERT only.

**Settings:**

- `risk_settings`: one row per client that changed something.
  - `inherent_required`;
  - `framework_document_id`;
  - `assessment_threshold_band`;
  - `acceptance_max_months` (12);
  - `revision`.
- `risk_matrices`:
  - `version`, `likelihood_levels`, `impact_levels`;
  - `status`: draft, in use, retired;
  - `put_in_use_at`, `put_in_use_by`.

  One in use at a time.
- `risk_matrix_levels`:
  - `matrix_id`, `axis` (likelihood or impact), `level`;
  - `label` (Localized), `descriptor` (Localized), `frequency` (Localized,
    likelihood only).
- `risk_impact_domains`: `matrix_id`, `name` (Localized), `position`, and
  `descriptors` (Localized per level).
- `risk_bands`:
  - `matrix_id`, `code` (low, medium, high, extreme), `name` (Localized);
  - `review_interval_days`;
  - `escalate_to_committee_id`;
  - `acceptance_needs_signature`.

  The tone is fixed by the code, from the code of the band, and is not a
  column.
- `risk_matrix_cells`: `matrix_id`, `likelihood`, `impact`, `band_code`.
- `risk_categories`:
  - `code`, `name` (Localized), `position`, `active`;
  - `appetite` (averse … eager), `appetite_statement` (Localized);
  - `tolerance_band`;
  - `revision`.
- `risk_committees`:
  - `name` (Localized), `position`;
  - `member_role_id`, `chair_role_id`;
  - `active`, `revision`.

**The register:**

- `risks`:
  - `reference`, `org_unit_id` (null: the organization), `category_id`;
  - `title` (Localized), `cause`, `event`, `consequence` (Localized);
  - `owner_id`;
  - `status`: proposed, open, closed, rejected;
  - `source`: manual, incident, assessment, investigation, ai_suggestion;
  - `treatment`, `target_on`;
  - the latest rating of each kind (likelihood, impact, score, band,
    matrix);
  - `next_review_on`, `last_reviewed_on`;
  - `escalated_to_committee_id`, `escalated_at`;
  - `acceptance_id` (the one in force);
  - `highest_band` and `closure_sign_off_needed` (both only ever raised);
  - `references` text[], `keywords` text[];
  - `closed_at`, `closed_by`, `close_reason`, `merged_into_id`;
  - `created_by`, `created_at`, `updated_at`, `revision`.
- `risk_ratings` (insert-only):
  - `risk_id`, `kind`, `likelihood`, `impact`, `score`, `band_code`,
    `matrix_id`;
  - `rationale` (Localized);
  - `rated_by`, `rated_at`, `review_id`.
- `risk_controls`:
  - `risk_id`, `description` (Localized), `kind`, `hierarchy`;
  - `owner_id`;
  - `effectiveness`, `assessed_on`;
  - `document_id`;
  - `active`, `revision`.
- `risk_reviews` (insert-only):
  - `risk_id`, `due_on`, `reviewed_on`, `reviewed_by`, `committee_id`;
  - `outcome`, `comment`;
  - `next_review_on`, `late`.
- `risk_events` (insert-only, the timeline, as `incident_events`):
  - `risk_id`, `occurred_at`, `kind`, `actor_id` (null for the system);
  - `details` jsonb, with from and to values.
- `risk_incident_links`:
  - `risk_id`, `incident_id`, `kind` (raised, supports), `note`;
  - `linked_by`, `linked_at`;
  - `removed_by`, `removed_at`, `remove_reason`.

  At most one live link per pair.
- `risk_acceptances`:
  - `risk_id`, `requested_by`, `rationale` (Localized), `conditions`
    (Localized), `until_on`;
  - `rating_id` (the rating accepted), `tolerance_band`;
  - `status`: in approval, accepted, returned, withdrawn, lapsed;
  - `approval_run_id`, `lapsed_reason`.

  A database rule fixes what is signed once the request is in approval.
- `risk_reminders` (insert-only claims, as `policy_reminders`):
  `kind`, `subject_id`, `period`.

**Assessments** (step 10):

- `risk_assessment_forms`: `kind` (area, hira, jha), `name` (Localized),
  the prompts (Localized), `active`.
- `risk_assessments`:
  - `reference`, `form_id`, `org_unit_id`, `title` (Localized);
  - `assessor_id`, `status`, `approved_by`, `approved_at`;
  - `next_review_on`, `superseded_by_id`.
- `risk_assessment_rows`:
  - `assessment_id`, `position`;
  - the row's fields (Localized);
  - the rating before and after;
  - `risk_id` (raised or linked).

**Actions** (shared, `apps/api/src/actions/`):

- `actions`:
  - `reference`, `source_type`, `source_id`;
  - `title` and `description` (Localized);
  - `owner_id`, `org_unit_id`;
  - `due_on`, `original_due_on`;
  - `strength`, `hierarchy`;
  - `status`;
  - `completed_at`, `completed_by`, `completion_note`;
  - `effectiveness`, `verified_by`, `verified_at`;
  - `cancel_reason`, `revision`.
- `action_events` (insert-only): `action_id`, `kind`, `actor_id`,
  `details` (from and to, with the reason for a new due day).

**Changes to existing tables:**

- **Approvals:**
  - `approval_routes_subject` widens to `risk_acceptance` and
    `risk_closure`;
  - a `variant` column (the band code) chooses the route, beside
    `document_type_id`, and the "one active route" index includes it;
  - `approval_runs_subject_type` widens to `risk_acceptance` and `risk`.
- **Signatures:**
  - `signatures_subject_type` widens to `risk_acceptance` and `risk`;
  - two meanings: `risk_accepted` and `risk_closure_approved`.
- **The engine:**
  - `routeFor()` takes the variant;
  - `SubjectContext.unitId` may be null (the whole organization), and
    `unitAndAbove()` then counts only grants for the whole organization;
  - `RouteSubject`, `RunSubject` and `SignedSubject` gain the new subjects;
  - `SubjectContext.permission` is `risks.approve`.
- **Notifications:**
  - `risk_id` and `action_id` columns, with composite keys;
  - `notifications_about_one_thing` widened, so that each notification
    still names one thing.
- **References:** `reference_counters` series `RSK`, `ACT` and `RAS`.

## API outline (under `/api/v1/risks`, `@ForModule('risks')`)

Follow the incident and document API's conventions:

- strict Zod bodies (400 for anything else);
- lists answer `{ items, total }`;
- a detail carries `revision`, `moves` and maps of `people`, `units` and
  `categories` named as they are now;
- 404 for anything the caller may not see, or of another client;
- 409 `stale_risk`, `stale_action` or `stale_settings` on a revision that
  does not match;
- every write is audited in its transaction.

| Route | Who | Body / query | Answers |
|---|---|---|---|
| `GET /` | a reader (see Permissions) | `q`, `unitId`, `categoryId`, `band`, `status`, `ownerId`, `mine`, `aboveTolerance`, `notAddressed`, `review=due\|overdue`, `committeeId`, `incidentId`, `sort=score\|next_review\|reference\|updated`, `page`, `pageSize` | `{ items, total }` |
| `GET /heat-map` | a reader | the list's filters, `rating=current\|inherent\|target` | `{ matrix: { id, version, likelihood: [{ level, label }], impact: [...] }, cells: [{ likelihood, impact, band, count }], total }` |
| `GET /summary` | a reader | | counts for the tiles |
| `GET /mine` | anyone signed in | | my risks, my actions, my steps |
| `GET /reviews` | a manager | `state=due\|overdue`, `unitId?` | `{ items, total }` |
| `POST /` | `risks.manage` over `orgUnitId` (null: whole organization) | `orgUnitId, categoryId, title, cause, event, consequence, ownerId, references?, keywords?, current?, inherent?, target?, fromIncidentId?, linkKind?` | 201 the risk (`open` with a current rating, `proposed` otherwise) |
| `GET /:id` | a reader of it | | the risk |
| `PATCH /:id` | a manager | metadata, `reason` (required for owner, unit or category), `revision` | the risk |
| `POST /:id/proposal/accept` | a manager | `ownerId, current, revision` | the risk |
| `POST /:id/proposal/reject` | a manager | `reason, revision` | the risk |
| `POST /:id/ratings` | owner or manager | `kind, likelihood, impact, rationale?, revision` | the risk (400 `level_out_of_range`, `target_above_current`) |
| `POST /:id/controls`, `PATCH /:id/controls/:controlId` | owner or manager | fields, `revision` | the control |
| `POST /:id/reviews` | owner, manager, committee member | `outcome, comment, current, target?, controls?, nextReviewOn?, revision` | the risk |
| `POST /:id/escalate` | a manager | `committeeId, reason, revision` | the risk |
| `POST /:id/de-escalate` | committee member, or manager for the whole organization | `reason, revision` | the risk (409 `still_above_threshold`) |
| `POST /:id/acceptance` | owner or manager | `rationale, conditions?, until, revision` | the risk with its run (409 `no_assignee`, `within_tolerance`) |
| `POST /:id/acceptance/approve` | assignee with `risks.approve` | `password, comment?, revision` | the risk (401 `wrong_password`, 403 `same_person`) |
| `POST /:id/acceptance/return` | assignee | `comment, revision` | the risk |
| `POST /:id/acceptance/withdraw` | requester or manager | `reason, revision` | the risk |
| `POST /:id/close` | a manager | `reason, mergedIntoId?, revision` | closed, or the closure run (409 `actions_open`) |
| `POST /:id/closure/approve`, `/closure/return` | assignee | as acceptance | the risk |
| `POST /:id/reopen` | a manager | `reason, current, revision` | the risk |
| `POST /:id/incident-links` | manager who sees the incident in full | `incidentId, kind, note?` | 201 the link |
| `DELETE /:id/incident-links/:linkId` | the same | `reason` | 204 |
| `GET /for-incident/:incidentId` | who sees the incident | | the linked risks the caller may read |
| `GET /:id/actions`, `POST /:id/actions` | reader / manager or owner | action fields | list / 201 |
| `PATCH /actions/:actionId` | action owner or manager | fields, `reason` (for a new due day), `revision` | the action |
| `POST /actions/:actionId/complete`, `/verify`, `/cancel`, `/reopen` | as "Treatment and actions" | `note` / `outcome` / `reason`, `revision` | the action |
| `GET /approvals` | `risks.approve` | | my pending steps |
| `GET /committees/:id/risks` | committee member, or a reader for the whole organization | | the escalated risks |
| `GET /exports/register` | a reader | the list's filters, `locale?` | CSV |
| `GET /settings`, `PATCH /settings` | a reader / `risks.manage` for the whole organization | | the settings |
| `GET/POST/PATCH /settings/matrices`, `POST /settings/matrices/:id/put-in-use` | `risks.manage` for the whole organization | levels, domains, cells, bands, `revision` | the matrix (409 `matrix_in_use` for a change of size) |
| `GET/POST/PATCH /settings/categories`, `/settings/committees`, `/settings/approval-routes` | the same | `revision` on PATCH | the record |
| `GET /people`, `GET /roles` | `risks.manage` | `q?` | names for pickers |

- `moves` on a risk are:
  - `edit`, `rate`, `add_control`, `review`;
  - `escalate`, `de_escalate`;
  - `request_acceptance`, `approve_acceptance`, `return_acceptance`,
    `withdraw_acceptance`;
  - `close`, `request_closure`, `approve_closure`, `return_closure`,
    `reopen`;
  - `accept_proposal`, `reject_proposal`;
  - `link_incident`, `add_action`.
- `moves` on an action are `edit`, `complete`, `verify`, `cancel` and
  `reopen`.
- **CSV** follows `csv.ts` (moved to `apps/api/src/common/csv.ts` as
  `reports-and-measures.md` recommends):
  - a byte-order mark, every cell quoted, CRLF lines, formula starts
    neutralised;
  - at most 50,000 rows;
  - headings and values in the caller's language, from
    `apps/api/src/risks/export-wording.ts`;
  - audited as `risks_exported`, with the filters but not the search text
    (only `search: { used, length }`), as `documents_exported` does.
  - **Columns:**
    - reference, title, unit, category, owner, status;
    - inherent, current and target ratings (likelihood, impact, score,
      band);
    - tolerance, standing against tolerance, treatment, target day;
    - open and overdue actions;
    - last review and next review;
    - committee;
    - acceptance until;
    - linked incidents (a count).
- **The actions module's own routes** (`/api/v1/actions`,
  `@ForModule('actions')`) are for `docs/specs/actions.md`. They call the
  same `ActionsService`.

## Permissions

New, all of the `risks` module in `PERMISSION_MODULE`
(`apps/api/src/identity/permissions.ts`):

- **`risks.view`** (scoped): read the risks of the units it covers. Risks of
  the whole organization need a grant for the whole organization, which is
  what `covers(auth, 'risks.view', null)` already answers.
- **`risks.manage`** (scoped): everything a manager does above, for risks
  of the units it covers. For the whole organization, it also covers the
  settings.
- **`risks.approve`:** may be named, by role, in an acceptance or closure
  route. Being assigned a step gives the right to read that risk and decide
  that step, nothing else, as `policies.approve` does.

Access that comes from a person's place, not from a permission:

- **the risk's owner** reads and works on their risks;
- **an action's owner** reads the action and the risk's reference, title
  and current band;
- **a committee's members** read the risks escalated to it;
- **an assignee of a step in progress** reads that risk.

Each ends when the place does.

**Built-in roles** (`SYSTEM_ROLES`):

| Role | Risks permissions |
|---|---|
| Administrator | all three, as it takes every permission but `policies.import` |
| Quality officer | `risks.view`, `risks.manage`, `risks.approve` |
| Department manager | `risks.view`, `risks.manage` (over their unit, as granted) |
| Approving authority | `risks.view`, `risks.approve` |
| Reporter | none |
| External reviewer | `risks.view` (decision 17) |

- Existing clients get these by migration, with one
  `built_in_roles_changed_by_system` entry per client, as 0039 did.
- **Recommended:** no built-in "Risk manager" role. A client that has one
  makes its own (decision 22).

**Who is a reader of a risk:**

- `risks.view` or `risks.manage` covering its unit;
- its owner;
- an owner of one of its actions (summary only);
- a member of the committee it is escalated to;
- an assignee of its run in progress.

**Who is a manager of it:** `risks.manage` covering its unit.

All of this is written once, in `apps/api/src/risks/visibility.ts`, and
used by every list, count, heat map, export, notification and digest, as
`apps/api/src/incidents/visibility.ts` and
`apps/api/src/policies/visibility.ts` are. Every route checks with
`requirePermission(req, ...)` and the scope rules. The menu hiding an item
is not the protection.

**The rules:**

- a risk outside the caller's reach is 404, never 403;
- a proposed or rejected risk is read only by managers and the person who
  raised it;
- a closed risk is read by readers with `risks.view` or `risks.manage`
  only;
- moving a risk to another unit needs `risks.manage` over both units;
- nobody decides a step of an acceptance they asked for, or of a risk they
  own (403 `same_person`).

## Audit

Every change is written through `ProvisioningService.audit()` in the same
transaction.

Register each action in `AUDIT_ACTIONS` (`apps/api/src/audit/actions.ts`):

- a new area `risks`, and `AuditModule` gains `risks` and `actions`;
- entity types `risk`, `risk_matrix`, `risk_category`, `risk_committee`,
  `risk_assessment` and `action`;
- wording in `apps/api/src/audit/wording/{en,ar,fr}.ts` and under
  `audit.actions` in the dictionaries;
- `actions.spec.ts` then holds them, as it holds every other action.

The actions:

- **Register:**
  - `risk_created` (with `source`, and the incident's reference when raised
    from one);
  - `risk_updated` (fields, old and new values, the reason);
  - `risk_proposal_accepted`, `risk_proposal_rejected`;
  - `risk_rated` (the kind, from and to: likelihood, impact, band);
  - `risk_control_added`, `risk_control_updated`;
  - `risk_reviewed` (outcome, late or not, next review);
  - `risk_escalated` (committee, `automatic`, band);
  - `risk_de_escalated` (reason);
  - `risk_closure_requested`, `risk_closed`, `risk_reopened`;
  - `risk_incident_linked`, `risk_incident_unlinked`.
- **Acceptance:**
  - `risk_acceptance_requested`;
  - `risk_acceptance_step_approved` (with the signature's id);
  - `risk_acceptance_returned`, `risk_acceptance_withdrawn`;
  - `risk_accepted`;
  - `risk_acceptance_lapsed` (written by the system: last day, score risen,
    category changed).
- **Settings:**
  - `risk_settings_changed`;
  - `risk_matrix_changed` (wording);
  - `risk_matrix_put_in_use` (how many risks changed band);
  - `risk_category_created`, `risk_category_updated` (tolerance and
    appetite, from and to);
  - `risk_committee_created`, `risk_committee_updated`;
  - the approval routes, as documents' routes are audited.
- **Actions:**
  - `action_created`, `action_updated`;
  - `action_due_changed` (from, to, reason);
  - `action_completed`, `action_verified` (outcome);
  - `action_cancelled`, `action_reopened`.
- **Assessments:** `risk_assessment_created`, `…_completed`, `…_approved`,
  `…_row_raised`, `…_superseded`.
- **Exports:** `risks_exported`.
- **Migrations:** `built_in_roles_changed_by_system`, and
  `risk_defaults_created_by_system` for existing clients.

Notes:

- A failed password or PIN on a signature is audited as
  `password_confirmation_failed` with its purpose, as today.
- Nothing in these entries names a reporter.
- No risk entry needs `maskActor`: a risk is never written anonymously.

## Tenant isolation

- Every table above has `tenant_id`, the `tenantIsolation()` policy and
  grants in a migration. `tenant-isolation.spec.ts` fails otherwise.
- **Composite keys** (`tenant_id`, id) on every link make the database
  refuse a pointer to another client's record, even past row-level
  security:
  - a risk to an incident, a document, a unit, a user or a role;
  - an action to its source.
- **The background checks** (risk check, action reminders, snapshots) work
  one client at a time, in short transactions under
  `TenantDb.withTenant()`.
- **No figure, suggestion or match** is ever worked out across clients.
- **An end-to-end test** makes two clients and checks that:
  - no route, heat map, export or notification of one names anything of
    the other;
  - a link to another client's incident is answered as an unknown
    incident.

## Subscription and modules

- **Off:**
  - every route of the module answers 404 like an unknown route;
  - the menu items, tiles, notification kinds, digest sections and the
    checks' work for the client are absent;
  - links from incidents and documents are hidden.

  Nothing is deleted.
- **Every controller** declares `@ForModule('risks')`;
  `modules-and-subscriptions.e2e-spec.ts` walks them.
- **`built: true`** in both `modules.ts` files once step 2 ships.
- **Suspended** (decision 16). **Recommended:** read-only, except what is
  safety work and changes nothing anyone else relies on, marked
  `@OpenWhileSuspended()`:
  - escalating a risk, and the automatic escalation of a rating that
    triggers it. To allow that, recording a current rating stays open;
  - completing an action with its note;
  - raising a risk from an incident as `proposed`, since incidents stay
    open while suspended.

  `moves` offers only these while suspended.
- **The risk check keeps running** for a suspended subscription, so
  reminders and lapses go on. Only a client Trustline suspended, or a
  cancelled one, is skipped, as for the policies check.
- **Plans** are data (decision 20). The business document puts risk
  management in Professional; of the illustrative plans, only Complete has
  it.

## Languages (en, ar, fr)

- **Interface text:** in the dictionaries, under `risks.*` and
  `audit.actions`, with identical keys.
- **Text the API makes:** CSV headings and values in
  `apps/api/src/risks/export-wording.ts`; email wording in
  `apps/api/src/email/wording/<lang>.ts`; each checked by a test that the
  files have the same keys.
- **Text the client writes is stored per language in one column**
  (`{ en, ar, fr }`), never in `_en` or `_ar` columns. This covers level
  labels and descriptors, domains, band names, categories, appetite
  statements, committee names, and each risk's title, cause, event and
  consequence, control descriptions, rationales and action titles.
  - Names are validated with `localizedText`, descriptions with
    `optionalLocalizedText`, and both with `fitsLanguages`.
  - **Recommended** (decision 14):
    - a risk's title is required in the client's default language, since it
      is read in committee packs and prints;
    - the cause, event, consequence, rationales and notes may be written in
      any one of the client's languages, and are shown with `pick()`
      (`pickText()` in files), with a plain note when a reader's language is
      missing.
- **Starting wording** in all three languages is in `risks/defaults.ts`
  (matrix, domains, bands, categories, committees), created for every new
  client by an `ensureRiskDefaults()` beside `ensurePolicyDefaults()`
  (`provisioning.service.ts`), and for existing clients by migration.
- **Terms, for the `bilingual-reviewer` to settle:**

  | English | Arabic | French |
  |---|---|---|
  | Risk register | سجل المخاطر | Registre des risques |
  | Likelihood | الاحتمالية | Vraisemblance |
  | Impact | الأثر | Impact |
  | Inherent rating | التقييم الكامن | Niveau de risque brut |
  | Current rating | التقييم الحالي | Niveau de risque actuel |
  | Target rating | التقييم المستهدف | Niveau de risque cible |
  | Control | ضابط رقابي | Moyen de maîtrise |
  | Risk owner | مالك الخطر | Propriétaire du risque |
  | Risk appetite | الرغبة في المخاطرة | Appétence au risque |
  | Tolerance | حدّ تحمّل المخاطر | Tolérance au risque |
  | Treatment | معالجة الخطر | Traitement du risque |
  | Heat map | خريطة المخاطر | Cartographie des risques |
  | Escalate | تصعيد | Faire remonter |
  | Review (of a risk) | مراجعة | Revue |

  - French « revue » is used here so that it is not confused with the
    « révision périodique » of documents.
- **Dates, numbers and order:**
  - days on the client's calendar, written as the web app writes them;
  - Latin digits and tabular figures;
  - the heat map mirrors in Arabic.
- **Neutral for any organization:** "the people we serve", "staff",
  "unit", "committee", never "patient" or "hospital".

## Notifications and email

New notification kinds, all of module `risks` in `NOTIFICATION_MODULE`,
except those of actions (see the note under the table). Each names its risk
(`risk_id`) or action (`action_id`).

What a notification carries:

- `data` holds the reference and `serious` (band High or Extreme, as it
  stands);
- for some kinds, a `stage`, a `change` or an `outcome`;
- never a title, a description or a name.

Nobody is notified of their own action, nor of a risk they cannot read.

| Kind | When | To | Email |
|---|---|---|---|
| `risk_proposed` | a risk is raised from an incident or an assessment | managers of its unit | digest |
| `risk_owner_assigned` | someone is made a risk's owner | that person | digest |
| `risk_escalated` | escalated, by hand or automatically | the committee's members (or the whole-organization managers, see "Escalation") and the owner | **at once when Extreme**; otherwise digest |
| `risk_de_escalated` | taken off a committee's list | the owner and the committee's members | in-app only |
| `risk_above_tolerance` | a current rating goes above tolerance with nothing addressing it | the owner and managers of the unit | digest |
| `risk_review_due` | 14 days before the next review (or a quarter of the interval, if shorter) | the owner | digest |
| `risk_review_overdue` | the day after | the owner and managers of the unit | digest, and the weekly managers' email |
| `risk_step_assigned` | an acceptance or closure step becomes someone's | its assignees | **at once**, and not to be switched off (an approval step, business decision 4) |
| `risk_step_overdue` | a step passes its due time | the managers for the whole organization, once | weekly managers' email |
| `risk_acceptance_decided` | accepted or returned | the requester and the owner | in-app only |
| `risk_acceptance_ending` | 30 days before its last day | the owner | digest |
| `risk_acceptance_lapsed` | it lapsed | the owner and managers of the unit | digest |
| `risk_closed` | closed | the owner, and the committee if it was escalated | in-app only |
| `risk_incident_linked` | an incident is linked | the owner | in-app only |
| `risk_control_document_retired` | a linked document is retired | the owner | digest |
| `action_assigned` | someone is made an action's owner | that person | digest |
| `action_due_soon` | 7 days before the due day | the action's owner | digest |
| `action_overdue` | the day after the due day | the owner and the risk's owner | digest |
| `action_escalated` | 14 days overdue | managers of the action's unit | weekly managers' email |
| `action_completed` | completed | the risk's owner, who checks it worked | digest |

Action kinds belong to the `risks` module while their source is a risk;
**recommended:** their module is that of their source.

**Email** (`apps/api/src/email/kinds.ts` and `digest.service.ts`):

- **At once:**
  - `risk_step_assigned`, added to `IMMEDIATE` as `always` and to
    `COMPULSORY_FOR_ASSIGNEES`;
  - `risk_escalated` when the band is Extreme, as a new rule beside
    `serious` (`extreme`).

  **Recommended:** the escalation email can be switched off by the person
  (decision 16). The governing body's members are not people who decide
  steps.
- **Morning digest, new sections:**
  - risks to review (owned, due within 14 days or past);
  - actions due (owned, due within 7 days or past, with how many are
    overdue);
  - risk steps to decide;
  - risks proposed for the register (for managers).

  Each section has a count and up to 10 references, linked, the same lists
  the screens show.
- **Weekly email to managers** (from the first run of each ISO week on the
  client's calendar, as `acknowledgements_overdue_digest`): a new kind,
  `risks_overdue_digest`, with the counts of overdue reviews, overdue
  actions and overdue steps in their reach. It links to "Reviews due".
- **What emails say:** references and counts only, never a title or a name,
  in the person's language, as `email.md` section 2 requires.
- **While suspended:** `risk_escalated` is added to
  `SAFETY_WHILE_SUSPENDED`. Steps and reviews wait, as for documents.

## The risk check

A new background check, `RiskCheck` (`apps/api/src/risks/risk-check.service.ts`),
started by `main.ts` beside the others, and built as `PolicyCheck` is:

- it runs every 15 minutes, since a day starts at a different moment for
  each client;
- it is safe with any number of API processes: each thing is claimed by a
  row lock and recorded in `risk_reminders` in the transaction that writes
  its notifications;
- batches of 100, at most `ROWS_PER_STATEMENT` rows a statement, no
  statement over 30 seconds;
- a client that fails is named in the log with the kind of failure only;
- `run(now, only)` lets tests name their own clients;
- it skips clients without the module, suspended by Trustline or
  cancelled; what came due meanwhile is done once when they are back.

It does:

- review reminders: due, overdue;
- acceptances: 30 days before the end, lapsing on the last day;
- actions: due soon, overdue, escalated, and the effectiveness check due
  (30 days after completion by default);
- steps overdue;
- the weekly managers' email;
- for assessments, review reminders.

**Recommended:** the reminders of actions are the actions engine's
(`ActionCheck` in `apps/api/src/actions/`), so that incidents' actions
later get them with no new check.

Escalation is not the check's: it happens in the transaction of the rating
that causes it.

## Measures and reports

Definitions go in `apps/api/src/reports/measures.ts`, as
`reports-and-measures.md` recommends, so that the dashboard, the Reports
page, the snapshots and the committee pack mean the same numbers.

- **`actions.overdue`** (the business's measure: under 10% of open actions):
  - open actions past their due day at the end of the month, as a share of
    open actions;
  - **Recommended:** counted over every action in the shared table, and
    shown when the client has the actions module or the risks module
    (decision 1);
  - beside it: how many due days were moved in the month.
- **New measures** (targets for the business to confirm, decision 23):
  - `risks.past_review`: open risks past their next review at the end of
    the month, as a share of open risks. Recommended target: under 5%, as
    for documents;
  - `risks.not_addressed`: open risks above tolerance with nothing
    addressing them at the end of the month. Recommended target: 0.
- **Supporting figures** (no target):
  - open risks by band and by category;
  - risks opened, closed and escalated in the month;
  - ratings that went up and down;
  - acceptances in force and lapsed;
  - actions on risks completed by their due day;
  - the heat map at the end of the month, as counts per cell.
- **Unit basis:** the risk's unit. Risks of the whole organization count in
  the organization's row only.
- **Snapshots:**
  - since ratings, reviews, events and action events are insert-only, the
    state at any month end is worked out exactly from the records, and the
    backfill needs no guessing;
  - the start month is the module's `module_starts` day.
- **Reports page:**
  - a "Risks" section: bands over months, the heat map as at a month end,
    and the two measures with their targets;
  - CSV as for every view.
- **Committee pack:** a "Risks" section, which the reports spec reserves for
  actions "when built":
  - **the high and extreme risks:** reference, title, unit, category,
    current and target bands, direction since last month, standing against
    tolerance, and review state;
  - newly escalated and de-escalated;
  - acceptances made and lapsed;
  - overdue actions on them.

  **Recommended:** risk titles are included, since a committee cannot
  oversee a risk it cannot name, and the form warns against names. Causes,
  consequences and notes are not included (decision 19).
- **Who sees the figures:** within the reach of `reports.view` and of
  `risks.view` or `risks.manage`, as `reports-and-measures.md`, "Who sees
  what", sets for the other modules.

## Data export

The full export (`data-export.md`) must cover every new table.

- **The coverage registry** (`apps/api/src/exports/coverage.ts`, to be
  built) lists each as `export`.
- **The archive gains:**
  - `risks/`:
    - `risks.jsonl` and `.csv` (the register);
    - ratings, controls, reviews and events;
    - incident links;
    - acceptances;
    - committees, the matrix with its versions, categories, settings and
      reminders;
    - assessments with their rows;
  - `actions/`: `actions.jsonl` and `.csv`, and their events.
- **Signatures of acceptances and closures** are in `signatures.jsonl`. The
  README says how to recompute their hash from the fields listed under
  "Acceptance above tolerance".
- **Until the registry exists,** each step of this spec adds its tables to
  the list in `data-export.md`.

## AI, later

Nothing here is built now. The data is shaped so that `ai-insights.md` can
use it:

- **Suggest a risk** from a cluster of incidents, or from a risk whose
  linked incidents are rising ("Links to propose" in `ai-insights.md`):
  - it appears as a suggestion with its records;
  - a person who uses it gets a proposed risk with `source: ai_suggestion`,
    marked as an AI draft until they take it over;
  - it is never opened, rated or escalated by the assistant.
- **Offer facts for a rating:** the number of similar incidents and their
  harm, for the person rating. It never sets a score: the principle is
  "the assistant suggests; a named person decides".
- **Other suggestions:**
  - controls from the procedures that apply;
  - a warning when only weaker actions are chosen;
  - a warning when a control's procedure is past review;
  - a draft of the committee pack's commentary.
- **Rules that carry over:**
  - suggestions are built from what the person may read;
  - who reported an incident is never an input;
  - incidents that need a medical decision are left out unless the client
    has signed for them (`ai-insights.md`, decision 5).
- **The conversational assistant** may set a risk score only with a tap on
  the summary ("Consequential"). Acceptance and closure are signatures and
  never go through it (`ai-conversational-assistant.md`).

## Order of build

Each step can be built, reviewed and tested on its own. All four checks
(`pnpm lint`, `typecheck`, `test`, `build`) pass at every step.

1. **Settings and permissions.**
   - `risks.view`, `risks.manage` and `risks.approve`, the built-in roles,
     and the migration for existing clients;
   - the tables of the matrix, bands, cells, domains, categories and
     committees, with `ensureRiskDefaults()` in three languages;
   - the settings API and screen.

   Tests: tenant isolation; module off is 404; defaults for a new client;
   only a manager for the whole organization changes settings.
   Reviews: `security-reviewer`, `bilingual-reviewer` (starting wording).
2. **The register.**
   - Risks, ratings, controls and the timeline; `risks/visibility.ts`;
   - list, detail, create, edit, rate, `moves`;
   - the audit registry entries and wording;
   - the register and risk pages and the rating dialog; `built: true`;
     the menu without `phase: 2`.

   Tests: scope by unit; risks of the whole organization need a grant for
   it; 404 out of reach; stale revisions; target above current refused.
   Reviews: `security-reviewer`, `bilingual-reviewer`.
3. **Reviews and the risk check.**
   - Intervals by band, reviews, next review days;
   - `RiskCheck` with its reminders;
   - "Reviews due" and "My risks";
   - the digest sections and the weekly managers' email.

   Tests: once with several processes; the client's calendar; skipping
   and catching up.
4. **The shared actions engine.** Write `docs/specs/actions.md` first.
   - `apps/api/src/actions/`, actions on risks, their reminders;
   - "My actions", the `overdueActions` tile, `actions.overdue`.

   Tests: a moved due day keeps the first one; the effectiveness check by
   another person; module rules with risks on and actions off.
5. **Escalation and committees.**
   - Automatic and manual escalation, de-escalation;
   - committee pages;
   - the immediate email for an extreme risk.

   Tests: in the rating's transaction; no repeat at the same or a higher
   level; de-escalation refused above the threshold.
6. **Approvals.**
   - Widen the engine and its database checks to the new subjects, with a
     variant and the whole organization as a unit;
   - acceptance with signatures, its fixed content and lapsing;
   - closure with a second signature where needed; reopening.

   Tests: same person; one person one step; password and PIN; the hash
   recomputed; documents' approvals unchanged.
   Review: `security-reviewer`.
7. **Links.**
   - Incident links, "Raise a risk", the panels on both pages;
   - documents as controls and their flags.

   Tests: no reporter or anonymity leaks through a link, a count or a
   notification; a link to another client refused; modules off hide links.
   Reviews: `security-reviewer`, `bilingual-reviewer`.
8. **Heat map, export and print.**
   - The heat map API and screen with its table;
   - CSV of the register;
   - print of the register and of a risk.

   Tests: counts match the list under the same filters; CSV rules;
   right-to-left.
   Review: `bilingual-reviewer`.
9. **Measures.**
   - The definitions, snapshots and backfill;
   - the Reports page section;
   - the committee pack section;
   - the dashboard tiles.

   Reviews: as `reports-and-measures.md` sets.
10. **Assessments.**
    - The three forms, their life, rows raised or linked to the register,
      and actions from rows.

    Reviews: `security-reviewer`, `bilingual-reviewer`.
11. **Later:**
    - training controls;
    - links to investigations;
    - opportunities;
    - FMEA;
    - a shared library of controls;
    - AI suggestions.

At the end, `quality-reviewer` checks the module against
`docs/business-requirements.md`, this spec, and the questions an
accreditation surveyor and an ISO auditor ask: show me your register, your
criteria, your top risks and what you did about them, who accepted this risk
and when, and when the board last saw it.

## Decisions needed

1. **Actions as one shared capability.** The risks module uses the shared
   actions engine from its first day, and the actions module adds the
   tracker across every source (recommended). The alternative is actions
   that belong to risks only. Also: does `actions.overdue` count actions on
   risks for a client without the actions module (recommended: yes)?
2. **The actions spec.** Write `docs/specs/actions.md` before step 4
   (recommended), including incidents' actions and effectiveness checks.
3. **Matrix size.** Configurable, 3 to 6 levels per axis, 5×5 by default
   and fixed once used (recommended). The alternative is 5×5 for everyone.
4. **Bands.** Four (Low, Medium, High, Extreme) with the starting
   thresholds and the colours above (recommended), always four.
5. **The inherent rating.** Optional per client, required by default
   (recommended).
6. **Starting tolerance and appetite.** Medium for every category
   (recommended), and the five-level appetite scale.
7. **Who accepts above tolerance.** The starting routes: High by the
   Approving authority; Extreme by the Quality officer, then the Approving
   authority (recommended). Or a committee chair for Extreme.
8. **The longest acceptance:** 12 months (recommended).
9. **Closure sign-off** for any risk that has ever been High or Extreme,
   escalated or accepted (recommended).
10. **Automatic escalation** of High and Extreme risks (recommended), rather
    than a manager's choice.
11. **Committees by role** (recommended) or by named members.
12. **Risks of the whole organization** are read only with a grant for the
    whole organization (recommended). Should some risks (security, legal,
    finance) be restricted to fewer people, as documents can be?
13. **Staff proposing risks.** Through hazard reports in the incidents
    module (recommended), or a "propose a risk" form for everyone.
14. **Languages of risk text.** Title in the default language, the rest in
    any of the client's languages (recommended).
15. **Routine reviews as signatures:** no (recommended). Only acceptance and
    closure are signed.
16. **Email and suspension.**
    - An extreme escalation emailed at once and switchable by the person
      (recommended), or compulsory;
    - risk steps compulsory, as approval steps (recommended);
    - what stays open while suspended: escalation, ratings, completing
      actions, raising from incidents (recommended).
17. **External reviewers read the risk register** (recommended), through
    `risks.view` in `READ_ONLY_PERMISSIONS`.
18. **Opportunities** (ISO 9001 6.1): later, scored on the same matrix
    (recommended), or in this release.
19. **Risk titles in committee packs:** included (recommended), with causes
    and notes left out.
20. **Plans.** Which plans include the risks module. The business document
    puts it in Professional.
21. **Assessment forms.** Area assessment and HIRA first, then JHA
    (recommended). FMEA after, for the yearly proactive assessment that
    hospital surveyors look for.
22. **A built-in "Risk manager" role:** no (recommended). The Quality
    officer holds the module, and a client adds its own role.
23. **Targets for the new measures:** risks past review under 5%, and no
    risk above tolerance left unaddressed (recommended).

## Decided by the business (28 November 2026)

The business asked for work to continue without stopping for questions:
every recommendation above is taken as decided. Decision 20 follows the
business document: the risks module is in the Professional plan and above.
Any of these can be revisited before the pilot.

## Built: steps 1 and 2, API

The API side of "Order of build" steps 1 (settings and permissions) and 2
(the register). The screens, the menu without `phase: 2` and `built: true`
in `apps/web/src/config/modules.ts` come next, from the web contract.
`built: true` is set in `apps/api/src/subscriptions/modules.ts`.

### What there is

- **Permissions:** `risks.view`, `risks.manage` and `risks.approve`, of the
  `risks` module, labelled in the three dictionaries. The built-in roles hold
  them as the table under "Permissions" says; the Quality officer's and the
  Department manager's descriptions now name risks. Clients that existed
  before get them from migration 0075, with one
  `built_in_roles_changed_by_system` entry each. `risks.approve` does
  nothing yet: the acceptance and closure routes are step 6.
- **Tables** (`schema.ts`, migration 0074): `risk_committees`,
  `risk_matrices`, `risk_matrix_levels`, `risk_impact_domains`,
  `risk_bands`, `risk_matrix_cells`, `risk_categories`, `risk_settings`,
  `risks`, `risk_ratings`, `risk_controls`, `risk_events`. Each has
  `tenant_id`, `tenant_isolation`, composite keys with the tenant, and its
  grants in 0075; `risk_ratings` and `risk_events` are insert-only.
- **Rules the database keeps** (0075, functions with
  `search_path = pg_catalog, public, pg_temp`, none `SECURITY DEFINER`):
  - a matrix keeps its size and version, and its status goes draft → in
    use or retired, in use → retired;
  - once a matrix leaves draft, its cells, its levels and its bands'
    intervals, escalation and signature setting do not change, and it takes
    no new cell, level or band; wording (labels, descriptors, band names,
    domains) still does;
  - a rating is made on the matrix in use only, and points at its cell with
    the band the cell gives (a five-column key), as does each rating copy
    on `risks`;
  - a risk keeps its reference, source and author; `highest_band` only
    rises, and `closure_sign_off_needed` becomes true for good once the risk
    has been High or Extreme, or escalated.
- **Defaults:** `apps/api/src/risks/defaults.ts`, in English, Arabic and
  French: the 5×5 matrix with the levels, frequencies and descriptors of
  "The matrix", five impact domains with a descriptor per level, the four
  bands (365, 180, 90 and 30 days; High to the risk committee, Extreme to
  the governing body), the cells by score, nine categories and two
  committees. `ProvisioningService.ensureRiskDefaults()` gives them to a new
  client (beside `ensurePolicyDefaults()`, and in the seed); migration 0075
  gives them to the clients that existed, with one
  `risk_defaults_created_by_system` entry each.
- **The settings API** (`RiskSettingsController`): the settings, the
  matrix versions (draft by copy or whole, change, discard, put in use),
  categories, committees, and pickers for roles and people.
- **The register API** (`RisksController`): list with the filters and
  sorts of the API outline that exist so far, detail with `moves`, create,
  edit, rate, controls, and taking proposals onto the register or not.
- **`apps/api/src/risks/visibility.ts`**: readers and managers, as the
  section "Permissions" says, used by every list and lookup.
- **Audit:** new area `risks`, entity types `risk`, `risk_matrix`,
  `risk_category`, `risk_committee`; 17 actions worded in
  `apps/api/src/audit/wording/{en,ar,fr}.ts`.
- **Tests:** `apps/api/test/risks.e2e-spec.ts` (the routes, for each:
  401, 403, 404 for another client's record, 400, and the working case;
  tenant isolation, module off, the starting settings, settings by a
  manager for the whole organization only, scope by unit, the
  organization's own risks, stale revisions, the rating rules, the database
  rules, a new matrix version, suspension) and
  `apps/api/test/risks-migration.e2e-spec.ts` (migration 0075 on clients
  of its own, twice: the same as a new client, audited once each). The
  tests that pinned the built-in roles' permission lists
  (`incidents.e2e-spec.ts`, `policies-import.e2e-spec.ts`,
  `policies-migration.e2e-spec.ts`) now list the risks permissions too.

### Decided while building

Where the spec left something open, this was chosen:

1. **A matrix's size is fixed per version.** A different size is a new
   draft, written whole (every level and cell) or copied and then changed.
   A version in use takes wording only; anything that decides a band
   (cells, review intervals, escalation, the signature setting, the size)
   is 409 `matrix_in_use`, to be made in a new version. A draft's size is
   fixed too (409 `matrix_size_fixed`). One draft at a time
   (`draft_exists`); a draft not wanted is discarded (retired), and its
   version number is not reused.
2. **Bands rise with likelihood and impact.** A matrix where a cell's band
   is lower than that of a cell with lower or equal likelihood and impact is
   refused (400 `bands_out_of_order`): a client may move single cells, but
   not so that a worse rating gives a lower band.
3. **Putting a version in use** moves the open and proposed risks onto it
   (closed and rejected ones keep theirs). A rating copy whose levels the
   new version does not hold keeps its band on the old version, and the risk
   says `rerateNeeded`. Each risk's next review comes no later than today
   plus the interval of its band in the new version. The preview counts
   both cases.
4. **Starting appetite:** `cautious` for every category, with no
   statement, beside the tolerance of Medium (decision 6). Medium's
   acceptance above tolerance needs a signature; Low's setting is moot, as
   Low is never above a tolerance, and is off.
5. **"A target above the current rating"** is one with a higher score or a
   higher band, either.
6. **A target is required when a risk is opened** above tolerance (created
   with a current rating, or a proposal taken onto the register), not at a
   later re-rating: a risk that rises above tolerance then shows "above
   tolerance, not addressed", which is what the register and measures make
   visible.
7. **Cause, event and consequence are required**, in any one of the
   client's languages (decision 14); the title in the default language.
8. **The settings are read by anyone signed in with the module**, since an
   owner may hold no permission of it and still rates on the matrix. They
   hold the organization's criteria, nothing about a record.
9. **Proposals are taken onto the register or not in step 2**, as creating
   a risk without a current rating proposes it.
10. **Committees** have a `code`, like categories, so that the starting ones
    are found again. Members are the holders of the member role or the chair
    role, granted for the whole organization. A committee that a band of the
    version in use or of the draft escalates to is not switched off (409
    `committee_in_use`).
11. **The next review day** is set when a risk is opened and brought forward
    by a current rating into a band with a shorter interval (part of step 3,
    pulled forward so the data is right from the start). Reviews and the
    manager's earlier day are step 3.
12. **The trend** is against the current rating before the latest one,
    until reviews give "since the last review".
13. **Where a risk stands against tolerance** is `within` or
    `above_not_addressed` for now; "being treated" comes with actions (step
    4) and "accepted" with approvals (step 6). `notAddressed` filters the
    same as `aboveTolerance` until then.
14. **Controls** have a required owner, their own revision (409
    `stale_control`), and raise the risk's revision. A document linked as a
    control is a document in force, while the policies module is on; the
    risk page gets its number, version in force, review state and
    `pastReview`, and its title only for a reader who may open it, through
    `policies/linked-documents.ts` (the risks area never reads the
    policies tables). The flags' notifications are step 7.
15. **Two audit actions** beyond the spec's list: `risk_matrix_created` and
    `risk_matrix_discarded`, for drafts.
16. **Notifications** came with steps 3 to 5 (see below).

### Not done, for the merge

- **External reviewers (decision 17):** done on the merge; see "Merged onto
  the main branch".
- **`audit.actions` in the web dictionaries.** This branch's base has none;
  the keys are in the web contract, to add beside the others.
- Migrations: regenerated on top of the main branch as 0074 (generated
  from `schema.ts`, every table of steps 1 to 7) and 0075 (custom SQL only:
  grants, the rules above, the built-in roles and the defaults and routes
  for existing clients, with their audit entries, which quote its file
  name).

### Before deploying: Department manager grants

Migration 0075 gives every built-in Department manager `risks.manage`
(security review 15). A grant of `risks.manage` for the whole organization
also covers the module's settings: the matrix, tolerances, committees and
putting a matrix version in use. A client that has granted the Department
manager role **for the whole organization** (rather than for a department)
would find those people can then change its risk criteria. Before
deploying, list such grants for each existing client:

```sql
select t.slug, u.email
from role_assignments ra
join roles r on r.id = ra.role_id and r.is_system and r.code = 'department_manager'
join users u on u.id = ra.user_id and u.status <> 'disabled'
join tenants t on t.id = ra.tenant_id
where ra.org_unit_id is null
order by t.slug, u.email;
```

and agree with each client whether those people keep the role for the whole
organization or are given it for their departments.

## Built: steps 3 to 5, API, and security review 15

### Steps 3 to 5

- **Reviews** (`POST /risks/:id/reviews`): by the owner, a manager, or a
  member of the committee the risk is escalated to (a committee's review,
  with `committeeId`). Each records a current rating (a new row naming the
  review), the target, treatment and controls' effectiveness if changed, an
  outcome, a comment, the next review (today plus the band's interval, or
  earlier: 400 `review_interval_too_long` for later) and whether it was
  late. Kept for ever (`risk_reviews`, insert-only but for the comment's
  correction).
- **The risk check** (`apps/api/src/risks/risk-check.service.ts`, started by
  `main.ts`): review reminders 14 days ahead (or a quarter of the interval)
  and the day after, and the weekly email to managers
  (`risks_overdue_digest`), each claimed once in `risk_reminders`, on each
  client's calendar, safe with several processes, skipping a client
  without the module and catching up when it is back.
- **"My risks and actions"** (`GET /risks/mine`), **"Reviews due"**
  (`GET /risks/reviews`, managers), the dashboard's counts
  (`GET /risks/summary`), and three digest sections: risks to review,
  actions due, proposals (managers).
- **The shared actions engine** (`apps/api/src/actions/`,
  `docs/specs/actions.md`): actions on risks with their timeline, reminders
  (`ActionCheck`), "My actions" and `actions.overdue`
  (`actions/measures.ts`, from the definition in `reports/measures.ts`; shown as `overdueActions` in `/risks/summary`).
  The engine imports no module; the risks module registers its rules.
- **Escalation and committees:** automatic in the transaction of a current
  rating (or a review), never to a lower committee and never repeated; by
  hand by a manager; down by a member or a manager for the whole
  organization once the band is below the committee's threshold; the
  committee's list (`GET /risks/committees/:id/risks`); and the email at
  once for an Extreme risk escalated (`IMMEDIATE`, rule `extreme`; it may
  be switched off; it is sent while suspended).
- **Notifications:** `risk_owner_assigned`, `risk_review_due`,
  `risk_review_overdue`, `risk_above_tolerance`, `risk_escalated`,
  `risk_de_escalated`, `risks_overdue_digest`, `action_assigned`,
  `action_due_soon`, `action_overdue`, `action_escalated`,
  `action_completed`, each naming its risk (`risk_id`) or action
  (`action_id`), with references and `serious` only. The notifications list
  names them with whether they can still be opened.
- **Standing against tolerance** now says `above_treated` (treatment
  "reduce", a target within tolerance, an open action); `notAddressed`
  filters on it.

### Decided while building (steps 3 to 5)

1. **A review's outcome `no_change` needs the same current rating**
   (400 `outcome_mismatch`).
2. **The trend** is against the current rating at the last review, while a
   later rating has changed it; else against the rating before.
3. **Escalation follows ratings and reviews**, not a new matrix version
   put in use; the next rating escalates.
4. **Coming down from a committee** puts the risk before the lower committee
   its band calls for, at once. A member who then no longer reads the risk is
   answered `{ access: 'none', id, reference, escalatedToCommitteeId: null }`.
5. **Committee members** are told when no role is set by those who manage
   risks for the whole organization (spec, "Escalation").
6. **An action's owner reads the risk's summary** (`access: 'summary'`)
   while the action is open, in progress or completed, and is not shown the
   risk in the register.
7. **Escalation reasons, due-day reasons and cancellation reasons** are
   recorded as given (`reasonGiven`), not their text, after M1. Cancel
   reasons stay on the action, correctable. Since security review 17 (L5),
   the reasons that had no place on the record are kept as notes and
   named by id: see "Built: steps 6 and 7".
8. **Reopening an action keeps its last note** until it is completed again,
   so no text needs to go into the timeline.
9. **Action notifications are the risks module's** while every action's
   source is a risk (`docs/specs/actions.md`, decision 3).
10. **The effectiveness check reminder** (30 days after completion) is left
    to the actions module's settings (`docs/specs/actions.md`).

### Security review 15, as the business decided

- **M1.** The audit trail and the timeline record which text fields
  changed (`{ changed: true }`) and that a reason was given
  (`reasonGiven`), never the text. Ratings' rationales were never in the
  trail. A manager of a risk corrects a rating's rationale, a review's
  comment, a rejection reason or a control's reason
  (`POST /risks/:id/corrections`), and an action's notes
  (`POST /risks/actions/:id/corrections`), audited as `risk_text_corrected`
  / `action_text_corrected` without the text, shown in the timeline as
  `text_corrected`. The application role may update only `rationale` of a
  rating and `comment` of a review.
- **L1.** Linking a document (as a control or the framework) needs the
  person to read it. A restricted document a reader may not open shows only
  as `{ restricted: true }`.
- **L2.** The matrix preview is for managers for the whole organization;
  others get `preview: null`.
- **L3.** A current rating below the stored target is refused
  (`target_above_current`); a new version that leaves a target above the
  current rating counts such risks (`risksTargetAboveCurrent`), says so in
  their timeline, and lists show `targetAboveCurrent`.
- **L4.** Wording changes to a matrix record the old and new label,
  descriptor, frequency, band name and domain.
- **Also:** nobody accepts their own proposal (403 `same_person`); 0075's
  audit entry lists exactly what each role got; a rating while suspended
  is refused where `moves` offers nothing; a version holds at most 12
  domains (400 `too_many_domains`); and the Department manager note above.

## Built: steps 6 and 7, API, and security review 17

### Step 6: approvals

- **The approval engine** takes risk subjects: routes of subject
  `risk_acceptance` (one per band: `variant` medium, high or extreme) and
  `risk_closure`; runs of subject `risk_acceptance` (the acceptance) and
  `risk` (the closure). A risk of the whole organization (`orgUnitId`
  null) is decided only by a grant for the whole organization. Documents'
  routes, runs and signatures are unchanged, and the policies settings
  neither show nor change a risk's route.
- **Starting routes**, for a new client (`ensureRiskRoutes`) and for every
  existing one (migration 0075, audited once as
  `risk_defaults_created_by_system` with the routes it got): Medium and
  High, one approval by the Approving authority; Extreme, a review by the
  Quality officer then an approval by the Approving authority; closure,
  one approval by the Quality officer; 7 days a step. Kept in
  `GET/POST/PATCH /risks/settings/approval-routes` (a manager for the
  whole organization; a role named must include `risks.approve`).
- **Acceptance** (`POST /:id/acceptance`, `/approve`, `/return`,
  `/withdraw`): as the spec says. The signed content is
  `{ riskId, reference, title, categoryId, orgUnitId, current: {
  likelihood, impact, score, band, matrixId }, tolerance, rationale,
  conditions, until }`. While in approval, `risks_acceptance_in_progress`
  (a trigger) keeps the title, category, unit and current rating, and
  `risk_acceptances_content_fixed` keeps the acceptance; its status only
  moves forward (`risk_acceptances_status_order`). In force, the risk shows
  `standing: 'above_accepted'`, `acceptedUntil`, treatment "accept". It
  lapses on its last day (the risk check), when the current score rises
  above the score accepted (a rating or a review), or when the category
  changes; the owner is reminded 30 days before.
- **Closure** (`POST /:id/close`, `/closure/approve`, `/closure/return`)
  and **reopening** (`POST /:id/reopen`), as the spec says. Nothing changes
  on the risk while its closure waits for a signature (409
  `closure_in_progress`), not even the reason's correction.
- **"My approvals"** (`GET /risks/approvals`, `risks.approve`), the
  `steps` of "My risks", the digest section "Risk steps to decide", and
  `stepsOverdue` in the weekly email to managers for the whole
  organization. `risk_step_assigned` is emailed at once and may not be
  switched off by its assignees; it waits while suspended.
- **An assignee** of a step in progress reads that risk; after deciding,
  one who reads it no other way is answered `{ access: 'none', id,
  reference }`.

### Step 7: links

- **Incidents** (`POST /:id/incident-links`, `DELETE
  /:id/incident-links/:linkId` with a reason): by a manager of the risk
  who sees the incident in full; 400 `unknown_incident` alike for one
  they do not see, of another client, that does not exist, or while the
  incidents module is off. The risk's page has `incidents: { items,
  hidden, last12Months, categories }` (null while the module is off): only
  the incidents the reader sees in full, each with its reference, type,
  category, unit, day, harm level and status; a count of the others; never
  the reporter, the channel or whether it was anonymous. The owner is told
  (`risk_incident_linked`) by the risk's reference only.
- **The incident's panel** (`GET /risks/for-incident/:incidentId`, for
  whoever sees the incident): the linked risks the caller reads, and for
  one who sees it in full what "Raise a risk" offers (`raise: { orgUnitId,
  impact, linkKind }`, impact from the harm level: mild 2, moderate 3,
  severe 4, death 5).
- **"Raise a risk"** is `POST /risks` with `fromIncidentId` (and
  `linkKind`, `raised` by default): by anyone who sees the incident in
  full, `risks.manage` or not. Opened when its author manages risks there
  and gives a current rating; proposed otherwise, the unit's managers told
  (`risk_proposed`). Open while suspended, as a proposal only.
- **Documents as controls:** a control's `flag` says `document_retired` or
  `document_past_review` (never for a restricted document the reader may
  not open). Retiring a document tells the owners of risks with an active
  control on it (`risk_control_document_retired`), through
  `LinkedDocuments.onRetired`. `GET /risks/for-document/:documentId` (for
  a reader of the document) lists the risks the caller reads; `total`
  counts all of them for readers for the whole organization only.

### Security review 17, as folded in

- **M1.** Escalation by hand to the committee a risk is before, or to one
  below it while that one is in use, is 409 `already_escalated`.
- **L1.** A member reviewing for a committee rates but does not set the
  treatment (403); "accept" above tolerance is never set by hand, at
  creation, in an edit or at a review (400 `acceptance_required`): it
  comes from a signed acceptance. Whoever lowered a risk's current score
  today (on the client's calendar) does not take it off its committee's
  list (403 `same_person`).
- **L2.** Whoever completed an action does not verify it (403
  `same_person`; `verify` is not in their moves).
- **L3.** A committee that open risks are before is not switched off (409
  `committee_in_use`); a risk before a committee switched off by other
  means is escalated as if it were before none.
- **L4.** Corrections (`POST /:id/corrections`) also take a risk's title,
  cause, event and consequence where it cannot be edited (rejected,
  closed; 409 `use_edit` otherwise), the close reason, and a link's note
  or removal reason (`link_text`); an action's corrections take its title
  and description at any status. Audited by name only.
- **L5.** Reasons that had no place on the record are kept as notes
  (`risk_notes`: change of owner, unit or category, escalation, coming
  down, reopening, withdrawing an acceptance; `action_notes`: a due day's
  move, a reopening), shown on the page as `notes`, corrected by a manager
  (`kind: 'note'`, recording who and when), and named in the timeline and
  the trail by `noteId`. The application role may update only a note's
  text and who corrected it when.
- **L6.** An action's owner reads the action and its risk's summary while
  the action is open, in progress or completed, as `visibility.ts` says;
  not once verified or cancelled (404).
- **Also:** an inherent rating is not refused because a new version of
  the matrix left the target above the current rating; only a current or
  target rating is held to it.

### Decided while building (steps 6 and 7)

1. **A band whose acceptance needs no signature** (`acceptanceNeedsSignature`
   off: Medium may be set so) is accepted at once, audited as requested
   and accepted with `signatureRequired: false`. Any other needs an active
   route for its band (409 `no_route`).
2. **A current rating on an older version** of the matrix is re-rated
   before an acceptance is asked for (409 `rerate_needed`); putting a new
   version in use leaves the current rating of a risk whose acceptance is
   in approval as it was signed (`risksAwaitingAcceptance` in the entry).
3. **The closure's signers exclude its requester and the risk's owner**,
   as an acceptance's do. A closure asked for and returned keeps its
   reason on the risk (correctable) for the next request.
4. **A closed risk keeps its acceptance** until its last day; reopened, a
   new current rating above the score accepted ends it.
5. **The signed content and a step's comment are not correctable**: a
   decided step is fixed by migration 0041's rule, and what was signed
   must stay as it was. Neither is in the trail or the timeline
   (`commentGiven`).
6. **A link's note** is plain text in one language, as a review's comment
   is.
7. **The merged-into risk** must be another open risk the closer reads (400
   `unknown_risk`).

### Not done, for the merge

- Migrations 0074 and 0075, on top of the main branch at 02568cb: see
  "Merged onto the main branch" below.
- The web screens of steps 6 and 7 (the wording keys are in the contract).

## Merged onto the main branch

- **Migrations** 0074 (generated) and 0075 (custom), in place of this
  branch's 0060 to 0065. 0074 holds none of the main branch's own schema
  that has no migration yet (the end of contract: `client_deletions`, the
  subscription's exit days, exports approved by Trustline): that stays its
  author's to generate on top.
- **Audit:** every action and detail key is registered and worded in the
  three languages (`details.fields`, `values`); the areas `risks` and
  `actions` and the entity types are worded; both areas belong to the
  `risks` module in the viewer (`AREA_MODULE`); an external reviewer's
  reading of the register is named `risk` / `risks` among the screens.
- **Exports:** every table of the module is in `exports/coverage.ts`, in
  `risks/` and `actions/`; none is excluded.
- **External reviewers** read the register (decision 17): `risks.view` is
  in `READ_ONLY_PERMISSIONS`, and the built-in External reviewer role holds
  it, given to existing clients by 0075 with its description reworded.
- **The measure:** `actions/measures.ts` reads `actions.overdue` from
  `reports/measures.ts` (code, target, direction, tenths of a percent).
  It stays `taken: false` there: the month-end snapshot and the Reports
  series for actions are the reports module's to build, with a reach rule
  for actions.
- **Email:** `risk_step_assigned` is an approval step in
  `COMPULSORY_FOR_ASSIGNEES`, and the preferences screen counts a holder
  of `risks.approve` among those who decide approval steps.

