# API contract for the web: the business decisions after quality review 3

> **CHANGED again (marked [Maya 2]):** `confirm_import` is never offered to
> the importer, and `review_approval_turned_off` carries `typeName`.
>
> **CHANGED after security review 11.** Every change since the first
> version of this file is marked **[R11]**, and summarised here:
> - **Confirmation:**
>   - `importConfirmation` gains `dueFrom`.
>   - New errors: 409 `owner_is_importer` on `PATCH /documents/:id` (field
>     `ownerId`), and 403 `importer_cannot_confirm`.
> - **Signing PIN:**
>   - `PUT /me/signing-pin` takes `{ pin, currentPin? }`; changing a PIN
>     needs `currentPin`.
>   - New errors: 400 `current_pin_required`, 403 `signing_pin_locked`,
>     409 `stale_signing_pin`, 503 `signing_pin_unavailable`, and 409
>     `signs_with_pin` on `POST /users/:id/invite`.
>   - A wider `pin_too_simple`.
>   - Setting, changing or resetting a PIN signs the person's other
>     sessions out; a reset signs them out everywhere.
> - **New notification kinds:** `signing_pin_locked` and
>   `review_approval_turned_off`. `signing_pin_changed` is now also emailed,
>   and the email cannot be switched off.
> - **Lists:** `GET /policies/approvals` gives `reviews[].requestedBy` as
>   `{ id, name }`, and each `GET /policies/documents` item gains
>   `confirmation`.
> - **Import screens:** show them only with `policies.import` for the whole
>   organization (`scope['policies.import'] === 'all'`), not merely listed in
>   `permissions`.


These cover decisions 1, 4, 5, 6, 8 and 9 of `policies-and-procedures.md`. All routes are under `/api/v1`. Every new route answers:
- 401 without a session;
- 403 `{ code: 'missing_permission', permission }` without its permission;
- 404 for a record of another client;
- 400 for anything but its strict input.

Migrations 0053 and 0054 are applied in the local database. **The web dictionaries need new entries**, listed at the end.

## 1. Who imports, and the owner's confirmation

### Permission `policies.import`
- **Routes:** every import route needs it for the whole organization: `POST /policies/documents/import`, `POST /policies/imports` and `POST /policies/imports/check`. Without it the answer is 403 with `permission: 'policies.import'`.
- **Who holds it:** the built-in **Quality officer**. The **Administrator** does not. Every existing client's Quality officer got it (audited).
- **Who may grant it:** someone who manages documents for a place may grant it there without holding it, so an administrator can still give someone the Quality officer role. Never to themselves (`cannot_change_self`).
- **[R11] The import screens** should show only when `/auth/me` gives `scope['policies.import'] === 'all'`. A grant for one unit is listed in `permissions` but does not open the routes.
- **The import register** (`GET /policies/imports` and its CSV) stays with whole-organization managers (`policies.manage`).

### The confirmation
Each imported document is due for its owner's confirmation 30 days after import.
- **In the document answer** (`GET /policies/documents/:id`, and every answer that is a document): `importConfirmation`, for the version in force when it is imported.

  ```json
  { "state": "awaiting" | "overdue" | "confirmed", "dueOn": "YYYY-MM-DD",
    "dueFrom": { "id", "name" } | null,
    "confirmedAt": "…" | null, "confirmedBy": { "id", "name" } | null,
    "byImport": false, "signatureId": "…" | null }
  ```

  It is `null` for any other document. `byImport: true` means the importer is the owner, so the import itself confirmed it. Show it that way, for example "Confirmed by the import: the owner imported it".
- **Move:** `confirm_import` appears in `moves` for the owner while the state is awaiting or overdue. **[Maya 2]** Never for the importer, even when they are the owner, nor when `dueFrom` is someone else: the move is offered exactly when the route would take it.
- **[R11] `dueFrom`** is whom the confirmation is awaited from: the owner, moved with each new owner while it awaits. It is null when the import itself confirmed it. A confirmation already given stays the one given: word it as "confirmed by {confirmedBy}, the owner then" when `confirmedBy` is not the current owner.
- **[R11] Changing the owner:** `PATCH /policies/documents/:id` with `ownerId`, while the confirmation is awaited, moves it to the new owner (they get `document_owner_assigned` with `confirmationDueOn`). It answers 409 `{ code: 'owner_is_importer', field: 'ownerId' }` when the new owner would be the importer.
- **Route:** `POST /policies/documents/:id/confirm-import` with `{ password, revision }` (the password, or the signing PIN). 200 returns the document. Refusals:
  - 403 `not_owner` (also when it is due from someone else);
  - **[R11]** 403 `importer_cannot_confirm` (the one who imported it, even if made owner since);
  - 409 `import_already_confirmed`, `not_imported`, `not_active`, `stale_document`;
  - 401 `wrong_password` and `password_locked`;
  - 403 `signing_pin_required`.
