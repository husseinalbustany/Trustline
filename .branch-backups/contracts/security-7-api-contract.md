# API contract changes for the web: security reviews 7 and 8, language review 7

Everything here is in the API working tree (not committed). Migrations 0048, 0049 and 0050 are applied in the local database.

The names follow Maya's screens (commit 658a486) wherever they fitted. Every name she reads is given below; none needed to change.

## 1. Import window (security 7, finding 2)

### `GET /api/v1/policies/settings`
This route gains `importWindow`. Dates are `YYYY-MM-DD`, on the client's calendar.

```json
{
  "maxReviewMonths": 36,
  "authoritativeLocale": null,
  "authoritative": "en",
  "revision": 1,
  "importWindow": {
    "startedOn": "2026-11-28",
    "closesOn": "2027-02-25",
    "latestApprovedOn": "2026-11-27",
    "open": true
  }
}
```

| Field | Meaning |
|---|---|
| `startedOn` | The day the policies module was first switched on for the client. |
| `closesOn` | The **last day imports are accepted**. "Closed" means `closesOn < today`, which is how `importWindowOf` in import-form.tsx compares it. By default this is `startedOn` + 89 days (the 90th day, counting the first). |
| `latestApprovedOn` | `startedOn` − 1 day: the latest approval day an imported document may have. |
| `open` | `today <= closesOn`, and false if the module's first day is not recorded (since security review 9 the window fails closed). Use it rather than comparing dates yourself if you like. |

`PATCH /settings` answers with the same shape.

### `POST /api/v1/policies/imports/check`
The answer gains `window`, with the same four fields:

```json
{ "window": { "startedOn": "…", "closesOn": "…", "latestApprovedOn": "…", "open": true }, "documents": [ … ] }
```

### New refusals

| Code | Status | Body | When |
|---|---|---|---|
| `import_window_closed` | **403** | `{ "code": "import_window_closed", "closedOn": "YYYY-MM-DD", "latestApprovedOn": "YYYY-MM-DD", "startedOn": "YYYY-MM-DD" }` | On `POST /documents/import`, `POST /imports` and `POST /imports/check` once the window has closed. `closedOn` is the window's last day (the same value as `closesOn`). The check is refused too, so a closed window shows the same way on every screen. |
| `approved_after_start` | 400 | `{ "code": "approved_after_start", "latestApprovedOn": "YYYY-MM-DD", "startedOn": "YYYY-MM-DD" }` | `approvedOn` is on or after `startedOn`. On a single import this is the body itself. In a batch or a check it is one entry of `problems` inside 400 `batch_refused`, with `index`, `number`, `status: 400` and the two dates. |

The existing `approved_in_future` is still checked first.

### Admin portal: `/api/v1/platform/tenants/:id/import-window`
Platform session (cookie of the portal). A hospital session gets 401.

`GET` answers:

```json
{
  "startedOn": "2026-11-28", "closesOn": "2027-02-25", "latestApprovedOn": "2026-11-27", "open": true,
  "setByTrustline": false, "reason": null, "setBy": null, "setAt": null
}
```

- For a client that has never had the module: `startedOn`, `closesOn` and `latestApprovedOn` are `null`, and `open` is `false`.
- `setBy` is the platform admin's id.

`PUT` takes `{ "closesOn": "YYYY-MM-DD", "reason": "…" }`, strict:
- `reason` is one line of 1 to 500 characters.
- 200 answers as `GET`.
- 400 for any other body.
- 400 `{ "code": "invalid_closes_on", "earliest": "…", "latest": "…" }` for a date outside the bounds. `earliest` is `latestApprovedOn`, so a date in the past closes the window (from its start, at the earliest). `latest` is today + 366 days.
- 404 for an unknown client.
- 409 `policies_never_on`.

Each change is audited:
- in the platform log, as `import_window_set` with `{ closesOn: { from, to }, reason }`;
- in the client's own audit log, as `import_window_changed` with the same fields plus `platformAdminId` and `platformAdminEmail`, and `actor_id` null, as for `subscription_changed`.

**Local demo data:** migration 0049 records the start of policies for existing clients as the earlier of their first document and the day of the migration. The seeded demo clients' documents are dated 2023-11-08, so their windows are closed. To try the import screens on a demo client, reopen its window with the `PUT` above (or re-seed: a client created now starts today).

