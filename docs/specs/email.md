# Email

Notifications are also sent by email (decision 4 of "Decided by the
business after the quality review" in `policies-and-procedures.md`). This
spec says what is sent, when, to whom and how. In-app notifications stay as
they are (`incident-safeguards-and-deadlines.md`, section 5, and
`policies-and-procedures.md`). Email is one more way of telling people about
the same events. It never tells anyone about something they would not be
notified of in the app.

The API builds all of this. The web screens (the preferences page and the
organization switch) are not built yet.

## 1. What is sent

Three kinds of email. Each one is about notifications that already exist.
Email adds no new events.

### Immediately: what cannot wait

When one of these notifications is written, an email for it is queued in
the same transaction. It is sent within about a minute.

| Notification | Only when | To | Why it cannot wait |
|---|---|---|---|
| `incident_reported` | the incident is serious (severe harm, death or sentinel) | those who may triage it (the in-app recipients) | The triage deadline for serious harm starts at 24 hours, and a death or sentinel event may have to be reported outside the organization. Someone has to act today, not tomorrow morning. |
| `incident_handed_over` | the incident is serious | those the handover brings to it (the in-app recipients) | For the new department this is the same as a new serious report. They were not told when it was reported. |
| `sentinel_flagged` | always (a sentinel event is serious by definition) | those who may sign it off and those who triage for the whole organization | Same reason as a serious report. The incident has just become serious. |
| `incident_assigned` | always | the person assigned | The incident's closing deadline is now that person's. They cannot work on it until they know about it. |
| `sign_off_requested` | always | those who may sign it off | A sentinel event or death cannot be closed until someone else signs. The closing deadline keeps running while it waits. |
| `document_step_assigned` | always | the assignees of the step | An approval route waits on each step in turn, and every step has a due date. Nobody else can decide it, and the steps after it cannot start. |

The other kinds are not sent immediately. Either they are not someone's
urgent work, or they come too often to be emails:

- `comment_added` and `status_changed` come often and ask nothing of the
  reader. In-app only.
- `sign_off_decided` tells the requester the outcome. No deadline turns on
  it. In-app only.
- `due_soon` and `overdue` go into the morning digest as "overdue" (see
  below). The deadline check could send them in bursts.
- `public_form_paused` asks nothing anyone can act on: the hourly limit is
  fixed. In-app only.
- `document_returned`, `document_approved`, `document_published` and
  `document_publish_failed` are in-app only. What they lead to (a draft to
  rework, a document to acknowledge) appears in the morning digest when it
  is someone's to do.
- `acknowledgement_*`, `review_*` and `document_step_overdue` are covered
  by the digest.

### The daily digest: what waits for the person

Once a day, at 07:00 in the organization's time zone (`tenants.time_zone`),
each active person gets one email listing what waits for them. Nobody is
sent an empty digest. If the API was not running at 07:00, the digest goes
out at the first run after that on the same day, and never on a later day:
one still unsent when the organization's day ends (tried again past
midnight) is dropped as `expired`, since the next morning has its own.

| Section | What | Module |
|---|---|---|
| Documents to acknowledge | published versions they are asked to acknowledge and have not, overdue ones marked | policies |
| Documents to review or approve | approval steps that are theirs to decide, overdue ones marked | policies |
| Periodic reviews due | documents they own whose review is within 60 days or past; and, for those who manage documents, reviews that are past | policies |
| Incidents assigned to them | open incidents assigned to them, overdue ones marked, with how many are overdue | incidents |

Each section gives a count and up to 10 references (incident references,
document numbers), each linked to the item. These lists are the same ones
the person sees on the screens ("Awaiting me", "Reviews", the library
filtered to "awaiting my acknowledgement", incidents "assigned to me"). They
are worked out when the digest is sent, with the same visibility rules.

### Weekly: overdue acknowledgements, to managers

When the policies daily check writes the weekly
`acknowledgements_overdue_digest` (the first run of each ISO week), an email
with the same counts is queued for each manager it goes to. It links to the
overdue acknowledgements screen.

## 2. What an email says

The same rules as the in-app notifications:

- **References and counts only:** an incident's reference, a document's
  number and version, which step (review or approval), a count. Never a
  description, a comment, a document's title or text, a patient's or
  customer's name, the name of whoever reported or acted, a harm level
  beyond "serious", or any other free text. The renderer is given those
  values and nothing else. It cannot add anything else, because nothing
  else reaches it.
