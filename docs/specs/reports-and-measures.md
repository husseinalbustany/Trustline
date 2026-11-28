# Reports and measures over time

Status: proposed, not built. Read CLAUDE.md, README.md,
`docs/business-requirements.md` ("Success measures") and
`modules-and-subscriptions.md` first.

This spec says how Trustline keeps the business's success measures month
by month, for the organization and for each unit, for years, and how people
read them: a Reports page with trends, filters, a CSV file and print, and a
monthly committee pack. It also places the server-made, side-by-side
bilingual PDF of a controlled document, which the business tied to this
work (decision 10 of "Decided by the business after quality review 3" in
`policies-and-procedures.md`).

Trustline's clients are any organization, not only hospitals. Every rule and
sentence here must read correctly for a factory or a school as well.

Each choice this spec makes where the business has not decided is marked
**Recommended**. What the business must decide is listed at the end.

## Why

Quality review 3 (S4 and "Missing") found that both document measures are
figures for today only (`apps/api/src/policies/library.service.ts`,
`summary()`), as are the incident figures
(`apps/api/src/incidents/incidents.service.ts`, `summary()`: "the last 30
days"). Nothing records a month's value, so nobody can say "under 5% past
review over the pilot's third month", and the Reports page is a placeholder
(`apps/web/src/app/[lang]/(app)/reports/page.tsx` renders `ModulePage`). A
committee, a surveyor and the pilot's own exit criteria ("increase within 6
months") all need trends, not today's figure.

## What exists today

- **Incident figures** (`IncidentsService.summary`), over what the caller
  sees (`visibleTo`; deadlines only over `seenInFull`,
  `apps/api/src/incidents/visibility.ts`): open, awaiting triage, closed in
  the last 30 days, assigned to me, serious open, overdue, `triagedOnTime`
  (of the reports of the last 30 days that had their first decision or are
  still untriaged past their deadline, the share whose first triage,
  `first_triaged_at`, came no later than
  `coalesce(first_triage_due_at, triage_due_at)`), and
  `medianSecondsToReport` (from `report_started_at` to `reported_at`). "The
  last 30 days" are days on the client's calendar (`lastDays()` in
  `apps/api/src/i18n/time-zones.ts`).
- **Document figures** (`LibraryService.summary`): `pastReview` (active
  documents whose `next_review_on` is before today, as a share of active
  documents; target `MEASURES.pastReviewBelow`, 5) and `acknowledgement` (of
  the people asked to acknowledge the published version of each active
  document the caller sees in full, still active, whose due date has passed,
  the share who have; target `MEASURES.acknowledgedAtLeast`, 90; `live`
  beside it over everyone asked). Shown only to those with full sight of
  some documents.
- **The dashboard** (`apps/web/src/components/dashboard/dashboard-view.tsx`)
  shows both sets as tiles. Nothing is stored.
- **`reports.view`** exists (`apps/api/src/identity/permissions.ts`, module
  `core`), held by the built-in Administrator, Quality officer and
  Department manager, and checked by no route. The sidebar item "Reports"
  (`apps/web/src/config/navigation.ts`) names no permission, so everyone
  sees it.
- **CSV files** are made by `apps/api/src/policies/csv.ts` (UTF-8 with a
  byte-order mark, every cell quoted, CRLF, formula starts neutralised with a
  leading apostrophe, every format character counted as one), headings in
  the caller's language from `export-wording.ts`, at most 50,000 rows, every
  export audited.
- **Background checks** run in every API process, started by `main.ts`: the
  incident deadline check every 5 minutes and the policies daily check every
  15 minutes (`POLICY_CHECK_EVERY_MS`), each thing claimed once, 30 seconds
  at most a statement, a client that fails named in the log with the kind of
  failure only.
- **Printing** a document is browser print in one language
  (`apps/web/src/components/policies/print-view.tsx`). There is no PDF
  library in the API (`apps/api/package.json`).

## The measures

The business named eight success measures. Two (pilot satisfaction, and
paying clients and revenue) are not figures Trustline holds about a client,
and are out of scope. The six others are defined once, in code, and used by
the dashboard, the live figures, the snapshots and the packs, so that the
same words always mean the same number.

**Recommended:** move the definitions into one place,
`apps/api/src/reports/measures.ts`, each with a code, its module, its target
and direction, its unit basis and a `definitionVersion`. The two `summary()`
methods call the same functions, so a tile on the dashboard and the month on
the Reports page cannot drift apart. `MEASURES` in `library.service.ts` moves
there.

