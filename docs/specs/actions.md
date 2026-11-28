# Actions: specification

Status: the shared engine is built with the risks module (risk management,
step 4; see "Built" at the end). The actions module's own tracker is
proposed. Read `CLAUDE.md`, `README.md`, `docs/business-requirements.md`,
`modules-and-subscriptions.md` and `risk-management.md` ("Treatment and
actions", decisions 1 and 2) first.

Trustline's clients are any organization. Say "staff", "unit" and "the
people we serve"; not "patient" or "hospital", except in examples.

## What was asked

- **Business document:** "one tracker for every corrective and preventive
  action", with an "action-strength check", and the success measure
  "Overdue corrective actions: under 10% of open actions".
- **Risk management, decision 1 (decided):** actions are one shared
  capability, built once and used by every module. The risks module uses it
  from its first day; the actions module adds the tracker across every
  source. `actions.overdue` counts every action in the shared table, and is
  shown when the client has the actions module or the risks module.
- **Risk management, decision 2 (decided):** this spec is written before
  step 4 of that spec, and covers incidents' actions and effectiveness
  checks.

## Words used here

- **Action:** one task, with an owner and a due day, that corrects or
  prevents something. It always has a **source**: the record that called for
  it (a risk now; an incident, an investigation, a document or an assessment
  later), except an action of the tracker that is tied to no record.
- **Strength:** how much the action changes things, after the hierarchy of
  actions used in patient safety and in health and safety:
  - **stronger:** changes the system or the equipment (a barrier, a forcing
    function, a redesign);
  - **intermediate:** a checklist, a standard way of working, more staff;
  - **weaker:** a reminder, a warning, training alone, a new policy alone.
- **Effectiveness check:** a later look at whether a completed action did
  what it was for. Made by someone other than the action's owner.

## How it works

### One engine, no routes of its own

- **`apps/api/src/actions/`** holds the `actions` and `action_events`
  tables, the rules below, the reminders (`ActionCheck`) and the measure.
  Like the approval engine, it serves no routes: each module calls
  `ActionsService` in its own transaction, under its own module and
  permissions, and tells it:
  - the action's **source** (`risk` today);
  - who may **manage** actions of that source record (for a risk: whoever
    manages the risk, and its owner);
  - who **owns** the source record (for a risk: its owner), who is told when
    an action is overdue or completed and may check its effectiveness.
- **A source registers its rules** with the engine (`ActionSourceRules`):
  its module, its managers, its owner, its reference. The engine imports no
  module: modules import it.
- **Each source has a column of its own** on `actions` (`risk_id` today,
  `incident_id` later), each a composite key with the tenant, and a check
  that exactly the column of its `source_type` is set. So the database
  refuses an action pointing at another client's record, as every other
  link does. An action of the tracker with no source has none set.
- **Module rule:** an action belongs to the module of its source. A client
  with risks and without the actions module has everything it needs for its
  risks' actions; the actions of a source whose module is off are kept and
  shown again when it is back (`modules-and-subscriptions.md`).

### Each action

- a reference, `ACT-2026-00031` (`nextReference()`, prefix `ACT`), never
  reused;
- its source;
- a title (required, in the client's default language) and a description
  (any of the client's languages), per language;
- an owner (an active member of staff) and the unit responsible (null: the
  whole organization); by default the unit of its source;
- a due day on the client's calendar, and the first due day it was given
  (`original_due_on`), which never changes;
- a strength (required) and, optionally, its place in the hierarchy of
  controls (elimination, substitution, engineering, administrative,
  protective equipment);
- a status:
  - `open`;
  - `in_progress`;
  - `completed`, with a note of what was done (required: it is the
    evidence), who and when;
  - `verified`, after the effectiveness check, with its outcome
    (`effective` or `not_effective`), an optional note, who and when;
  - `cancelled`, with a reason.

### Rules

- **Moving a due day needs a reason.** The timeline keeps the old and new
  day; the reason is kept on the action as a note (`action_notes`), named
  in the timeline and the trail by its id (`noteId`), never copied there
  (security review 17, L5); `original_due_on` is kept, so the overdue
  figure cannot be improved quietly by moving dates.
- **Who does what** (the source says who manages; the engine applies it):

  | Who | May |
  |---|---|
  | A manager of the source (for a risk: `risks.manage` over its unit) | add actions; change everything; complete, verify, cancel and reopen |
  | The source's owner (a risk's owner) | the same |
  | The action's owner | mark it in progress; move its due day with a reason; complete it with a note |

- **The effectiveness check** is made by the source's owner or a manager,
  never by the action's owner nor by whoever completed it (403
  `same_person`: security review 17, L2), on a completed action. A
  `not_effective` outcome asks the source to look again (for a risk: a
  prompt to re-rate it).
- **Completing or verifying changes nothing else by itself.** A risk is
  re-rated by a person.
- **Reopening** (with a reason, kept as a note like a due day's) is from
  completed, verified or cancelled, back to `open`; what it had is kept in
  the timeline.
- **Corrections:** a manager of the source corrects, at any status, what
  was written on an action: what was done, the effectiveness note, the
  reason it was cancelled, its title and description, and a reason kept as
  a note (security reviews 15 and 17, L4 and L5). Audited as
  `action_text_corrected` with the field's name (and the note's id), never
  the text.
- **An action's owner reads it** (and its risk's summary) while it is open,
  in progress or completed, as the risk's visibility says (security review
  17, L6); not once verified or cancelled.