- **A link to the item in Trustline**, built from `WEB_BASE_URL` and the
  recipient's language (`/<lang>/incidents/<id>`, `/<lang>/policies/<id>`,
  `/<lang>/policies/<id>/versions/<versionId>`, `/<lang>/policies/overdue`).
  Opening it requires signing in, and the screen applies its own access
  check.
- **In the recipient's language:** their preferred language
  (`users.preferred_locale`, set through the preferences route) if the
  organization works in it, otherwise the organization's default. English,
  Arabic or French. Arabic is right to left (`dir="rtl"` on the HTML).
  References are isolated from the surrounding text so they do not reorder.
- **Plain text and simple HTML:** both in every email (multipart). The HTML
  has no images, no external resources, no scripts, no tracking pixels, and
  no link to anywhere except Trustline itself.
- **Neutral for any organization:** "your organization", never "hospital".
  The organization's own name is shown in the footer.
- **Dates and terms as in the app** (language review 7): the digest's day
  is written as the web app writes a day in that language (medium style,
  Latin digits: "Nov 28, 2026", « 28 nov. 2026 », 28/11/2026), the day
  being the organization's own. The terms are the app's: in Arabic «حادث»,
  «خطير», «حدث جسيم», «كُلِّف», «الإقرار بالاطلاع», «اعتماد الإغلاق»; in
  French « vérification », « révision périodique », « prise de
  connaissance », « e-mail », with U+00A0 before « : » and U+202F before
  « ? ».
- **The wording** is in `apps/api/src/email/wording/<lang>.ts`, one file per
  language with identical keys and placeholders. `wording.spec.ts` checks
  this.
- **Headers:** `List-Unsubscribe` with `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` (RFC 8058), `Auto-Submitted: auto-generated`
  so out-of-office replies are not sent back, and a `Message-ID` that stays
  the same on every attempt of one message.

## 3. Who gets email, and how to stop it

An email is sent only if all of these hold when it is sent, not only when it
was queued:

1. **The organization has email switched on.** Its administrator
   (`settings.manage` for the whole organization) can switch email off for
   everyone. On by default. While it is off nothing is sent (queued emails
   are dropped as `organization_off`) and no digest is prepared.
2. **The person is active and has an email address.** Invited or disabled
   accounts get nothing. In SMTP mode, neither do addresses under a reserved
   domain that cannot receive mail (`.invalid`, `.test`, `.example`,
   `.localhost`). The outbox keeps those, since it sends nothing.
3. **The person has not switched that kind off.** Each person has two
   switches, both on by default: `immediate` (the immediate emails) and
   `digest` (the daily digest and the weekly one).
4. **The module is on** (section 4).

**Unsubscribe link.** Every email has one, for its own kind (immediate or
digest). It is a signed, expiring token (HMAC-SHA256 with
`EMAIL_LINK_SECRET`, valid 90 days) naming the organization, the person, the
switch, when it was issued and the expiry. Nothing else is in it. A link
issued before the person last switched that kind back on no longer works
for it (security review 8, L2): an old email cannot switch off again what
the person chose to have. When a link switches something off, the person
is told in Trustline (in-app notification `email_turned_off`, `data.switch`),
so that a link used by someone else does not pass unseen. Opening the link shows a page
with one button, because a link that acted on a plain GET would be clicked
by the link scanners many mail systems run. A mail client's own unsubscribe
button posts to the same address and works in one click (RFC 8058). The page
says only that the emails of that kind are off and that they can be turned
back on in Trustline. It shows no name, address, organization or anything
else. It is the same whatever the state of the account. An invalid, altered
or expired token gets a page saying the link is not valid, nothing more.

## 4. Modules and subscription

- **A module that is off** is never emailed about, as in the app: an
  immediate email whose notification belongs to a module the client does not
  have (`NOTIFICATION_MODULE`) is dropped as `module_off`, and the digest has
  no section of a module that is off. A cancelled subscription has no module,
  so nothing is sent.
- **A suspended subscription** still gets the safety emails: everything
  about incidents (immediate and in the digest) and documents to acknowledge
  (in the digest and the weekly digest). Approval steps and reviews are not
  emailed while suspended: they cannot be decided until the subscription is
  active again.
- **A client Trustline has suspended** (`tenants.status`) gets nothing and
  has no digest made. The worker still visits it, only to drop as `expired`
  what was queued more than 24 hours before, and to delete what is finished
  after 30 days like anyone's (section 7). Made active again within the
  day, it sends what is still queued.

