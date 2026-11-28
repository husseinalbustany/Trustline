# Full data export

Status: proposed, not built. Read CLAUDE.md, README.md,
`modules-and-subscriptions.md` ("When a subscription lapses"),
`audit-trail.md` and `reports-and-measures.md` first.

`modules-and-subscriptions.md` promises that on cancellation "the client can
export its data first", but nothing does it: today a client can take out only
some CSV lists of the policies module and print one document at a time
(quality review 3, "Missing" and S6). This spec defines a full export of a
client's data:

- before its contract ends, and on request at any other time;
- what it contains, and in what form;
- who may ask for it, and how it is approved, delivered and expired;
- what happens around cancellation;
- what personal data it carries, and what Trustline's own staff can and
  cannot do.

Trustline's clients are any organization, not only hospitals. Each choice
made here where the business has not decided is marked **Recommended**. What
the business must decide is listed at the end.

## What exists today

- **Exports:** CSV files of the document library, of the acknowledgements of
  a version, the import register, overdue acknowledgements, and one person's
  acknowledgements (`apps/api/src/policies/library.service.ts`). They are
  made with `apps/api/src/policies/csv.ts`, at most 50,000 rows, and each is
  audited.
- **Printing:** browser print of one version in one language
  (`print-view.tsx`).
- **Statuses:** `cancelled` ends every session and link, refuses sign-in, and
  deletes nothing (`modules-and-subscriptions.md`, "Status"). A subscription
  has start, renewal and trial-end dates, and no end date. Status changes are
  made by Trustline staff, never by a date passing.
- **The platform role** (`trustline_platform`) cannot read a client's data.
- **No file storage** exists yet. Attachments come later.
- **No signing key** exists yet. `audit-trail.md` adds one, for audit
  checkpoints.

## What the archive contains

One ZIP archive per export, built from one consistent moment of the
client's data. Machine-readable files are the reference; CSV and HTML are for
people.

```
README.<lang>.txt           what is here and how to check it, in each of the client's languages
manifest.json               every file, its size and SHA-256; counts; the moment; who asked and approved
manifest.sig                Trustline's Ed25519 signature of manifest.json, with the key id
schema/                     a JSON Schema for every .jsonl file (format "trustline-export", version 1)
organization/               the organization: identifier, name, languages, default language, time zone,
                            standard, settings (reporting, response rules, email, documents, reports);
                            the subscription's plan, status, modules and dates (no price, no note)
structure/                  org_units.jsonl (+ .csv)
people/                     users.jsonl (+ .csv), roles.jsonl, role_assignments.jsonl
incidents/                  incidents.jsonl (+ .csv), events.jsonl (+ .csv), comments.jsonl,
                            categories.jsonl
documents/                  documents.jsonl (+ .csv: the master list), types, categories, audiences,
                            versions.jsonl, approval_routes, approval_runs, approval_run_steps,
                            review_rounds, reviews, acknowledgements.jsonl (+ .csv), signatures.jsonl,
                            imports, import_batches, reminders, settings
documents/<number>/v<n>/    content.json (every section in every language, as stored),
                            <lang>.html for each language, and the PDFs (below)
notifications/              notifications.jsonl (who was told what, and when)
reports/                    measure_snapshots.jsonl (+ .csv), report_packs.jsonl, packs/<number>.<lang>.pdf
audit/                      audit_log.jsonl, audit_log.<lang>.csv (worded as the viewer),
                            audit-chain.jsonl (the chain file of audit-trail.md), checkpoints.json
```

### Every module's records

- **Every table holding the client's data is either exported or excluded for
  a stated reason.**
  - **Recommended:** a registry (`apps/api/src/exports/coverage.ts`) lists
    each table with `tenant_id` as `export` (its file and columns) or
    `exclude` (with the reason).
  - `export-coverage.spec.ts` fails for a table that is in neither list. It
    works like `tenant-isolation.spec.ts`, which fails for a table without a
    policy. A new module's tables cannot be forgotten.
- **A module that is off is still exported.** Switching a module off deletes
  nothing (`modules-and-subscriptions.md`), and the data is the client's.
