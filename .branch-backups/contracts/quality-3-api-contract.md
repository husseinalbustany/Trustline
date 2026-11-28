# API contract for the web: quality review 3

All routes are under `/api/v1`. Dates are `YYYY-MM-DD` on the client's calendar, and moments are ISO timestamps. Every new route answers:
- 401 without a session;
- 403 `{ code: 'missing_permission', permission }` without its permission;
- 404 for a record of another client, or one outside the caller's reach;
- 400 for anything but its strict input.

Migration 0052 is applied in the local database.

## M2 and M3: importing

### New optional fields on an import document
These apply to `POST /policies/documents/import`, `POST /policies/imports` and `POST /policies/imports/check`, and to the CSV/JSON layout.

| Field | Type | Rule |
|---|---|---|
| `lastReviewedOn` | date | When the original was last reviewed, as it says. It may not be before `approvedOn`, nor after today. |
| `differences` | `{ en?, ar?, fr? }`, up to 2,000 characters per language | Plain text. Only the client's languages. For example: "Table 2 written as a list; the flowchart of appendix B is not reproduced, see the original." |

### New and changed refusals
On a single import, each is the answer's body. In a batch or a check, each is one entry of `problems`.

| Code | When |
|---|---|
| `reviewed_before_approval` | `lastReviewedOn` is before `approvedOn`. |
| `reviewed_in_future` | `lastReviewedOn` is after today. |
| `review_before_last_review` | `nextReviewOn` is on or before `lastReviewedOn`. |
| `review_date_too_far` | **Changed.** `{ code, latest, maxReviewMonths, from }`. `latest` is now `from` plus the client's longest review period. `from` is the later of `approvedOn` and `lastReviewedOn`; before, it was today. Word it as "no later than {latest}: {maxReviewMonths} months from {from}". |
| `language_mismatch` with `field: 'differences'` | `differences` is written in a language the client does not use. |

An old document whose review has passed is still accepted, and is shown as overdue.

### Wording of the signature
The import signature now covers the differences. The signing text should say that the text "matches the approved original, except as noted below". Put the differences under that sentence, in both the single and the batch sign prompts.

### Where the new fields appear in answers
- **`imported`** in a version answer gains `lastReviewedOn` (date or null) and `differences` (Localized or null).
- **`control.approvedBeforeTrustline`** gains:
  - `lastReviewedOn` and `differences`;
  - `sectionsNotInOriginal`: `[{ key, required }]`, in the version's order. Use it to say on the reader's view and on print which sections were not in the original.
- **`control.originalRevision`** is the original's revision (for example "Rev. 4"), or null. It is for the print header: "Version 1 (Rev. 4 on the original)".
- **The master list** CSV (`GET /policies/exports/documents`) gains two columns at the end: "Last reviewed on the original" and "Differences from the original".

## S1: the import register, the library filters, the owner's notice

### The register
`GET /policies/imports?page=&pageSize=` (pageSize up to 500, default 100). It needs `policies.manage` for the whole organization.

```json
{ "items": [ {
    "documentId": "…", "number": "PRC-SAF-007", "title": { "en": "…" }, "versionId": "…",
    "numberAsGiven": "PRC-SAF-007" | null, "revisionLabel": "Rev. 4" | null,
    "approvedOn": "…", "approvedBy": "Head of Operations", "lastReviewedOn": "…" | null,
    "originalKeptAt": { "en": "…" }, "differences": { "en": "…" } | null,
    "effectiveOn": "…", "nextReviewOn": "…",
    "importedBy": { "id": "…", "name": { "en": "…" } }, "importedAt": "…",
    "batch": { "id": "…", "index": 0, "size": 12, "listHash": "<64 hex>" },
    "signatureId": "…", "contentHash": "<64 hex>"
  } ], "total": 1 }
```

Items are newest first.

`GET /policies/exports/imports?locale=` returns the same list as a CSV and is audited as `imports_exported`. Its columns:
- Number, Title
- Number on the original, Revision on the original
- Approved on, Approved by (as on the original)
- Last reviewed on the original, Where the signed original is kept, Differences from the original
- Imported by, Imported at
- Batch, Fingerprint of the batch, Fingerprint of what was signed

### Library filters
`GET /policies/documents` and `GET /policies/exports/documents` take two new filters:
- `source=imported|written`: the version in force was imported ("Approved before Trustline") or written in Trustline.
- `reissueDue=true`: in force as imported, with its review within 60 days or past ("Re-issue due").

### The owner's notice
New notification kind `document_owner_assigned`:
- **Data:** `{ version: 1, versionId, number, serious: false }`, with the `documentId` of the document.
- **When:** an import makes someone the owner of a document, unless they imported it themselves.
- **Where:** in the app only, with no email.
- **Wording:** this needs dictionary entries in all three languages. For example: "You are now the owner of {number}: its periodic review and its re-issue are yours."

## S2: overdue approval steps by email
- **The weekly digest notification** (`acknowledgements_overdue_digest`):
  - its data gains `stepsOverdue` (a count);
  - it now also goes to managers who have only overdue steps, in which case `overdue` and `people` are 0.
  - The in-app wording should show the acknowledgement line only when `overdue > 0`, and add "Approval steps overdue: {stepsOverdue}" when that is above 0.