## 5. How it is sent

### The sender

One interface (`MailSender`), and the configuration chooses which one is
used:

- **SMTP** when `SMTP_HOST` is set. Any mail service that offers SMTP can be
  plugged in.
- **Outbox** when it is not: each email is stored in `email_outbox`, fully
  rendered, and not sent. The API logs once at start, and in every run that
  handled email, that mail is not configured. Mail kept in the outbox is
  never sent later, even after SMTP is configured.

Settings, all from the environment, documented in `.env.example` with no
real values:

| Variable | Meaning |
|---|---|
| `SMTP_HOST` | The SMTP server. Unset: outbox mode. |
| `SMTP_PORT` | Default 587 (465 with `SMTP_TLS=implicit`). |
| `SMTP_TLS` | `starttls` (default: the server must offer STARTTLS or nothing is sent), `implicit` (TLS from the first byte, usually 465), `none` (only for a server on this machine, `localhost` or `127.x`). Certificates are always verified, and TLS is at least 1.2. |
| `SMTP_USER`, `SMTP_PASSWORD` | Credentials, both or neither. Never logged. |
| `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` | The sender. The name defaults to "Trustline". |
| `WEB_BASE_URL` | The web address the links lead to, such as `https://trustline.example.com`. |
| `EMAIL_LINK_SECRET` | The key that signs unsubscribe links, 32 characters or more. |
| `MAIL_TRANSPORT` | `outbox` forces outbox mode whatever else is set. The tests use it. |

In SMTP mode, `MAIL_FROM_ADDRESS`, `WEB_BASE_URL` (https, unless it is on
this machine) and `EMAIL_LINK_SECRET` are required. If any of them is
missing or invalid, the API still starts, but in outbox mode. It logs an
error naming each variable at fault, never its value. Email never stops the
API from serving. In outbox mode `WEB_BASE_URL` defaults to
`http://localhost:3000`, and a missing secret is replaced by a random one
for the life of the process (the log says so).

### Outside the request: the queue

- A notification of a kind that is emailed queues one row in `email_queue`,
  in the transaction that writes the notification. The queueing runs in a
  savepoint. If it fails, the failure is logged (the client and the kind of
  error) and the action goes on. **Nothing about email can make an action
  fail.**
- The **email worker** (`EmailWorker`) is started by `main.ts`, beside the
  deadline and policy checks. It runs every 30 seconds and goes through each
  client in transactions of its own under `TenantDb.withTenant`: it sends
  for active clients, and only expires and deletes for suspended ones.
  Tests do not start it; they call `run()` with a moment and their own
  clients.
- **Once, with any number of API processes.** A process claims a row by
  setting it to `sending` and adding one to `attempts`, for rows it has
  locked with `SKIP LOCKED`, for 15 minutes by the database's clock, which
  every process shares, as is the test of a lapsed claim (security review
  8): no process's own clock, fast or slow, can take over a claim early. Then it sends, outside any transaction, and
  records the outcome only while the row is still `sending` with that
  attempt number. A second process never sees a claimed row as free. Just
  before each send the claim is renewed for 15 minutes from then, on the
  same condition, so a batch sent one by one to a slow server cannot outlast
  its claim. A row another process has taken over is not sent. If a
  process dies mid-send, its claim lapses after 15 minutes and the row is
  tried again. The SMTP timeouts (10 seconds to connect and greet, 30
  seconds of silence) keep any send far shorter than that. Every
  attempt of a message has the same `Message-ID`, so in the one case
  Trustline cannot rule out (the connection lost after the server took the
  message and before it said so), mail systems see the retry as the same
  message.
