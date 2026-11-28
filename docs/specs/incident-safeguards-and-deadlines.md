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
  language, its time zone (`timeZone`, so the form can ask "when did it
  happen" on the hospital's clock as the staff form does), its active org
  units (id, parent, type, name) and active categories. 404 if the hospital
  does not exist, is suspended, or has public reporting off: the three cases
  must look the same, and take the same time (see "Protection").
  > **Added after the browser regression (API engineer).** It also carries
  > `paused: boolean` and `retryAfterSeconds: number | null`: whether the
  > hospital's hourly ceiling of public reports is reached, and if so how
  > long until it frees a place, so that the form can say so before a sender
  > writes a whole report. See "Decided after the browser regression".
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
  attempt at the code, not two. With a right code it can still be refused,
  in two ways (decided after the third security review):
  - 409 `incident_ended` once the incident is `closed` or `rejected`. Nobody
    is working on it then, and a code cannot be taken back. Reading with the
    code still works, and a reopened incident takes comments again. (Staff
    who are signed in may still comment on an ended incident.)
  - 429 `too_many_requests`, with `Retry-After`, when the incident has had
    10 comments by code in the last 24 hours, whatever addresses they came
    from. Counted in the database, so it is the same for every API process.
    `Retry-After` can be most of a day here, where the limits per address
    never say more than an hour.

  These two come only after the code has proved right, so they are not part
  of the rule that every refusal looks the same: they are answered at once
  and plainly, to someone who already holds the code and learns nothing from
  them that the view itself does not tell. A wrong code on the same route is
  the same 404 as ever.

`incidents.channel`: `app` (default, signed in) | `public`.

Protection, since these routes are open to the internet:
- A limit per IP address: 10 reports an hour, 30 follow-up attempts an hour
  and 60 openings of the report form an hour, answered with 429
  `too_many_requests`. An in-memory limiter is acceptable for now; say so in
  the README (it is per server process). An IPv6 address is counted as its
  /56 network, which is what one home connection is handed.
- A wrong code answers the same 404, in the same time, whether the hospital
  is active, is suspended or does not exist (compare hashes in constant
  time; do the same work on every path).
  > **Changed after the third security review (API engineer).** "The same
  > time" is kept by a step, not by the work being equal to the last tenth
  > of a millisecond: every 404 of the four public routes (no hospital, a
  > suspended one, a form that is off, a wrong code) is held until the next
  > multiple of 50 milliseconds since the request was taken up. Normally
  > that is one step; when the server is so busy that the work takes longer,
  > the answer still leaves on a step. A 400 for a malformed request and a
  > 429 are answered before anything is looked up, and say nothing of a
  > hospital.
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
  When it is typed or pasted back, only the characters of that alphabet are
  read: letter case does not matter, and everything else is left out
  (hyphens, spaces, punctuation, and the invisible direction marks a phone
  puts around text pasted into a right-to-left field), so none of it costs
  the reporter an attempt.
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
  > **Added after the third security review (API engineer).** The database
  > keeps this itself. A trigger on `incidents` raises the flag whenever a
  > row is, or until that change was, a sentinel event or a death, and
  > ignores any change of the flag from true to false: the rest of such a
  > change is stored, the flag stays. So a release that knows nothing of the
  > flag, a script or a mistake can neither clear it nor fail to set it.
  >
  > **Changed after the second quality review.** A report through the public
  > link does not start this from the sender's own harm level: the flag is
  > raised only once a triager grades it sentinel or death. The trigger keeps
  > the same rule (migration 0030): a public report's grade counts once it
  > has a `first_triaged_at`. Reports by signed-in staff are unchanged.
- **"By the reporter" is decided when a comment is written,** not when it is
  read: it is true only when the writer had no more than the reporter's own
  access, or used a follow-up code. A handler who also reported the incident
  comments under their own name like any other handler, so nothing about a
  comment tells a reader who reported.
  > **Added while building (API engineer): comments stored before this.**
  > What access a writer had was never recorded, so it cannot be decided
  > afterwards for an old comment that everyone may read. Every such comment
  > whose author is the incident's reporter is therefore kept as "by the
  > reporter", exactly as each reader has been shown it so far; no name
  > appears where none did. New comments also record the other capacity
  > (`as_handler`), so that a comment written by a release that records
  > neither is read the same cautious way instead of showing the reporter's
  > name.
  >
  > **Changed after the third security review.** For an *internal* comment
  > it can be decided: only someone who saw all of the incident could write
  > one, so its author wrote it as a handler. Marked "by the reporter", it
  > told whoever reads the internal comments that the report was a named
  > one, made by a colleague with full access. A migration records every
  > stored internal comment of an incident's reporter as written by a
  > handler, and an internal comment is never read as the reporter's,
  > whatever is stored with it. Such a comment now carries its author's
  > name, like any handler's.
- **A withdrawal note is not shown to the reporter,** like a sent-back note.
- **Signing off needs the `revision`** the signer was looking at.
- **The address limit is not the only limit.** Each hospital also has a
  ceiling of 60 public reports an hour whatever addresses they come from; when
  it is reached the public form answers 429 until the hour moves on, and the
  quality office is not buried. (Since the browser regression the form's
  page says so before anything is written: `paused`, above.) The limiter only accepts a real IP address as
  a key. The README states what must sit in front of the web app for the
  address limit to mean anything.

### Decided after the third security review

Where a rule above changed, it says so in its place. The rest:

- **A form held shut is not silent.** The first time in an hour that a
  hospital's ceiling turns a public report away, the hospital's audit log
  gets an entry `public_reporting_limit_reached` (no actor, no address,
  nothing of what was sent; `changes` holds the limit) and the server log
  one warning with the hospital's id. Once an hour per hospital, however
  many are turned away. (Since the second quality review it is also
  notified: `public_form_paused`, below.)
- **Nobody queues for a hospital's turn.** Public reports to one hospital
  are counted one at a time. A report that arrives while another is being
  stored is not kept waiting, holding a database connection: it is answered
  429 `too_many_requests` with `Retry-After: 1` and is to be sent again.
  The form must keep what was typed and offer to send it again, as it must
  for the ceiling. A report that is refused for what it says (400: unknown
  category or unit, harm that does not fit its type) is refused before its
  turn is asked for: it is answered 400 even when the hospital's ceiling is
  reached, where it was 429 before. (The limit per address still comes
  before everything.)
- **Text a client writes carries no control characters.** Every name, code
  and free text on every route is refused (400) with a C0 or C1 control
  character or DEL in it; a name, which is one line, also with a tab or a
  line break. Free text keeps its tabs and line breaks. What Arabic and
  French are written with is none of these and is stored as written: the
  zero-width joiner and non-joiner, the direction marks, the non-breaking
  spaces. The organization and the email of a sign-in, and the organization
  of a set-password link, are refused the same way, before anything is
  looked up, so that the answer is the same whether or not the hospital
  exists.
- **The public routes can be verified from outside.** The README gives the
  check to run on a host before a hospital switches public reporting on.

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
edited, and validated against the names the runtime knows. No offset is
taken, under any spelling: the whole `Etc/` area (`Etc/GMT+3`, `Etc/UTC`) is
refused, and UTC is written `UTC`. The name is stored in the letter case
IANA writes it, whatever was typed (`asia/riyadh` is stored `Asia/Riyadh`);
a second spelling of a zone that the runtime does not list (`Asia/Kolkata`
beside `Asia/Calcutta`) is kept as chosen, and taken only when each of its
parts starts with a capital letter. Every "day" the
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
  > moves to a moment still to come, it is another deadline, and is
  > announced in its turn.
  >
  > **Changed after the second quality review.** What was announced is no
  > longer cleared when the deadline moves; it is kept with the deadline it
  > was announced for (`close_due_soon_for`, `close_overdue_for`), and a
  > closing deadline is announced at a stage only if it is later than the
  > last one announced there. So changing the harm level back and forth,
  > between two deadlines still to come or between one past and one to come,
  > never repeats a `due_soon` or an `overdue`.
  >
  > **Changed after the third security review.** When it moves to a moment
  > already past, what was announced stands. Otherwise whoever may triage
  > could have an overdue incident announced again, to the assignee and to
  > everyone who triages for the whole organization, as often as they
  > changed its harm level. If nothing was announced yet (the old deadline
  > had not passed), the next check announces the missed one, once.
  >
  > **Changed after the browser regression.** Triage still never moves
  > `triage_due_at`. A reopening does, for a report set aside before triage,
  > which goes back to `new`: it gets a triage deadline counted from the
  > reopening. The one its setting aside was judged by is kept for "triaged
  > on time" (`incidents.first_triage_due_at`), so that reopening can neither
  > excuse a late decision nor spoil a timely one. See "Decided after the
  > browser regression".
- `triage_due_at` stops mattering once the incident leaves `new`.
  `close_due_at` stops mattering once it is `closed` or `rejected`.
  > **Changed after the second quality review: reopening gives a new
  > closing deadline**, counted from the reopening under the rules in force
  > (`incidents.close_due_from` records when that time started; a later
  > regrading counts from it too, and so does "due soon"). The deadline it
  > had stays on the timeline: the `reopened` entry's details carry
  > `closeDueAt: { from, to }`, as does its audit entry. Someone who sees the
  > incident only as its reporter does not get that part of the details.
  > (Since the browser regression a report set aside before triage also
  > gets a new triage deadline when reopened, carried the same way as
  > `triageDueAt: { from, to }`, and counted from
  > `incidents.triage_due_from`.)
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
  >
  > **Changed after the second quality review.** Counted: the reports of
  > the last 30 days that have been triaged, or set aside (which records
  > `first_triaged_at` at that moment; migration 0030 records it for those
  > set aside before), or are still `new` past their triage deadline, which
  > count as late. On time: first triage no later than the deadline.
  >
  > **Changed after the browser regression.** "The deadline" is the one the
  > first decision was made under: `first_triage_due_at` where a reopening
  > replaced it, `triage_due_at` otherwise. `first_triaged_at` is set once,
  > by the first triage or setting aside, and a report reopened to `new` and
  > triaged again keeps it. Such a report is counted by that first decision,
  > not as one still waiting; while it waits again it is counted, like any
  > report in `new`, in `awaitingTriage` and, past its new deadline, in
  > `overdue`.
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
  >   `reopened`). Since the second quality review every `data` also
  >   carries `serious: boolean` (severe harm, death or sentinel, as the
  >   incident stands when the notification is written).
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
  >
  > **Changed after the browser regression.** A report reopened to `new` has
  > a new triage deadline, so what was announced of the old one
  > (`triage_due_soon_at`, `triage_overdue_at`) is cleared with the
  > reopening, as the closing marks are; "due soon" counts its quarter from
  > the reopening (`triage_due_from`). The new deadline is at least an hour
  > away, so no reopening can have an overdue announced at once.
  >
  > **Added after the third security review.**
  > - A run that did something writes one line to the server log (how many
  >   notifications, how many hospitals failed); a hospital whose check
  >   failed is named with the kind of failure, never with anything from a
  >   record; a run that could not start says so. None fails in silence.
  > - No statement of the check may take longer than 30 seconds, waiting
  >   for a lock included. A hospital it cannot finish is left for the next
  >   run, and the others are checked.
  > - Notifications are written in pieces of a thousand, so no batch is too
  >   large to be sent.
  > - The check can be run for named hospitals only. The API never does;
  >   tests do, because they share a database with hospitals they did not
  >   make and run the check as of moments that are not now.