- **Excluded, with the reason:**
  - `sessions`, `user_tokens`: hashes of secrets, of no use outside
    Trustline;
  - `users.password_hash`, `failed_attempts` and `locked_until`: never leave
    Trustline;
  - `incidents.follow_up_code_hash`: the secret of an anonymous reporter;
  - `email_queue` and `email_outbox`: copies of messages and addresses, kept
    30 days for support only (`email.md`, section 7);
  - `audit_chain_heads`: rebuilt from the chain.
- **Single sign-on identifiers** (`users.sso_subject`) are included.
  **Recommended:** they let the client match accounts in its next system.

### Documents with every version's text, signatures and hashes

- **Every version, of every document, drafts and withdrawn ones included,**
  with:
  - its sections in every language, exactly as stored (Markdown limited to
    paragraphs, headings, lists and bold);
  - its status and dates;
  - its change summary, contributors, review rounds and approval run.
- **The HTML of each version and language** is made with the same safe
  renderer as the screens, entirely self-contained: no scripts, no loaded
  fonts or images, nothing from elsewhere. It carries the control block
  (number, version, owner, effective day, approvals, or "Approved before
  Trustline" with its details and differences) and the notes per section
  ("fallback", "translation not updated").
- **PDFs,** once the shared renderer of `reports-and-measures.md` exists.
  **Recommended:** a PDF of every version that was ever published, in force
  or superseded, in each language, and side by side when the version has
  two languages. Drafts and withdrawn versions get JSON and HTML only.
- **Signatures:** every signature (approval, review, no-change review,
  acknowledgement, import), with signer, time, meaning, method and
  `content_hash`. The README says how to recompute a version's hash:
  - it is SHA-256 of the canonical JSON (keys sorted) of
    `{ documentId, number, versionId, version, sections, content, changeSummary, acknowledgementRequired, acknowledgeWithinDays }`,
    as `policies-and-procedures.md` ("Signatures") and
    `apps/api/src/approvals/signatures.ts` define it;
  - for an import, the signed fields of `signedImport`.

  So anyone can confirm that what was signed is the text in the archive.
- **Reviews and acknowledgements**, those of people who have left included,
  with due days, times and the fingerprints of what was signed.

### Incidents

- **Every incident, with its timeline and every comment, internal ones
  included,** and its reporter for a named report.
- **An anonymous report names nobody** here either, because nothing records
  who made it.

### The audit trail with its chain

- **Every entry**, with its body as hashed, the chain, and the signed
  checkpoints.
- **The archive's audit trail can be checked** with the same published
  verifier, offline (`audit-trail.md`).
- **The export's own entries** (`data_export_*`) up to the moment of the
  snapshot are in it.

### Users

- **Every account:** name, email, phone, job title, employee number, unit,
  status, preferred language, created on and last signed in.
- **Roles and their grants.**
- **External reviewers** with their periods.
- **No password hashes**, and nothing else from the exclusions above.

### Records Trustline keeps about the client

The subscription (without price or Trustline's note) and the platform's log
entries about the client are not readable by the application role.
**Recommended:** the worker adds them through the platform role, limited to
those columns: action, time, the staff member's name and the details (decision
7). The entries the client's own log mirrors are already in `audit/`.

## Formats

- **JSON Lines** (`.jsonl`): one object per line, in UTF-8.
  - Ids are UUIDs.
  - Times are ISO 8601 in UTC (`Z`).
  - Days are `YYYY-MM-DD` on the client's calendar, whose time zone is in
    `organization/`.
  - Text in several languages is an object per language, as stored
    (`{"en": …, "ar": …}`).
  - The keys are English and stable, since this is a machine format.
  - Each file has a JSON Schema in `schema/`.
- **CSV** for the tables people open: users, units, incidents, events,
  documents, acknowledgements, reviews, measures and the worded audit log.
  - The same rules as today's exports (`csv.ts`, moved to a shared place):
    UTF-8 with a byte-order mark, every cell quoted, CRLF lines, and formula
    starts neutralised. Every name and title in them was written by someone
    other than whoever opens the file.
  - Headings and values in the language chosen at the request.
  - Split into parts of at most 1,000,000 rows, since spreadsheets open no
    more.
- **HTML and PDF** for each document version, as above. Committee packs as
  PDF.
- **The archive:**
  - **Recommended:** ZIP (ZIP64 for size), which every system opens without
    extra software;
  - `manifest.json` lists every file with its size and SHA-256, the number of
    rows of each table, the moment of the data, the format version, the
    client, who asked and who approved, the chain's head, and its latest
    signed checkpoint;
  - `manifest.sig` is the Ed25519 signature of the manifest's bytes, by
    Trustline's export key (its own key id, published with the audit keys);
  - the download page and the audit entry give the SHA-256 of the archive
    itself, so the client can confirm that the file it holds is the one
    made.
- **Checking the archive:** the README explains, in each of the client's
  languages, how to:
  1. check the signature on the manifest with the published key;
  2. check each file against the manifest;
  3. check the audit chain with the verifier;
  4. recompute a document signature's hash.

## Who may ask, and two-person approval

- **New permission:** `data.export` (core).
  - Only a grant for the whole organization counts, since an export holds
    everything.
  - Built-in: the Administrator only.
  - It is given to existing clients' Administrator roles by migration, with
    one audit entry per client.
- **An export sees everything:** reporters' names, internal comments,
  restricted documents, the whole trail. Giving someone `data.export` is
  giving them all of that, and the role editor says so.
- **Request:** a holder asks for an export, with:
  - a reason: `contract_end` or `on_request`, and a note;
  - the language of the CSV and the README's first language (one of the
    client's);
  - whether to include PDFs.

  They give their password again, checked as for signatures, on the same lock
  as sign-in. Nothing is made yet.
- **Approval:** another holder of `data.export` approves or refuses the
  request (refusing needs a reason), with their password, within 7 days.
  - Otherwise the request lapses.
  - The person who asked can never approve (403 `same_person`).
  - The person who asked may cancel the request until it is made.
- **A client with one holder** cannot export alone. Its administrator gives a
  second person the permission, which is itself audited and seen by every
  administrator. Whether Trustline may count as the second person, on the
  written request of the client's contract contact, is decision 3.
- **One at a time.** **Recommended:** one export requested or in the making
  per client at a time (409 `export_in_progress`). There is no other
  frequency limit: the approval is the limit.
- **Everyone with authority is told.** At the request, the approval, the
  readiness and every download, every holder of `data.export` or
  `settings.manage` for the whole organization is told:
  - in the app;
  - and by email at once, since a full export is something an administrator
    must know about the same day. The email carries no name: "A full export
    of your organization's data was requested. Open Trustline to see who
    asked." (`email.md`, section 2).

## How it is made, delivered and expired

- **Made in the background** by an export worker, started by `main.ts` like
  the others. It claims requests with `SKIP LOCKED`, and any number of
  processes may run it. It works in three phases:
  1. **Data:** one `REPEATABLE READ, READ ONLY` transaction under
     `TenantDb.withTenant()`, so every file comes from the same moment. It
     reads table by table, by key, in batches that keep each statement under
     the application role's 15-second limit, and is never idle for 60
     seconds. It records that moment.
  2. **Documents:** HTML, and PDFs through the shared renderer, made from the
     files of phase 1, outside the transaction.
  3. **Archive:** the manifest, the signature, and the ZIP.

  A failure records its kind (never content), is retried twice, and tells
  the person who asked and the approver.
- **Size:** today everything is text: a large client with 10,000 incidents
  and 1,000 documents makes an archive of tens of megabytes. PDFs are the
  slow part, at about a second each. The page shows progress by phase.
- **Kept until downloaded:**
  - **Recommended:** in object storage in the client's data region
    (`tenants.data_region`), encrypted with a key of its own per export;
  - deleted when it expires;
  - never copied into backups;
  - single-tenant and on-premises deployments use their own volume. See
    decision 4.
- **Downloaded** from Administration, "Data export":
  - by the person who asked or the approver only;
  - each time with the password again;
  - at most 5 downloads, within 7 days of readiness (decision 8).

  After that it is `expired` and its file is deleted. The record of the
  export stays.
- **Passphrase.** **Recommended:** an optional passphrase, chosen by the
  person who asked, which encrypts the ZIP (AES-256) and is never stored
  (decision 5). Without one, the file is protected in storage and in
  transit, and is the client's to protect once downloaded.

## At the end of a contract

What `modules-and-subscriptions.md` says today:

- past due: everything works;
- suspended: read-only, with safety work open;
- cancelled: access ends on the agreed date, the client can export its data
  first, and deletion follows the contract's retention period.

**Recommended:**

- **An end date.** Trustline staff set the contract's end date on the
  subscription (`ends_on`, audited in both logs). It changes no status by
  itself, as with the other dates.
- **Notices before the end.** At 90, 30 and 7 days before it, the client's
  administrators are told in the app and by email: "Your organization's
  contract ends on <day>. You can export its data before then."
- **While suspended, exporting stays open** (`@OpenWhileSuspended()` on the
  request, approval and download). A client in a billing dispute must still
  be able to take its data, just as a hospital can always take someone's
  access away (decision 6).
- **An exit window after cancellation.** A cancelled client today has nobody
  able to sign in.
  - When Trustline staff cancel, they set an exit window (`exit_until`, 30
    days by default).
  - Until then, holders of `data.export` for the whole organization may sign
    in, and every route but signing in and out, `/auth/me` and the export
    routes answers 403 `subscription_cancelled`. Everyone else stays shut
    out, the public routes stay closed, and no session from before comes
    back (`access_reset_at`).
  - See decision 2.
- **After the exit window,** the data is kept, read by nobody, until the
  retention date in the contract (decision 9), then deleted.
  - Deletion is a command run by Trustline staff from the command line, like
    `platform:create-admin`, as the owner role, and needs two staff members.
  - It refuses before the date, and when no export was downloaded, unless
    the client's written instruction is recorded.
  - It produces a **deletion certificate**, signed with Trustline's key:
    - the client's identifier and id;
    - the day;
    - the number of rows deleted from each table;
    - the audit chain's last checkpoint;
    - the day the last backup holding the data expires.

    The certificate is sent to the client's contract contact and kept in
    `platform_audit_log`.
  - The `tenants` row stays as a stub (the identifier and status `deleted`,
    with no name), so that platform log entries keep their reference and the
    identifier is never reused.
- **Decision 8 and deletion conflict.** Decision 8 says acknowledgement
  records are kept "at least six years after the document is retired" and
  that "nothing in Trustline deletes them earlier". Deleting at the
  contract's retention date can come sooner.
  - **Recommended:** decision 8 holds while the client is a client. At exit,
    custody passes to the client with the archive, and the contract says so.
  - The alternative is a paid, read-only archive held by Trustline for the
    rest of the period. This is decision 1.

## Personal data (PDPL, GDPR)

- **Roles.**
  - **Recommended reading, for legal review:** the client is the controller
    of the personal data in its account, and Trustline is its processor.
  - Under the GDPR (Article 28(3)(g)) and the Saudi and UAE PDPL, a processor
    returns or deletes the data at the end of the service, as the controller
    chooses. The export is that return, and the deletion certificate is that
    deletion.
  - The business document already recommends legal review before the first
    Saudi contract (decision 11).
- **What the archive holds about people:**
  - staff: names, emails, phones, job titles, employee numbers, units, and
    sign-in times and addresses (in the audit trail);
  - who reported each named incident;
  - signatures and acknowledgements;
  - the free text of incidents and comments, which by rule holds no patient
    identifier but is written by people and may.

  The README says so plainly, in each of the client's languages.
- **Kept to what is needed:** secrets and their hashes, and copies of email,
  are left out (see "Excluded"). Addresses already cleared from the audit
  trail (`audit-trail.md`, "Personal data") are not in it; their commitments
  are.
- **Where the data goes.** The archive is kept in the client's data region
  until it is downloaded. Where the client then takes it is the controller's
  choice and responsibility, and the request screen says so.
- **A person's own data.** A member of staff asking the organization for
  their own data (a subject access request) is answered by the controller.
  **Recommended later:** a per-person export built on the same machinery
  (their account, their audit entries, their signatures and
  acknowledgements, the incidents they reported by name), run by the
  client's administrator.

## What Trustline staff can and cannot do

**Cannot:**

- request, approve or download an export;
- open, read or receive an archive;
- read any of the client's data. The platform role still cannot, and this
  spec gives it nothing more than the status columns below.

Storage keys for archives are given to the export worker only.

**Can:**

- see each export's status, reason, times, size and number of downloads (not
  who asked: names are the client's data), through a policy on
  `data_exports` limited to those columns;
- set the contract's end date, the exit window and the retention date;
- send the client the notices;
- run the deletion after the retention date, with a second staff member,
  and issue the certificate;
- if decision 3 allows it, record a second approval for a client with one
  administrator, on the written request of its contract contact. This
  releases nothing to Trustline.

**Operators with infrastructure access** (the database's owner, the storage)
could technically read data, as for any hosted service. This is limited by:

- per-export encryption keys held in a key service whose use is logged;
- archives that expire;
- the audit chain, which shows any change made to the data's record.

## Data outline (not a schema)

- **`data_exports`** (a tenant table, under `tenantIsolation()`, with grants
  for `trustline_app`, and a column-limited select policy for the platform
  role):
  - `reason`, `note`, `locale`, `include_pdfs`;
  - `requested_by`, `requested_at`, `approved_by`, `approved_at`,
    `refused_reason`;
  - `status`: requested, approved, refused, lapsed, cancelled, making,
    ready, failed, expired;
  - `snapshot_at`, `phase`, `size_bytes`, `archive_sha256`,
    `manifest_sha256`;
  - `storage_key` (not readable by the platform role), `expires_at`,
    `downloads`, `last_downloaded_at`;
  - `error_kind`, `revision`.
- **`subscriptions`:** `ends_on`, `exit_until` and `retain_until`, written by
  the platform role. The application role reads the first two.
- **Keys:** the export signing key and the audit checkpoint key are separate
  keys from the same infrastructure (`audit-trail.md`).

## API outline (under `/api/v1/exports`, `@ForModule('core')`)

| Route | Who | Body / query | Answers |
|---|---|---|---|
| `GET /` | `data.export` (whole organization) | `page`, `pageSize` | the exports, newest first |
| `POST /` | the same | `{ reason, note?, locale?, includePdfs?, password }` | 201 the request; 409 `export_in_progress` |
| `POST /:id/approve` | the same, not the person who asked | `{ password, revision }` | the export; 403 `same_person`; 409 `stale_export`, `lapsed` |
| `POST /:id/refuse` | the same | `{ reason, revision }` | the export |
| `POST /:id/cancel` | the person who asked | `{ revision }` | the export |
| `POST /:id/download` | the person who asked, or the approver | `{ password }` | the archive (`Content-Disposition: attachment`, `Cache-Control: no-store`); 410 `expired`; 409 `download_limit` |

Further rules:

- Every route answers 401 without a session, 403 without the permission, 404
  for an export of another client, and 400 for anything but its strict input.
- All of them stay open while the subscription is suspended, and during the
  exit window.
- On the platform side (`/api/v1/platform/tenants/:id/…`): the contract's
  dates (`ends_on`, `exit_until`, `retain_until`) and the exports' status.

## Audit

In the client's log, through `ProvisioningService.audit()` in the same
transaction:

- `data_export_requested`, `data_export_approved`, `data_export_refused`,
  `data_export_cancelled`, `data_export_lapsed`;
- `data_export_ready`, with the archive's hash and the row counts;
- `data_export_failed`, with the kind;
- `data_export_downloaded`, with who, the archive's hash and the address;
- `data_export_expired`;
- `contract_end_set`, mirrored from the platform.

In the platform's log: `contract_end_set`, `exit_window_set`,
`retention_set`, `client_data_deleted` (with the certificate's hash) and
`second_approval_recorded`.

## Tenant isolation

- **The worker** works client by client under `TenantDb.withTenant()`, so
  row-level security limits every read to that client.
- **The coverage test** names every table with `tenant_id`.
- **An end-to-end test** makes two clients, exports one, and checks that no
  id of the other appears in any file.
- **A test for secrets** checks that no file contains a password hash, a
  token hash or a follow-up code hash of any of the test's accounts.
- **Storage keys** are per client and per export, so one client's download
  cannot name another's file.

## Languages (en, ar, fr)

- **The README** is in each of the client's languages, with the requester's
  language first.
- **CSV headings and values, and the README's text,** are in
  `apps/api/src/exports/wording/<lang>.ts`, one file per language with the
  same keys, checked by a test.
- **The screens** (the request, approval, download and contract-end notices)
  use the web dictionaries.
- **The notices' emails** use the email wording files.
- **Document HTML and PDF** follow the version's languages.
- **The machine files** (JSON Lines, schemas, the manifest) use English keys
  and are never translated.

## Order of build

1. **The coverage registry and its test.** The shared signing keys come with
   step 3 of `audit-trail.md`.
2. **Request and approval:** `data.export`, the two-person rule, password
   re-entry, notices, audit, and the web page.
3. **The worker:** the consistent snapshot, JSON Lines with schemas, CSV, the
   manifest and its signature, storage, download, expiry, and the tests of
   isolation and of secrets.
4. **Documents:** HTML for every version now; PDFs once the shared renderer
   exists (`reports-and-measures.md`, step 7).
5. **The audit trail with its chain** in the archive, once `audit-trail.md`
   step 2 is built (until then, the entries without a chain).
6. **The contract's end:** the end date, the notices, the exit window, and
   Trustline's view of the status.
7. **Deletion after retention,** with the deletion certificate.
8. **Later:** a per-person export, and attachments once file storage exists.

The reviews:

- `security-reviewer` after steps 2, 3, 6 and 7;
- `bilingual-reviewer` after steps 2 and 3 (README, CSV, notices);
- `quality-reviewer` at the end.

## Decisions needed

1. **Retention after exit and decision 8:** custody passes to the client with
   the archive and Trustline deletes after the agreed period (recommended),
   or Trustline keeps a paid, read-only archive until six years after the
   last retirement.
2. **The exit window:** 30 days (recommended), and only holders of
   `data.export` may sign in during it.
3. **A client with one administrator:** may Trustline record the second
   approval on the written request of the contract contact, or must the
   client always name a second person?
4. **Where archives are kept:** the object storage provider in each region,
   the key service, and the equivalent on single-tenant and on-premises
   deployments.
5. **A passphrase on the archive:** optional (recommended), compulsory, or
   none. AES-encrypted ZIPs do not open with every system's built-in tool.
6. **Exporting while suspended** stays open (recommended).
7. **Trustline's records about the client** (the platform's log entries
   naming its staff) are included (recommended).
8. **Expiry:** 7 days and 5 downloads (recommended).
9. **The retention period after the contract ends**, to be written into
   contracts (for example 90 days after the exit window).
10. **Charging:** whether an export on request is charged, and whether the
    export at exit is always free (recommended).
11. **Legal review** of the processor's obligations under the Saudi and UAE
    PDPL and the GDPR, and of the deletion certificate.
12. **The first release without PDFs:** JSON, CSV and HTML first, with PDFs
    added once the renderer exists (recommended), or wait for the renderer.

## Decided by the business (28 November 2026)

Every recommendation in this spec is accepted. In particular:

- **Records after the contract ends:** custody passes to the client with the
  signed export; Trustline deletes its copy after a 90-day exit window. A
  paid read-only archive may be offered as an option.
- **A client with one administrator:** Trustline approves on the contract
  contact's written request, and that request is recorded.
- **First release:** JSON, CSV and documents as HTML; PDFs follow once the
  renderer exists.
- **Legal review** of the export and retention terms (PDPL and GDPR) before
  the first contract is signed.
- Every other decision in "Decisions needed" follows the recommendation
  written there.
