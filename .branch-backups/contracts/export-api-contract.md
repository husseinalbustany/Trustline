# Data export: web contract

The harness blocks writing new files to the scratchpad, so the contract is here.

All routes are under `/api/v1/exports`.
- **Every route:** `data.export` for the whole organization (403 `{code:'missing_permission', permission:'data.export'}`), 401 without a session, 404 for another client's export, 400 for non-strict input or a bad uuid.
- **`GET /?page&pageSize`** (pageSize up to 100) returns `{items, more, page}`. Each item:
  ```
  {id, status, reason, note, locale, includePdfs, pdfsIncluded:false,
   requestedBy:{id,name}, requestedAt, lapsesAt, approvedBy, approvedAt,
   refusedBy, refusedAt, refusedReason, cancelledAt,
   phase ('data'|'documents'|'archive' while making), failure (kind, when failed),
   snapshotAt, sizeBytes, archiveSha256, readyAt, expiresAt, expiredAt,
   downloads, downloadsLeft, revision,
   may:{approve, refuse, cancel, download}}
  ```
  Statuses: requested, approved, refused, lapsed, cancelled, making, ready, failed, expired.
- **`POST /`** with `{reason:'contract_end'|'on_request', note?(≤1000), locale?, includePdfs?, password}`:
  - 201 with the item;
  - 401 `wrong_password` or `password_locked`;
  - 400 `{code:'language_mismatch', field:'locale'}`;
  - 409 `export_in_progress`.
- **`POST /:id/approve`** with `{password, revision}`: 200, or 403 `same_person`, 409 `lapsed` or `stale_export`, 401 for a wrong password.
- **`POST /:id/refuse`** with `{reason(1–1000), revision}`: 200, or 403 `same_person`, 409 `stale_export`.
- **`POST /:id/cancel`** with `{revision}`: the requester only (403 `not_requester`), while requested or approved, else 409 `stale_export`.
- **`POST /:id/download`** with `{password}`:
  - success returns `application/zip`, `Content-Disposition: attachment`, `Cache-Control: no-store`, `X-Archive-SHA256`;
  - refusals: 403 `not_yours`, 409 `not_ready` or `download_limit`, 410 `expired`.
  - Show the archive's SHA-256 on the page.
- **`GET /audit/keys`** now also returns `exportKeys` (the same shape as `keys`).
- **Permission label** for `admin.permissions["data.export"]`:
  - en "Ask for, approve and download a full export of the organization's data"
  - ar «طلب التصدير الكامل لبيانات المنشأة واعتماده وتنزيله»
  - fr « Demander, approuver et télécharger une exportation complète des données de l’établissement » **[L11]**

  The role editor must warn that it gives everything: reporters' names, internal comments, restricted documents and the whole audit trail.
- **In-app notification `data_export_changed`**, with `data.change` one of requested, approved, refused, cancelled, lapsed, ready, downloaded, failed. Word it like the email subjects in `src/email/wording/*.ts` (`data_export_<change>`), and link to `/admin/data-export`.
- **`audit.actions` labels:** copy the 9 `data_export_*` labels from `src/audit/wording/{en,ar,fr}.ts`.
- **Request screen:** it must say the controller's responsibility once the file is downloaded, and that a second holder must approve.


## CHANGED by security review 19 (marked [S19])

- **[S19] Who may export:** every `/exports` route also needs `incidents.see_reporter` for the whole organization, else 403 `{code:'missing_permission', permission:'incidents.see_reporter'}`. The role editor should say that `data.export` works only together with it, and that it gives everything.
- **[S19] Approve:** 403 `{code:'approver_not_independent', reason}`. The reasons:
  - `account_by_requester`, `account_new`: the approver's account was made by the requester, or less than 7 days ago;
  - `grant_by_requester`, `grant_new`: so was every grant giving them `data.export` for the whole organization.

  Suggested wording: "You cannot approve this export: your account or your permission was given by the person who asked, or less than 7 days ago. Another administrator must approve it."