- **The version answer:** `imported.confirmation` has the same shape, and `control.approvedBeforeTrustline.ownerConfirmation` has `{ state, dueOn, confirmedAt, confirmedBy, byImport }` for print.
- **The register:** each item has `confirmation: { state, dueOn, confirmedAt, confirmedBy, byImport }`. The CSV gains three columns: "Owner's confirmation", "Confirmation due on" and "Confirmed at".
- **The master list:** a last column, "Owner's confirmation of the import", with "Awaiting the owner", "Overdue", "Confirmed", or "Confirmed by the import (the owner imported it)".
- **[R11] The library list** (`GET /policies/documents`): each item gains `confirmation`: `'awaiting' | 'overdue' | 'confirmed' | 'byImport' | null`, for the version in force. It is null when that version was not imported. These are the master list's values, and the same rows carry them.
- **Notifications:**
  - `document_owner_assigned` data gains `confirmationDueOn`.
  - New kind `import_confirmation_due`: `data: { dueOn, overdue: boolean, number, serious: false }`, with the `documentId`. It goes to the owner and the importer 7 days before the due day, and again once it is overdue.

## 4. Emails that cannot be switched off
- **`GET` and `PATCH /me/notification-preferences`** gain `alwaysOn: [{ emails, reason }]`. The values are:
  - `{ emails: 'serious_incident_alerts', reason: 'triages' }`;
  - `{ emails: 'approval_steps', reason: 'decides_approval_steps' }`.

  Show them as always on, with the reason, under the immediate switch. The switch itself still works for everything else.
- **The unsubscribe pages** (API wording) say which emails stay on.

## 5. The language that applies, per document
- **`PATCH /policies/documents/:id`** takes `authoritativeLocale`: one of the client's languages, or `null` for the organization's setting.
  - It is refused with 400 `{ code: 'language_mismatch', field: 'authoritativeLocale' }` for another language.
  - When the language that stands changes, the answer has `versionsInProgress: { draft, in_review, approved }`, as the organization setting does.
- **The document answer** has `authoritativeLocale` (null means it follows the organization).
- **Drafts** are checked against it, and versions record it when sent (`version.authoritativeLocale`).

## 6. "No change" review, also signed by the Approving authority
- **The type setting:** the type routes (`GET`, `POST` and `PATCH /policies/types`) have `noChangeNeedsApproval: boolean`. It is on for policies and off for the other types by default.
- **The document answer** gains:
  - `reviewNeedsApproval` (from its type);
  - `reviewApproval`, the latest one, or null:

    ```json
    { "id", "status": "pending" | "approved" | "returned", "dueOn",
      "comment": "…" | null, "requestedBy": { "id", "name" }, "requestedAt",
      "decidedBy": { "id", "name" } | null, "decidedAt", "decisionComment": "…" | null }
    ```

    The comments are given only to the owner, the managers, those with full sight, and the approvers.
- **Moves:** `confirm_review` is not offered while a review is pending. `approve_review` and `return_review` are offered to those who sign it.
- **`POST /policies/documents/:id/review`** (confirm no change): when the type needs approval, the answer has `reviewApproval.status: 'pending'`, and `nextReviewOn` has not moved. Refusals:
  - 409 `review_pending` (one at a time);
  - 409 `no_review_approver` (nobody could sign it).
- **`POST /policies/documents/:id/review/approve`** with `{ password, revision }` needs `policies.approve` and being one who signs it. It returns the document with `reviewApproval.status: 'approved'`, the next review moved, and `lastReviewedOn` set to today. Refusals:
  - 403 `not_review_approver`;
  - 403 `same_person` (`reason: 'requested'`);
  - 409 `no_review_pending`, `stale_document`;
  - the password refusals.
- **`POST /policies/documents/:id/review/return`** with `{ comment (1 to 2,000), revision }` is the same check without a password. It returns `reviewApproval.status: 'returned'` with `decisionComment`.
- **"Awaiting me":** `GET /policies/approvals` gains `reviews: [{ documentId, number, title, dueOn, requestedBy, requestedAt }]`. **[R11]** `requestedBy` is now `{ id, name }` (name per language, shown with `pick()`), no longer a bare id. The dashboard's "awaiting my approval" counts them too.
- **Notifications:**
  - `review_approval_requested` (`data: { dueOn, number }`) goes to those who sign it, in the app and by email at once.
  - `review_returned` (`data: { dueOn, number }`) goes to its owner.