- **Stale saves:** every change sends the action's `revision` (409
  `stale_action`).
- **The strength check:** the source's screen says when every open action of
  it is weaker (`allWeaker`).
- **Nothing is deleted.** The application role cannot delete an action or an
  event; the database keeps `original_due_on`, the reference, the source and
  the author as they were made.

### Reminders (`ActionCheck`)

Every 15 minutes, beside the other checks, built as `PolicyCheck`: one
client at a time, short transactions, each reminder claimed once in
`action_reminders` (by kind, action and due day, so a new due day gives new
reminders), safe with any number of API processes, skipping clients without
the source's module, suspended by Trustline or cancelled.

| Kind | When | To |
|---|---|---|
| `action_due_soon` | 7 days before the due day | the action's owner |
| `action_overdue` | the day after the due day | the action's owner and the source's owner |
| `action_escalated` | 14 days overdue | the managers of the source |

And, written by the engine in the change's transaction:

| Kind | When | To |
|---|---|---|
| `action_assigned` | someone is made an action's owner | that person |
| `action_completed` | completed | the source's owner, who checks it worked |

Each carries the action's reference and the source's reference, and
`serious` as the source says (for a risk: its band High or Extreme); never a
title or a name. None is emailed at once: they reach the person through the
morning digest ("Actions due"). Nobody is told of their own action.

### "My actions"

Every action a person owns that is open or in progress, due and overdue
first, with the reference, title and current band of the source, nothing
more (the risks module's `GET /risks/mine`; the tracker's `/actions/mine`
later).

### The measure

`actions.overdue` (defined in `apps/api/src/reports/measures.ts`, counted
live by `apps/api/src/actions/measures.ts`): open actions (open
or in progress) past their due day, as a share of open actions; target under
10%. Beside it, how many due days were moved. Counted over the actions the
reader may see; the dashboard's `overdueActions` tile shows it, for a client
with the actions or the risks module. The month-end snapshots come with
`reports-and-measures.md`.

## The actions module (proposed, not built)

- the tracker across every source (`/api/v1/actions`, `@ForModule('actions')`),
  calling the same `ActionsService`;
- actions tied to no record, with `actions.manage` (which exists) over their
  unit;
- its settings: the days before a reminder, the days to escalate, whether
  the effectiveness check is required, and after how long;
- filters by source, unit, owner, status, strength, overdue, moved due days.

## Incidents (proposed, not built)

- **Source `incident`:** a column `incident_id`, a composite key, and the
  incidents module's rules: managers are whoever handles the incident
  (`seenInFull()` and `incidents.triage`); its "owner" is the person it is
  assigned to, else the handling department's managers.
- **Closing an incident** whose actions are open is allowed: actions often
  outlive the incident. The closure summary lists them.
- **Who reported an incident** is never shown on an action or its
  notifications, as everywhere else.

## Data outline

- `actions`: `reference`, `source_type`, `risk_id`, `title`, `description`,
  `owner_id`, `org_unit_id`, `due_on`, `original_due_on`, `strength`,
  `hierarchy`, `status`, `completed_at`, `completed_by`, `completion_note`,
  `effectiveness`, `verified_by`, `verified_at`, `verification_note`,
  `cancel_reason`, `created_by`, `created_at`, `updated_at`, `revision`.
- `action_events` (insert-only): `action_id`, `kind`, `actor_id`,
  `occurred_at`, `details` (from and to, and the id of the note holding the
  reason for a new due day or a reopening).
- `action_notes`: `action_id`, `kind` (`due_change_reason`,
  `reopen_reason`), `text`, `written_by`, `written_at`, `corrected_by`,
  `corrected_at`; inserted, and only its text corrected.
- `action_reminders` (insert-only claims): `kind`, `action_id`, `period`.

Each has `tenant_id`, `tenant_isolation`, composite keys and grants for
`trustline_app`.

## Audit

`action_created`, `action_updated`, `action_due_changed` (from, to, the
note's id), `action_completed`, `action_verified` (outcome),
`action_cancelled` (that a reason was given), `action_reopened` (the note's
id), `action_text_corrected` (which field), in a new audit area of their
own, entity type `action`, worded in every language. Never the text people
wrote.

## Decisions taken

The recommendations of `risk-management.md` (decisions 1 and 2) are decided.
Taken here, and open to the business before the pilot:

1. **An action's owner moves its own due day** with a reason, rather than
   asking for it: the move is audited, kept on the timeline and visible in
   "due days moved" beside the measure.
2. **The effectiveness check is offered, not required,** until the
   actions module's settings exist.
3. **Action notifications belong to the module of their source:** today all
   are the risks module's.