- **The emails** (wording in the API): there is a new daily digest section "Approval steps overdue in the documents you manage", and the weekly email has a line for the steps. Its subject names what is overdue: acknowledgements, steps, or both (language review 8, A3). With acknowledgements overdue it links to `/<lang>/policies/overdue`; with steps only, to `/<lang>/policies/steps/overdue`, the new web screen. The in-app notice with steps only should lead there too.

### The list of overdue steps (language review 8, M6)
`GET /policies/steps/overdue?page=&pageSize=` (pageSize up to 500, default 100).
- **Who:** `policies.manage`. The steps are those of the documents the caller manages: the same steps and scope as the emails count. Other clients' steps are never listed.
- **Why not `policies.view_all` too:** the late list takes `policies.view_all` or `policies.manage`, but this list is scoped to managed documents, so with `view_all` alone it would always be empty. The weekly email that links here also goes only to those who manage.
- **Order:** most overdue first.
- **Answer:**

  ```json
  { "today": "…",
    "items": [ {
      "document": { "id": "…", "number": "PRC-SAF-014", "title": { "en": "…" } | null, "canOpen": true },
      "version": { "id": "…", "version": 2 },
      "position": 1, "kind": "review" | "approve",
      "assignee": { "type": "person", "id": "…", "name": {…} } | { "type": "role", "id": "…", "name": {…} } | null,
      "dueAt": "…", "dueOn": "YYYY-MM-DD", "daysOverdue": 3
    } ],
    "total": 1 }
  ```

- **Titles:** `title` is null where the caller may not open the document. The number and version are always given, as the emails give them.
- **Links:** the version page is `/<lang>/policies/<document.id>/versions/<version.id>`.

## S5: acknowledgements as files
- **`GET /policies/exports/acknowledgements/overdue?locale=`:** the late list as a CSV. It needs `policies.view_all` or `policies.manage`, and is audited. Its columns:
  - Person, Employee number, Their area;
  - Document number, Document title, Version;
  - Due on, Days overdue.
  - A document the caller may not open is left unnamed (empty cells), as on screen.
- **`GET /policies/people/:userId/acknowledgements?page=&pageSize=`:**
  - It needs `policies.manage` over the person's home unit (whole organization for a person with no unit). Anyone else gets 404, as for a person of another client.
  - It includes people who have left.
  - It answers:

    ```json
    { "today": "…",
      "person": { "id": "…", "name": {…}, "status": "active" | "invited" | "disabled", "orgUnit": { "id": "…", "name": {…} } | null },
      "items": [ { "document": { "id", "number", "title" } | null, "version": { "id", "version", "status" } | null,
                   "assignedAt": "…", "dueOn": "…", "acknowledgedAt": "…" | null,
                   "state": "acknowledged" | "pending" | "overdue", "late": true } ],
      "total": 1 }
    ```

  - `document` and `version` are null where the caller may not open them.
  - `late` means acknowledged after the due day, or not acknowledged with the day passed.
- **`GET /policies/people/:userId/acknowledgements/export?locale=`:** the same as a CSV, audited as `person_acknowledgements_exported`. Its columns:
  - Person, Employee number, Their area, Account;
  - Document number, Document title, Version, Status of the version;
  - Asked on, Due on, Where it stands, Acknowledged at, Late;
  - Fingerprint of what was signed.
- **Where to get the people:** the screen can take them from the late list, or from the person's page. `GET /policies/people` lists only active staff for choosing owners, so it is not the right source here.

## S3: email opt-outs
- **`GET /settings/email/opt-outs`:**
  - It needs `settings.manage` for the whole organization.
  - It answers `{ items: [{ id, name, immediate, digest, reliedOn: { approves, triages } }], total }`, listing each active person who has a switch off.
  - Names only, never an address.
- **`GET` and `PATCH /me/notification-preferences`:**
  - Both answers gain `reliedOn: { approves, triages }`.
  - `approves` is true when the person decides approval steps and the client has policies. `triages` is true when the person triages incidents and the client has incidents.
  - Warn before such a person switches the immediate emails off.

## Periodic review: "confirm no change"
- **When it is allowed:** within 60 days before the due date, or after it.
- **Otherwise:** `POST /policies/documents/:id/review` answers 409 `{ code: 'review_not_due', dueOn, opensOn }`, before the password is asked.
- **Moves:** the document's `moves` no longer include `confirm_review` until `opensOn`.
- **Said in advance:** the document's answer (`GET /policies/documents/:id`, and every answer that is a document) has `reviewOpensOn` next to `nextReviewOn`. It is the day "Confirm no change" opens: `nextReviewOn` minus 60 days, or null with no review date. It comes from the same function as `moves` and the refusal, so `confirm_review` is in `moves` exactly when today is on or after `reviewOpensOn`, and the refusal's `opensOn` is the same day.
- **Wording:** for example "This review can be confirmed from {opensOn}; it is due on {dueOn}."

## Language review 8: CSV wording changed

These are header and value changes in the files the API makes. No screen reads them, and they are listed so the screens can match.
- **Late column** of the person's record, in French: « Hors délai » (A5).
- **Acknowledged at** heading and the "acknowledged" value, in French: « Confirmée le » and « Confirmée » (A8).
- **Account "invited"** now uses the screen's wording: "Invited, not signed in yet", «دعوة لم تُقبل بعد», « Invitation envoyée, pas encore acceptée » (A7).
- **The register:**
  - "Approved by (as written on the original)" / « Approuvé par (tel qu’écrit sur l’original) » (A6);
  - Arabic "imported by": «مَن استوردها»;
  - the French fingerprint heading, in every file: « Empreinte du contenu signé ».

