# Reports API contract

> **CHANGED by security review 16 and the business's answers** (marked **[S16]** below):
> - **Approving authority:** now holds `reports.view` (migration 0067). It sees the two document measures only, and `GET /settings` gives it `baseline`, `firstMonthsBaseline` and `reportedTarget` as `null`.
> - **Unit queries:** `incidents.reported` has `target: null`, `targetSource: null` and `met: null`, in `months[]`, `current` and the CSV's Target columns. Show no target for it on a unit.
> - **`GET /settings`:**
>   - `baseline`, `firstMonthsBaseline` and `reportedTarget` are `null` unless the caller sees incident figures for the whole organization;
>   - `targets` lists only the measures of modules the client has.
> - **`details.channel`** may now be missing from a unit's month even for someone told reporters: when units moved into or out of that unit since. Show "not available for this month".
> - **History:** `reason` is `null` on a unit's revisions unless the caller reads reports for the whole organization.
> - **Corrections:**
>   - they keep the month's target, boundaries and structure;
>   - new 409 codes: `correction_in_progress` (another correction is being made, or the month is being made final; try again shortly) and `stale_measures` (a revision was added meanwhile; reload).
>   - The reason field should say "Do not include anyone's personal details."
> - **Months:** years before 2000 give 400.
> - **`PATCH /settings`:** two first changes at once give 409 `stale_settings` (previously 500).
> - **Weekly figures** wait (business decision).

All routes are under `/api/v1/reports`.
- **Session:** required; without one the answer is 401.
- **`reports.view`:** checked first on every route. Without it the answer is 403 `{code:'missing_permission', permission:'reports.view'}`.
- **Invalid input:** 400, with no body code unless one is listed below.
- **Suspended subscription:** reads stay open.

### Permission `reports.manage` (new, core)
- **What it covers:** corrections, targets and the baseline, and later the committee packs.
- **Where it counts:** only when given for the whole organization.
- **Who has it:** the built-in Administrator and Quality officer; existing clients got it by migration.
- **Labels needed in the web dictionaries**, under `admin.permissions["reports.manage"]`:
  - en: "Correct report figures, and set targets and the baseline"
  - ar: "تصحيح أرقام التقارير وتحديد الأهداف وخط الأساس"
  - fr: "Corriger les chiffres des rapports et fixer les objectifs et la référence"
- **Suggested hint**, under `permissionHints["reports.manage"]`: the same wording as the `audit.view` hint ("Counts only when given for the whole organization: a grant for one unit opens nothing.").
- **Sidebar:** the Reports item takes `permissions:["reports.view"]`.

### Measures

| code | module | unit | direction | business target |
|---|---|---|---|---|
| incidents.time_to_report | incidents | seconds (median) | below | 120 |
| incidents.reported | incidents | count | above | the baseline |
| incidents.triaged_on_time | incidents | % (whole) | at_least | 95 |
| policies.past_review | policies | % (1 decimal) | below | 5 |
| policies.acknowledged | policies | % (1 decimal) | at_least | 90 |

`actions.overdue` is defined but never returned yet.

Names, as used in the CSV:

| code | en | ar | fr |
|---|---|---|---|
| time_to_report | Time to submit a report (median seconds) | مدة تقديم البلاغ (الوسيط بالثواني) | Durée de déclaration (médiane en secondes) |
| reported | Reports submitted | البلاغات المقدَّمة | Déclarations envoyées |
| triaged_on_time | Triaged on time | الفرز في الموعد | Tri dans les délais |
| past_review | Documents past their review date | وثائق فات موعد مراجعتها | Documents dont la révision est dépassée |
| acknowledged | Acknowledgement completion | نسبة الإقرار بالاطلاع | Taux de prise de connaissance |

**`status`:**
- `provisional`: Provisional / مؤقت / Provisoire
- `final`: Final / نهائي / Définitif

**`method`:**
- `snapshot`: Taken at month end / مسجَّل في نهاية الشهر / Relevé en fin de mois
- `reconstructed`: Reconstructed from records / معاد بناؤه من السجلات / Reconstitué à partir des dossiers
- `corrected`: Corrected / مصحَّح / Corrigé

Rows marked `reconstructed` or `corrected` should be shown with a mark (decision 4).