## 2. The large body of the import routes (security 7, finding 1)

- **Who gets 2 MB:** only a live session holding `policies.manage` for the whole organization, in a client with the policies module and a subscription that is not suspended (since security review 9). Anyone else gets the 100 kB of every other route: a body over that is 413 from Nest's parser before the guard, otherwise the guard's 401 or 403.
- **Paths:** matched whole, at `/api/v1/policies/imports`, `/api/v1/policies/imports/check` and `/api/v1/policies/documents/import`. A trailing slash or another prefix falls back to 100 kB.
- **Nesting:** a body nested more than 64 deep is refused with 400 `{ "statusCode": 400, "message": "Bad Request", "code": "body_too_deep", "max": 64 }`. An import is about 5 deep, so the screens should never see this. Treat it like `body_too_large`.

## 3. Numbers (security 7, finding 4)

- **Normalisation:** a given number is kept in NFKC, with every digit of any script as ASCII and spaces made one. `POL-GOV-٠٠٧` and `ＰＯＬ-ＧＯＶ-００７` are `POL-GOV-007`. It is checked as taken, counted in its series and stored in that form.
- **What the screens see:** `POST /imports/check` answers the normalised value in `documents[].number`. So "Entered as X" can compare it with what was typed, as `CheckedLines` already does. The imported document's `number` is the normalised one.
- **Letters of another script (security review 9, new):** a number's letters may be only Latin, or Arabic where the client works in Arabic. Any other letter is refused with 400 `{ "code": "invalid_number", "reason": "script" }`. Examples: `ЅОР-001` (Cyrillic), `ꓑꓳꓡ-007` (Lisu), `ᏢᎾᏞ-007` (Cherokee), `РОL-GOV-007` (Cyrillic among Latin), and Arabic letters for a client without Arabic. In a batch it is one entry of `problems`. **This needs its own wording.** For example: "A document number may use only Latin letters, or the letters of your organization's languages, with digits and - . / _ ( )." The `/mixed_script|scripts/` test in types.ts does **not** match `script` (no "s"), so it falls through to plain `invalid_number` until it gets that wording.
- **Mixed scripts:** a number whose letters mix two allowed scripts, such as `POL-سياسة-1`, is refused with 400 `{ "code": "invalid_number", "reason": "mixed_scripts" }`. The check for `reason: 'script'` runs first, so Cyrillic among Latin is now `script`.

## 4. Authoritative language on each version (security 7, finding 3)

- **On the version:** `GET …/versions/:versionId` (and every answer that is a version view) gains `authoritativeLocale`. It is the language recorded when the version was sent for review or imported, and `null` on a draft, which follows the setting. `authoritativeOf()` in lib/policies.ts already reads it this way.
- **Language status:** `languageStatus.authoritative` is now the recorded language for every version that is no longer a draft. Changing the setting no longer changes it for those versions.
- **Settings screen text:** `settings.authoritativeWillChange` and its family can say that versions already sent keep their language. Only drafts follow the new one.

## 5. Starting route (security 7, finding 5)
No contract change. A client whose own role holds the code `approving_authority` gets starting routes ending with an Administrator approval, and the audit entry `approval_route_created` says so (`fallback: { missing, approvedBy: 'administrator' }`).

## 6. Email (security 8, language review 7)

- **New notification kind `email_turned_off`:** `data: { switch: 'immediate' | 'digest', serious: false }`. It has no incident and no document, and its module is core.
  - **When:** written when an email's unsubscribe link switched a kind of email off, so the person sees it in Trustline.
  - **Web dictionaries need wording for it,** in en, ar and fr. For example: "An email link turned off your immediate emails." / "…your summary emails." It could link to `/notifications/preferences`.
- **Old unsubscribe links:** a link issued before the person last switched that kind back on now opens the "not valid" page (404). The preferences screen needs nothing new: `PATCH /me/notification-preferences` records the time a switch is turned back on.
- **Footer link:** "Change your email preferences" in every email now leads to `/<lang>/notifications/preferences` (M6). The unsubscribe page still says the emails can be turned back on "in your notification preferences".
- **Wording:** the emails' Arabic and French now use the app's terms (E1 to E14), and French uses « e-mail ». The digest's day is written as `dayFormat` writes it: medium style, Latin digits.
- **Unchanged:** the API wording has no Arabic text for "the language that applies", so «اللغة المرجعية» is web-only.