- **History:** a review in history signed by the Approving authority has `approvedBy` and `approvalSignatureId` (signature meaning `reviewed_no_change_approved`).
- **[R11] Who signs:** never the one who asked. When the only Approving authority is that person, the Administrators sign.
- **[R11] New kind `review_approval_turned_off`**, `data: { typeId, typeCode, typeName }`, with no document. **[Maya 2]** `typeName` is the type's name, `{ en, ar, fr }`, shown with `pick()`. It goes to the Approving authorities and the Administrators, in the app only, when a type's `noChangeNeedsApproval` is turned off.

## 8. Retention
No contract change. Acknowledgement records and signatures, including those of people who have left, are never deleted. The spec has the rule: at least six years after the document is retired.

## 9. Signing PIN (`docs/specs/identity-signing-pin.md`)
- **`GET /auth/me`** gains `signingMethod: 'password' | 'pin' | 'none'`.
- **[R11] `PUT /me/signing-pin`** with `{ pin, currentPin? }` answers 204. It is only for a person with no password (single sign-on only). **Changing a PIN needs `currentPin`.** Refusals:
  - 409 `signs_with_password`;
  - 400 for a malformed PIN (6 to 12 digits);
  - **[R11]** 400 `pin_too_simple`: fewer than three different digits, runs, repeats (121212, 123123), doubled digits (112233), mirrors (123321), dates (311290, 19800521), or common PINs. Word it as "too easy to guess";
  - 403 `fresh_sign_in_required` (more than 10 minutes since signing in: ask them to sign in again);
  - **[R11]** 400 `current_pin_required`;
  - **[R11]** a wrong `currentPin` gets the signing refusals below (401 `wrong_password`, `password_locked`, 403 `signing_pin_locked`);
  - **[R11]** 409 `stale_signing_pin` (changed or reset meanwhile: reload);
  - **[R11]** 503 `signing_pin_unavailable` (the server has no `SIGNING_PIN_PEPPER`; for local work add one to `.env`).
- **[R11] Other sessions:** setting or changing the PIN signs the person's other sessions out. The current one stays.
- **Using the PIN:** every signature prompt takes the PIN in the same `password` field. Word the prompt by `signingMethod` ("Your signing PIN"). The refusals are the same: `wrong_password`, and `password_locked` after 5 wrong attempts.
- **[R11] The lock:** after 10 wrong PINs in all (only a right one sets the count back), signing routes answer 403 `signing_pin_locked`, even with the right PIN, until an administrator resets the PIN. The session in which the 10th was entered is signed out, so the screen will see 401 next. Word it as "Signing with your PIN is locked: ask your administrator to reset it".
- **Signing routes** answer 403 `signing_pin_required` when the person has neither a password nor a PIN. Lead them to set one.
- **`DELETE /users/:id/signing-pin`** answers 204 (an administrator's reset), for whoever may manage the person. Refusals: 409 `no_signing_pin`; 404 for another client's person. **[R11]** It also clears the lock, and signs the person out everywhere.
- **[R11] `POST /users/:id/invite`** answers 409 `signs_with_pin` for a person who has a PIN or a single sign-on identity: they are given no password by a link. Word it as "This person signs with a signing PIN; reset the PIN instead".
- **Notifications:** new kind `signing_pin_changed`, `data: { action: 'set' | 'changed' | 'reset' }`, about nothing else. It goes to the person. **[R11]** It is now also emailed, and the email cannot be switched off.
- **[R11] New kind `signing_pin_locked`**, `data: {}`, about nothing else. It goes to the person, in the app and by an email that cannot be switched off.

## Dictionary entries the web needs (en, ar, fr)
- **Permission label:** `policies.import`. For example "Import existing documents" / «استيراد الوثائق القائمة» / « Importer les documents existants ».
- **Notification kinds:** `import_confirmation_due` (the overdue variant follows `data.overdue`), `review_approval_requested`, `review_returned`, `signing_pin_changed` (the variants follow `data.action`), **[R11]** `signing_pin_locked`, **[R11]** `review_approval_turned_off`.
- **Error codes:**
  - `not_owner`, `import_already_confirmed`, `not_imported`;
  - `review_pending`, `no_review_approver`, `no_review_pending`, `not_review_approver`;
  - `signs_with_password`, `pin_too_simple`, `fresh_sign_in_required`, `signing_pin_required`, `no_signing_pin`;
  - **[R11]** `owner_is_importer`, `importer_cannot_confirm`, `current_pin_required`, `signing_pin_locked`, `stale_signing_pin`, `signing_pin_unavailable`, `signs_with_pin`.
- **Always-on reasons:** `serious_incident_alerts` / `triages`, and `approval_steps` / `decides_approval_steps`.