- `GET /notifications?unread=&page=&pageSize=` → the caller's own, newest
  first, each with the incident's reference and whether the caller can still
  open it. `GET /notifications/count` → `{ unread }`.
  `POST /notifications/:id/read`, `POST /notifications/read-all`.
- A user only ever reads and marks their own.

> **Email (added later, `email.md`).** Some of these notifications are also
> sent by email, from a queue written in the same transaction: at once,
> `incident_reported` and `incident_handed_over` when the incident is
> serious, and `sentinel_flagged`, `incident_assigned` and
> `sign_off_requested` always; the incidents assigned to a person, with how
> many are overdue, in their morning digest. The email says what the
> notification says (the reference, "serious") and links to the incident.

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

## Decided after the second quality review

Where a rule above changed, it says so in its place. The rest:

- **Not taken forward after triage.** `rejected` can be reached from
  `triaged` as well as `new`, note required, for anything not serious. Not
  for an incident that has needed sign-off (`sign_off_needed`), whatever it
  is called now: one person would otherwise end it without the second
  signature (409 `serious_cannot_be_rejected`). From `new` it records
  `first_triaged_at`.
  > **Changed after the browser regression:** a report set aside is no
  > longer reopened to `in_progress`. See "Decided after the browser
  > regression".
- **The channel filter.** `GET /incidents?channel=app|public`. Refused with
  403 `missing_permission` (`incidents.see_reporter`) to a caller who holds
  that right nowhere. For one who holds it somewhere it matches only the
  incidents whose reporter they are told of (they reported it, or the right
  covers its unit or handling department); any other incident matches
  neither value, so the filter cannot tell an anonymous report from a named
  one. List items carry `channel` on the same rule (null otherwise).