- **[S19] Download:** 409 `{code:'archive_unavailable'}` when the stored archive cannot be opened whole. The download is not counted. Say "This archive cannot be opened. Ask for a new export."
- **[S19] Only one archive is ready at a time.** When a newer export is ready, the older one is `expired`.
- **[S19] Failures:** a `failed` export may show `failure: 'stopped'`: the export stopped while being made, at its last try.

## Steps 6 and 7 (new)

**The client side:**
- **`GET /auth/me`** has `tenant.exit: { until: 'YYYY-MM-DD' } | null`.
  - When set, the client's subscription has ended and this is its exit window. Show only the data export page, with "Your organization's contract has ended. You can export its data until {day}." Every other route answers 403 `{code:'subscription_cancelled'}`.
  - Only holders of `data.export` and `incidents.see_reporter` for the whole organization can sign in then; anyone else gets the usual refusal.
- **Export items** have `approvedByTrustline: { at, writtenRequest: { receivedOn, from, reference, note } } | null`.
  - When set, `approvedBy` is null.
  - Show "Approved by Trustline on the written request of {from} ({reference}, received {receivedOn})".
  - Only the person who asked may download.
- **Notifications:**
  - `contract_ending`, with `data.endsOn` and `data.days` (90, 30 or 7). Wording as the email: "Your organization's contract with Trustline ends on {day}. You can export its data before then." Link to `/admin/data-export`.
  - `data_export_granted`, with `data.personId`: "{person} was given permission to export all of the organization's data." Link to the person.

