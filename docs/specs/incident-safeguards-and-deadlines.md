# Incident reporting, second step: safeguards, deadlines and notifications

Read `CLAUDE.md`, `README.md` and `docs/specs/incident-reporting.md` first.
This file adds to that one and wins where they differ. If something here is
impossible or wrong, say so in your report rather than quietly doing
something else.

Four decisions taken by the business after the quality review:

1. Only the quality office sees who reported an incident.
2. A report can be made without signing in (a link or QR code), and an
   anonymous reporter gets a follow-up code to come back to their report.
3. Closing a sentinel event needs a second person to sign it off.
4. Deadlines and notifications are in the first release.

Still out of scope: patient identifiers, attachments, investigations,
actions, regulator reports, working-hours calendars, SMS, and sending email
(notifications are stored so that an email sender can be added once the
hospital's mail server is known; nothing is sent by email in this step).

## 1. Who sees the reporter

New permission `incidents.see_reporter`. The built-in Administrator and
Quality officer roles hold it; Department manager and Reporter do not.
Existing clients get it added to those two built-in roles by a migration or
by `ensureSystemRoles`, whichever the code already uses for built-in roles.

- A caller sees the reporter's identity on an incident only if they are the
  reporter, or hold `incidents.see_reporter` covering the incident's
  `org_unit_id` or `owner_unit_id`.
- Everyone else who can see the incident gets `reporter: null` and
  `reporterShown: false`. They are not told whether the report was anonymous
  or named: both look the same to them. Someone allowed to see it gets
  `reporterShown: true`, and `reporter: null` then means anonymous.
- The same hiding applies everywhere the reporter could leak: the actor of
  the `reported` event, the author of any comment the reporter wrote, the
  actor of the matching `commented` events, and the `people` map. Those come
  back with no person and `byReporter: true`, so the screen can say "the
  reporter".
  > **Changed while building (API engineer, section 1): the `people` map is
  > not altered.** It names only the people that timeline entries point at as
  > the one an incident was *assigned to*; the reporter was never in it as
  > reporter, so there is nothing to hide. A reporter who is also the assignee
  > stays in it, as the assignee: taking them out would make the one missing
  > name the giveaway. `byReporter` is carried by timeline entries and
  > comments (always present, true or false), not by the map.
- The reporter's own view is unchanged.
- Assignable users, lists and summaries never carried the reporter; check
  that this is still true.

## 2. Reporting without signing in, and the follow-up code

### Switching it on

`tenants.public_reporting` boolean, default false. A hospital user holding
`settings.manage` for the whole organization turns it on or off
(`GET /settings/reporting`, `PUT /settings/reporting`), audited. While it is
off, the two `/public/reporting` routes below answer 404 for that hospital.

The two follow-up routes do not depend on the switch (decided after the
first build): they answer for every active hospital. A code given to a
signed-in member of staff who reported anonymously must work in a hospital
that never opens the public form.

### Public routes (no session; under `/api/v1/public`)

- `GET /public/reporting/:slug` → the hospital's name, languages and default
  language, its active org units (id, parent, type, name) and active
  categories. 404 if the hospital does not exist, is suspended, or has public
  reporting off: the three cases must look the same.
- `POST /public/reporting/:slug` → the same body as `POST /incidents` without
  `anonymous` (a public report is always anonymous). Stored with
  `reported_by` NULL and `channel = 'public'`. Answers 201 `{ followUpCode }`
  and nothing else. A public report gives no incident number (decided after
  the security review): the numbers run in one series, so handing one to
  anyone who files a public report would tell them how many incidents the
  hospital has had. The same 404 as the route above.
- `POST /public/follow-up/:slug` body `{ code }` → 200 with the reporter's
  view of the incident (what `access: "reporter"` gives a signed-in
  reporter), read with the code alone: no reference is asked for, and one
  sent is refused like any other unknown field. A wrong code, an unknown
  hospital and a suspended one answer the same 404. The view read with a code
  differs from a signed-in reporter's in three ways:
  - It carries no `reference` and no internal `id`, for the reason a public
    report is given no number.
  - It names no member of staff (decided after the first build). The actor
    of an event and the author of a comment written by staff come back with
    no person and `byStaff: true`, and the `people` map is empty. A named
    reporter who is signed in sees names as before.
  - It carries `hospital: { name, locales, defaultLocale }`, for the page to
    show whose report this is and in which languages. Only a view carries
    it: a refusal says nothing of the hospital.
- `POST /public/follow-up/:slug/comments` body `{ code, body }` → adds an
  `everyone` comment written by the reporter, and answers 201 with that same
  view as it now reads, the comment included. So writing a comment costs one
  attempt at the code, not two.

`incidents.channel`: `app` (default, signed in) | `public`.

Protection, since these routes are open to the internet:
- A limit per IP address: 10 reports an hour and 30 follow-up attempts an
  hour, answered with 429 `too_many_requests`. An in-memory limiter is
  acceptable for now; say so in the README (it is per server process).
- A wrong code answers the same 404, in the same time, whether the hospital
  is active, is suspended or does not exist (compare hashes in constant
  time; do the same work on every path).
- The body limits of `POST /incidents` apply. No free text reaches a log.
- Nothing about the sender (IP address, user agent) is stored with the
  incident, its events or the audit log. The audit row says a public report
  was received and nothing more.

### The follow-up code

- Every anonymous report gets one, whether it was made signed in with
  "report anonymously" or through the public route. So `POST /incidents`
  answers `{ id, reference, followUpCode }` when `anonymous` is true: a
  signed-in member of staff who reports anonymously still gets their
  reference with the code, and follows up with the code alone like everyone
  else.
- 16 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown in
  groups of four (`K7QM-2RXD-9FHT-WB3N`), generated with the system's secure
  random source. Only a hash is stored (`incidents.follow_up_code_hash`).
  Case and hyphens are ignored when it is typed back.
- It is shown once and cannot be recovered or reissued.
- A signed-in user can also use it: the follow-up page works with or without
  a session, and never links the code to the session.

### Decided after the security review

That a public report gives no incident number, and that follow-up takes the
code alone, are written into the sections above. The rest:

- **Once an incident has needed sign-off, it needs it to close.** Lowering
  the harm level or clearing the sentinel flag afterwards does not remove the
  second signature (`incidents.sign_off_needed`, set when the incident is
  reported or triaged as sentinel or death, never cleared).
- **"By the reporter" is decided when a comment is written,** not when it is
  read: it is true only when the writer had no more than the reporter's own
  access, or used a follow-up code. A handler who also reported the incident
  comments under their own name like any other handler, so nothing about a
  comment tells a reader who reported.
  > **Added while building (API engineer): comments stored before this.**
  > What access a writer had was never recorded, so it cannot be decided
  > afterwards for an old comment. Every stored comment whose author is the
  > incident's reporter is therefore kept as "by the reporter", exactly as
  > each reader has been shown it so far; no name appears where none did.
  > New comments also record the other capacity (`as_handler`), so that a
  > comment written by a release that records neither is read the same
  > cautious way instead of showing the reporter's name.
- **A withdrawal note is not shown to the reporter,** like a sent-back note.
- **Signing off needs the `revision`** the signer was looking at.
- **The address limit is not the only limit.** Each hospital also has a
  ceiling of 60 public reports an hour whatever addresses they come from; when
  it is reached the public form answers 429 until the hour moves on, and the
  quality office is not buried. The limiter only accepts a real IP address as
  a key. The README states what must sit in front of the web app for the
  address limit to mean anything.

### Comments by an anonymous reporter

`incident_comments.author_id` becomes nullable and gains `by_reporter`
boolean default false. A comment made with a follow-up code has no author and
`by_reporter = true`. The `commented` event has no actor. Handlers see it as
written by "the reporter".

## 3. Second sign-off for a sentinel event

Applies to an incident that is sentinel or whose harm level is death (below:
"needs sign-off").

- New status `awaiting_sign_off` and new permission `incidents.sign_off`,
  held by the built-in Administrator and Quality officer roles.
- For an incident that needs sign-off, the move to `closed` from `triaged` or
  `in_progress` is replaced by a move to `awaiting_sign_off` (note required;
  it is the proposed closure summary). `incidents.closure_requested_by` and
  `closure_requested_at` record who asked and when.
- From `awaiting_sign_off`:
  - `closed`, by someone who holds `incidents.sign_off` covering the incident
    and is not the person who requested closure: 403 `same_person` if they
    are, 403 `missing_permission` without the right. An optional note is
    added to the timeline.
  - `in_progress` (sent back), by the same kind of person, note required.
  - `in_progress` (withdrawn), by the person who requested it or anyone who
    may triage it, note required.
- Triage is not possible while `awaiting_sign_off`. If an incident stops
  needing sign-off it could only be by triage, so that cannot happen while it
  waits.
- An incident that does not need sign-off closes as today.
- `moves` on `GET /incidents/:id` reflects all of this for the caller.
  > **Added while building (API engineer, section 3, asked for by the web
  > engineer): every move has a `kind`.** Sending back and withdrawing both
  > lead to `in_progress`, and someone who may sign off and triage may do
  > either, so `to` alone does not say which is meant. Each entry of `moves`
  > is `{ to, noteRequired, kind }`, with `kind` one of `start`, `close`,
  > `reject`, `reopen`, `request_sign_off`, `sign_off`, `send_back`,
  > `withdraw`. `POST /incidents/:id/status` takes an optional `kind`: from
  > `awaiting_sign_off` to `in_progress` it is required (400 `kind_required`),
  > elsewhere it is checked when sent (409 `invalid_transition` if no move of
  > that kind leads there). A withdrawal is written to the timeline as
  > `status_changed` with `details.withdrawn: true`; no fourth event kind was
  > added.
- New event kinds: `sign_off_requested`, `signed_off`, `sent_back`. All
  visible to the reporter except the notes of `sent_back`.
- `awaiting_sign_off` counts as open in the summary.

## 4. Deadlines

### Rules

`incident_response_rules`, one row per hospital per harm level:
`triage_within_hours`, `close_within_days`. Created with the hospital (and
for existing hospitals) with these starting values, which each hospital is
expected to change:

| Harm level | Triage within | Close within |
|---|---|---|
| none | 72 hours | 30 days |
| mild | 72 hours | 30 days |
| moderate | 48 hours | 30 days |
| severe | 24 hours | 45 days |
| death | 24 hours | 45 days |

A sentinel incident uses the `death` row whatever its harm level.

`GET /settings/response-rules` (anyone who may triage or holds
`settings.manage`), `PUT /settings/response-rules` (`settings.manage` for the
whole organization; hours 1 to 720, days 1 to 365), audited with from and to.

Hours and days are calendar time. Working-hours calendars come later.

### The hospital's own day

`tenants.time_zone`: an IANA name (for example `Asia/Beirut`), default `UTC`,
set by Trustline staff in the admin portal when the client is created or
edited, and validated against the names the runtime knows. Every "day" the
API works out for a hospital uses it: the `from` and `to` list filters, and
"the last 30 days" in the summary. `GET /auth/me` returns it as
`tenant.timeZone`, so screens show dates in the hospital's time, not the
browser's. The client is never asked for an offset.

### On the incident

- `triage_due_at` = reported time + the rule's hours. `close_due_at` =
  reported time + the rule's days. Both are set when the report is made, from
  the harm level the reporter gave, and recalculated at each triage that
  changes harm level or the sentinel flag (always counted from the reported
  time). A change to the rules does not move deadlines already set.
  > **Changed while building (API engineer, section 4): only `close_due_at`
  > is recalculated at triage. `triage_due_at` never moves.** Every triage
  > takes the incident out of `new`, so a recalculated triage deadline could
  > never again be waited for; all it would change is whether the triage
  > just made counts as on time. Recalculated, a late triage becomes "on
  > time" by lowering the harm level in the same step, and a timely one
  > becomes "late" by raising it: the person being measured could move the
  > mark, and would be discouraged from raising a harm level. So the triage
  > deadline stays the one the triage was made under. When `close_due_at`
  > moves, what was announced about the old one is forgotten
  > (`close_due_soon_at`, `close_overdue_at` are cleared): it is another
  > deadline.
- `triage_due_at` stops mattering once the incident leaves `new`.
  `close_due_at` stops mattering once it is `closed` or `rejected`; reopening
  does not give a new deadline.
- An incident is **overdue for triage** when it is `new` and past
  `triage_due_at`; **overdue for closure** when it is `triaged`,
  `in_progress` or `awaiting_sign_off` and past `close_due_at`. This is
  worked out when the incident is read, never stored.
- List items and the detail carry `triageDueAt`, `closeDueAt` and
  `overdue: "triage" | "closure" | null`. Someone who sees the incident only
  as its reporter does not get these.
- `GET /incidents` gains `overdue=true` and `sort=due` (the nearest live
  deadline first, overdue at the top). The summary gains `overdue` (count)
  and `triagedOnTime`: of the incidents reported in the last 30 days that
  have been triaged, the share triaged before `triage_due_at`, as a whole
  percentage, null if none.
  > **Added while building (API engineer, section 4).**
  > - "Triaged" is the first triage, kept in `incidents.first_triaged_at`:
  >   `triaged_at` moves with every later correction and would turn a timely
  >   triage into a late one.
  > - `overdue`, `triagedOnTime`, the `overdue=true` filter and `sort=due`
  >   count only incidents the caller sees in full. Otherwise a reporter
  >   would learn their own report's deadlines from a count or an order.
  > - The summary also returns `last30Days: { from, to }`, the hospital's
  >   days those 30 are, in the form the list's `from` and `to` take.
  > - `triage_due_at` and `close_due_at` may be null for an incident stored
  >   by a release that did not know of deadlines and was still running
  >   during a deployment. The deadline check fills them in on its next run.

## 5. Notifications

`notifications`: `user_id`, `kind`, `incident_id`, `created_at`, `read_at`,
`data` jsonb (reference and nothing a patient could be identified from: no
description, no comment text, no names of people).

| Kind | Sent when | To |
|---|---|---|
| `incident_reported` | a report is made | everyone who may triage the unit where it happened |
| `incident_assigned` | a person is assigned | that person |
| `incident_handed_over` | the handling department changes, the first time it is set included | those whose right to triage covers the incident through the new department and did not cover it before, through the unit where it happened or the department that handled it until then |
| `comment_added` | a comment is written | the reporter (for `everyone` comments, if named), the assignee, and whoever triaged it; while nobody is assigned and nobody has triaged it, everyone who may triage it (its unit or its handling department); never the author |
| `status_changed` | closed, not taken forward, reopened | the reporter (if named) and the assignee |
| `sign_off_requested` | closure of a sentinel event is requested | everyone who may sign it off, except the requester |
| `sign_off_decided` | signed off, sent back, or the request withdrawn by someone other than the requester | the requester |
| `due_soon` | a quarter of the allowed time is left | for triage: those who may triage it; for closure: the assignee, or those who may triage it if nobody is assigned |
| `overdue` | the deadline passes | the same people, plus everyone who may triage for the whole organization |

- Nobody is notified of their own action. A person who would be notified
  twice for one event gets one notification.
  > **Changed while building (API engineer, section 5).**
  > - **An anonymous report is told to everyone who may triage the unit, the
  >   reporter included if they are one of them.** Leaving them out would
  >   store, in who was not notified, exactly who made the report. For the
  >   same reason a comment written with a follow-up code on a report nobody
  >   has triaged yet is told to every one of them, whoever wrote it.
  > - **Nobody is notified who cannot open the incident**, whatever the table
  >   above says: only active users, and for `sign_off_requested` only those
  >   holders of `incidents.sign_off` who can also see the incident (the
  >   right to sign off opens nothing by itself); for a comment, whoever
  >   triaged it only while they can still see it; an internal comment never
  >   reaches someone who sees the incident only as its reporter.
  > - **`due_soon` for closure goes to those who may triage it also when the
  >   assignee's account has been switched off**, not only when nobody is
  >   assigned.
  > - **A notification names nobody.** `data` is the reference plus, by kind,
  >   `deadline` (`triage` | `closure`), `decision` (`signed_off` |
  >   `sent_back` | `withdrawn`) or `change` (`closed` | `rejected` |
  >   `reopened`).
- A notification is written in the same transaction as the change it
  announces.
- `due_soon` and `overdue` come from a background check that runs every five
  minutes in the API process. Each is sent once per incident per deadline
  (`triage_due_soon_at`, `triage_overdue_at`, `close_due_soon_at`,
  `close_overdue_at` on the incident record when it was sent). It must be
  safe with several API processes running: two of them must not both send.
  It works one hospital at a time inside `TenantDb.withTenant`.
  > **Added while building (API engineer, section 5).**
  > - A deadline already past when the migration ran, or already in its last
  >   quarter, is recorded as announced without anyone being notified.
  >   Otherwise a hospital would get one notification per old incident, per
  >   recipient, on the day it receives this release. Those incidents are
  >   still shown and counted as overdue.
  > - An incident found already past its deadline gets `overdue` only;
  >   `due_soon` is not sent after it.
  > - A suspended hospital is skipped; its deadlines are announced, once,
  >   when it is active again.
- `GET /notifications?unread=&page=&pageSize=` → the caller's own, newest
  first, each with the incident's reference and whether the caller can still
  open it. `GET /notifications/count` → `{ unread }`.
  `POST /notifications/:id/read`, `POST /notifications/read-all`.
- A user only ever reads and marks their own.

## Web

- **Reporter:** the incident page shows "Reported by" only when
  `reporterShown`. Otherwise it says that only staff the hospital has
  authorised, normally the quality team, can see it, in the same words for a
  named and an anonymous report. Comments and timeline entries by the
  reporter say "The reporter"; staff who are not named say "Hospital staff".
- **Report form:** tells the reporter who will see their name. After an
  anonymous report, the follow-up code is shown once, large, with a copy
  button and a plain warning that it cannot be shown again.
- **Public report page** `/[lang]/report/[slug]` (no sign-in, no app shell):
  the same form without the anonymous box, with `?unit=<id>` preselecting
  where it happened. Works on a phone, in plainer words than the staff form,
  and says what to do if someone is in danger now. After sending: the
  follow-up code and the address to come back to, and no incident number.
- **Follow-up page** `/[lang]/follow-up/[slug]`: the code alone, then the
  reporter's view with the comment box, with no staff names.
- **Settings** (`/[lang]/admin/settings`, `settings.manage`): the switch for
  reporting without sign-in, with the link; and the deadline table.
- **Admin portal:** the client form sets the hospital's time zone. Staff
  screens show every date and time in the hospital's time.
- **Organization:** when public reporting is on, each unit's page shows its
  reporting link and a QR code that can be printed.
- **Sign-off:** the status actions follow `moves` from the API (the screen no
  longer keeps its own copy of the rules). An incident awaiting sign-off says
  who asked and offers Sign off / Send back to those who may.
- **Deadlines:** the list shows the live deadline and an overdue mark, with
  an "Overdue" filter and "By deadline" order; the detail shows both dates;
  the dashboard shows the overdue count and the share triaged on time.
- **Notifications:** a bell in the shell with the unread count and a
  notifications page. Opening one marks it read and goes to the incident.
- All wording in the three dictionaries with identical keys.
