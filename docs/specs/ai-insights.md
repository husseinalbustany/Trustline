# AI insights and suggestions: preparation

Status: preparation only. Nothing here is built. It adds a second job for the
AI assistant beside drafting documents (`ai-policy-drafting.md`): reading what
is already in the system and offering suggestions to the people who review,
investigate and decide. Limits on use and how it is sold are in
`modules-and-subscriptions.md`.

Trustline's clients are any organization, not only hospitals.

## What was asked

The AI should use the incidents and the other information in the system to
help automatically: suggest actions and solutions, and possibly the root
cause, so that administrators, reviewers and investigators have more insight.

## The principle

**The assistant suggests; a named person decides.** Every suggestion is shown
as a suggestion, with the records it is based on, and does nothing until
someone accepts it. It never triages, assigns, closes, signs off, changes a
score or writes to a record on its own. Accepting, changing or dismissing a
suggestion is recorded with who did it.

## What it suggests, and to whom

### On one incident

| Moment | Suggestion | For |
|---|---|---|
| A report arrives | A category and a severity to consider, with the words in the report that point to it; whether it looks like a duplicate of an open report | Whoever triages |
| At triage | The department that usually handles this kind of event; similar past incidents and how they ended | Whoever triages |
| While handling | Questions worth asking the reporter; missing facts (when, where, what was done) | The handler |
| At closure | A draft closure summary from the timeline, in plain words the reporter can read | The handler, to edit |

### In an investigation

| Suggestion | Detail |
|---|---|
| **Contributing factors to consider** | From the client's own factor list, each with the evidence in the record that points to it |
| **Possible root causes** | Offered as hypotheses to test, each with what would confirm it and what would rule it out. Never one answer |
| **Questions for the "five whys"** | The next question to ask, not the answer |
| **Similar investigations** | What they found and which actions worked |
| **A draft of the report** | From the findings the team has entered; the team writes the conclusions |

### Actions and solutions

- **Actions to consider**, drawn from what the client did after similar
  events and from the procedure that applies, each marked by strength:
  a change to the system or equipment is stronger than a reminder or
  training alone. The assistant says so when only weak actions are chosen.
- **Whether an action worked**: after a corrective action is completed, did
  events of that kind fall? Shown as figures with their period, for the
  person who checks effectiveness.

### Across many records (for the quality office and leadership)

- **Clusters and trends**: several reports that look like the same problem
  (one place, one piece of equipment, one step in a process), or a kind of
  event that is rising. Shown with the records behind it.
- **Links to propose**: an incident that looks related to a risk in the
  register; a risk whose incidents are increasing; a procedure that several
  incidents suggest is unclear or not followed; a training need.
- **A periodic digest**: what changed since the last one, in a page, for a
  committee meeting.

## What it may read

Only the client's own data, and only what the person asking may see:

| Source | Used for |
|---|---|
| Incidents: type, category, place, time, severity, description, timeline | Everything above |
| Investigations and their findings | Factors, causes, similar cases |
| Actions and whether they were effective | Actions to consider |
| Policies and procedures | Which document applies; where a gap is |
| Risks and their scores | Links to propose |
| Training records, as counts per department and course | Training needs |
| The client profile | Sector, structure, terms |

Rules on reading:

- **Permissions hold.** A suggestion is built only from records the user
  could open themselves. A department manager gets no insight drawn from
  another department's incidents.
- **Who reported is never an input.** The reporter's identity, and whether a
  report was anonymous, are not given to the assistant, so no suggestion can
  reveal or depend on it.
- **People are not the subject.** The assistant is not asked about, and does
  not name, an individual as a cause. It reasons about tasks, equipment,
  environment, process and organization. A suggestion that would single out a
  person is not shown. This matters for trust: staff stop reporting if the
  system appears to find someone to blame.
- **Personal details are removed** from text before it leaves Trustline,
  unless the client runs the model itself.
- **Nothing crosses clients.** No client's records inform another client's
  suggestions, and none are used to train a model.

## How a suggestion appears

- In place, beside the thing it concerns, in a panel marked as AI
  suggestions; never mixed into the record.
- Each one has: what is suggested, **why** (the records and passages it rests
  on, as links), and how sure the assistant is in plain words (several
  similar cases, or a single weak signal).
- Three choices: **use it** (it becomes a draft the person edits and saves
  under their own name), **dismiss it** (with an optional reason), or
  **ignore it**.
