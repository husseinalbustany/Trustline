# Audit trail: viewer, tamper evidence, surveyor access

Status: proposed, not built. Read CLAUDE.md, README.md and
`modules-and-subscriptions.md` first.

The business document promises that "every action in the system is recorded
in a tamper-evident audit trail, which accreditation surveyors and auditors
can review", and lists "re-authentication, signature meaning, timestamp,
tamper-evident record" for electronic signatures (21 CFR Part 11 and EU
Annex 11 style). Quality review 3 found three gaps:

- clients cannot read their audit trail: the only route that reads it is
  `GET /policies/documents/:id/changes`, which covers document details only;
- there is no hash chain in the schema or the migrations;
- entries cannot be changed by the application, but an auditor cannot check
  that for themselves.

This spec closes those gaps. It covers a read-only viewer and its exports,
tamper evidence that anyone can verify, time-limited access for an external
surveyor, retention, performance, and the migration of the entries that
already exist.

Trustline's clients are any organization, not only hospitals. Each choice
made here where the business has not decided is marked **Recommended**. What
the business must decide is listed at the end.

## What exists today

- **`audit_log`** (`apps/api/src/database/schema.ts`) has these columns:
  - `id`, `tenant_id`, and `actor_id` (null for the system, for Trustline
    staff, and for anonymous reporters);
  - `action`, `entity_type`, `entity_id`, and `changes` (jsonb);
  - `ip_address`, and `occurred_at` (the database's `now()`, which is the
    start of the writing transaction).

  It has one index, on (tenant, entity type, entity id), and is under
  `tenantIsolation()`.
- **Who may write it:**
  - **The application role** may SELECT and INSERT, never UPDATE or DELETE
    (`drizzle/0005_identity_grants.sql`).
  - **The platform role** may insert only the tenant, action, entity and
    changes columns (`drizzle/0035_…`), only with no actor and no address,
    and only `subscription_changed` and `import_window_changed` (policy
    `audit_log_platform_insert`, `drizzle/0048_…`). It cannot read the log.
  - **Migrations** write entries as the owner role (for example
    `built_in_roles_changed_by_system` in 0025 and 0039,
    `policy_defaults_reworded_by_system` in 0043, and
    `approval_routes_changed_by_system` in 0045).
- **One way in from the code:** `ProvisioningService.audit()`
  (`apps/api/src/identity/provisioning.service.ts`), always in the caller's
  transaction. The platform's two entries go through
  `auditSubscriptionChange()` and `auditImportWindowChange()` in raw SQL, so
  the id and the time stay the database's.
- **Readers today:**
  - `trailOf()` serves a document's history of changes;
  - the incidents service reads the log once an hour, for
    `public_reporting_limit_reached`.
- **`platform_audit_log`** is Trustline's own log of its staff's actions
  (sign-in, clients, plans, subscriptions, import windows). It is written by
  `PlatformAuthService.audit()`, readable and insertable by the platform role
  only, and shown on the client's page in the admin portal. It has no tenant
  isolation, since it is not a client's data.

### What is recorded today

The actions written in code (`audit()` calls) and by migrations, by area:

| Area | Actions |
|---|---|
| Sign-in | `sign_in` (with the address and the client), `sign_in_failed` (with the address and whether it locked), `sign_out`, `password_set`, `password_confirmation_failed` (with the address, the purpose and whether it locked) |
| Accounts and roles | `user_created`, `user_updated` (which fields changed; old and new values only for the unit and the status), `user_roles_changed` (the new list only), `sign_in_link_created`, `role_created`, `role_updated` (permissions before and after), `role_deleted`, `administrator_created_by_platform` (naming the Trustline staff member), `built_in_roles_changed_by_system` |
| Organization and settings | `org_unit_created`, `org_unit_updated`, `org_unit_moved`, `public_reporting_changed`, `response_rules_changed`, `email_setting_changed`, `notification_preferences_changed` |
| Incidents | `incident_reported` (reference, type, whether anonymous, the public channel), `incident_triaged` (old and new values), `incident_status_changed` (from, to, kind, new deadline; this covers sign-off, sending back, reopening, closing and setting aside), `incident_commented`, `incident_deadlines_filled`, `public_reporting_limit_reached` |
| Documents | `document_created`, `document_updated` (old and new values, and the reason), `document_version_created`, `document_version_edited`, `document_submitted`, `document_step_approved`, `document_returned`, `document_recalled`, `document_version_withdrawn`, `document_publish_scheduled`, `document_published`, `document_retired`, `document_reviewed`, `document_review_requested`, `document_review_approved`, `document_review_returned`, `document_acknowledged`, `document_imported`, `document_import_signed`, the settings of types, categories, routes and the module, `document_type_changed_by_system`, `approval_routes_changed_by_system`, `policy_defaults_reworded_by_system` |
| Exports | `documents_exported`, `acknowledgements_exported`, `imports_exported`, `overdue_acknowledgements_exported`, `person_acknowledgements_exported` |
| Written by Trustline | `subscription_changed`, `import_window_changed` |