- **Retries and backoff.** No answer, or a temporary refusal (4xx), is
  tried again after 1, 5, 30 and 120 minutes. After 5 attempts it is
  `failed`. Only a refusal of this message or its recipient is `failed` at
  once: a 5xx to the message (`EMESSAGE`), or one to RCPT TO (`EENVELOPE`)
  whose enhanced status (RFC 3463) is about the address, the mailbox or the
  mail system (5.1.x, 5.2.x, 5.3.x), or, with no enhanced status, 550 to
  553 (security review 9, finding 1). At RCPT TO, 530 and any 5.7.x
  (Postfix's "554 5.7.1 Relay access denied", Exchange's "550 5.7.54
  Unable to relay") are the sender's standing, the configuration's: tried
  again, as a refused login is, and sending stops.
  Everything else is tried again, whatever its reply code and nodemailer's
  own `permanent` (security review 8, M1): a refused or missing login
  (`EAUTH` 535, `ENOAUTH`, 530), TLS, the protocol, the connection, and a
  refusal of the sender at MAIL FROM (550, 553). These are the
  configuration's or the server's, and fixing them fixes every message. A
  refused login or relay stops sending: the email it happened to and every
  other one claimed go back to the queue as they were, with no attempt
  counted (security review 9, finding 2), so an outage of the login gives
  up nobody's email (the day-old expiry is the only limit); nothing is sent
  to any client for 5 minutes (`PAUSE_AFTER_REFUSAL_MS`), so a wrong
  password is not tried every 30 seconds; and the log says to check
  `SMTP_USER`, `SMTP_PASSWORD` and the relay's settings.
- **Read for each email.** The organization's switch, the subscription and
  its modules are read as each email is prepared (security review 8, L1),
  so switching email off, a module off or a suspension counts from the next
  email, not the next run.
- **Each client's steps are apart** (security review 8, L4): its digests,
  then its queue, then its retention. A digest that cannot be queued holds
  back neither what cannot wait nor the deletion of what is past keeping;
  each failure is logged with the client. An email still
  unsent 24 hours after it was queued is dropped as `expired`. A digest
  that is a day old says nothing useful.
- **What is logged:** one line per run that handled email (sent, kept in
  the outbox, skipped, to retry, failed, and clients that failed). A failure
  names the client, the queue row and the error code (`ECONNECTION`, `451`),
  never an address, a subject, a message from the server or a credential.

## 6. Routes

| Route | Who | Body | Answers |
|---|---|---|---|
| `GET /me/notification-preferences` | anyone signed in, their own | none | `{ immediate, digest, language, organizationEnabled }` |
| `PATCH /me/notification-preferences` | the same | `{ immediate?, digest?, language? }`, at least one; `language` one of the organization's languages, or null for its default | 200 as GET; 400 for anything else, 400 `language_mismatch` for a language the organization does not use |
| `GET /settings/email` | `settings.manage` for the whole organization | none | `{ enabled, delivery: 'smtp' \| 'outbox' }` |
| `PUT /settings/email` | the same | `{ enabled }` | 200 as GET |
| `GET /email/unsubscribe/:token` | no session | none | 200 a page with one button; 404 a page saying the link is not valid |
| `POST /email/unsubscribe/:token` | no session | empty, or `List-Unsubscribe=One-Click` (form) | 200 a page saying it is done; 404 as above; 400 for any other body |

- Both `/me` routes are core and stay open while the subscription is
  suspended (they are about the person, like marking notifications read). No
  permission opens them; each person reads and changes only their own.
- `PUT /settings/email` while suspended can switch email off, not on (403
  `subscription_suspended`).
- The unsubscribe pages are served with `Content-Security-Policy:
  default-src 'none'; style-src 'unsafe-inline'; form-action 'self';
  frame-ancestors 'none'`, `Referrer-Policy: no-referrer` (the token is in
  the address) and `Cache-Control: no-store`.

## 7. Data, audit and retention

Four tables, all tenant data under row-level security (`tenant_isolation`),
created by migration 0046 (generated, additive: new types and tables only),
with grants for `trustline_app` only in migration 0047 (custom SQL):

- `email_settings`: one row per organization that has changed something.
  No row means email is on. It also records the day its digests were last
  scheduled, so each day is scheduled once.
- `email_preferences`: one row per person who has changed a switch. No row
  means both are on.
- `email_queue`: one row per email to send. Its notification (cascade, by
  a key of the tenant and the notification: security review 8, L3), or
  for a digest its day. One per notification, one daily digest per person
  per day (unique indexes). It has its status, attempts, next attempt, the
  reason it was skipped or failed, and the error code. Never the content or
  the address.
- `email_outbox`: what would have been sent, in outbox mode: address,
  subject, text, HTML and headers. One per queue row, by a key of the
  tenant and the row.

Migration 0050 (generated, with the indexes put before the keys that need
them by hand) makes both keys composite with the tenant, adds the unique
indexes they point to (`notifications (tenant_id, id)` and `email_queue
(tenant_id, id)`), the times each switch was last turned back on
(`email_preferences.immediate_on_since`, `digest_on_since`), and the
notification kind `email_turned_off`. A key is checked past row-level
security, so one of the id alone could have named another tenant's row.
The index on notifications, which may be large, is built concurrently by
`migrate.ts` before the migrations run (a migration runs in a transaction,
where that cannot be done); the migration makes it only if it is not
there. `migrate.ts` builds it only while 0050 is not applied, and a
migration run holds an advisory lock throughout, so two never build or
drop it together (security review 9, finding 4). 0050 itself still holds a
lock on `notifications` while its check is added again over every row, in
the one transaction the migrations run in. It is committed as it is: no
production database holds data yet, so the lock lasts no time today. A
later change of that kind to a table with data adds its check and key
`NOT VALID` and validates them after.

**Audit:** changing one's preferences (`notification_preferences_changed`,
with what changed and `via: 'settings' | 'unsubscribe_link'`), and switching
email for the organization (`email_setting_changed`). Not each email: the
in-app notification is already the record of who was told what, and the
queue keeps the outcome for the retention period.

