# Risk management API, steps 1 to 7: contract for the web app

Branch `risk-management-api` (worktree `.claude/worktrees/agent-a134bec58094aa0f6`).
Spec: `docs/specs/risk-management.md` ("Built: steps 1 and 2, API" and
"Built: steps 3 to 5, API, and security review 15"); `docs/specs/actions.md`.

Everything is under `/api/v1/risks`, module `risks` (`@ForModule('risks')`).
For a client without the module every route answers **404 exactly as an
unknown route** (`{ message: "Cannot GET /risks", error: "Not Found", statusCode: 404 }`).
Without a session: **401**. While the subscription is **suspended**, every
write answers **403 `subscription_suspended`** except safety work: a
current rating of a risk on the register (`POST /risks/:id/ratings`,
`kind: "current"`), escalating (`POST /risks/:id/escalate`) and completing
an action (`POST /risks/actions/:id/complete`). `moves` says so.

## Conventions

- Bodies are strict: an unknown field, a wrong type or a control character
  is **400 with no `code`**. Show a generic "check the form" message.
- Errors the screens word specifically carry `body.code` (table at the end).
- **404** for anything the caller may not see, or of another client, and for
  an id that is not a uuid. Never 403 for a record out of reach.
- **403 `{ code: "missing_permission", permission }`**: the caller sees the
  record (or the route) but may not do this.
- Every change takes the **`revision`** the screen read and answers 409
  `stale_*` if it moved on. After a 409, reload and show "This changed while
  you were looking at it".
- Client text is `Localized` = `{ en?, ar?, fr? }`. Show it with `pick()`.
  - **Names** (titles, labels, band names, category and committee names):
    must include the client's default language, and use no language the
    client has not switched on (400 `language_mismatch`).
  - **Wording** (cause, event, consequence, descriptors, rationales,
    appetite statements, control descriptions): any of the client's
    languages, not necessarily the default. Show a plain note when the
    reader's language is missing (`risks.text.notInYourLanguage`).
- Days are `YYYY-MM-DD` on the client's calendar (`session.tenant.timeZone`).
  Moments are ISO timestamps.
- Name maps: `people`, `units`, `categories` and `committees` are
  `{ [id]: Localized }`, named as they are now (people who left and units
  switched off included). A unit id of `null` means **the whole organization**
  (`risks.wholeOrganization`).

### Types

```ts
type Band = 'low' | 'medium' | 'high' | 'extreme';           // rising order
type Rating = { likelihood: number; impact: number; score: number; band: Band };
type RatingInput = { likelihood: number; impact: number; rationale?: Localized | null };
type Standing = 'within' | 'above_treated' | 'above_not_addressed';  // 'accepted' comes with step 6
type RiskStatus = 'proposed' | 'open' | 'closed' | 'rejected';
type Move = 'edit' | 'rate' | 'add_control' | 'review' | 'add_action' | 'escalate' | 'de_escalate'
  | 'correct' | 'accept_proposal' | 'reject_proposal';
type ActionMove = 'edit' | 'complete' | 'verify' | 'cancel' | 'reopen';
```