### What is not recorded today

1. **Reading.** Opening an incident or a document, seeing a reporter's name,
   or viewing a person's acknowledgement record leaves no entry. Only CSV
   exports are recorded; printing is not.
2. **Refusals.** A 403 for a missing permission, or a 404 for a record out of
   reach. Only failed sign-ins and failed password confirmations are
   recorded.
3. **Trustline's actions on the client, beyond the three it mirrors**
   (`subscription_changed`, `import_window_changed`,
   `administrator_created_by_platform`). `client_updated`, which covers
   suspending and reactivating the client and changing its time zone,
   languages or standard, is written only to `platform_audit_log`
   (`apps/api/src/platform/platform-tenants.controller.ts`), which the client
   cannot read.
4. **Some old values.** `user_roles_changed` keeps the new list but not the
   one before. `user_updated` deliberately keeps which fields changed, not
   the names or contact details themselves.
5. **Emails and notifications.** This is deliberate (`email.md`, section 7):
   the in-app notification is the record of who was told what, and the email
   queue is kept 30 days.
6. **Reminders sent by the daily checks.** These are kept in their own tables
   (`policy_reminders`, and the `*_due_soon_at` and `*_overdue_at` columns of
   incidents), not in the audit log.
7. **What operators do directly in the database** outside migrations, as the
   owner role. Trustline does not record it.

**Recommended:** close items 3 and 4 in this work.

- **Item 3:** mirror every platform action about a client into the client's
  own log (`client_settings_changed_by_platform`, with fields, old and new
  values, and the staff member's name, as
  `administrator_created_by_platform` already names them). This widens the
  platform role's insert policy to that one more action.
- **Item 4:** keep the list before in `user_roles_changed`.
- **Item 1:** recording reads starts with external reviewers only (below);
  more is decision 8.
- **Item 7:** recording operators' direct access is an infrastructure matter
  (decision 9).

## The viewer

`/<lang>/admin/audit`, under Administration, as "Audit trail" / «سجل
التدقيق» / « Journal d’audit ».

- **The list:** newest first, 50 entries a page. Each entry shows:
  - when, in the organization's time zone, with the offset;
  - who: the person's name now, "Trustline staff" with the staff member's
    name, "System", or the reporter's masking described below;
  - what: the action's wording;
  - the record: a link if the caller may open it, otherwise its reference or
    number only;
  - the details, worded per action ("Status: In progress → Closed");
  - the address, for sign-in entries;
  - the entry's number in the chain (#18,422) and its seal (see
    "Tamper evidence").
- **Filters:**
  - **Record:** by reference or number (`INC-2026-00042`, `PRC-SAF-014`), or
    by a person's account, or from a "History" link on the record itself;
  - **Person:** who acted;
  - **Action and area:** sign-in, accounts and roles, organization and
    settings, incidents, documents, exports, Trustline;
  - **Dates:** from and to, on the organization's calendar.

  The filters are in the address.
- **Read-only.** Nothing in the trail can be edited, hidden or annotated.
- **Exports:** "Download CSV" for the filtered view, and "Download chain file"
  (see below).
- **Modules.** Entries of a module the client does not have are not shown,
  just as the module's routes answer as if they did not exist. They stay in
  the chain, where only their seal appears, and in the full export, so the
  chain remains checkable.

### Masking: what the trail must not reveal

The trail must not undo a rule the screens keep.

- **Who reported an incident.** `incident_reported` carries the reporter as
  its actor for a named report, and `anonymous: true` otherwise. Comments
  written as the reporter have the reporter as actor.
  - **Recommended:** on these entries, the actor and the anonymous flag are
    shown only to those who hold `incidents.see_reporter` over the incident's
    unit or handling unit, the same rule as `reporterToldTo()`
    (`apps/api/src/incidents/visibility.ts`).
  - Everyone else sees "The reporter" / «المُبلِّغ» / « Le déclarant »,
    whether the report was named or not.
  - A person filter does not match entries whose actor is masked for the
    caller, so filtering by a colleague cannot list what they reported.