**The portal** (`/api/v1/platform/tenants/:id/…`, Trustline's staff session):
- **`GET contract`** returns `{tenantId, clientStatus, subscriptionStatus, endsOn, exitUntil, retainUntil, exitWindowOpen, exportDownloaded, deletable, exports, deletion}`.
  - `deletable` is null, or why not: `already_deleted`, `not_cancelled`, `no_retention_date`, `before_retention`, `no_export_downloaded`.
  - `exports`: up to 50, newest first, each `{id, status, reason, requestedAt, approvedAt, trustlineApprovedAt, refusedAt, cancelledAt, readyAt, expiresAt, expiredAt, sizeBytes, downloads, lastDownloadedAt}`. No names.
  - `deletion`: the latest, or null: `{id, status ('requested'|'approved'|'done'|'cancelled'), reason, writtenInstruction, requestedBy:{id,name}, requestedAt, approvedBy, approvedAt, cancelledAt, executedAt, certificate, certificateSha256, signature}`.
- **`PUT contract`** with `{endsOn?, exitUntil?, retainUntil?}` (each `YYYY-MM-DD` or null, at least one): returns the view, or 400 `invalid_dates` (retention before the end of the exit window). Cancelling the subscription sets `exitUntil` to 90 days later unless set.
- **`POST exports/:exportId/approve`** with `{writtenRequest: {receivedOn, from (1–200), reference (1–200), note?}}`:
  - 200: the view;
  - 409 `not_alone` (another holder of the client's can approve), `lapsed`, `stale_export`;
  - 404 for an export of another client.
- **`POST deletion`** with `{reason (1–1000), writtenInstruction?}`:
  - 201: the view;
  - 409 with the `deletable` codes, or `deletion_in_progress`.
- **`POST deletion/:deletionId/approve`:** another member of staff (403 `same_person`); 409 `stale_deletion` or the `deletable` codes.
- **`POST deletion/:deletionId/cancel`:** 200, or 409 `stale_deletion`.
- **The deletion itself** runs from the command line: `pnpm --filter api platform:delete-client --deletion <id> --backups-expire-on <YYYY-MM-DD> [--out file]`. It writes the signed certificate. The portal shows it once done.

**New audit actions in the client's log** (worded in en, ar and fr; copy them into `audit.actions`):
- `contract_end_set`: "Contract end dates set by Trustline";
- `data_export_approved_by_trustline`: "Full data export approved by Trustline, on a written request".

## CHANGED by language review 11 (marked [L11])

- **[L11]** The permission's French label is above. The role editor's warning, from the review (§2):
  - en "This gives everything the organization holds in Trustline: reporters' names, internal comments, restricted documents and the whole audit trail. A full export needs two people who hold it: one asks, the other approves. Give it only to those who will answer for the data once it leaves Trustline."
  - ar «تتيح هذه الصلاحية كل ما لدى المنشأة في Trustline: أسماء المبلّغين، والتعليقات الداخلية، والوثائق المقيّدة، وسجل التدقيق كاملًا. ويحتاج التصدير الكامل إلى شخصين يحملانها: أحدهما يطلب والآخر يعتمد. لا تمنحها إلا لمن يتحمّل مسؤولية البيانات بعد خروجها من Trustline.»
  - fr « Cette permission donne accès à tout ce que l’établissement détient dans Trustline : noms des déclarants, commentaires internes, documents restreints et journal d’audit complet. Une exportation complète demande deux titulaires : l’un la demande, l’autre l’approuve. Ne la donnez qu’aux personnes qui répondront des données une fois sorties de Trustline. »
- **[L11]** The audit labels of the 9 `data_export_*` actions, and of `data_export_approved_by_trustline` and `contract_end_set`: copy them from `apps/api/src/audit/wording/{en,ar,fr}.ts` into `audit.actions`. The French ones are now noun phrases.
- **[L11]** French uses « exportation » and « établissement » throughout; Arabic treats Trustline as masculine.
- **[L11]** The `detailLines` of audit entries now word what they used to print raw:
  - languages by name;
  - months ("October 2026") and days as the web writes them, including the external reviewer's access days;
  - measures by name, with their units ("Triaged on time: 95% → 85%");
  - `module` and `method` as words.


## Security review 20 (added 28 November 2026; its migration is held)

Portal (Trustline staff), under `/api/v1/platform/tenants/:id`:

- **New:** `POST exports/:exportId/written-request` with body `{ writtenRequest: { receivedOn, from, reference } }` returns 201. One member of Trustline's staff records the client's written request here; a different one approves.
  - 404 when the export is not this client's;
  - 409 `stale_export` when the export is not waiting for approval;
  - 409 `already_recorded`.
- **Changed:** `POST exports/:exportId/approve` now takes **no body**. It approves on the recorded request.
  - 409 `no_written_request`;
  - 403 `same_person` when the approver is the staff member who recorded the request;
  - 409 `requester_not_independent` when the person who asked is the administrator the platform made, or their account or password is under 7 days old;
  - the earlier `not_alone`, `stale_export` and `lapsed` answers are unchanged.
- **`PUT contract`:**
  - 409 `client_deleted`;
  - 409 `exit_window_open` when the change would shorten an exit window that is open.
- **PATCH client** (`/platform/tenants/:id`): 409 `client_deleted`.
- **The contract view (`GET contract`):**
  - it answers for a deleted client, with `subscription: 'cancelled'`;
  - `deletion.certificateText` holds the certificate's exact text. To check it, verify the signature over `"trustline-deletion-certificate-v1\n" + certificateText`, with the key named in `deletion.signature.keyId`. Show it as preformatted text, and offer it as a download of exactly those bytes;
  - downloads count only those made since the cancellation.
- **Reactivating** a cancelled client clears `exitUntil` and `retainUntil`. Cancelling again opens a new exit window unless the stored one ends today or later.
- **New platform log actions:**
  - `second_approval_request_recorded` (exportId, writtenRequest);
  - `second_approval_recorded` now also carries `recordedBy`.

Client side:

- **`approver_not_independent`** has three new `reasons`: `password_recent`, `link_by_requester` and `role_widened`, alongside `account_new`, `account_by_requester`, `grant_new` and `grant_by_requester`. **Web:** wording for the three new reasons:
  - `password_recent`: "their password was set in the last 7 days"
  - `link_by_requester`: "you sent them a sign-in link in the last 7 days"
  - `role_widened`: "a role they hold gained data export or reporter names in the last 7 days"
- **Sign-in:** an external reviewer of a cancelled client is refused (`subscription_cancelled`) before any code is sent.

The archive's README now has an "After the contract ends" section about the deletion certificate, in every language. No web change is needed.