**`targetSource`:**
- `business`
- `client`
- `baseline`: the figure the client entered
- `first_months`: the average of the first three full months
- `null`: no target yet

### Scope (every route with `unitId`)
- **No `unitId`:** the organization's figures. This needs `reports.view` for the whole organization, else 403 `missing_permission`. A department manager must always pass a unit.
- **A `unitId` the caller cannot use** (out of reach, unknown, or another hospital's): 404.
- **Incident measures** need `incidents.view` or `incidents.triage` over the unit.
- **Document measures** need `policies.manage` or `policies.view_all`.
- **Modules:** a module the client lacks returns none of its measures. Draw whatever comes back; do not hard-code the list.
- **Channel:** `details.channel` on `incidents.reported` appears only with `incidents.see_reporter` over the unit, and **[S16]** not on a unit's month when units moved into or out of it since.
- **Subtree:** a unit's figure counts the unit and everything under it.

### GET /reports/measures
Query (strict):
- `from`, `to`: `YYYY-MM`, in order, fewer than 120 months apart; **[S16]** years from 2000
- `unitId?`: uuid
- `measures?`: comma-separated codes

Response 200:
```
{ unitId, measures: [{ code, module, direction, valueUnit, definitionVersion,
    target, targetSource,               // in force now; [S16] null for incidents.reported on a unit
    months: [{ month:'YYYY-MM', value, numerator, denominator,
      target, targetSource,             // as when the month was taken, kept through corrections [S16]; null for incidents.reported on a unit
      met, status, method, revision, correctedAt, asAt, takenAt, definitionVersion, details }],
    current: { month, value, numerator, denominator, met, provisional, asOf, details } }] }
```
`months` holds only months that were taken, at their latest revision. Missing months are not filled with zeros.

What `details` holds, by measure:
- **`time_to_report`:** `{quickShare, withStartTime, reported}`. The numerator is reports made within 120 s; the denominator is reports with a start time.
- **`reported`:** `{byType, byHarm, byCategory, nearMissShare, channel?:{public, anonymous, named}}`. The denominator is null.
- **`triaged_on_time`:** `{pending}`. While `pending` is above 0 the month is provisional.
- **`policies.*`:** `{}`.

### GET /reports/measures/:code/history
- **Query:** `month` (`YYYY-MM`), `unitId?`.
- **Code unknown or not visible:** 404.
- **200:** `{code, month, unitId, revisions:[{revision, value, numerator, denominator, target, met, status, method, reason, requestedBy:{id, name}|null, asAt, takenAt, definitionVersion, details}]}`, oldest first.
- **[S16]** `reason` is `null` on a unit's revisions unless the caller reads reports for the whole organization.

### GET /reports/exports/measures
- **Query:** the same as `/measures`, plus `locale?`.
  - A locale the client does not work in gives 400 `{code:'language_mismatch'}`.
  - Without one, the file uses the client's default language.
- **File:** a UTF-8 CSV with a BOM, named `measures-<date>.csv`. Each row is one month of one measure.
- **Columns:** Month, Unit, Place in the structure, Measure, Value, Counted, Out of, Target, Target met, Status, How it was taken, Revision, As at, Definition version.
- **Audit:** `measures_exported`.

### POST /reports/measures/corrections
- **Permission:** `reports.manage` for the whole organization, else 403 with `permission:'reports.manage'`.
- **Body (strict):** `{month:'YYYY-MM', measures:[codes, 1 or more], unitId?:uuid, reason:string (1 to 1000)}`.
  - There is no value field: Trustline recomputes the month from the records as at the same month end.
  - Without `unitId`, the organization row and every unit row of the month are recomputed.
- **Answers:**
  - 201 `{month, revisions:[{measure, unitId, revision, from:{value, numerator, denominator}, to:{…}}]}`
  - 409 `{code:'no_snapshot'}` if the month was never taken
  - **[S16]** 409 `{code:'correction_in_progress'}`: another correction is being made for the client, or the month is being made final
  - **[S16]** 409 `{code:'stale_measures'}`: a revision was added meanwhile
- **[S16]** The month keeps its target, boundaries and structure; only the figures are worked out again. The reason field should say "Do not include anyone's personal details."
  - 404 for a measure or unit the caller cannot see
- **Audit:** `measure_correction_requested`.

### GET /reports/settings
- **Permission:** `reports.view` for the whole organization.
- **200:**
  ```
  {revision, targets:[{code, module, direction, business, client, effective}],  // every measure except reported
   baseline:{monthlyAverage, note:{en?, ar?, fr?}}|null, firstMonthsBaseline, reportedTarget:{value, source}|null}
  ```
- **[S16]** `baseline`, `firstMonthsBaseline` and `reportedTarget` are `null` unless the caller sees incident figures for the whole organization; `targets` lists only the measures of modules the client has.

### PATCH /reports/settings
- **Permission:** `reports.manage` for the whole organization.
- **Body (strict):** `{targets?:{[code]:number|null}, baseline?:{monthlyAverage:0 to 1,000,000, note:localized (500 max)}|null, revision}`.
  - At least one of `targets` and `baseline` must be present.
  - A null target goes back to the business target.
- **Target ranges:**
  - `time_to_report`: whole seconds, 1 to 3600
  - the others: 0 to 100
  - `incidents.reported` cannot be set (400); its target is the baseline
- **Answers:**
  - 200: the same body as GET; a body that changes nothing keeps the same revision
  - 409 `{code:'stale_settings'}`, **[S16]** also when two first changes are made at once
  - 400 `{code:'language_mismatch', field:'baseline.note'}`
- **Audit:** `report_settings_changed`, with from and to for each change.
- **New targets** apply to months taken from then on; earlier months keep theirs.

### New audit actions (area `reports`, en/ar/fr)
- `measures_snapshot_taken` (by the system)
- `measure_correction_requested`
- `report_settings_changed`
- `measures_exported`
- `measures_recomputed_by_system` (by a Trustline update)

They show through the audit API's `detailLines`, so the web needs no new strings for them.

## Step 5: incident breakdowns (added 28 November 2026)

`GET /api/v1/reports/incidents?from=YYYY-MM&to=YYYY-MM&by=<by>[&unitId=][&type=][&harmLevel=]`

- `by`: `month | type | harm | category | unit | channel`. `type`: `incident | near_miss | hazard`. `harmLevel`: `none | mild | moderate | severe | death`. Blank values count as unset. Anything else is 400.
- Refusals:
  - 401 without a session;
  - 403 `{ code: 'missing_permission', permission: 'reports.view' }`;
  - 403 `permission: 'incidents.view'` without incident reach over the scope (the Approving authority gets this);
  - 403 `permission: 'incidents.see_reporter'` for `by=channel` without it over the scope;
  - 404 for a unit out of reach, of another client, or a client without the incidents module.
- Answer:
  ```
  { unitId, from, to, by, type, harmLevel, total, median, currentMonth: 'YYYY-MM', asOf,
    rows: [{ key, count, share, runningShare?, partial?, name?, code?, here? }] }
  ```
  - `share` and `runningShare` are percentages with one decimal, or null when `total` is 0.
  - `month`: every month from `from` up to the current month, zeros included. `partial: true` marks the month so far. `median` is the median of the whole months, for the run chart's centre line, else null.
  - `type` and `harm`: every value in the order above, zeros included.
  - `category`: only the categories reported, most first, with `code`, `name` (Localized, show it with `pick()`) and `runningShare`, for the Pareto chart.
  - `unit`: each unit directly beneath the scope (the top units for the organization) with `name`, counting everything under it, most first. With a unit, a last row `{ key: unitId, here: true }` holds the reports made at the unit itself.
  - `channel`: `public` (public link), `anonymous` (in the app, without a name) and `named`. Each report is counted once.
- Counts come from the records as they are now (classification after triage, today's structure), the month so far included.

`GET /api/v1/reports/exports/incidents?…same…[&locale=]`: a CSV file named `incidents-by-<by>-<day>.csv`. It has the same refusals, plus 400 `language_mismatch` for a language the client does not work in.
- Columns: unit, place in the structure, from, to, type shown, harm level shown, the breakdown's own heading, reports, share (%), running share (%), month so far.
- Audit action `incident_figures_exported`, with filters, locale and rows. **Web:** the audit action labels in `apps/web/src/lib/audit.ts` and the three dictionaries need `incident_figures_exported`:
  - en "Incident figures exported (CSV)"
  - ar "تصدير أرقام الحوادث (CSV)"
  - fr "Exportation des chiffres des incidents (CSV)"