- **Anonymous reports and timing.** An anonymous report stores no reporter
  anywhere. But the trail shows sign-in entries beside it, with times. The
  incident's own reported time is already visible to its handlers, so the
  trail adds the sign-in side of that comparison, not the report side.
  **Recommended:** accept this, say so to clients, and have the
  `security-reviewer` assess it (decision 3).
- **Records the caller could not open.** The details can name a restricted
  document's title (`document_created`, `document_updated`).
  **Recommended:** `audit.view` is a deliberate, organization-wide
  permission for auditors, and it shows every entry's details. Links still
  open only what the caller may open.

### Wording of actions

- **One registry.** **Recommended:** a constant, `AUDIT_ACTIONS`
  (`apps/api/src/audit/actions.ts`), lists every action with:
  - its area and entity type;
  - the shape of its details;
  - whether its actor may need masking.

  `audit()` accepts only a registered action (checked at compile time), and
  a test fails for an action written by a migration but not registered.
- **Wording files.** The web app's dictionaries hold, under `audit.actions`,
  a label for every action and a sentence per detail ("{field}: {from} →
  {to}"). The API holds the same words for the CSV
  (`apps/api/src/audit/wording/<lang>.ts`). A test checks that the registry,
  the three dictionaries and the three API wording files have the same keys.
- **Style.** **Recommended:** a label names what happened, not who did it,
  since "who" is its own column:
  - English: a noun with a past participle ("Incident reported");
  - Arabic: a verbal noun (masdar, «الإبلاغ عن حادث»);
  - French: a noun phrase (« Déclaration d’un incident »).

  This avoids the gender agreement that an Arabic or French verb would need
  for the actor.
- **Values in details** are worded as on the screens (statuses, harm levels,
  meanings of signatures), and client text is shown with `pick()`.
- **Starting wording,** for the `bilingual-reviewer` to settle:

| Action | English | Arabic | French |
|---|---|---|---|
| `sign_in` | Sign-in | تسجيل الدخول | Connexion |
| `sign_in_failed` | Failed sign-in | محاولة دخول فاشلة | Échec de connexion |
| `sign_out` | Sign-out | تسجيل الخروج | Déconnexion |
| `password_set` | Password set | تعيين كلمة المرور | Définition du mot de passe |
| `password_confirmation_failed` | Wrong password when signing | كلمة مرور خاطئة عند التوقيع | Mot de passe erroné lors d’une signature |
| `user_created` | User added | إضافة مستخدم | Ajout d’un utilisateur |
| `user_roles_changed` | User’s roles changed | تغيير أدوار مستخدم | Modification des rôles d’un utilisateur |
| `role_updated` | Role changed | تعديل دور | Modification d’un rôle |
| `org_unit_moved` | Unit moved in the structure | نقل وحدة في الهيكل التنظيمي | Déplacement d’une unité dans l’organisation |
| `incident_reported` | Incident reported | الإبلاغ عن حادث | Déclaration d’un incident |
| `incident_triaged` | Incident triaged | فرز حادث | Tri d’un incident |
| `incident_status_changed` | Incident status changed | تغيير حالة حادث | Changement de statut d’un incident |
| `document_step_approved` | Approval step approved | الموافقة على خطوة في مسار الاعتماد | Approbation d’une étape du circuit |
| `document_published` | Version published | نشر إصدار | Publication d’une version |
| `document_acknowledged` | Document acknowledged | الإقرار بالاطلاع على وثيقة | Prise de connaissance d’un document |
| `documents_exported` | Document list exported | تصدير قائمة الوثائق | Export de la liste des documents |
| `subscription_changed` | Subscription changed by Trustline | تعديل الاشتراك من قِبل Trustline | Modification de l’abonnement par Trustline |
| `public_reporting_limit_reached` | Public form paused (hourly limit) | إيقاف النموذج العام مؤقتًا (بلوغ الحد في الساعة) | Formulaire public suspendu (limite horaire) |
| `audit_chain_started` | Audit trail sealed | ختم سجل التدقيق | Scellement du journal d’audit |

Who acted, when it is not a person:

- "System" / «النظام» / « Système »;
- "Trustline staff" / «فريق Trustline» / « Équipe Trustline »;
- "The reporter" / «المُبلِّغ» / « Le déclarant »;
- and, for holders of `incidents.see_reporter` only, "Anonymous" / «مجهول
  الهوية» / « Anonyme ».

## Who may view

- **New permission:** `audit.view` (core). It opens the viewer and both
  exports.
  - **Recommended:** only a grant for the whole organization counts, as for
    creating roles. A unit-scoped trail would still name records and people
    outside the unit. The role editor says so.
  - Built-in: Administrator and Quality officer (decision 1). It is given to
    existing clients' roles by migration, with one audit entry per client.
- **While suspended:** reading the trail and downloading its files are reads,
  so they stay open. **Recommended:** granting external reviewer access also
  stays open while the subscription is suspended
  (`@OpenWhileSuspended()`): a survey can fall during a billing dispute.

### Time-limited access for an external surveyor

A surveyor or external auditor needs to read, for a few days, without
becoming a member of staff. **Recommended:**

- **Who grants it:** someone holding `users.manage` and `audit.view` for the
  whole organization creates it, under Administration, Users, "External
  reviewer access". They give:
  - the person's name and email;
  - the organization they come from (free text, for example "Accreditation
    body");
  - the purpose;
  - a first and a last day: at most 30 days, extendable once, with a reason;
  - a role.
- **What they may hold:**
  - A built-in "External reviewer" role holds `audit.view`,
    `policies.view_all`, `incidents.view` and `reports.view`, for the whole
    organization.
  - The client may give a narrower role instead.
  - An external reviewer may hold only reading permissions. A role with
    anything else is refused (400 `not_read_only`), and so is
    `incidents.see_reporter`: a just culture does not show reporters' names
    to outsiders (decision 2).
- **How they get in:** through a one-time link, as for an invitation, where
  they choose a password. The account is marked external, with
  `access_from` and `access_until`.
  - Sign-in outside those days is refused.
  - Sessions end at `access_until`, and the session guard checks this on
    every request.
  - The daily check disables the account when the period ends
    (`external_access_ended`).
- **Read-only by construction:** for such a session, the session guard
  refuses every route that is not a read (403 `read_only_access`), except
  signing out and setting the password. This holds even if a role with writes
  were given by mistake. Such a reviewer cannot sign, acknowledge or comment.
- **Their reading is recorded:** every record an external reviewer opens, and
  every file they download, writes an entry (`external_reviewer_viewed`,
  `…_exported`). The client can then show what was examined. The volume is
  small.
- **Everyone with authority is told:** every holder of `users.manage` for the
  whole organization is told in the app when access is granted, extended or
  ended. All of it is audited (`external_access_granted`,
  `external_access_extended`, `external_access_ended`).
- **Named users:** **Recommended:** an external reviewer does not count as a
  named user (decision 2).
- **A second factor** is not built in Trustline. **Recommended:** a one-time
  code by email at each sign-in for external reviewers, who are outside the
  client's own controls (decision 2).

## Tamper evidence

### What it protects against

- **The application** already cannot change or delete an entry.
- **The risk** is someone with the database owner's rights (an operator, or
  an intruder with those rights) editing, deleting or adding entries, and
  rewriting them so that nothing looks wrong.
- **The aim** is that any such change is found by Trustline's daily check
  and, independently, by the client or a surveyor, without trusting
  Trustline's servers.

### The chain

- **One chain per tenant.** Each entry gets:
  - a number in the chain (`seq`, from 1, with no gaps);
  - `prev_hash`, the hash of the entry before it (64 zeros for the first);
  - its own `hash`.
- **What is hashed:**
  - `body` is a fixed text form of the entry: its id, tenant, `seq`,
    `occurred_at` (UTC, with microseconds), actor, action, entity type and
    id, `changes`, and a commitment to the address (see "Personal data").
  - `body_hash` is `SHA-256(body)`.
  - `hash` is `SHA-256("trustline-audit-v1\n" + seq + "\n" + prev_hash + "\n" + body_hash)`.

  Hashing the body's own hash lets a chain file withhold an entry's body and
  still be checked link by link.
- **Where it is kept.** **Recommended:** in a separate, insert-only table,
  `audit_chain` (one row per entry: `seq`, `entry_id`, `prev_hash`,
  `body_hash`, `hash`, `ip_commitment`), with `audit_chain_heads` holding
  each tenant's last `seq` and `hash`.
  - `audit_log` stays as it is and insert-only.
  - Each entry still carries the previous entry's hash, through its chain
    row.
- **Sealed by the database, at commit.** **Recommended:** a deferred
  constraint trigger on `audit_log` (`DEFERRABLE INITIALLY DEFERRED`, a
  `SECURITY DEFINER` function owned by the owner role, with a fixed
  `search_path`). It runs as each writing transaction commits:
  1. it locks the tenant's head row;
  2. it builds the body and the hashes;
  3. it inserts the chain row and moves the head.
- **Why a database trigger:**
  - every writer is chained, with no way round it in code: the application,
    the platform role's raw inserts, and migrations;
  - the head lock is held only for the commit, not for the whole transaction.
    Holding it longer would make a long batch import hold up every sign-in of
    the client, and the application role gives up a lock wait after 5
    seconds (README, "What the database gives up on").
- **The chain's order is commit order.** `occurred_at` is the start of the
  writing transaction, so a long transaction's entry can carry an earlier
  time than the entry chained before it. The viewer orders by time; the
  chain orders by `seq`.
- **If sealing fails,** the transaction fails. An action that cannot be
  audited is not taken, which is what "audited in the same transaction"
  already means.

### Signed checkpoints

- **Every day,** the verification below signs the tenant's head: tenant,
  `seq`, `hash` and time, with Trustline's key (Ed25519, with a key id). The
  result is stored in `audit_chain_checkpoints`.
- **The keys:**
  - the private key is held outside the database (a key service or a secret
    of the deployment, never in a table);
  - the public keys, past ones included, are published at a fixed address on
    Trustline's site and inside every chain file;
  - when a key is replaced, the old public key stays published.
- **Why checkpoints are not enough on their own:** someone holding both the
  database and the key could still rewrite everything. So a checkpoint is
  worth most once a copy of it is outside Trustline's hands.
  **Recommended:**
  - the client's administrators can download the checkpoints at any time,
    and the viewer encourages a monthly download;
  - every chain file carries them;
  - external anchoring is decision 5: a weekly email of the head's number and
    hash to administrators, and/or a daily timestamp from an independent
    timestamping service (RFC 3161) over all clients' heads, with each
    client's proof of inclusion.

### The daily verification

- **When:** once a day for each client, at the first run of the background
  checks after 02:00 on its calendar. It is built like the other checks.
- **What it checks**, from the last good checkpoint to the head:
  - every chain row's `body_hash` and `hash`, rebuilt from `audit_log`;
  - the link to the row before;
  - that the `seq` numbers have no gaps;
  - that every `audit_log` row has its chain row: an entry older than 10
    minutes without one was inserted round the trigger;
  - that every chain row has its entry: a deletion;
  - that the head has not gone back below the last checkpoint: a truncation;
  - that no entry is dated before the checkpoint preceding it by more than
    10 minutes: added after the fact.
- **Weekly,** it checks the whole chain from entry 1.
- **On success:** it signs a new checkpoint and records the result in
  `audit_chain_verifications`.
- **On failure:**
  - it records the first entry found wrong and the kind of failure
    (`content_changed`, `missing_entry`, `missing_seal`, `gap`,
    `head_rewound`, `backdated`);
  - it writes an error to the server log, naming the client and the kind,
    never any content;
  - it writes an entry in `platform_audit_log` (`audit_chain_broken`), and
    the admin portal shows it;
  - **Recommended:** it tells the client's holders of `audit.view` and
    `settings.manage` at once, in the app (`audit_chain_broken`). The viewer
    shows a permanent notice with the first entry found wrong. A tamper
    check whose failures the client is not told of is worth nothing
    (decision 4).
- **What the platform role sees:** the result rows only (client, time,
  result, kind, first entry), through a policy of their own. It sees nothing
  of the entries.

### What a surveyor sees

At the top of the viewer:

> **Unbroken:** entries 1 to 18,422. Checked every day; last check today at
> 02:07, passed. Entries 1 to 1,204 were recorded before the trail was
> sealed, on 3 December 2026: the chain shows they have not changed since
> that day, not before it.

Each entry shows its number. "Download chain file" and "Download
checkpoints" sit beside the CSV.

### How anyone can check it themselves

- **The chain file**
  (`audit-chain-<organization>-<first>-<last>.jsonl`, JSON Lines):
  - a header line: format, version, tenant, organization identifier, first
    and last `seq`, made at, and the public keys;
  - one line per entry: `seq`, `entryId`, `prevHash`, `bodyHash`, `hash`,
    and `body`, the exact text that was hashed. The body is left out for
    entries the caller may not see in full (masked or of a module that is
    off);
  - the checkpoints that fall within the range.

  It is made for a range of numbers. The first line of a range links to the
  checkpoint at or before its start.
- **The format** is documented publicly (`docs/audit-chain-format.md`,
  published with the public keys).
- **The checks:**
  - a verification page on Trustline's site that runs only in the browser:
    the file is read on the reviewer's own machine and never sent anywhere,
    and the hashes and signatures are checked with the browser's own
    cryptography;
  - a script of under 100 lines, published openly, for those who do not want
    to trust any page of Trustline's;
  - the steps to check one entry by hand with `sha256sum`.
- **What a surveyor confirms:**
  1. every line's hash recomputes and links to the one before it;
  2. the last line matches a checkpoint whose signature is valid under the
     published key;
  3. a checkpoint the client kept from earlier (a download, or an email)
     still appears in the new file, with the same hash. Nothing before it has
     been rewritten since;
  4. the entries they reviewed in the CSV (by entry id) have the same content
     as their bodies in the chain file.

## Personal data in the trail

- **Addresses** (on sign-in entries) are personal data, and are useful for
  far less time than the trail must last.
  - **Recommended:** the body holds a commitment, `SHA-256(salt + address)`,
    not the address itself. The salt is random per entry and kept with the
    address, outside the hashed body.
  - After the period the business sets (decision 7), a database function the
    application may call clears the address and its salt, and nothing else.
    The chain stays intact.
  - While both are kept, the chain file includes them, so a reviewer can
    check the address against its commitment.
- **Contact details in new entries:**
  - **Recommended:** from now on, an entry's details hold no contact details.
    `user_created` today keeps the new user's email address
    (`provisioning.service.ts`, `createUser`); the id is enough, since the
    address is on the account.
  - The same applies to `client_administrator_created` in the platform log.
  - Entries written before stay as they are: they are sealed as they stand.
- **Erasure requests.** Audit entries are kept because the organization must
  be able to show what was done, by whom. This is evidence for accreditation
  and for electronic signatures. A request to erase a person is answered on
  their account (their name and contact details), not in the trail, which
  holds the account's id. The `legal` review named in the business document
  should confirm this for the PDPL and the GDPR.

## Retention

- **Decision 8** keeps acknowledgement records, those of people who have left
  included, at least six years after the document is retired. The audit
  entries are the evidence of those records and of every signature.
  - **Recommended:** nothing in the audit trail is deleted while the client
    is a client.
  - Addresses are the only exception: they are cleared after their own
    period, as above.
- **After the contract,** the trail and its chain go to the client in the
  full export (`data-export.md`). What Trustline keeps afterwards, and for
  how long, is decided there (decision 10).
- **If a very long-lived client ever needs old entries removed,** only a
  whole beginning of the chain is removed, up to a signed checkpoint. That
  checkpoint becomes the start ("entries before #N removed on <day> under the
  retention rule; their last hash was H"), so everything after it can still
  be checked. Not built now.

## Performance

- **Writing:** one extra row and one head-row lock per committing transaction
  that audited, held only during the commit. Target: under 2 ms added to a
  commit. Commits of one client that audit queue for each other only during
  that step.
- **Reading:**
  - new indexes on (tenant, occurred_at desc, id), (tenant, actor, occurred_at)
    and (tenant, action, occurred_at), beside the existing
    (tenant, entity type, entity id);
  - pages by key (before this time and id), not by offset;
  - totals capped at "more than 10,000", so that no count runs over millions
    of rows.
- **Volume:** sign-ins are most of it. 1,000 staff signing in daily make
  about 365,000 entries a year, and all other actions a large organization
  might add would bring the total to about a million a year. That is easily
  served by these indexes. Partitioning by year can come later, if ever.
- **Verification:**
  - the daily run checks one day of entries;
  - the weekly run checks the whole chain, in batches of 10,000 by `seq`,
    each statement within the checks' 30-second limit;
  - a million SHA-256 hashes take seconds.
- **Exports:**
  - the CSV is capped at 50,000 rows, like every other export;
  - the chain file is streamed by `seq`, with no cap.

## Migration of existing entries

- **One generated migration** adds `audit_chain`, `audit_chain_heads`,
  `audit_chain_checkpoints` and `audit_chain_verifications`, and the
  address's salt column.
- **One custom SQL migration**, in a single transaction, holding
  `LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE` so that no entry is
  written meanwhile:
  1. it creates the sealing function and the trigger;
  2. for each tenant, it seals the existing entries in the order of
     `occurred_at, id`;
  3. it then writes, through the trigger, an `audit_chain_started` entry
     (`{ sealedBefore: n, sealedOn }`);
  4. it adds the grants: SELECT on the chain tables for `trustline_app`, no
     writes, and the verification results for the platform role.

  No production database holds data yet (`email.md`, section 7), so the lock
  lasts no time today.
- **Honesty about the past:** entries sealed by the migration are shown as
  "recorded before the trail was sealed on <day>". The chain proves they have
  not changed since, not before.
- **Tests:**
  - **Tenant isolation:** the new tables are covered by
    `tenant-isolation.spec.ts`.
  - **The verification catches tampering.** Each of these, done as the owner
    role, is found:
    - an update to an entry;
    - a deletion;
    - an insert made with the triggers disabled
      (`session_replication_role = replica`);
    - a truncated tail, caught against a checkpoint;
    - a backdated entry.
  - **Test clean-up.** Tests must never delete audit entries of a client that
    is kept, or that client's chain breaks.
    - `test/cleanup.ts` deletes whole test clients only; the chain tables
      must be added to its list.
    - `src/database/deadlines.spec.ts` (around line 708) deletes demo
      clients' entries, but inside a transaction it rolls back, which is
      harmless. Any new test of that kind must do the same.

## Data outline (not a schema)

All are tenant tables under `tenantIsolation()`, read by the application
inside `TenantDb.withTenant()`, with grants in a migration.

- `audit_log`: as today, plus `ip_salt`.
- `audit_chain`: `tenant_id`, `seq`, `entry_id` (unique per tenant),
  `prev_hash`, `body_hash`, `hash`, `ip_commitment`, `sealed_at`, and
  `sealed_late` (true for entries sealed by the migration). Insert-only, and
  written only by the sealing function.
- `audit_chain_heads`: `tenant_id`, `seq`, `hash`. Written only by the
  sealing function.
- `audit_chain_checkpoints`: `tenant_id`, `seq`, `hash`, `at`, `key_id`,
  `signature`.
- `audit_chain_verifications`: `tenant_id`, `run_at`, `from_seq`, `to_seq`,
  `full` (boolean), `result`, `kind`, `first_bad_seq`.
- `users`: `kind` (`staff`, `external_reviewer`), `access_from`,
  `access_until`, and `access_purpose` and `access_organization` (plain
  text).

`platform_audit_log` gets a chain of its own, by the same mechanism, so that
what Trustline's staff did is tamper-evident too. **Recommended**, as the
same step.

## API outline (under `/api/v1/audit`, `@ForModule('core')`)

| Route | Who | Query / body | Answers |
|---|---|---|---|
| `GET /entries` | `audit.view` (whole organization) | `before?` (cursor), `pageSize` (50, at most 200), `from?`, `to?` (days), `actorId?`, `actions?`, `area?`, `entityType?` with `entityId?`, or `reference?` | `{ items: [{ id, seq, at, actor: { kind, id?, name? }, action, entity: { type, id, label, canOpen }, details, ip?, sealedLate }], more, totalCapped }` |
| `GET /status` | `audit.view` | | `{ head: { seq, at }, lastCheck: { at, result, kind?, firstBadSeq? }, sealedOn, sealedBefore }` |
| `GET /exports/entries` | `audit.view` | the same filters, `locale?` | CSV (`csv.ts` rules, worded) |
| `GET /exports/chain` | `audit.view` | `fromSeq?`, `toSeq?` | JSON Lines file |
| `GET /checkpoints` | `audit.view` | `from?`, `to?` | the signed checkpoints, as a JSON file |
| `GET /users/external` | `users.manage` (whole organization) | | external reviewers, with their access |
| `POST /users/external` | `users.manage` and `audit.view` (whole organization) | `{ name, email, organization, purpose, from, until, roleId }` | 201, with a one-time link |
| `PATCH /users/external/:id` | the same | `{ until, reason, revision }` (once) or `{ end: true }` | the access |

Further rules:

- Every route answers 401 without a session, 403 without the permission, and
  400 for anything but its strict input.
- Every export is audited (`audit_entries_exported`, `audit_chain_exported`,
  `audit_checkpoints_exported`, with the filters, as `documents_exported`
  keeps them).
- Reading the viewer is not audited, except by an external reviewer.

## Tenant isolation

- The chain is per tenant. The sealing function reads only the inserted row's
  tenant's head, so one client's chain never depends on another's.
- The viewer and the exports run inside `TenantDb.withTenant()`.
- A cross-client timestamp (decision 5) covers only the heads' hashes, and
  each client receives only its own proof of inclusion, never another
  client's head.

## Languages (en, ar, fr)

- **On screen:** action labels, detail sentences, filters, the status
  notice and the external access screens are in the web dictionaries, one
  file per language, with the same keys.
- **In files the API makes:** CSV headings and values are in
  `apps/api/src/audit/wording/<lang>.ts`.
- **Checked:** a test checks that the registry, the dictionaries and the
  wording files all match.
- **Times:** in the organization's time zone, written as the web app writes
  them, with Latin digits.
- **The chain file** is a machine format: English keys, never translated.
  The published format notes and the verification page are in all three
  languages.

## Order of build

1. **The action registry,** the wording in three languages, and a typed
   `audit()`. Stop storing email addresses in new entries, and keep the list
   before in `user_roles_changed`.
2. **The chain:** tables, the sealing trigger, the migration sealing existing
   entries, and the tampering tests.
3. **Verification and checkpoints:** the daily and weekly checks, the
   signing key and its publication, the notices to the client and to
   Trustline, and the status.
4. **The viewer:** `audit.view`, the entries API with masking, and the web
   page.
5. **Exports:** CSV and chain file, the checkpoints download, the published
   format, the in-browser verification page, and the script.
6. **External reviewer access:** accounts, the read-only guard, expiry, the
   record of what they read, and the notices.
7. **Mirroring Trustline's actions** into the client's log, and chaining
   `platform_audit_log`.
8. **Later:** external anchoring (decision 5), logging of operators' direct
   database access (decision 9), and more recorded reading (decision 8).

The reviews:

- `security-reviewer` after steps 2, 3, 4 and 6;
- `bilingual-reviewer` after steps 1, 4 and 5;
- `quality-reviewer` at the end, against an accreditation surveyor's and an
  ISO auditor's questions.

## Decisions needed

1. **Who holds `audit.view` by default:** Administrator and Quality officer
   (recommended), or the Administrator only.
2. **External reviewers:**
   - the longest access (30 days, recommended);
   - the permissions of the built-in role;
   - that they never see reporters' names (recommended);
   - whether they count as named users (recommended: no);
   - whether a one-time code by email is required at each sign-in
     (recommended).
3. **Anonymity and timing:** accept that the trail shows sign-in times beside
   the times of reports, which handlers already see (recommended, after the
   security review), or hide sign-in entries' exact times from some viewers.
4. **A broken chain is shown to the client at once** (recommended), or only
   after Trustline has looked into it.
5. **External anchoring:** a weekly email of the head's number and hash to
   administrators (this needs `email.md`'s rule on what an email may contain
   to allow a hash), a daily independent timestamp, both, or neither for now.
6. **Signing keys:** who holds Trustline's key, and, for dedicated and
   on-premises deployments, whether the client or the operator holds its
   own.
7. **How long addresses of sign-ins are kept** before they are cleared (for
   example two years), compared with the trail itself (kept for the
   contract).
8. **Recording more reading:** who opened a sentinel event, who was shown a
   reporter's name (recommended later; external reviewers now).
9. **Operators' direct database access:** to be logged at the
   infrastructure level (for example a database audit extension), outside
   this product.
10. **After the contract ends:** what Trustline keeps of the trail, and for
    how long (see `data-export.md`).
11. **Publishing the verifier** as open source under Trustline's name.

## Decided by the business (28 November 2026)

Every recommendation in this spec is accepted. In particular:

- **Who holds `audit.view` by default:** the Administrator and the Quality
  officer.
- **External reviewers:** at most 30 days, extendable once, with a one-time
  code at sign-in; they do not count as named users.
- **A break in the chain:** shown to the client at once.
- **Anchoring:** a weekly email of the latest hash to the administrators
  now; a timestamping service later.
- **Giving someone the Quality officer role** (raised by security review
  11): stays possible for an administrator alone, as it is audited; the
  other Quality officers and administrators are also told in the app when
  anyone is given `policies.import`.
- Every other decision in "Decisions needed" follows the recommendation
  written there.