**Band tones are fixed by the code, never by the client** (spec, "Colours of
the bands"): `low` → `neutral`, `medium` → `warn`, `high` → `danger`,
`extreme` → `alert` with the warning icon. Always show the band's **name**
(`pick(band.name)` from the matrix, which the client may rename) and the
score where there is room: "High · 12". Never colour alone.

## Who may do what

| | Read | Write |
|---|---|---|
| Settings, matrix in use, categories, committees | anyone signed in with the module (`GET /risks/settings`, `GET /risks/settings/categories`, `GET /risks/settings/committees`) | `risks.manage` **for the whole organization** |
| Matrix versions (`/settings/matrices`), `/roles`, `/people` | `risks.manage` anywhere | as above |
| A risk | `risks.view` or `risks.manage` covering its unit (a risk of the whole organization: a grant for the whole organization); its **owner**; a member of the committee it is escalated to | see `moves` |
| A proposed or rejected risk | its managers and the person who raised it only | managers |
| A closed risk | `risks.view` / `risks.manage` over its unit only | (step 6) |

The menu item "Risk settings" is for `session.scope['risks.manage'] === 'all'`;
"Register" for anyone with any `risks.*` permission, or anyone at all (owners
may hold none: an empty list is a valid answer). The API is the protection.

## Settings (step 1)

### `GET /risks/settings`

Anyone signed in with the module. Answers:

```ts
{
  inherentRequired: boolean;               // default true
  frameworkDocumentId: string | null;
  frameworkDocument: { id; restricted: boolean; number: string | null; status: 'draft'|'active'|'retired' | null; title: Localized | null } | null;
                                            // null while the policies module is off; title null if the reader may not open it;
                                            // a restricted one they may not open: { restricted: true, number: null, status: null, title: null }
  assessmentThresholdBand: Band;           // 'high' (used from step 10)
  acceptanceMaxMonths: number;             // 12 (used from step 6)
  revision: number;
  matrix: Matrix | null;                   // the version in use
  categories: Category[];                  // active only, by position
  committees: Committee[];                 // active only, by position
}

type Level = { level: number; label: Localized; descriptor: Localized | null; frequency: Localized | null }; // frequency: likelihood only
type Domain = { id; name: Localized; descriptors: { [level: '1'..'6']: Localized }; position: number; active: boolean };
type MatrixBand = { code: Band; name: Localized; reviewIntervalDays: number; escalateToCommitteeId: string | null; acceptanceNeedsSignature: boolean };
type Matrix = {
  id; version: number; status: 'draft' | 'in_use' | 'retired';
  likelihoodLevels: number; impactLevels: number;   // 3..6 each; 5×5 by default
  putInUseAt: string | null; putInUseBy: string | null; revision: number;
  likelihood: Level[]; impact: Level[];             // level 1 first
  domains: Domain[];                                // by position; show active ones in the rating dialog
  bands: MatrixBand[];                              // always the four, low first
  cells: { likelihood: number; impact: number; band: Band }[];
};
type Category = { id; code; name: Localized; position; active; appetite: 'averse'|'minimal'|'cautious'|'open'|'eager';
                  appetiteStatement: Localized | null; toleranceBand: Band; revision };
type Committee = { id; code; name: Localized; position; memberRoleId: string | null; chairRoleId: string | null; active; revision };
```

The settings page warns for a committee with `memberRoleId: null`
(`risks.settings.committeeNoRole`), and asks for the framework document while
`frameworkDocumentId` is null and the policies module is on.

### `PATCH /risks/settings` (whole-organization manager)

Body `{ revision, inherentRequired?, frameworkDocumentId?: uuid | null, assessmentThresholdBand?, acceptanceMaxMonths?: 1..12 }`.
Answers the settings (without `matrix`, `categories`, `committees`).
400 `unknown_document` (not a document in force of the library that the
caller may read, or the policies module off); 409 `stale_settings`.

### Matrix versions (whole-organization manager to write; `risks.manage` to read)

- `GET /risks/settings/matrices` → `MatrixHead[]` (newest version first:
  `{ id, version, status, likelihoodLevels, impactLevels, putInUseAt, putInUseBy, revision }`).
- `GET /risks/settings/matrices/:id` → `Matrix & { preview: null | { risksChangingBand: number; risksOutOfRange: number; risksTargetAboveCurrent: number } }`.
  `preview` is given for a draft, **to managers for the whole organization
  only** (others get `null`): how many open and proposed risks would change
  band, how many have a rating the draft cannot hold (a level beyond its
  size) and would need re-rating, and how many would have their target above
  their current rating. Show it in the "put in use" confirmation (ask once).
- `POST /risks/settings/matrices` → 201 `Matrix` (a draft). Body either
  `{ copyOf: matrixId }` (same size, wording, bands and cells) or a whole
  matrix:
  ```ts
  { likelihoodLevels: 3..6, impactLevels: 3..6,
    levels: { axis: 'likelihood'|'impact'; level; label; descriptor?; frequency? }[],  // every level of both axes
    domains: { name; descriptors: { '1': Localized, ... }; position?; active? }[],     // 1..12
    bands: { code; name; reviewIntervalDays: 1..730; escalateToCommitteeId: uuid | null; acceptanceNeedsSignature }[], // the four
    cells: { likelihood; impact; band }[] }                                             // every cell
  ```
  To change the size, make a new draft of the size wanted (pre-fill it from
  the version in use). 409 `draft_exists` (one draft at a time).
- `PATCH /risks/settings/matrices/:id` → `Matrix`. Body
  `{ revision, levels?, domains?, bands?, cells? }`, each part partial:
  levels by `axis`+`level` (send a level whole: label, descriptor and
  frequency; one left out is cleared), domains by `id` (send a domain whole:
  name, descriptors, position, active; without `id` it is a new domain; to
  switch one off send `active: false`), bands by `code` (any of their
  fields), cells by place. A level, domain, band or cell not sent stays.
  - **In use:** wording only (labels, descriptors, frequencies, band names,
    domains), applied at once. Anything that decides a band (cells, review
    intervals, escalation, signature, size) is 409 `matrix_in_use`: offer
    "Make a new version".
  - **Draft:** anything but the size (409 `matrix_size_fixed`).
  - **Retired:** 409 `matrix_retired`.
- `POST /risks/settings/matrices/:id/put-in-use` `{ revision }` → 200
  `Matrix & { risksRebanded: number; risksOutOfRange: number; risksTargetAboveCurrent: number }`. The version
  in use is retired; open and proposed risks move to the new version's cells
  at once (their timelines get a `rebanded` entry; earlier ratings keep the
  band they had). A risk whose rating the new version cannot hold keeps it on
  the old version and shows `rerateNeeded: true`. 409 `not_draft`, `stale_matrix`.
- `POST /risks/settings/matrices/:id/discard` `{ revision }` → 200 the head,
  `status: 'retired'`. Draft only (409 `not_draft`).

Whole matrices are checked (400): `matrix_incomplete`, `level_out_of_range`,
`frequency_of_impact`, `bands_out_of_order` (a cell's band is lower than a
cell with lower or equal likelihood and impact), `signature_required`
(acceptance of High and Extreme is always signed), `unknown_committee`,
`unknown_domain`, `language_mismatch`, `too_many_domains` (with `max: 12`,
switched-off ones included). The four bands are always all four, never
added or removed.

### Categories and committees

- `GET /risks/settings/categories?includeInactive=true|false` → `Category[]`
  (`includeInactive` needs `risks.manage`, else 403).
- `POST /risks/settings/categories` (whole-organization manager) → 201.
  Body `{ code: /^[a-z][a-z0-9_]{1,39}$/, name, position?, appetite, appetiteStatement?, toleranceBand }`.
  409 `code_taken`.
- `PATCH /risks/settings/categories/:id` → the category. Body
  `{ revision, name?, position?, active?, appetite?, appetiteStatement?, toleranceBand? }`.
  409 `stale_category`. Where risks stand against tolerance follows at once.
- `GET /risks/settings/committees?includeInactive=` → `Committee[]`.
- `POST /risks/settings/committees` → 201. Body
  `{ code, name, position?, memberRoleId?: uuid|null, chairRoleId?: uuid|null }`.
  400 `unknown_role`; 409 `code_taken`.
- `PATCH /risks/settings/committees/:id` → the committee. Body
  `{ revision, name?, position?, memberRoleId?, chairRoleId?, active? }`.
  409 `stale_committee`, `committee_in_use` (a band of the version in use or
  of the draft escalates to it).

Members of a committee are the active holders of its member (or chair) role
**granted for the whole organization**.

### Pickers (`risks.manage`)

- `GET /risks/roles` → `{ id, code, name: Localized, isSystem }[]`.
- `GET /risks/people?q=` → `{ id, name: Localized, orgUnitId }[]`, active
  people, at most 50.

## The register (step 2)

### `GET /risks`

Anyone signed in with the module; filtered by who may read each risk. Query
(all optional; blank = unset; filters belong in the address):

| Param | Values |
|---|---|
| `q` | reference, title, cause, event, consequence, keywords, any language |
| `unitId` | a unit id (with every unit beneath it), or `whole` for the risks of the whole organization |
| `categoryId`, `ownerId`, `committeeId` | ids |
| `band` | the current band |
| `status` | `proposed`, `open`, `closed`, `rejected`; none: open and proposed |
| `mine` | `true`: owned by me |
| `aboveTolerance`, `notAddressed` | `true` (the same set until steps 4 and 6) |
| `review` | `due` (within 30 days), `overdue` |
| `sort` | `score` (default, highest first), `next_review`, `reference`, `updated` |
| `page`, `pageSize` | 1.., 1..100 (20) |

Answers `{ items: RiskSummary[], total, people, units, categories, committees }`:

```ts
type RiskSummary = {
  id; reference;                 // RSK-2026-00012
  title: Localized; orgUnitId: string | null; categoryId; ownerId; status: RiskStatus;
  inherent: Rating | null; current: Rating | null; target: Rating | null;
  tolerance: Band;               // the category's
  standing: Standing | null;     // null: no current rating yet
  trend: 'up' | 'down' | null;   // since the last review (or the rating before, with none)
  nextReviewOn: string | null;
  review: 'due' | 'overdue' | null;   // open risks only
  escalatedToCommitteeId: string | null;
  rerateNeeded: boolean;         // a rating is on a version no longer in use
  targetAboveCurrent: boolean;   // a new matrix version left the target above: rate the target again
  lastReviewedOn: string | null;
  actions: { open: number; overdue: number };
  updatedAt: string;
};
```

### `GET /risks/:id`

A reader of it; 404 otherwise. To someone who reads it only as the owner
of one of its actions: `{ access: 'summary', id, reference, title, status,
current: Rating | null, moves: [], actions: Action[] /* theirs only */ }`.
Otherwise `access: 'full'`, `RiskSummary` plus:

```ts
{
  cause: Localized; event: Localized; consequence: Localized;
  source: 'manual' | 'incident' | 'assessment' | 'investigation' | 'ai_suggestion';
  treatment: 'reduce' | 'avoid' | 'share' | 'accept' | null; targetOn: string | null;
  references: string[]; keywords: string[];
  lastReviewedOn: string | null; escalatedAt: string | null;
  highestBand: Band | null; closureSignOffNeeded: boolean;   // only ever rise
  currentAboveInherent: boolean;      // show the warning risks.rating.currentAboveInherent
  rejectedBy; rejectedAt; rejectReason;                       // rejected proposals
  createdBy; createdAt;
  matrixId: string | null;            // the version in use: rate against it (from GET /risks/settings)
  revision: number;
  moves: Move[];
  ratings: { id; kind: 'inherent'|'current'|'target'; likelihood; impact; score; band; matrixId;
             rationale: Localized | null; ratedBy; ratedAt; reviewId: string | null }[];   // newest first, every rating ever made
  reviews: { id; dueOn: string | null; reviewedOn; reviewedBy; committeeId: string | null;
             outcome: 'no_change'|'re_rated'|'treatment_changed'|'closure_proposed'; comment: string;
             nextReviewOn; late: boolean; createdAt }[];               // newest first
  actions: Action[];                  // oldest first, as the caller sees each
  actionSummary: { open: number; overdue: number; allWeaker: boolean };  // allWeaker: the strength check
  controls: Control[];                // active first
  events: { id; kind: EventKind; actorId: string | null; occurredAt; details }[];  // oldest first
  people; units; categories; committees;
}
type Control = { id; description: Localized; kind: 'preventive'|'detective'|'mitigating';
  hierarchy: 'elimination'|'substitution'|'engineering'|'administrative'|'protective_equipment' | null;
  ownerId; effectiveness: 'not_assessed'|'effective'|'partly_effective'|'ineffective'; assessedOn: string | null;
  documentId: string | null;
  document: { id; restricted: boolean; number: string | null; status: string | null; version: number | null;
              nextReviewOn: string | null; pastReview: boolean; title: Localized | null } | null;
                                       // null while the policies module is off; title null if the reader may not open it;
                                       // a restricted document the reader may not open shows only as
                                       // { restricted: true, number: null, status: null, ... }: "a restricted document" 
  active: boolean; inactiveReason: string | null; createdBy; createdAt; updatedAt; revision };
```

Timeline `details` by `kind` (ids are named by the maps):

| kind | details |
|---|---|
Text people write never appears in a timeline entry (security review 15,
M1): a changed text field is `{ changed: true }`, a reason is
`reasonGiven: true`. Word them "Cause changed", "with a reason".

| `created` | `{ status, source, ratings: { inherent?, current?, target?: Rating } }` |
| `updated` | `{ [field]: { from, to } \| { changed: true }, reasonGiven? }`: ids, days and choices from and to (`orgUnitId`, `categoryId`, `ownerId`, `treatment`, `targetOn`); text as `{ changed: true }` (`title`, `cause`, `event`, `consequence`, `references`, `keywords`) |
| `rated` | `{ kind, from: Rating \| null, to: Rating, matrixId, nextReviewOn? }` |
| `control_added` | `{ controlId, kind, hierarchy, ownerId, effectiveness, assessedOn, documentId }` |
| `control_updated` | `{ controlId, [field]: { from, to } \| { changed: true }, reasonGiven? }` |
| `proposal_accepted` | `{ ownerId: id \| { from, to }, ratings, nextReviewOn }` |
| `proposal_rejected` | `{ reasonGiven: true }` (the reason is `rejectReason` on the risk) |
| `rebanded` | `{ matrixId, version, bands: { [kind]: { from, to } }, outOfRange: kind[], targetAboveCurrent: boolean }` (actor: who put the version in use) |
| `reviewed` | `{ reviewId, outcome, late, dueOn, nextReviewOn, committeeId, current: { from, to }, target?: { from, to }, controls?: [{ controlId, from, to }], treatment?, targetOn? }` |
| `escalated` | `{ committeeId, from: committeeId \| null, automatic: boolean, band, reasonGiven? }` (automatic: "escalated automatically by its rating") |
| `de_escalated` | `{ committeeId, band, reasonGiven: true }` |
| `text_corrected` | `{ kind: 'rating_rationale' \| 'review_comment' \| 'reject_reason' \| 'control_reason', ratingId?, reviewId?, controlId? }` |

### Moves

The screen offers exactly `moves`; it keeps no copy of the rules.

| Move | Who | Route |
|---|---|---|
| `edit` | a manager (`risks.manage` over its unit) | `PATCH /risks/:id` |
| `rate` | its owner (open risk) or a manager | `POST /risks/:id/ratings` |
| `add_control` | as `rate`; also governs editing and switching off controls | `POST /risks/:id/controls`, `PATCH /risks/:id/controls/:controlId` |
| `review` | its owner, a manager, or a member of its committee (send `committeeId`) | `POST /risks/:id/reviews` |
| `add_action` | its owner or a manager | `POST /risks/:id/actions` |
| `escalate` | a manager | `POST /risks/:id/escalate` |
| `de_escalate` | a member of its committee, or a manager for the whole organization, once its band is below the threshold | `POST /risks/:id/de-escalate` |
| `correct` | a manager | `POST /risks/:id/corrections` |
| `accept_proposal` | a manager other than the one who raised it | `POST /risks/:id/proposal/accept` |
| `reject_proposal` | a manager | `POST /risks/:id/proposal/reject` |

While suspended `moves` is at most `['rate', 'escalate']`, and `rate` means
the **current** rating only.

### `POST /risks` (`risks.manage` over `orgUnitId`; null: for the whole organization)

```ts
{ orgUnitId: uuid | null; categoryId; title: Localized; cause: Localized; event: Localized; consequence: Localized;
  ownerId; references?: string[]; keywords?: string[];
  treatment?: 'reduce'|'avoid'|'share'|'accept' | null; targetOn?: day | null;
  current?: RatingInput; inherent?: RatingInput; target?: RatingInput }
```

201 the risk (as `GET /risks/:id`): `open` with a current rating, `proposed`
without one. Opening needs: an inherent rating while `inherentRequired`
(400 `inherent_required`); a target when the current band is above the
category's tolerance (400 `target_required`); a target never above the
current rating (400 `target_above_current`); levels within the matrix (400
`level_out_of_range`). Also 400 `unknown_unit`, `unknown_category`,
`unknown_owner` (an active person of the client), `language_mismatch`; 403
without `risks.manage` over the unit. The form shows the warning
`risks.form.noPersonalDetails`. `fromIncidentId` and `linkKind` come with
step 7.

### `PATCH /risks/:id` (a manager)

`{ revision, reason?, title?, cause?, event?, consequence?, orgUnitId?, categoryId?, ownerId?, references?, keywords?, treatment?, targetOn? }`
→ the risk. 400 `reason_required` (owner, unit or category changed);
403 moving it to a unit the caller does not manage; 409 `stale_risk`,
`not_editable` (closed or rejected).

### `POST /risks/:id/ratings` (owner or manager)

`{ revision, kind: 'inherent'|'current'|'target', likelihood, impact, rationale? }` → 200 the risk.
400 `level_out_of_range`, `target_above_current` (a target above the current
rating, **or a current rating below the stored target**: rate the target
first); 409 `stale_risk`, `not_editable`; 403 `subscription_suspended` while
suspended for anything but a current rating of a risk on the register. A current rating into a band with a shorter review interval
brings `nextReviewOn` forward. A current rating above the inherent one is
accepted (`currentAboveInherent` then shows the warning).

### Controls (owner or manager)

- `POST /risks/:id/controls` → 201 `Control & { riskRevision }`. Body
  `{ revision /* the risk's */, description, kind, hierarchy?, ownerId, effectiveness?, assessedOn?, documentId? }`.
- `PATCH /risks/:id/controls/:controlId` → `Control & { riskRevision }`. Body
  `{ revision /* the control's */, description?, kind?, hierarchy?, ownerId?, effectiveness?, assessedOn?, documentId?, active?, reason? }`.
  Switching off needs `reason` (400 `reason_required`). A new effectiveness
  without `assessedOn` is assessed today. 409 `stale_control`.
- 400 `unknown_document` (not a document in force, or the policies module
  off), `unknown_owner`, `assessed_in_future`. Both raise the risk's
  revision: use `riskRevision` for the next change to the risk.

### Proposals (a manager)

- `POST /risks/:id/proposal/accept` `{ revision, ownerId, current, inherent?, target? }` → 200 the risk, `open`.
  Same rating rules as creating; 409 `not_proposed`; 403 `same_person` for
  the manager who raised it (offer it to another manager).
- `POST /risks/:id/proposal/reject` `{ revision, reason }` → 200 the risk, `rejected`.

## Error codes

| Status | `code` | Where |
|---|---|---|
| 400 | (none) | anything the body or query does not take |
| 400 | `language_mismatch` | text not in the client's languages, or a name without the default language |
| 400 | `unknown_document`, `unknown_matrix`, `unknown_committee`, `unknown_domain`, `unknown_role`, `unknown_unit`, `unknown_category`, `unknown_owner` | what the body names does not exist here (or is switched off) |
| 400 | `matrix_incomplete`, `level_out_of_range`, `frequency_of_impact`, `bands_out_of_order`, `signature_required` | the matrix |
| 400 | `inherent_required`, `target_required`, `target_above_current` | ratings |
| 400 | `reason_required`, `assessed_in_future` | risk and control changes |
| 400 | `outcome_mismatch`, `review_interval_too_long` (with `latest`), `review_day_past`, `unknown_control` | reviews |
| 400 | `due_in_past`, `unknown_unit`, `unknown_owner` | actions |
| 400 | `too_many_domains` (with `max`) | the matrix |
| 403 | `same_person` | accepting one's own proposal; checking one's own action |
| 403 | `not_a_member` | a committee's review by someone who is not a member of the risk's committee |
| 403 | `missing_permission` (with `permission`) | not allowed |
| 403 | `subscription_suspended` | suspended client |
| 409 | `stale_settings`, `stale_matrix`, `stale_category`, `stale_committee`, `stale_risk`, `stale_control` | revision moved on |
| 409 | `draft_exists`, `matrix_size_fixed`, `matrix_in_use`, `matrix_retired`, `not_draft`, `no_matrix` | matrix versions |
| 409 | `code_taken`, `committee_in_use` | settings |
| 409 | `not_editable`, `not_proposed`, `not_on_register` | the risk's status |
| 409 | `already_escalated`, `not_escalated`, `still_above_threshold` | escalation |
| 409 | `stale_action`, `action_not_open`, `action_not_completed`, `action_open`, `nothing_to_correct` | actions and corrections |

## Wording keys the web needs

All under `risks.*` in `apps/web/src/i18n/dictionaries/{en,ar,fr}.json`, same
keys in every file. Suggested text below; the `bilingual-reviewer` settles
it (terms from the spec's table are used as given there).

### Already added on this branch

`admin.permissions` (the `permissions` map next to `policies.import`):

| key | en | ar | fr |
|---|---|---|---|
| `risks.view` | View the risk register | الاطلاع على سجل المخاطر | Consulter le registre des risques |
| `risks.manage` | Manage risks, and for the whole organization the risk settings | إدارة المخاطر، وإعدادات المخاطر على مستوى الجهة كلها | Gérer les risques et, pour toute l’organisation, les paramètres des risques |
| `risks.approve` | Sign the acceptance or closure of risks when named in a step of a route | التوقيع على قبول المخاطر أو إغلاقها عند التسمية في خطوة من مسار | Signer l’acceptation ou la clôture de risques lorsqu’on est désigné dans une étape d’un circuit |

### Enumerations (keys = API values)

| key | en | ar | fr |
|---|---|---|---|
| `risks.status.proposed` | Proposed | مقترح | Proposé |
| `risks.status.open` | On the register | مُدرج في السجل | Inscrit au registre |
| `risks.status.closed` | Closed | مغلق | Clos |
| `risks.status.rejected` | Not taken onto the register | غير مُدرج | Non retenu |
| `risks.source.manual` | Written by a manager | كتبه مدير | Saisi par un responsable |
| `risks.source.incident` | Raised from an incident | ناشئ عن حادث | Issu d’un incident |
| `risks.source.assessment` | Raised from an assessment | ناشئ عن تقييم | Issu d’une évaluation |
| `risks.source.investigation` | Raised from an investigation | ناشئ عن تحقيق | Issu d’une enquête |
| `risks.source.ai_suggestion` | From a suggestion of the assistant | من اقتراح المساعد | Suggestion de l’assistant |
| `risks.treatment.reduce` | Reduce | خفض | Réduire |
| `risks.treatment.avoid` | Avoid | تجنّب | Éviter |
| `risks.treatment.share` | Share | مشاركة | Partager |
| `risks.treatment.accept` | Accept | قبول | Accepter |
| `risks.ratingKind.inherent` | Inherent rating | التقييم الكامن | Niveau de risque brut |
| `risks.ratingKind.current` | Current rating | التقييم الحالي | Niveau de risque actuel |
| `risks.ratingKind.target` | Target rating | التقييم المستهدف | Niveau de risque cible |
| `risks.axis.likelihood` | Likelihood | الاحتمالية | Vraisemblance |
| `risks.axis.impact` | Impact | الأثر | Impact |
| `risks.appetite.averse` | Averse | تجنّب | Aversion |
| `risks.appetite.minimal` | Minimal | حدّ أدنى | Minimale |
| `risks.appetite.cautious` | Cautious | حذر | Prudente |
| `risks.appetite.open` | Open | انفتاح | Ouverte |
| `risks.appetite.eager` | Eager | إقبال | Forte |
| `risks.standing.within` | Within tolerance | ضمن حدّ التحمّل | Dans la tolérance |
| `risks.standing.above_not_addressed` | Above tolerance, not addressed | فوق حدّ التحمّل، دون معالجة | Au-delà de la tolérance, non traité |
| `risks.standing.above_treated` *(step 4)* | Above tolerance, being treated | فوق حدّ التحمّل، قيد المعالجة | Au-delà de la tolérance, en cours de traitement |
| `risks.standing.above_accepted` *(step 6)* | Accepted until {day} | مقبول حتى {day} | Accepté jusqu’au {day} |
| `risks.review.due` | Review due | المراجعة مستحقة | Revue à faire |
| `risks.review.overdue` | Review overdue | المراجعة متأخرة | Revue en retard |
| `risks.trend.up` | Up since the last rating | ارتفع منذ التقييم السابق | En hausse depuis l’évaluation précédente |
| `risks.trend.down` | Down since the last rating | انخفض منذ التقييم السابق | En baisse depuis l’évaluation précédente |
| `risks.control.kind.preventive` | Preventive | وقائي | Préventif |
| `risks.control.kind.detective` | Detective | كاشف | De détection |
| `risks.control.kind.mitigating` | Mitigating | مخفّف | D’atténuation |
| `risks.control.hierarchy.elimination` | Elimination | الإزالة | Suppression |
| `risks.control.hierarchy.substitution` | Substitution | الاستبدال | Substitution |
| `risks.control.hierarchy.engineering` | Engineering controls | الضوابط الهندسية | Mesures techniques |
| `risks.control.hierarchy.administrative` | Administrative controls | الضوابط الإدارية | Mesures organisationnelles |
| `risks.control.hierarchy.protective_equipment` | Protective equipment | معدات الوقاية | Équipements de protection |
| `risks.control.effectiveness.not_assessed` | Not assessed | لم يُقيَّم | Non évalué |
| `risks.control.effectiveness.effective` | Effective | فعّال | Efficace |
| `risks.control.effectiveness.partly_effective` | Partly effective | فعّال جزئيًا | Partiellement efficace |
| `risks.control.effectiveness.ineffective` | Ineffective | غير فعّال | Inefficace |
| `risks.matrixStatus.draft` | Draft | مسودة | Brouillon |
| `risks.matrixStatus.in_use` | In use | قيد الاستخدام | En service |
| `risks.matrixStatus.retired` | Retired | متوقف | Retiré |
| `risks.moves.edit` | Edit | تعديل | Modifier |
| `risks.moves.rate` | Rate | تقييم | Évaluer |
| `risks.moves.add_control` | Add a control | إضافة ضابط رقابي | Ajouter un moyen de maîtrise |
| `risks.moves.accept_proposal` | Take onto the register | إدراج في السجل | Inscrire au registre |
| `risks.moves.reject_proposal` | Do not take onto the register | عدم الإدراج في السجل | Ne pas retenir |

### Timeline (`risks.events.<kind>`)

| key | en |
|---|---|
| `created` | Risk added |
| `updated` | Details changed |
| `rated` | {kind} rated: {band} · {score} |
| `control_added` | Control added |
| `control_updated` | Control changed |
| `proposal_accepted` | Taken onto the register |
| `proposal_rejected` | Not taken onto the register: {reason} |
| `rebanded` | Re-banded by version {version} of the matrix |

### Screens and messages

| key | en |
|---|---|
| `risks.title` | Risk register |
| `risks.wholeOrganization` | Whole organization |
| `risks.form.noPersonalDetails` | Describe the situation, not a person. Do not write names or details that identify a person served or a member of staff. |
| `risks.form.cause` / `.event` / `.consequence` | Cause / Event / Consequence |
| `risks.form.reason` | Why (required to change the owner, the unit or the category) |
| `risks.rating.currentAboveInherent` | The current rating is above the inherent rating. Check the inherent rating. |
| `risks.rating.rerateNeeded` | Rated on an earlier version of the matrix. Rate it again. |
| `risks.rating.domainsHint` | Read the domains that apply and take the highest level. |
| `risks.text.notInYourLanguage` | Not written in your language. |
| `risks.settings.committeeNoRole` | No role is set for this committee yet. Until one is, its notices go to whoever manages risks for the whole organization. |
| `risks.settings.frameworkMissing` | Link the document that is your risk management policy or framework. |
| `risks.settings.putInUseConfirm` | {changing} risks will change band and {outOfRange} will need rating again. Put this version in use? |
| `risks.settings.newVersionNeeded` | This changes how risks are banded. Make a new version of the matrix. |
| `risks.errors.<code>` | one message per code in the table above |

### The audit trail (`audit.actions.<action>`, beside the other actions)

Registered in `apps/api/src/audit/actions.ts`, worded in
`apps/api/src/audit/wording/{en,ar,fr}.ts` (copy the text from there):
`risk_created`, `risk_updated`, `risk_proposal_accepted`,
`risk_proposal_rejected`, `risk_rated`, `risk_control_added`,
`risk_control_updated`, `risk_settings_changed`, `risk_matrix_created`,
`risk_matrix_changed`, `risk_matrix_discarded`, `risk_matrix_put_in_use`,
`risk_category_created`, `risk_category_updated`, `risk_committee_created`,
`risk_committee_updated`, `risk_defaults_created_by_system`. New area
`risks`; entity types `risk`, `risk_matrix`, `risk_category`,
`risk_committee`.

## The starting settings (client data, shown with `pick()`)

Not dictionary keys: they are stored per client in three languages and the
client may change them. Listed so that the screens and their tests know them.

**Likelihood** (label, frequency):
1 Rare / نادر / Rare, "Less than once in five years";
2 Unlikely / غير مرجّح / Peu probable, "Once in two to five years";
3 Possible / ممكن / Possible, "About once a year";
4 Likely / مرجّح / Probable, "Several times a year";
5 Almost certain / شبه مؤكد / Quasi certain, "Monthly or more often".

**Impact:** 1 Negligible / ضئيل / Négligeable; 2 Minor / طفيف / Mineur;
3 Moderate / معتدل / Modéré; 4 Major / كبير / Majeur;
5 Catastrophic / كارثي / Catastrophique.

**Impact domains:** Safety of people / سلامة الأشخاص / Sécurité des personnes;
Service and operations / الخدمة والعمليات / Service et activités;
Compliance / الامتثال / Conformité; Finance / المالية / Finances;
Reputation / السمعة / Réputation. Each with a descriptor per level
(`apps/api/src/risks/defaults.ts`).

**Bands** (review interval, escalated to): Low / منخفض / Faible (365 days);
Medium / متوسط / Moyen (180); High / مرتفع / Élevé (90, Risk committee);
Extreme / بالغ الخطورة / Extrême (30, Governing body). Cells by score:
Low 1–3, Medium 4–6, High 8–12, Extreme 15–25.

**Categories** (appetite `cautious`, tolerance Medium): Safety of the people
we serve / سلامة من نخدمهم / Sécurité des personnes que nous servons; Staff
health and safety / صحة العاملين وسلامتهم / Santé et sécurité du personnel;
Service and operations / الخدمة والعمليات / Service et activités; Compliance
and regulation / الامتثال والأنظمة / Conformité et réglementation; Finance /
المالية / Finances; Reputation / السمعة / Réputation; Information and data /
المعلومات والبيانات / Information et données; Facilities, equipment and
environment / المرافق والمعدات والبيئة / Locaux, équipements et
environnement; Strategy / الاستراتيجية / Stratégie.

**Committees** (no role yet): Risk committee / لجنة المخاطر / Comité des
risques; Governing body / الهيئة الحاكمة / Instance de gouvernance.

## Not in this contract yet

Heat map, acceptance and closure, incident links, export: later steps of
the spec. `standing` will gain "accepted" (step 6) without changing its
shape.


## Steps 3 to 5

### Reviews

`POST /risks/:id/reviews` (its owner, a manager, or a member of the
committee it is escalated to) → 200 the risk.

```ts
{ revision,
  outcome: 'no_change' | 're_rated' | 'treatment_changed' | 'closure_proposed',
  comment: string,                       // 1..4000, required
  current: RatingInput,                  // confirmed or changed: a new rating either way
  target?: RatingInput,
  controls?: { controlId, effectiveness }[],  // assessed today
  treatment?: 'reduce'|'avoid'|'share'|'accept' | null, targetOn?: day | null,
  nextReviewOn?: day,                    // earlier than the band allows, never later
  committeeId?: uuid }                   // a committee's review: the risk's committee, by a member
```

400 `outcome_mismatch` (`no_change` with another current rating),
`review_interval_too_long` (with `latest`, the latest day allowed),
`review_day_past`, `unknown_control`, `target_above_current`; 403
`not_a_member`; 409 `stale_risk`, `not_on_register`. The next review is
today plus the interval of the band the review leaves it in, unless an
earlier day is given. A review can escalate the risk (as a rating does).

- `GET /risks/reviews?state=due|overdue&unitId=` (`risks.manage`): the open
  risks the caller manages whose next review is within 30 days (`due`) or
  has passed (`overdue`); none given: both. `{ items: RiskSummary[], total,
  people, units }`, soonest first.
- `GET /risks/mine` (anyone signed in): `{ risks: RiskSummary[]` (owned, on
  the register, next review first)`, actions: (Action & { risk: { id,
  reference, title, current } })[]` (owned, open or in progress, due first)`,
  committees: { id, name, risks: number }[]` (those the caller sits on)`,
  steps: [] }` (step 6).
- `GET /risks/summary` (anyone; over what they read in full):
  `{ openRisks, highAndExtreme, aboveToleranceNotAddressed, reviewsOverdue,
  overdueActions: { code: 'actions.overdue', count, of, percent: number |
  null, target: 10, dueDaysMoved } }`. The dashboard's `overdueActions` tile
  shows `count` and `percent` against the target (good under 10%), for a
  client with the risks or the actions module. Tiles: "High and extreme
  risks", "Risks above tolerance, not addressed", "Risk reviews overdue".

### Actions on risks (the shared engine)

```ts
type Action = {
  id; reference;                    // ACT-2026-00031
  sourceType: 'risk'; riskId;
  title: Localized; description: Localized | null;
  ownerId; orgUnitId: string | null;
  dueOn: day; originalDueOn: day; dueMoved: boolean;   // the first due day never changes
  strength: 'stronger' | 'intermediate' | 'weaker';
  hierarchy: 'elimination'|'substitution'|'engineering'|'administrative'|'protective_equipment' | null;
  status: 'open' | 'in_progress' | 'completed' | 'verified' | 'cancelled';
  completedAt; completedBy; completionNote: string | null;
  effectiveness: 'effective' | 'not_effective' | null; verifiedBy; verifiedAt; verificationNote: string | null;
  cancelReason: string | null;
  createdBy; createdAt; updatedAt; revision;
  overdue: boolean;
  editable: 'all' | 'progress' | null;   // what `edit` may change: everything, or status and due day
  moves: ActionMove[];
};
```

| Route | Who | Body | Answer |
|---|---|---|---|
| `GET /risks/:id/actions` | a reader of the risk | | `{ items: Action[], summary? }` |
| `POST /risks/:id/actions` | its owner or a manager (risk on the register) | `{ revision /* the risk's */, title, description?, ownerId, orgUnitId? (null: whole organization; none: the risk's), dueOn, strength, hierarchy? }` | 201 `Action & { riskRevision }` |
| `GET /risks/actions/:actionId` | a reader of the risk, or the action's owner | | `Action & { risk: { id, reference, title, current, access }, events, people, units }` |
| `PATCH /risks/actions/:actionId` | a manager or the risk's owner (anything); the action's owner (`status`, `dueOn`) | `{ revision, title?, description?, ownerId?, orgUnitId?, dueOn?, strength?, hierarchy?, status?: 'open'\|'in_progress', reason? /* required with dueOn */ }` | `Action & { riskRevision }` |
| `POST /risks/actions/:actionId/complete` | the action's owner, the risk's owner, a manager; open while suspended | `{ revision, note }` | the same |
| `POST /risks/actions/:actionId/verify` | the risk's owner or a manager, never the action's owner (403 `same_person`) | `{ revision, outcome, note? }` | the same |
| `POST /risks/actions/:actionId/cancel` | the risk's owner or a manager | `{ revision, reason }` | the same |
| `POST /risks/actions/:actionId/reopen` | the risk's owner or a manager | `{ revision, reason }` | the same |
| `POST /risks/actions/:actionId/corrections` | the risk's owner or a manager | `{ revision, field: 'completionNote'\|'verificationNote'\|'cancelReason', text }` | the same |

An action's owner who reads the risk no other way sees its summary only
(`GET /risks/:id` answers `access: 'summary'`), and the action through
"My risks and actions"; the risk is not in their register. Say when every
open action is weaker (`actionSummary.allWeaker`):
`risks.actions.allWeaker`. A `not_effective` check: prompt to re-rate the
risk (`risks.actions.reRatePrompt`).

Action timeline (`events`, oldest first; never text): `created`, `updated`
(`{ [field]: { from, to } | { changed: true } }`), `due_changed`
(`{ from, to, reasonGiven, originalDueOn }`), `completed` (`{ from, onTime,
dueOn, noteGiven }`), `verified` (`{ outcome, noteGiven }`), `cancelled`
(`{ from, reasonGiven }`), `reopened` (`{ from, reasonGiven, effectiveness
}`), `text_corrected` (`{ field }`).

### Escalation and committees

- Automatic: a current rating (or a review) into a band with a committee
  puts the risk before it, unless it is before that committee or a higher
  one already. The risk's `escalatedToCommitteeId` changes; the timeline has
  `escalated` with `automatic: true`.
- `POST /risks/:id/escalate` (a manager; open while suspended) `{ revision,
  committeeId, reason }` → the risk. 400 `unknown_committee`; 409
  `already_escalated`, `not_on_register`.
- `POST /risks/:id/de-escalate` (a member of its committee, or a manager for
  the whole organization) `{ revision, reason }` → the risk; 409
  `still_above_threshold` (its band still calls for that committee or a
  higher one), `not_escalated`. A band that calls for a lower committee puts
  it before that one at once. A member who no longer reads the risk is
  answered `{ access: 'none', id, reference, escalatedToCommitteeId: null }`.
- `GET /risks/committees/:id/risks` (its members; readers for the whole
  organization; 403 otherwise; 404 unknown) → `{ committee: { id, name,
  active }, items: (RiskSummary & { lastReview: { reviewedOn, committeeId }
  | null })[], total, people, units, categories, committees }`, highest
  score first. "Record the committee's review" is `POST /risks/:id/reviews`
  with `committeeId`; the risk page then says "Reviewed by {committee} on
  {day}" from `reviews[].committeeId`.

### Corrections (security review 15, M1)

`POST /risks/:id/corrections` (a manager of the risk, any status) → the
risk. Body, one of:

```ts
{ revision, kind: 'rating_rationale', ratingId, text: Localized | null }
{ revision, kind: 'review_comment', reviewId, text: string }
{ revision, kind: 'reject_reason', text: string }
{ revision, kind: 'control_reason', controlId, text: string }   // a switched-off control's reason
```

404 for a rating, review or control not of this risk; 409
`nothing_to_correct`. Offer it beside the text ("Correct"), with the form's
warning about personal details.

### Notifications (the notifications list and email)

Each item of `GET /notifications` now also has `risk: { id, reference,
title: Localized | null /* when read in full */, canOpen } | null` and
`action: { id, reference, riskId, canOpen } | null`. `data` holds
`reference`, `serious`, and as said below.

| Kind | About | `data` | Email |
|---|---|---|---|
| `risk_owner_assigned` | risk | | digest |
| `risk_review_due` | risk | `dueOn` | digest |
| `risk_review_overdue` | risk | `dueOn` | digest, weekly |
| `risk_above_tolerance` | risk | `band` | digest |
| `risk_escalated` | risk | `committeeId`, `automatic`, `band` | **at once when `band` is `extreme`** |
| `risk_de_escalated` | risk | `committeeId` | in-app only |
| `risks_overdue_digest` | nothing | `reviewsOverdue`, `actionsOverdue`, `week` | weekly; links to "Reviews due" |
| `action_assigned`, `action_due_soon`, `action_overdue`, `action_escalated`, `action_completed` | action | `sourceReference` (the risk's), `dueOn` | digest |

The morning digest gains "Risks to review", "Actions due" (with how many
are overdue) and, for managers, "Risks proposed for the register". The
email preferences screen lists the extreme escalation among the immediate
emails a person may switch off.

### Wording keys for steps 3 to 5

| key | en |
|---|---|
| `risks.review.title` | Review |
| `risks.review.outcome.no_change` | No change |
| `risks.review.outcome.re_rated` | Re-rated |
| `risks.review.outcome.treatment_changed` | Treatment changed |
| `risks.review.outcome.closure_proposed` | Closure proposed |
| `risks.review.late` | Made late |
| `risks.review.byCommittee` | Reviewed by {committee} on {day} |
| `risks.review.comment` | What was looked at and found |
| `risks.reviewsDue.title` | Reviews due |
| `risks.mine.title` | My risks and actions |
| `risks.mine.committees` | My committees |
| `risks.standing.above_treated` | Above tolerance, being treated |
| `risks.trend.up` / `.down` | Up since the last review / Down since the last review |
| `risks.targetAboveCurrent` | The target is above the current rating. Rate the target again. |
| `risks.escalation.automatic` | Escalated automatically by its rating |
| `risks.escalation.byHand` | Escalated by hand, with a reason |
| `risks.escalation.deEscalated` | Taken off the committee's list |
| `risks.escalation.done` | Taken off the committee's list. You no longer see this risk. |
| `risks.committee.risks` | Risks before the committee |
| `risks.committee.record` | Record the committee's review |
| `risks.actions.title` | Actions |
| `risks.actions.add` | Add an action |
| `risks.actions.strength.stronger` | Stronger: changes the system or the equipment |
| `risks.actions.strength.intermediate` | Intermediate: a checklist or a standard way of working |
| `risks.actions.strength.weaker` | Weaker: a reminder or training alone |
| `risks.actions.status.open` / `in_progress` / `completed` / `verified` / `cancelled` | Open / In progress / Completed / Effectiveness checked / Cancelled |
| `risks.actions.effectiveness.effective` / `not_effective` | Effective / Not effective |
| `risks.actions.allWeaker` | Every open action of this treatment is weaker. Consider a stronger one. |
| `risks.actions.reRatePrompt` | The action did not work. Rate the risk again. |
| `risks.actions.dueMoved` | Due day moved; first due {day} |
| `risks.actions.moves.edit` / `complete` / `verify` / `cancel` / `reopen` | Edit / Mark complete / Check effectiveness / Cancel / Reopen |
| `risks.actions.events.<kind>` | one per action timeline kind above |
| `risks.events.reviewed` / `escalated` / `de_escalated` / `text_corrected` | Reviewed / Escalated to {committee} / Taken off {committee}'s list / Wording corrected |
| `risks.text.changed` | {field} changed |
| `risks.text.reasonGiven` | with a reason |
| `risks.correct.title` | Correct the wording |
| `risks.correct.kind.<kind>` | Rationale / Review comment / Reason not taken / Reason switched off |
| `risks.document.restricted` | A restricted document |
| `risks.summary.highAndExtreme` | High and extreme risks |
| `risks.summary.notAddressed` | Risks above tolerance, not addressed |
| `risks.summary.reviewsOverdue` | Risk reviews overdue |
| `dashboard.overdueActions` (exists) | Overdue actions: help text "{percent} of {of} open actions; target under 10%" |
| `notifications.kinds.<kind>` | one per new kind above |
| `risks.errors.<code>` | one per new code above |

Audit wording (`audit.actions.<action>`, copy from
`apps/api/src/audit/wording/{en,ar,fr}.ts`): `risk_reviewed`,
`risk_escalated`, `risk_de_escalated`, `risk_text_corrected`,
`action_created`, `action_updated`, `action_due_changed`,
`action_completed`, `action_verified`, `action_cancelled`,
`action_reopened`, `action_text_corrected`. New audit area `actions`,
entity type `action`. The details of `risk_updated`,
`risk_proposal_rejected`, `risk_control_updated`, `risk_escalated`,
`risk_de_escalated`, `action_due_changed`, `action_cancelled` and
`action_reopened` hold `reasonGiven` instead of a reason, and text fields as
`{ changed: true }`. `risk_matrix_changed` holds the wording from and to.
`built_in_roles_changed_by_system` of migration 0061 holds
`permissionsAdded` by role: `{ administrator: [...], ... }`.

## Steps 6 and 7, and security review 17

### On a risk's page (`GET /risks/:id`, `access: 'full'`), new fields

```ts
{
  acceptanceId: string | null,          // the acceptance in force
  acceptedUntil: Day | null,            // also on list rows
  closureRequested: boolean,            // also on list rows
  standing: ... | 'above_accepted',
  acceptances: {                        // newest first
    id, requestedBy, requestedAt, rationale: Localized, conditions: Localized | null,
    untilOn: Day, ratingId, score, bandCode, toleranceBand, categoryId,
    status: 'in_approval' | 'accepted' | 'returned' | 'withdrawn' | 'lapsed',
    approvalRunId, decidedAt, lapsedReason: 'last_day' | 'score_risen' | 'category_changed' | null, lapsedAt,
    run: Run | null,                    // null when the band needs no signature
    signatures: { id, userId, meaning: 'reviewed' | 'risk_accepted', signedAt, contentHash, method }[],
  }[],
  closure: null | {
    requestedBy, requestedAt, closeReason, mergedIntoId, closedBy, closedAt,
    runs: Run[], signatures: { ..., meaning: 'reviewed' | 'risk_closure_approved' }[],
  },
  incidents: null /* incidents module off */ | {
    items: { linkId, kind: 'raised' | 'supports', note: string | null, linkedBy, linkedAt,
             incident: { id, reference, type, categoryId, orgUnitId, occurredOn: Day, harmLevel, status } }[],
    hidden: number,                     // linked incidents the reader may not open: say "and {count} more you cannot open"
    last12Months: number,
    categories: Record<id, Localized>,  // incident categories, for pick()
  },
  notes: { id, kind: 'change_reason' | 'escalation_reason' | 'de_escalation_reason' | 'reopen_reason' | 'withdraw_reason',
           text: string, writtenBy, writtenAt, correctedAt: string | null }[],
  controls: { ..., flag: 'document_retired' | 'document_past_review' | null }[],
}
// Run: { id, status: 'in_progress' | 'approved' | 'returned' | 'cancelled', startedBy, startedAt, completedAt,
//        steps: { position, kind: 'review' | 'approve', assigneeUserId, assigneeRoleId, status, dueAt,
//                 decidedBy, decidedAt, comment, signatureId }[] }
```

Timeline `details` name a note by `noteId` (show the note's text from
`notes`, "Reason: …"); never text. An assignee who has decided and reads
the risk no other way is answered `{ access: 'none', id, reference }`:
say "Your decision is recorded."

### Moves, new

`link_incident`, `request_acceptance`, `withdraw_acceptance`,
`approve_acceptance`, `return_acceptance`, `close`, `request_closure`,
`approve_closure`, `return_closure`, `reopen`. While a closure waits:
only `approve_closure`/`return_closure` (its signer), `escalate`,
`correct`. While an acceptance is in approval, no `review`. A closed risk:
`reopen`, `correct`.

### Acceptance

| Route | Who | Body | Answer |
|---|---|---|---|
| `POST /risks/:id/acceptance` | owner or manager | `{ revision, rationale: Localized, conditions?: Localized, until: Day }` | the risk |
| `POST /risks/:id/acceptance/approve` | assignee with `risks.approve` | `{ revision, password, comment? }` | the risk, or `{ access: 'none' }` |
| `POST /risks/:id/acceptance/return` | assignee with `risks.approve` | `{ revision, comment }` | the same |
| `POST /risks/:id/acceptance/withdraw` | requester or manager | `{ revision, reason }` | the risk |

`password` is the password, or the signing PIN for someone signing with
one (as documents). Codes: 400 `until_past`, `acceptance_too_long` (with
`latest`), `language_mismatch`; 401 `wrong_password`, `password_locked`;
403 `signing_pin_required`, `signing_pin_locked`, `not_assignee`,
`same_person` (`reason`: `requested` | `owner` | `decided_earlier_step`);
409 `within_tolerance`, `rerate_needed`, `already_accepted`,
`acceptance_in_progress`, `closure_in_progress`, `no_route`, `no_assignee`
(with `position`), `not_in_approval`, `not_current_step`, `stale_risk`.

### Closing and reopening

| Route | Who | Body | Answer |
|---|---|---|---|
| `POST /risks/:id/close` | a manager | `{ revision, reason, mergedIntoId? }` | the risk: closed, or with `closure.requestedAt` |
| `POST /risks/:id/closure/approve` | assignee with `risks.approve` | `{ revision, password, comment? }` | the risk, or `{ access: 'none' }` |
| `POST /risks/:id/closure/return` | the same | `{ revision, comment }` | the same |
| `POST /risks/:id/reopen` | a manager | `{ revision, reason, current: { likelihood, impact, rationale? } }` | the risk |

Codes: 400 `unknown_risk` (merged into), `target_required`,
`target_above_current`, `level_out_of_range`; 409 `actions_open`,
`not_on_register`, `not_closed`, `closure_in_progress`,
`acceptance_in_progress`, `no_route`, `no_assignee`, and as acceptance.

### "My approvals"

`GET /risks/approvals` (`risks.approve`) → `{ items: { subject:
'acceptance' | 'closure', runId, acceptanceId, riskId, reference, title:
Localized, currentBand, position, step: 'review' | 'approve', dueAt,
overdue, requestedBy, requestedAt }[], people }`. The same list is
`steps` in `GET /risks/mine`.

### Routes (risk settings, a manager for the whole organization)

`GET /risks/settings/approval-routes` → `{ items: { id, name, subject:
'risk_acceptance' | 'risk_closure', variant: 'medium' | 'high' | 'extreme'
| null, active, revision, steps: { position, kind, userId, roleId,
dueInDays, userName, roleName }[] }[] }`. `POST` `{ subject, variant,
name, steps: { kind, roleId | userId, dueInDays }[] }`; `PATCH /:id` `{
revision, name?, steps?, active? }`. Codes: 400 `last_step_must_approve`,
`same_person_in_two_steps`, `unknown_role`, `role_cannot_approve`,
`user_cannot_approve`; 409 `route_exists`, `stale_route`.

### Links to incidents

| Route | Who | Body | Answer |
|---|---|---|---|
| `POST /risks/:id/incident-links` | a manager of the risk who sees the incident in full | `{ incidentId, kind: 'raised' \| 'supports', note? }` | 201 `{ id, riskId, incidentId, kind, note, linkedBy, linkedAt, riskRevision }` |
| `DELETE /risks/:id/incident-links/:linkId` | the same | `{ reason }` | 204 |
| `GET /risks/for-incident/:incidentId` | whoever sees the incident | | `{ items: (list row & { linkKind, linkId })[], raise: { orgUnitId, impact: 2..5 \| null, linkKind: 'raised' } \| null, mayLink, people, units, categories }` |
| `POST /risks` with `fromIncidentId`, `linkKind?` | whoever sees the incident in full | as a new risk | 201 the risk (`source: 'incident'`; `proposed` unless a manager with a current rating) |

Codes: 400 `unknown_incident` (also with the incidents module off); 409
`already_linked`, `not_on_register`. The incident's page shows the panel
"Risks" with "Raise a risk" when `raise` is given; prefill unit and
impact; never copy the incident's description.

### Documents

`GET /risks/for-document/:documentId` (a reader of the document) → `{
total, items: list row[], people, units }`: "Controls in {total} risks".

### Corrections, new kinds (`POST /risks/:id/corrections`)

```ts
{ revision, kind: 'note', noteId, text: string }
{ revision, kind: 'risk_text', field: 'title', text: Localized }                        // rejected or closed risks (409 use_edit otherwise)
{ revision, kind: 'risk_text', field: 'cause' | 'event' | 'consequence', text: Localized }
{ revision, kind: 'close_reason', text: string }
{ revision, kind: 'link_text', linkId, field: 'note' | 'removeReason', text: string }
```

`POST /risks/actions/:id/corrections` also takes `{ revision, field:
'title' | 'description', text: Localized }` and `{ revision, field:
'note', noteId, text }`. An action's page gains no notes list yet: the
reasons show from `GET /risks/actions/:id` `events` by `noteId` (a later
step adds them).

### Security review 17, what the screens say

- Escalation by hand offers only committees above the current one (409
  `already_escalated`).
- A committee member's review form has no treatment; "Accept" is not a
  treatment to pick above tolerance (400 `acceptance_required`): offer
  "Ask for acceptance" instead.
- De-escalation by whoever lowered the rating today: 403 `same_person`
  ("Someone else takes it off the list").
- An action's `verify` is not offered to whoever completed it.
- Switching off a committee with risks before it: 409 `committee_in_use`.

### Notifications, new

| Kind | `data` | Email |
|---|---|---|
| `risk_step_assigned` | `subject: 'acceptance' \| 'closure'`, `position`, `step` | **at once**, not to be switched off by assignees |
| `risk_step_overdue` | `subject`, `position` | in-app; counted in the weekly email (`stepsOverdue`) |
| `risk_acceptance_decided` | `outcome: 'accepted' \| 'returned'`, `until?` | in-app |
| `risk_acceptance_ending` | `until` | digest |
| `risk_acceptance_lapsed` | `reason` | digest |
| `risk_closed` | | in-app |
| `risk_proposed` | | digest |
| `risk_incident_linked` | | in-app |
| `risk_control_document_retired` | `controlId` | digest |

`risks_overdue_digest` gains `stepsOverdue`. The morning digest gains "Risk
steps to decide".

### Wording keys for steps 6 and 7

| key | en |
|---|---|
| `risks.acceptance.title` | Acceptance above tolerance |
| `risks.acceptance.ask` | Ask for acceptance |
| `risks.acceptance.rationale` | Why the risk is kept |
| `risks.acceptance.conditions` | Conditions |
| `risks.acceptance.until` | Accepted until |
| `risks.acceptance.status.in_approval` / `accepted` / `returned` / `withdrawn` / `lapsed` | In approval / Accepted / Returned / Withdrawn / Lapsed |
| `risks.acceptance.lapsed.last_day` / `score_risen` / `category_changed` | Its last day came / The score rose above the one accepted / The category changed |
| `risks.acceptance.withdraw` | Withdraw the request |
| `risks.acceptance.fixed` | While the request is in approval, the title, category, unit and current rating cannot change. |
| `risks.standing.above_accepted` | Above tolerance, accepted until {day} |
| `risks.closure.title` | Closure |
| `risks.closure.close` | Close the risk |
| `risks.closure.request` | Ask for closure |
| `risks.closure.reason` | Why it is closed |
| `risks.closure.mergedInto` | Merged into {reference} |
| `risks.closure.waiting` | Closure waiting for a second signature |
| `risks.closure.reopen` | Reopen |
| `risks.steps.approve` / `return` | Sign / Return |
| `risks.steps.signWith.password` / `pin` | Your password / Your signing PIN |
| `risks.steps.meaning.reviewed` / `risk_accepted` / `risk_closure_approved` | Reviewed / Accepted the risk / Approved the closure |
| `risks.steps.done` | Your decision is recorded. |
| `risks.approvals.title` | Approvals waiting for me |
| `risks.incidents.title` | Linked incidents |
| `risks.incidents.kind.raised` / `supports` | Raised the risk / Supports the risk |
| `risks.incidents.hidden` | And {count} you cannot open |
| `risks.incidents.last12Months` | {count} in the last 12 months |
| `risks.incidents.link` | Link an incident |
| `risks.incidents.unlink` | Remove the link |
| `incidents.risks.title` | Risks |
| `incidents.risks.raise` | Raise a risk |
| `risks.controls.flag.document_retired` | The procedure was retired |
| `risks.controls.flag.document_past_review` | The procedure is past its review date |
| `policies.document.risks` | Controls in {count} risks |
| `risks.notes.kind.<kind>` | Reason for the change / for escalating / for taking it off the list / for reopening / for withdrawing |
| `risks.notes.corrected` | Corrected |
| `risks.correct.kind.note` / `risk_text` / `close_reason` / `link_text` | Reason / Wording of the risk / Reason for closing / Note of the link |
| `risks.events.acceptance_requested` / `acceptance_step_approved` / `acceptance_returned` / `acceptance_withdrawn` / `accepted` / `acceptance_lapsed` / `closure_requested` / `closure_step_approved` / `closure_returned` / `closed` / `reopened` / `incident_linked` / `incident_unlinked` | Acceptance asked for / Acceptance step signed / Acceptance returned / Acceptance withdrawn / Accepted until {day} / Acceptance lapsed / Closure asked for / Closure step signed / Closure returned / Closed / Reopened / Incident {reference} linked / Incident link removed |
| `risks.settings.routes.title` | Acceptance and closure routes |
| `risks.settings.routes.variant.medium` / `high` / `extreme` / `closure` | Medium above tolerance / High above tolerance / Extreme above tolerance / Closure |
| `notifications.kinds.<kind>` | one per new kind above |
| `risks.errors.<code>` | one per new code above |
| `email.preferences` (exists) | lists `risk_step_assigned` among the approval steps that are always on for assignees |

The starting routes' names (client data, `pick()`): "Acceptance of a
Medium risk above tolerance" / "قبول خطر متوسط فوق حدّ التحمّل" /
"Acceptation d’un risque moyen au-delà de la tolérance"; the same for High
("مرتفع", "élevé") and Extreme ("بالغ الخطورة", "extrême"); "Closure of a
risk" / "إغلاق خطر" / "Clôture d’un risque".

Audit wording (`audit.actions.<action>`, from
`apps/api/src/audit/wording/{en,ar,fr}.ts`): `risk_acceptance_requested`,
`risk_acceptance_step_approved`, `risk_acceptance_returned`,
`risk_acceptance_withdrawn`, `risk_accepted`, `risk_acceptance_lapsed`,
`risk_closure_requested`, `risk_closure_step_approved`,
`risk_closure_returned`, `risk_closed`, `risk_reopened`,
`risk_incident_linked`, `risk_incident_unlinked`,
`risk_approval_route_created`, `risk_approval_route_updated`. Details
`noteId` (new) on `risk_updated`, `risk_escalated`, `risk_de_escalated`,
`risk_acceptance_withdrawn`, `risk_reopened`, `risk_text_corrected`,
`action_due_changed`, `action_reopened`, `action_text_corrected`;
`commentGiven` on step decisions; `risksAwaitingAcceptance` on
`risk_matrix_put_in_use`; `routes` on `risk_defaults_created_by_system`.

## Step 8: heat map, export and print

### Filters, shared

`GET /risks`, `GET /risks/heat-map`, `GET /risks/exports/register` and
`GET /risks/print` take the same filters: `q, unitId, categoryId, band,
status, ownerId, mine, aboveTolerance, notAddressed, review, committeeId,
incidentId`, and now `rating` (`inherent` | `current` default | `target`),
`likelihood`, `impact` (1 to 6). A heat-map cell opens the register with
`rating`, `likelihood` and `impact` set: the list's `total` is the cell's
count.

### `GET /risks/heat-map`

```ts
{
  rating: 'inherent' | 'current' | 'target',
  matrix: { id, version, likelihood: { level, label: Localized }[], impact: { level, label }[], bands: { code, name: Localized }[] },
  cells: { likelihood, impact, band, count }[],   // every cell; likelihood from the highest, impact from the lowest
  total: number,        // = the list's total under the same filters
  unrated: number,      // no rating of that kind (a proposal)
  otherVersion: number, // rated on an earlier matrix version: "N rated on an earlier version of the matrix"
}
```

400 for a value it does not take (`rating`, levels, unknown parameter).

### `GET /risks/exports/register`

The filters, `sort`, `locale?` (one of the client's; else the caller's,
else the client's; 400 `language_mismatch`). A CSV download
(`risk-register-<day>.csv`). Offer "Download CSV" beside the list, with
the current filters.

### Print

- `GET /risks/print` (filters, `sort`) → `{ organization: Localized,
  printedOn: Day, filters, heatMap /* as above */, items: list row[],
  total, truncated, people, units, categories, committees }`. Print A4
  landscape: organization, scope and filters, "Printed on {day}", page
  numbers, the heat map with its table, then the rows.
- `GET /risks/:id/print` → the risk as `GET /risks/:id` gives it (full or
  summary), without `moves`, with `organization` and `printedOn`.

### Wording keys for step 8

| key | en |
|---|---|
| `risks.heatMap.title` | Heat map |
| `risks.heatMap.rating.inherent` / `current` / `target` | Inherent rating / Current rating / Target rating |
| `risks.heatMap.likelihood` / `impact` | Likelihood / Impact |
| `risks.heatMap.cell` | {band}: {count} risks, likelihood {likelihood}, impact {impact} |
| `risks.heatMap.unrated` | {count} not rated |
| `risks.heatMap.otherVersion` | {count} rated on an earlier version of the matrix |
| `risks.heatMap.table` | The same figures as a table |
| `risks.export.csv` | Download CSV |
| `risks.print.register` / `risk` | Print the register / Print this risk |
| `risks.print.printedOn` | Printed on {day} |
| `risks.print.truncated` | The first {shown} of {total} risks |
| `audit.actions.risks_exported` (added) | Risk register exported |

## Step 9: measures

- `GET /reports/measures` gains, for those with `reports.view` and
  `risks.view` or `risks.manage` over the unit, while the risks module is
  on: `actions.overdue` (percent, target 10, `below`), `risks.past_review`
  (percent, target 5, `below`), `risks.not_addressed` (count, target 0, a
  new direction **`at_most`**: "Target: {target} or fewer"). Their
  `module` is `risks`.
- `risks.not_addressed`'s `details`: `byBand`, `byCategory` (category id →
  count), `cells` (`"likelihood:impact"` → count, the heat map at month
  end), `opened`, `closed`, `escalated`, `acceptancesMade`,
  `acceptancesLapsed`. `actions.overdue`'s: `dueDaysMoved`, `completed`,
  `completedOnTime`.
- `GET /risks/summary` gains `measures: { 'actions.overdue' |
  'risks.past_review' | 'risks.not_addressed': { value, numerator,
  denominator, target, direction, met } }`: the dashboard tiles.
- Web wording added: `reports.measures['risks.past_review' |
  'risks.not_addressed'].{name, help}`, `reports.target.at_most`; the
  reports API's CSV names the measures from `reports/wording`.