| Code | Business measure | What is counted for month M | Target (business default) | Module |
|---|---|---|---|---|
| `incidents.time_to_report` | Time for staff to submit a report | Median seconds from opening the form to sending it, over the reports sent in M that carry a start time; beside it the share sent in under 2 minutes and how many carried a start time | Median under 120 seconds | incidents |
| `incidents.reported` | Change in reporting volume | Reports sent in M (`reported_at`), by type (incident, near miss, hazard); beside it the change against the baseline | Above the baseline within 6 months | incidents |
| `incidents.triaged_on_time` | Share of reports triaged within deadline | Of the reports sent in M, those whose first decision came no later than their first triage deadline, as a share of those decided or past their deadline (today's rule, by month) | 95% or more | incidents |
| `actions.overdue` | Overdue corrective actions | Open actions past their due date at the end of M, as a share of open actions. Defined now, taken once the actions module exists | Under 10% | actions |
| `policies.past_review` | Policies past their review date | At the end of M, active documents whose next review was before the last day of M, as a share of active documents | Under 5% | policies |
| `policies.acknowledged` | Policy acknowledgement completion | At the end of M, of the acknowledgements asked on the version in force of an active document, of people still active, due before the last day of M, the share given (today's `due_date_passed` basis) | 90% or more | policies |

**Recommended: figures that explain the measures,** taken with them but with
no target, so that a committee can see why a measure moved:

- Incidents:
  - open, overdue (triage and closure) and awaiting sign-off at the end of M;
  - closed in M, and of those, closed by their closing deadline;
  - serious events (severe harm, death, sentinel) and sentinel events
    reported in M;
  - near misses as a share of reports (a sign of reporting culture);
  - median days from report to closure for those closed in M;
  - counts by category (for a Pareto chart) and by harm level.
- Documents:
  - published, retired and imported in M;
  - periodic reviews completed in M, and how many on time;
  - approval steps overdue at the end of M;
  - imported documents due for re-issue;
  - acknowledgements falling due in M and the share given by their due day.
    This flow sits beside the stock measure, which moves slowly.

**Recommended: the baseline for reporting volume** is a figure the client
enters: its monthly average before Trustline, with a note of where it comes
from, such as "paper register, 2025". The business's question is whether
reporting rose after moving off paper. Without such a figure, the baseline is
the average of the first three full months after the incidents module
started (`module_starts`). See decision 1.

**Recommended: targets.** The business's defaults stay in code. A client may
set its own target per measure (in settings, audited). Each snapshot keeps the
target that was in force when it was taken, so a later change of target never
makes an old month look better or worse.

### Per organization and per unit

- **Units.** A snapshot is taken for the whole organization and for every
  unit that was active during the month (facility, department, unit). A
  unit's row counts the unit and everything beneath it, as a grant for a unit
  reaches what is under it (`reachOf()`, `apps/api/src/identity/scope.ts`).
  So medians and shares are worked out for each row, never added up from
  children.
- **Which unit a record counts for:**
  - **Incidents:** where it happened (`org_unit_id`), as reported.
    **Recommended:** the closure figures are also given by handling unit
    (`owner_unit_id` at the end of the month), since that unit is
    accountable for closing.
  - **Documents:** the owning unit (`owner_unit_id`).
  - **Acknowledgements:** the person's own unit (`users.org_unit_id`) at the
    end of the month.
- **The structure moves** (`org_unit_moved` is audited). **Recommended:**
  each row keeps the unit's path as it was when the snapshot was taken
  (`unit_path`), and history is shown in that structure: March's figure for a
  department is what that department was in March. The unit's name is shown
  as it is now, with `pick()`. See decision 3.
- **Small numbers are not hidden:** these are management figures inside the
  organization. The exception is anything that tells whether a report was
  anonymous (see "Who sees what").

## How a snapshot is taken

### The month-end check

- **Recommended:** a new background check, `MeasureSnapshotCheck`
  (`apps/api/src/reports/`), started by `main.ts` beside the others and built
  the same way:
  - it runs every 15 minutes, in any number of processes, and claims each
    snapshot once;
  - it works in batches, and no statement takes longer than 30 seconds;
  - a client that fails is named in the log with the kind of failure only,
    and is tried again at the next run;
  - `run(now, only)` lets tests name their own clients.
- **When.** At the first run on or after 00:00 on the first day of a month on
  the client's own calendar (`tenants.time_zone`), the check takes month M,
  the month just ended. Every client's month ends at a different moment,
  which is why it runs every 15 minutes rather than once a day.
- **As at.** Every row records `as_at` (the end of M, which is the first
  moment of the next month in the client's time zone) and `taken_at`.
  - Measures over a month (reports sent in M, acknowledgements due in M) are
    exact whenever they are taken.
  - Measures at the end of M (documents past review, open incidents) are
    read from the records as they stand when taken. A run within 6 hours of
    `as_at` reads them as they are (`method: snapshot`). A later run, after
    the API was down, works them out as at `as_at` from the records' history
    (`method: reconstructed`, see below) and says so.
- **One transaction per client and module** writes all of that module's rows
  for M (the organization and every unit), so a month is there whole or not
  at all. A unique key on (client, month, measure, unit, revision) makes a
  second process's attempt do nothing.
- **Catching up.** A client whose check failed, or that was closed (a client
  Trustline suspended, or a cancelled subscription), gets the months it
  missed at the first run once it is open again. They are reconstructed and
  marked so.
- **Modules.** Only the modules the client had during M are taken.
  - A module that was off for the whole month has no row, and the chart
    shows a gap labelled "not in use", not a zero.
  - While the subscription is suspended, snapshots go on: they read, and
    change nothing of the client's.

### Provisional and final

The triage measure for M is not settled at the end of M: a report sent on
the 31st may be triaged on time two days later. **Recommended:** its first
row is `provisional`. The check adds a `final` row once every report sent in
M has had its first decision or is past its first deadline, which is at most
the client's longest triage window after the month ends. The Reports page
shows "provisional" until then. Every other measure is final when taken.

### The first months (backfill)

When this is released, clients already have months of records.
**Recommended:**

- **At the first run after release**, every month from the module's start
  (`module_starts.started_on`) to the month before the current one is taken
  as `reconstructed`, with the day it was done.
- **Exact from the records:** everything counted over a month, since the
  records keep those times:
  - reports sent and their time to report;
  - their first triage against their first deadline;
  - closures and their deadlines;
  - acknowledgements due and given.

  The columns used are `incidents.reported_at`, `report_started_at`,
  `first_triaged_at`, `first_triage_due_at`, `closed_at` and `close_due_at`,
  and `document_acknowledgements.due_on` and `acknowledged_at`.
- **Worked out from history:** what stood at the end of a month.
  - **Incidents:** the status at a moment comes from the timeline
    (`incident_events`, `from_status` and `to_status`, insert-only).
  - **Documents:**
    - whether one was active comes from the versions' `published_at` and the
      document's `retired_at`;
    - its next review date comes from the reviews
      (`document_reviews.next_review_on`), the publications, and the audited
      changes of `nextReviewOn` and `reviewMonths` (`document_updated` in
      `audit_log`).
  - **People:** whether a person was active at a moment comes from the
    `user_updated` entries with a change of status.
  - **The unit tree** is today's: moves before the release are not replayed,
    and the rows say so.
- **The current month,** partly before the release, is taken at its end like
  any other. What it counts over the month is exact.
- See decision 4: whether reconstructed figures from before the release are
  shown at all, or only kept.

### Corrections

- **A snapshot is never changed or deleted.** The application role may read
  and add rows, never update or delete them (grants and a trigger, as for
  signatures).
- **A correction is a new revision** of the same month, measure and unit,
  with a reason (required), by someone holding `reports.manage` for the whole
  organization.
- **Recommended: a correction is recomputed by Trustline, never typed in.**
  - The person asks for it and gives the reason ("incidents of ward 4 were
    entered against ward 3, and moved on 12 March").
  - The figure is worked out again, as at the same `as_at`, from the records
    as they are now, by the reconstruction method.
  - A typed figure would invite the very gaming the measures are meant to
    expose: the import review date in quality review 3 (M2) was such a case.
- **Corrections by Trustline:** after a defect in a definition is fixed, a
  migration may add recomputed revisions for every client, with one audit
  entry per client (`measures_recomputed_by_system`, with the reason), as
  0039 does for roles.
- **What readers see:**
  - the latest revision, marked "corrected on <day>", with the earlier
    figures and reasons one click away;
  - a pack issued before a correction keeps its figures and, when opened,
    says that a figure has since been corrected.
- **A changed definition** (a new `definitionVersion`) applies from the month
  it is released. Earlier months keep the figure taken under the old one, and
  the chart marks the month the definition changed.

### Retention

Snapshots hold no personal data: counts, shares and medians per unit.
**Recommended:** they are kept for the life of the client's account, never
deleted earlier, and are part of the full export (`data-export.md`). This is
consistent with decision 8 (records kept at least six years after the
document is retired): the figures about documents last at least as long as
the documents.

## Who sees what

The figures are scoped like the screens, so the Reports page tells nobody
what their screens would not.

- **The page** needs `reports.view`. Its reach (the whole organization, or
  some units) bounds everything below. The sidebar item gets
  `permissions: ["reports.view"]`.
- **Incident figures for a unit:**
  - the unit must be within the reach of `reports.view`, and within the
    reach of `incidents.view` or `incidents.triage` (the reach that
    `seenInFull()` uses);
  - the organization's row needs both for the whole organization;
  - someone who sees incidents only as their reporter or assignee sees no
    incident figures here.
- **Anything that tells a report was anonymous**, or that it came through the
  public link, is shown for a unit only to those who also hold
  `incidents.see_reporter` over it. This covers counts by channel, and named
  against anonymous. Suppose a ward had one report this month, and it was
  anonymous. Someone who handles that report, shown a count of one anonymous
  report for the ward, would learn what README.md says they are not told.
- **Document figures for a unit:** within the reach of `reports.view` and of
  `policies.manage` or `policies.view_all` (full sight, as for the
  acknowledgement figures today).
- **Actions figures**, when built: within the actions module's own reach.
- **Live figures** for the month so far follow the same rules, worked out
  when read.
- **The built-in roles:**
  - Administrator and Quality officer see the organization;
  - a Department manager (reports, incidents and documents over their unit)
    sees their unit and those under it;
  - a Reporter has no Reports page;
  - the Approving authority does not hold `reports.view` today (see
    decision 6).
- **A unit the caller may not see** is answered as if it were not there (404
  for a unit named in a query), as elsewhere.

**New permission (recommended):** `reports.manage` (core). It asks for a
correction, sets the client's targets and baseline, and prepares and issues
packs. Built-in: Administrator and Quality officer. It is given to existing
clients' roles by migration, with one audit entry per client, as 0039 did.

## The Reports page

`/<lang>/reports`, replacing the placeholder.

- **Measures** (the landing view): one panel per measure the caller may see.
  - Each panel shows the latest month's value, the target, and whether it was
    met. That is shown in colour, with an icon and a word, never by colour
    alone, as the design guidelines say.
  - It also shows the month so far (live, marked as such), and a 12-month
    trend line with the target drawn as a line.
  - Opening a measure shows its full history: the numerator and denominator
    for each month, the provisional and corrected marks, and the supporting
    figures.
- **Incidents:**
  - reports by month and type, by harm level, by category (a Pareto chart:
    categories in order, with the running share) and by unit;
  - open and overdue at each month end, and closed on time.

  Past months come from the snapshots; the current month is worked out live.
  **Recommended:** control (SPC) charts come later, with the KPI work (Phase
  3 in the business document); a run chart (the months with their median)
  comes now.
- **Documents:** past review and acknowledgement completion over time, with
  the flows (published, reviewed, acknowledged on time).
- **Packs:** the committee packs (below).
- **Filters:**
  - period (from month, to month; quick choices of 6, 12 and 24 months);
  - unit (a picker limited to the caller's reach, the organization first);
  - module, and for incidents, type and harm level.

  The filters are in the address, so a view can be shared with a colleague
  who has the same reach.
- **CSV:** every view has "Download CSV" (see the API).
- **Print:** the page has a print layout (A4, landscape for charts) with the
  organization's name, the scope, the period, "printed on <day>" and page
  numbers. Each chart has its table printed beneath it. The committee pack is
  the formal printed report.
- **Charts:** **Recommended:** small SVG charts made in the web app, with no
  chart library and nothing loaded from elsewhere, each with a table of its
  figures for screen readers and print. Time runs from the inline start (so
  right to left in Arabic) like the rest of the layout; see decision 9.
- **Phone:** each panel stacks. A chart becomes its value, its target and a
  sparkline, with the table behind a "Show figures" button.

## Committee packs

A pack is a frozen, issued report for one period and one scope, for a
committee: for example the monthly quality and patient safety committee, or
a factory's health and safety committee.

- **Recommended: one kind to start, the monthly quality report**, for the
  organization or for a unit, in the client's languages:
  1. **Cover:** organization, scope, period, prepared by, issued on, and the
     pack's number (`RPT-2026-11-01` style, from `reference_counters`).
  2. **Measures against targets,** each with its 12-month trend.
  3. **Incidents:**
     - by type and harm level;
     - the serious and sentinel events of the month, listed by reference,
       category, unit, harm level, status, whether triaged on time, and
       closing deadline;
     - those overdue at month end;
     - the top categories over 12 months.
  4. **Documents:**
     - past review and acknowledgement completion;
     - published, retired, and due for review next month: by number, with
       the title only where the document is open to all staff (restricted
       documents by number only);
     - approval steps overdue.
  5. **Actions,** when built.
  6. **Commentary:** one per section, written by whoever prepares the pack,
     in the client's languages (`Localized`, validated with `localizedText`
     and `fitsLanguages`, shown with `pick()`).
- **No free text from records.** **Recommended:** a pack carries references,
  categories, units, levels and counts. It never carries an incident's
  description, immediate action or comment, which may hold details of a
  person. A committee that needs the story opens the incident in Trustline,
  with its own access. See decision 7.
- **Lifecycle: draft, then issued.**
  - A draft is made from the latest snapshots and can be refreshed on
    demand.
  - Issuing freezes the content (`content` JSON and its SHA-256), records who
    issued it and when, and makes it readable to everyone holding
    `reports.view` over the pack's scope.
  - So issuing a pack publishes its figures to those people. That includes
    incident figures for people who would not see those incidents
    themselves, which is what a committee pack is for.
  - The preparer must hold the module reach for every section included, so a
    pack never holds a figure its preparer could not see.
- **Recommended:** packs are drafted automatically the morning after the
  month's snapshot, and the preparers (holders of `reports.manage` over the
  scope) are told in the app. They add the commentary and issue the pack.
  Emailing packs on a schedule is Phase 2 in the business document; when it
  comes, the email carries the pack's number and a link, never figures
  (`email.md`).
- **Sign-off.** **Recommended:** issuing is not a signature in this release.
  Whether a pack needs the committee chair's signature through the approval
  engine (`apps/api/src/approvals/`) is decision 8.
- **PDF:** each issued pack has a server-made PDF in each of the client's
  languages, made from the frozen content, so that it reads the same every
  time it is made. Its footer carries the pack's number, page x of y, the
  content hash, and "figures as at <as_at>".

## The server-made PDF

Two things need a PDF made by the server:

- the committee pack;
- the bilingual controlled document the business expected ("bilingual PDF
  export" is a key capability of the policies module in the business
  document).

The full export (`data-export.md`) also wants each document as a file.

**Recommended: the controlled-document PDF gets its own spec,
`docs/specs/document-pdf.md`, written before it is built.**

- It belongs to the policies module.
- It carries the controlled-document rules: what is in force, the control
  block, "valid on the day printed", and the language that applies.
- The security review of a renderer is a piece of work of its own.

This spec only fixes the outline, so that the renderer is built once, for all
three uses.

### The renderer (shared)

- **Recommended:** the API makes HTML from the same sanitised content the
  screens render, and a headless browser in a separate worker process prints
  it to PDF.
  - The content is Markdown limited to paragraphs, headings 1 to 3, lists and
    bold; `apps/api/src/policies/content.ts` refuses everything else.
  - Arabic shaping, joining and mixed-direction text are where PDF libraries
    fail. A browser engine gets them right, and the print layout already
    exists as HTML.
  - A Typst or PDF-library renderer is the alternative (decision 10).
- **The worker's limits:**
  - it has no network access;
  - it loads nothing from outside the HTML it is given; fonts are embedded,
    a Latin and an Arabic face under an open licence, such as the Noto
    families;
  - it runs with a time limit and a memory limit per document;
  - it is given no session and no token.
- **Audit:** every PDF made is audited (`document_pdf_made`,
  `report_pack_pdf_made`), like the CSV exports. Reading on screen and
  browser print stay as they are and are not audited.

### The side-by-side bilingual document (outline for its own spec)

- **What:** one version of a document, in two of its languages, laid out in
  two columns, section by section, so that each section's two texts start
  level.
  - The language that applies is the first column (the inline start of the
    page's direction).
  - The page's direction and the control block follow the requester's
    language.
  - **Recommended:** at most two languages per page. A client working in
    three chooses which two (decision 11).
- **The control block, in both languages:**
  - number and version (and "Rev. 4 on the original" for an imported one,
    `control.originalRevision`);
  - title, owner, owning unit, effective day and next review;
  - the approvals with names and days, or "Approved before Trustline" with
    its details and the differences from the original;
  - the language that applies, and the fingerprint of what was signed
    (`contentHash`).
- **Notes per section** (`languageStatus`):
  - a section with no text in a language shows the authoritative text, with
    the same note as on screen ("fallback");
  - a section changed in the authoritative language and not in the other is
    marked "translation not updated".
- **Every page** carries, as the browser print does today:
  - number, version and title, and page x of y;
  - "printed on <day>, valid on that day only";
  - the "printed copies are not controlled" line;
  - the QR code to `GET /documents/:id`, the version in force.
- **Which versions:**
  - the version in force, for anyone who may read it;
  - any other version only with full sight, marked with its status
    ("Superseded", "Draft", "Withdrawn") on every page.
- **A single-language PDF** comes from the same template, in one column, for
  clients working in one language.
- **Route (outline):**
  `GET /policies/documents/:id/versions/:versionId/pdf?languages=en,ar`.
  - `languages` is one or two of the version's languages (400
    `language_mismatch` otherwise).
  - It answers with `Content-Disposition: attachment` and
    `Cache-Control: no-store`, and is audited.
  - A version the caller may not open is 404.
- **Tests:**
  - the Arabic and French text extracted from the PDF match the source;
  - every page carries the header and the footer;
  - a visual check of a three-page bilingual procedure, in each direction.

## API outline (under `/api/v1/reports`, `@ForModule('core')`)

Every route:

- needs a session (401 without);
- takes strict input (400 otherwise);
- follows the scope rules above (a unit out of reach is 404);
- follows the module rule: figures of a module the client does not have are
  absent, as if the measure did not exist.

| Route | Who | Query / body | Answers |
|---|---|---|---|
| `GET /measures` | `reports.view` | `from`, `to` (months, `YYYY-MM`, at most 120 months), `unitId?` (the organization if absent), `measures?` | `{ measures: [{ code, module, target, direction, months: [{ month, value, numerator, denominator, met, status, method, revision, correctedAt?, asAt, definitionVersion }], current: { value, asOf } }] }` |
| `GET /measures/:code/history` | `reports.view` | `month`, `unitId?` | every revision of that month, with reasons |
| `GET /incidents` | `reports.view` and incident reach | `from`, `to`, `unitId?`, `by=month\|type\|harm\|category\|unit\|channel`, `type?`, `harmLevel?` | counts; `channel` only with `incidents.see_reporter` over the unit |
| `GET /documents` | `reports.view` and full sight | `from`, `to`, `unitId?` | the flows and stocks by month |
| `GET /exports/measures` | as `GET /measures` | the same, `locale?` | CSV file |
| `GET /exports/incidents` | as `GET /incidents` | the same, `locale?` | CSV file |
| `POST /measures/corrections` | `reports.manage` for the whole organization | `{ month, measures, unitId?, reason }` | 201 the new revisions, old and new value side by side |
| `GET /settings`, `PATCH /settings` | `reports.view` / `reports.manage` for the whole organization | `{ targets?, baseline?: { monthlyAverage, note: Localized }, revision }` | the settings; 409 `stale_settings` |
| `GET /packs` | `reports.view` | `page`, `pageSize` | the packs the caller may read |
| `POST /packs` | `reports.manage` over the scope | `{ kind: 'monthly_quality', month, unitId? }` | 201 a draft |
| `GET /packs/:id` | a reader of the pack | | the pack (a draft: its preparers only) |
| `PATCH /packs/:id` | a preparer | `{ commentary, revision }` | the draft |
| `POST /packs/:id/refresh` | a preparer | `{ revision }` | the draft, with the latest figures |
| `POST /packs/:id/issue` | `reports.manage` over the scope | `{ revision }` | the issued pack |
| `GET /packs/:id/pdf` | a reader of the pack | `locale?` | PDF file |

**CSV files.** **Recommended:** move `csv.ts` to a shared place
(`apps/api/src/common/csv.ts`) and use it as it is:

- the same quoting, byte-order mark and CRLF lines;
- the same neutralising of formula starts. Unit names are written by the
  client, so it matters here as much as in the existing exports;
- the 50,000-row cap;
- headings and values in the caller's language.

There is one row per measure, month and unit, with these columns: month,
unit (named in that language), unit path, measure, value, numerator,
denominator, target, met, provisional or final, how it was taken (snapshot,
reconstructed or corrected), revision, as at, and definition version.

## Data outline (not a schema)

These are all tenant tables. Each has `tenant_id` and the `tenantIsolation()`
policy, gets its grants for `trustline_app` in a migration, and is read and
written only inside `TenantDb.withTenant()`. `tenant-isolation.spec.ts`
covers them.

- **`measure_snapshots`:**
  - `month` (a date, the first of the month), `measure` (its code), and
    `org_unit_id` (null for the organization);
  - `unit_basis` (`occurred_in`, `handled_by`, `owner`, `person`) and
    `unit_path` (uuid[] at the time);
  - `value` (numeric), `numerator` and `denominator`;
  - `details` jsonb: the breakdowns (by type, harm and category), the share
    under two minutes, and the channel counts, which the API gives out only
    as above;
  - `target` and `target_source` (the business's or the client's);
  - `status` (provisional, final) and `method` (snapshot, reconstructed,
    corrected);
  - `revision`, `reason`, and `requested_by` (null for the system);
  - `as_at`, `taken_at` and `definition_version`.

  It is unique on (tenant, month, measure, unit, basis, revision). The grants
  are SELECT and INSERT only, and a trigger refuses any update. It is indexed
  for "this measure, this unit, a range of months".
- **`report_settings`:** one row per client that changed something: targets
  per measure, the reporting baseline and its note (`Localized`), and
  `revision`.
- **`report_packs`:**
  - `number`, `kind`, `month` and `org_unit_id`;
  - `status` (draft, issued);
  - `content` jsonb (frozen at issue) and `content_hash`;
  - `commentary` (`Localized`, per section);
  - `prepared_by`, `issued_by`, `issued_at` and `revision`.

  Issued content cannot change (a trigger, as migration 0041 does for signed
  versions).

## Audit

Every entry is written through `ProvisioningService.audit()` in the same
transaction as the change:

- **Corrections:**
  - `measure_correction_requested`, with the month, the measures, the unit,
    the reason, and the old and new values;
  - `measures_recomputed_by_system`.
- **Settings:** `report_settings_changed`, with what changed, old and new.
- **Packs:** `report_pack_created`, and `report_pack_issued` with its number
  and content hash.
- **Exports:** `measures_exported` and `incidents_report_exported`, keeping
  the filters as `documents_exported` keeps them.
- **PDFs:** `report_pack_pdf_made` and `document_pdf_made`.

Taking a snapshot is not audited row by row: the snapshot is its own record.
One entry per client and month (`measures_snapshot_taken`, with the method
and the number of rows) says it happened.

## Tenant isolation

The snapshot check, like the other checks, works client by client, in
transactions of its own under `TenantDb.withTenant()`. No figure is ever
worked out across clients. A cluster or group view (Phase 3 in the business
document) is a separate piece of work and will need its own consent model.

## Languages (en, ar, fr)

- **On screen:** measure names, explanations, statuses ("provisional",
  "corrected", "reconstructed from records"), filters and chart labels are in
  the web dictionaries, one file per language, with the same keys. They reuse
  today's wording:
  - "Triaged on time" / «الفرز في الموعد» / « Tri dans les délais »;
  - "Acknowledgement completion" / «نسبة الإقرار بالاطلاع» / « Taux de
    prise de connaissance »;
  - "Documents past their review date" / «وثائق فات موعد مراجعتها» /
    « Documents dont la révision est dépassée ».
- **Made by the API:** CSV headings and PDF wording live in
  `apps/api/src/reports/wording/<lang>.ts`, one file per language with the
  same keys, checked by a test as `email/wording.spec.ts` does.
- **Client text** (unit names, commentary, the baseline note) is shown with
  `pick()`.
- **Numbers and months:** Latin digits, and months as the web app writes
  them (as the email spec settled for days). Arabic month names differ by
  region: «نوفمبر» in the Gulf, «تشرين الثاني» in the Levant. The launch
  region is still open, so see decision 9.
- **Neutral for any organization:** "report", "unit", "organization", never
  "patient" or "hospital".

## Order of build

1. **One definition per measure** (`reports/measures.ts`). The two
   `summary()` methods call it, and tests check that the dashboard and the
   live figure agree. No visible change.
2. **Snapshots:** `measure_snapshots`, the month-end check, provisional and
   final rows, the backfill of past months, and the reconstruction functions,
   with tests against hand-built histories (a document reviewed late, a unit
   moved, a person who left).
3. **The Reports API:** series, history, the live month, CSV. Scope tests: a
   department manager sees their units only, channel counts need
   `incidents.see_reporter`, and a module that is off has no figures.
4. **The Reports page:** the measures view with trends and tables, the
   filters, the print layout, and the sidebar permission.
5. **Incident and document breakdowns,** with Pareto and run charts.
6. **Settings and corrections:** targets, baseline, `reports.manage`,
   corrections with reasons, and the "corrected" marks.
7. **The renderer** (the shared worker), then the controlled-document PDF
   under its own spec.
8. **Committee packs:** drafts after each snapshot, commentary, issue, PDF.
9. **Later:**
   - emailing packs on a schedule;
   - SPC charts;
   - rates against denominators (staff numbers, patient days, hours worked),
     with the KPI work;
   - the actions measure, once that module exists;
   - a report builder.

The reviews:

- `security-reviewer` after steps 2, 3 and 7;
- `bilingual-reviewer` after steps 4, 7 and 8;
- `quality-reviewer` at the end.

## Decisions needed

1. **The baseline for reporting volume:** a figure the client enters from
   before Trustline (recommended), the first three months in Trustline, or
   both.
2. **Targets:** may each client set its own (recommended, audited and kept
   per snapshot), or are the business's targets fixed for everyone?
3. **History follows the structure as it was** (recommended), or as it is now
   when units have moved.
4. **Reconstructed months before the release:** show them, marked
   (recommended), keep them hidden, or do not make them.
5. **Weekly figures** as well as monthly ones, for the pilot's first months.
6. **Who reads reports:** should the Approving authority role get
   `reports.view`? It reads every document but sees no incidents.
7. **Packs and free text:** confirm that packs carry no incident descriptions
   (recommended), only references, categories and counts.
8. **Signing a pack:** issued by a quality manager (recommended for now), or
   signed off by the committee chair through the approval engine.
9. **Arabic presentation:** the month names for the launch region, and
   whether charts run right to left in Arabic (recommended, as the layout
   does) or keep time left to right.
10. **The PDF renderer:** a headless browser in a separate worker
    (recommended), or another engine. It adds a component to every
    deployment, single-tenant and on-premises ones included.
11. **Three languages:** which two go side by side when a client works in
    three (recommended: the language that applies, and one the requester
    chooses).
12. **Denominators** (staff numbers, patient days, production hours) for
    rates: with the KPI module in Phase 3 (recommended), or sooner for the
    pilot.

## Decided by the business (28 November 2026)

Every recommendation in this spec is accepted. In particular:

- **Baseline for "more reports":** the client enters its figure from before
  Trustline; without one, the first three months in Trustline are the
  baseline.
- **Targets:** each client may set its own, starting from the business
  requirements' targets.
- **Committee pack:** carries no incident descriptions, and is signed by the
  committee chair when issued.
- Every other decision in "Decisions needed" follows the recommendation
  written there.

## Built (steps 1 to 3, 28 November 2026)

Steps 1 to 3 of "Order of build", with the decisions above. Not yet
reviewed: `security-reviewer` is due after steps 2 and 3.

### One definition per measure (step 1)

- `apps/api/src/reports/measures.ts` holds every measure:
  - its code, module, target, direction, unit and unit basis;
  - its definition version (1 for all);
  - the queries that count it: `incidentFigures` and `documentFigures`.
- `IncidentsService.summary()` and `LibraryService.summary()` call those
  queries. `MEASURES` is now exported from there.
- The test checks that the dashboard and the month so far give the same
  figures.
- `actions.overdue` is defined but not taken (`taken: false`) until the
  actions module exists.

### Snapshots (step 2)

- **The tables:**
  - `measure_snapshots` (migrations 0065 and 0066):
    - one row per month, measure, unit (null for the organization), unit
      basis and revision;
    - each unit row keeps the unit's path as it was when taken;
    - insert-only: `trustline_app` has SELECT and INSERT only, and a BEFORE
      UPDATE trigger refuses changes from anyone, the owner included
      (23514);
    - each row keeps the target in force when it was taken, with its source:
      `business`, `client`, `baseline` or `first_months`.
  - `report_settings` holds one row per client.
- **The month-end check:** `MeasureSnapshotCheck`
  (`reports/measure-snapshot.check.ts`), started by `main.ts`.
  - It runs every 15 minutes, takes clients one at a time, and keeps every
    statement under 30 seconds. Failures are logged by kind only.
  - For each module the client may use, it takes every month that has no
    figures. That runs from the start in `module_starts` (else the client's
    creation) up to the month just ended, on the client's own calendar.
  - Each module's month goes in one transaction, under an advisory lock and
    the unique key, so it is there whole and only once.
  - A month taken within 6 hours of its end is read as the records stand
    (`snapshot`). Later, and for the backfill, it is worked out from history
    (`reconstructed`):
    - a document is in force if published before the month's end and not
      retired then;
    - its next review date is the last one recorded in the audit trail
      before that moment;
    - the version in force is the last published before it;
    - a person counts as active by their recorded changes of status;
    - an acknowledgement counts if it was given before the month's end.
  - Each month is audited as `measures_snapshot_taken`.
- **Provisional and final:**
  - triage is provisional while any of the month's reports is undecided and
    still within its deadline;
  - a later run that finds it settled adds a final revision.
- **Corrections:**
  - `POST /reports/measures/corrections` works the month out again from the
    records as they are now, at the same month-end moment. Nobody can type a
    value in.
  - The result is a new `corrected` revision, with the reason and who asked.
  - It is audited as `measure_correction_requested`, with every value before
    and after.
- **Existing clients:** migration 0066 adds `reports.manage` to their
  built-in Administrator and Quality officer roles, with one
  `built_in_roles_changed_by_system` entry per client.

### The Reports API (step 3)

- **Routes:** `apps/api/src/reports/reports.controller.ts`, under
  `/reports`, with `@ForModule('core')`.
  - Every route checks `reports.view` first.
  - Routes: series with the month so far, a month's revisions, the CSV,
    corrections, and reading and changing the settings.
- **Scope:**
  - a unit outside the caller's `reports.view` reach, or in another
    hospital, is answered 404;
  - the organization row needs `reports.view` for the whole organization;
  - incident measures need `incidents.view` or `incidents.triage` over the
    unit, and document measures need `policies.manage` or
    `policies.view_all`;
  - the measures of a module the client lacks do not appear at all;
  - how reports arrived (`details.channel`: public, anonymous or named) is
    given only to those holding `incidents.see_reporter` over the unit.
- **`reports.manage` (core):** corrections, targets and the baseline,
  for the whole organization only.
  - Built-in roles: Administrator and Quality officer.
  - Targets start at the business requirements' figures, and each client may
    set its own.
  - The reporting-volume target comes from the baseline the client enters,
    or else from the average of its first three full months.
- **Audit:** five new actions, in the new `reports` area, with wording in
  all three languages:
  - `measures_snapshot_taken`;
  - `measure_correction_requested`;
  - `measures_recomputed_by_system`, kept for a later migration that
    recomputes;
  - `report_settings_changed`;
  - `measures_exported`.

### Not done here

- Step 6 (settings and corrections) was mostly brought forward into step 3:
  the API for targets, the baseline, `reports.manage` and corrections, with
  their audit entries. Its screens come with step 4.
- Not built:
  - `csv.ts` stays in `policies/` and is used from there;
  - the incident and document breakdown routes (step 5);
  - weekly figures (decision 5 has no recommendation).
- `reports.view` was not given to the Approving authority. Decision 6 has
  no recommendation, so it is still open.
- **Simplification:** whether a module counted for a past month is judged
  by whether the client has it now, and the month is on or after the
  module's start.