- **The category filter.** `GET /incidents?categoryId=<uuid>`; a category of
  another hospital finds nothing.
- **List items carry `access`** (`full` | `reporter`), as the detail does.
- **Who else could sign off.** The incident carries `signOff: { others }`
  for a reader with full access when it needs sign-off, null otherwise:
  how many active people hold `incidents.sign_off` covering it and see all
  of it, other than the one who asked for the closure it awaits (or, before
  anyone has asked, the reader, who would be the one to ask). 0 means nobody
  else could sign.
- **A missed closing deadline while awaiting sign-off** is told, as
  `overdue`, also to those who may sign it off (not the requester).
- **Handover.** `incident_handed_over` also reaches holders of
  `incidents.view` over the new handling department who could neither view
  nor triage it before through the unit where it happened or the old
  department (the department's managers). The triage part is unchanged.
- **`sentinel_flagged`**: when triage makes an incident a sentinel event,
  to those who may sign it off and can see it, and to those who triage for
  the whole organization, never the triager. Separate from an assignment or
  a handover in the same triage, so it is not folded into either.
- **`public_form_paused`**: when the hourly ceiling first turns a public
  report away (the moment of the audit entry, once an hour), to everyone
  holding `settings.manage` or `incidents.triage` for the whole
  organization. It is about no incident: `notifications.incident_id` is
  null for this kind only (a database check), and `GET /notifications`
  gives it `incident: null`. `data` is `{ limit, serious: false }`.
- **The follow-up view's `hospital`** carries `timeZone` too.

### Left open by the third security review, done in this step

- **`tenants.time_zone` is checked by the database**
  (`tenants_time_zone_shape`): `UTC`, or Area/Location with at most one more
  part, each starting with a capital letter or a digit, nothing in `Etc/`.
  Which names exist stays the API's check, against the runtime.
- **Deadlines the check fills in are audited**: one entry per incident,
  `incident_deadlines_filled`, no actor, `changes` the deadlines given
  (`{ from: null, to }`).
- **Changing the harm level back and forth repeats nothing**: see section 4.

## Decided after the browser regression

The browser regression of incident reporting (HEAD a244e5b) left two points
for a decision. Where a rule above changed, it says so in its place.

### The public form says it is paused before anything is written

`GET /public/reporting/:slug` answers, besides what it gave before, either
`"paused": false, "retryAfterSeconds": null` or, for example,
`"paused": true, "retryAfterSeconds": 587`.

- `paused` is true when the hospital's hourly ceiling of public reports is
  reached, by the same count `POST /public/reporting/:slug` refuses with
  (the newest-but-59 public report of the last hour exists). Then
  `retryAfterSeconds` is the time until that report is an hour old, in
  whole seconds rounded up and never less than 1, as the POST's
  `Retry-After` gives it.
- It says nothing the POST's 429 does not: not how many reports came, not
  how close a hospital is to its ceiling while it is not paused, and not
  that another report is being stored at this moment (the 429 with
  `Retry-After: 1` of "Nobody queues": the GET does not ask for that turn,
  so it stays `paused: false` then). Nothing finer than whole seconds, so
  the report that holds the hour is not dated to the millisecond.
- Reading it writes nothing: the audit entry `public_reporting_limit_reached`
  and the `public_form_paused` notification still come from the first
  report turned away in an hour, not from a page being opened.
- Every 404 is unchanged in shape (`{ statusCode: 404, message: "Not Found" }`)
  and in time: the hospital is looked up and refused before the count is
  read, so a hospital with its form off, a suspended one and one that does
  not exist are refused on the same step whether or not their hour is full.
- The POST is unchanged. A form opened just before the ceiling was reached
  still gets the 429 when it is sent, and must keep what was typed.

### Reopening a report that was set aside

Reopening a `rejected` report returns it to where the setting aside took it
from:

| Set aside from | Reopened to | Deadlines |
|---|---|---|
| `new` (nobody had triaged it) | `new` | triage and closing deadlines, both counted from the reopening |
| `triaged` | `triaged` | a closing deadline counted from the reopening; the triage deadline it had |
| (a closed incident, unchanged) | `in_progress` | a closing deadline counted from the reopening |

- **Back to `new`** it is triaged like any new report: it waits in
  "awaiting triage", has no handling department, and is triaged or set
  aside again. `moves` offers it `reject` only, and `canRetriage` is true.
- **Decided: a report triaged before it was set aside returns to
  `triaged`, not `new`.** Its triage was a decision on its merits, with a
  handling department, a grade and perhaps an assignee, and setting it
  aside did not undo any of that (all of it is kept on the record). Only
  the setting aside is taken back. Sending it to `new` would put a report
  that already has a department back in the triage queue, under a second
  triage deadline for work already done. Whether a report "had been
  triaged" is `triaged_at`, which only triage sets and nothing clears; so a
  report in `new` has never been triaged, whether or not it was reopened.
- `POST /incidents/:id/status` with `to: "new"` or `to: "triaged"` (kind
  `reopen`), note required. A move to `in_progress` from `rejected`, or to
  whichever of the two does not apply, is 409 `invalid_transition`: the
  screen follows `moves`, which offers the one that applies.
- The `reopened` timeline entry and the audit entry carry the deadlines it
  had beside the new ones: `closeDueAt: { from, to }` always, and
  `triageDueAt: { from, to }` when it goes back to `new`. Someone who sees
  the incident only as its reporter gets neither. The named reporter and
  the assignee are told `status_changed` with `change: "reopened"`, as for
  a closed incident.
- **"Triaged on time"** judges the first decision (the first triage or
  setting aside, `first_triaged_at`) by the deadline it was made under: a
  reopening keeps that deadline in `first_triage_due_at` (the first time
  only), and a later triage does not move `first_triaged_at`. A late
  setting aside stays late after reopening; a timely one stays timely even
  if the reopened report then misses its new deadline.
- **Deadlines** of a report back in `new`: overdue for triage past the new
  `triage_due_at` (the summary's `overdue`, `overdue=true`, `sort=due`);
  the deadline check announces the new deadline in its turn (section 5).
- **Sign-off.** A report can only be set aside while it is not serious and
  has never needed sign-off, so a reopened one starts without the flag. A
  triage after the reopening that makes it a sentinel event or a death
  raises `sign_off_needed` as any triage does; from then on it needs the
  second signature and cannot be set aside again, whatever it is called
  later. A report through the public link that was set aside has
  `first_triaged_at`, so its grade counts as a member of staff's; that
  grade was not serious, or it could not have been set aside.
- Migration 0031 adds `incidents.triage_due_from` and
  `incidents.first_triage_due_at`, both nullable; nothing existing changes.