- **Root-cause and factor suggestions are hidden until the investigator asks
  for them**, and the investigation asks the team to record its own first
  view before showing them. A suggestion seen too early steers people toward
  it.
- When there is too little to go on, it says so and suggests nothing.

## When it runs

"Automatically" is kept modest, for cost and for noise:

- **On request** from a button, for anything expensive (causes, clusters, a
  draft report).
- **Once, quietly, when a report arrives**: the triage suggestions only,
  because they are cheap and timely. A client can turn this off.
- **On a schedule** for the digest and for trends, weekly or monthly as the
  client sets.
- It never sends a notification of its own for a single incident; it adds to
  what people already look at.

Each run uses credits from the client's AI allowance. Scheduled and
on-arrival runs stop first when the allowance is nearly used, so that
on-request help remains.

## Safeguards

- **Shown as a suggestion, always**, with its basis. No suggestion without
  evidence the user can open.
- **Recorded.** What was suggested, to whom, from which records and which
  model, and what the person did with it, are kept. An accepted suggestion is
  marked in the record's history as having started from the assistant.
- **No decision by default.** Leaving a suggestion untouched changes
  nothing: there is no "accept all", and nothing is accepted by a timer.
- **Checked for quality.** The share of suggestions used and dismissed, per
  kind, is visible to the client and to Trustline. A kind that is mostly
  dismissed is switched off or improved. Dismissal reasons are the feedback.
- **Each client chooses**, per kind of suggestion, what is on; all are off
  until switched on.
- **Honest about limits.** Trends from a handful of records are labelled as
  such. The assistant does not give legal, clinical or engineering advice,
  and says so where a suggestion touches those.
- **Languages.** Suggestions are given in the user's language; quality in
  Arabic needs checking with native reviewers before a client relies on it.
- **Data residency** follows the client's region, as for drafting.

## What has to exist first

Suggestions are only as good as the records under them.

| Suggestion | Needs |
|---|---|
| Triage help, duplicates, closure summary | Incidents (built) |
| Similar incidents | Incidents, with enough history at that client |
| Factors, causes, report draft | The investigations module (not built) |
| Actions to consider, effectiveness | The actions module (not built) |
| Links to risks, procedures, training | Those modules (not built) |
| Clusters and trends | A few hundred incidents at one client to be meaningful |

So the first step that can be built soon is small: triage suggestions,
duplicate detection and the closure summary on incidents. The rest follows
the modules.

A new client has no history. Until it has, suggestions come from its
procedures and profile only, and trend features stay off; this should be
said plainly at onboarding and in sales.

## Data to add (outline, not a schema)

- `ai_suggestions`: what was suggested, kind, the record it concerns, the
  records it was based on, model, when, for whom.
- `ai_suggestion_outcomes`: used, changed, dismissed, with who and why.
- `ai_settings`: per client, which kinds are on and when they run.
- A search index over the client's own records, kept inside the client's
  data region and under the same separation between clients, for finding
  similar cases.
- Use is metered through `ai_usage` (see `modules-and-subscriptions.md`).

## Decisions taken

1. **First suggestions:** the three on incidents: triage help, duplicate
   detection, and the draft closure summary.
2. **Root cause:** offered as hypotheses to test, each with what would
   confirm it and what would rule it out; never a single answer.
3. **Running on its own:** each client opts in. The scheduled digest and
   trend check can run daily, weekly or monthly, as the client sets.
4. **Learning stays inside the client.** Suggestions draw on that client's
   own data only. Nothing is learnt from, or shared with, another client.
5. **No medical suggestions.** The assistant does not suggest anything
   clinical: no diagnosis, no treatment, no clinical cause, no clinical
   action. Where a record is about clinical care it keeps to organization and
   process (staffing, handover, equipment, the procedure that applies) or
   suggests nothing. A legal view is still wanted before sale to healthcare
   clients, but the product does not rely on it: this rule holds everywhere.
6. **Always marked as a suggestion.** Every place a suggestion appears
   carries the same plain notice, in the user's language, that cannot be
   switched off or styled away:

   > This is a suggestion from the AI assistant, based on the records listed
   > below. It can be wrong or incomplete. Check it and investigate further
   > before you decide.

   The notice is repeated in anything exported or printed that contains a
   suggestion, and a text that began as a suggestion says so in its history
   after a person has taken it over.

## Still to decide

- **Who sees suggestions:** everyone who handles a record, or the quality
  office first.
- **The AI service and where it runs**, as for drafting.