**Retention: 30 days.** Queue rows that are finished (sent, skipped,
failed) and outbox rows are deleted 30 days after they were last changed, by
the worker, for every client, including one Trustline has suspended. Thirty days covers the questions support gets ("did I get that
email last week?") and holds back a resend for as long as it matters. The
queue's notification and the day of a digest are never queued again. After
30 days, keeping email addresses and copies of messages is personal data
held for no purpose, and the lasting record (the notification and the audit
log) is kept elsewhere.

## Decided while building

- **The preferred language can be set** by the person, with the switches,
  because nothing else set `users.preferred_locale` and an email "in the
  recipient's language" needs one. Only a language the organization works
  in.
- **Reserved domains get nothing when sending through SMTP** (`.invalid`,
  `.test`, `.example`, `.localhost`): the demo and test data use them, and a
  real mail server would only bounce them (`no_address`). The outbox keeps
  them, so that what would be sent can be read.
- **A serious handover is immediate** as well as a serious report: for the
  department it reaches, it is the first it hears of the incident.
- **Ambiguous sends are retried with the same Message-ID** rather than
  dropped. For a serious incident, an email lost is worse than one that
  arrives twice and is recognized as the same.

- **Queued in the request's transaction, decided at sending.** The queue
  row holds only what the email is about. The switches, the module, the
  subscription, the person's status and address, and the language are read
  when it is sent. The content is made then, from the notification's own
  short values (`reference`, `number`, `version`, `versionId`, `step`, and
  the weekly counts), which the worker checks before it uses them. A queue
  row ends as `sent`, `skipped` with a reason (`organization_off`,
  `inactive`, `no_address`, `opted_out`, `module_off`, `suspended`,
  `nothing_waiting`, `expired`, `gone`) or `failed` (`refused`, `gave_up`).
- **The daily digest links to the dashboard** (`/<lang>/dashboard`), and
  each reference to its item. The preferences link leads to
  `/<lang>/notifications/preferences`, the web app's email preferences
  screen (language review 7, M6).
- **Who sees whom in the digest** is decided by the screens' own services
  (`IncidentsService.list`, `LibraryService.list`, `myApprovals`,
  `reviewsDue`), called as the person through `BackgroundContext`
  (`email/background-context.ts`). This builds the person's access as a
  session would, with no session, and only for work in the background. It
  is a provider of EmailModule's own, exported to nothing (security review
  8), so no other module can build a context without a session. It asks
  `AuthService.backgroundContextIn`, which takes no token and no session
  time; lint (`.oxlintrc.json`) refuses that call, and the import of
  `BackgroundContext`, outside `identity/` and `email/` (security review 9,
  finding 6).
- **The unsubscribe link posts a form.** The API takes JSON bodies only,
  except a form posted to `/email/unsubscribe/:token` (`app.setup.ts`), which
  is what RFC 8058 has mail clients send. It needs no session and acts on the
  signed token alone, so a form posted from another site can do nothing the
  token's holder could not do.
- **Mail settings are read once,** when the application starts.
- **The digest hour is fixed** at 07:00 (`DIGEST_HOUR`). The worker keeps
  it as a field only so that a test can make the digest due at any hour.
- **Library:** SMTP through `nodemailer` (MIT-0, no dependencies), with its
  logger off and file and URL access disabled.

## Not built yet

The preferences screen and the organization switch in the web app. An email
for an overdue approval step. Choosing the digest hour per organization.
Delivery reports (bounces), and other transports beyond SMTP (an HTTP API of
a mail service can be added as another `MailSender`).
