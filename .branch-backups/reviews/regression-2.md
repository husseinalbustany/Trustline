# Regression 2: policies, email, import window (HEAD 086b688)

## Decisions
- Fix D1 to D8.
- D1: in a language other than the one that applies, a section with no text in that language shows the text of the language that applies, with the fallback note, and the change list flags it as changed in that language; the reviewer must not see "No section has changed".
- D3: the New document screen shows the "not allowed" panel for people who cannot create documents, without the background calls.
- D4: number wording: "in Latin letters, or the letters of your organization's languages, and digits".
- D6: the page heading uses the same title as the control block (language that applies when the reader's language is missing).
- D7: the fallback note prints.
- D8: administrators get wording that tells them what they can do themselves.
- Observations: hide "Import documents" in the library while the window is closed; update the stale docs (email.md token holds the language; "Built" sections). Keep the script precedence. Publishing in one click stays (it is not destructive).
- Web: D1 (screen), D2, D3, D4, D6, D7, D8, import link. API: D5, docs.

# Policies, email and import window: browser regression 2, HEAD 086b688

Tested by Jad on 28 Nov 2026 (UTC).

**Result:** all 9 journeys work end to end. I found **no failure in permissions, tenant separation, signatures, hashes, numbering, import refusals or email content rules**. I found **8 defects**: one medium, six low and one cosmetic. None loses or exposes data.

## How it was run
- **Build and servers:** `pnpm build` passed. The API ran with `MAIL_TRANSPORT=outbox node dist/main` and a fixed `EMAIL_LINK_SECRET`; the web app ran with `pnpm start`. PostgreSQL was already up and `pnpm db:migrate` ran cleanly.
- **Browser:** Chromium headless through Playwright, device clock Europe/London.
- **My data:**
  - Portal admin `jad-r2-9d4a17e7@test.invalid`, made with `platform:create-admin`.
  - Client `zz-r2-9d4a17e7`, made through the portal: plan Complete, languages en/ar/fr, time zone America/Los_Angeles. Its day was 27 Nov while UTC was 28 Nov, so the client's day and the server's day differed throughout.
  - Cast, made through the API: admin; writer and reviewer (quality officers); Alba (Approving authority, given through the Users screen during J6); manager (department manager over Medicine); Sam (department manager over Surgery, the named approver on the Procedure route); staff (Ward M1); staff2 (Surgery, outside the audience).
- **Moved by SQL, on my client only:** acknowledgement due dates, two next-review dates, and the digest's claimed day (to make the 07:00 digest run again). The daily check and the email worker then ran on their own timers.
- **Results:** 288 distinct checks pass, 0 fail. A few first-run failures were mistakes in my scripts, fixed and rerun, not product faults (for example a form picked by the wrong password field, a sr-only switch, the portal's two-step confirm).
- **Console and network:** no page errors, no 5xx, nothing in the API error log. Every 4xx came from a deliberate negative check.

## Journeys

| # | Journey | Result | Evidence (screenshots unless stated) |
|---|---|---|---|
| 1 | Settings | Pass | J1-* |
| 2 | Draft to publication | Pass | J2-*, J2-{en,ar,fr}-print.pdf |
| 3 | Acknowledgement and exports | Pass | J3-*, ack-export-*.csv, library-export-*.csv (r2 folder) |
| 4 | Periodic review, new version, retire | Pass | J4-* |
| 5 | Import and the import window | Pass | J5-* |
| 6 | Roles (no Approving authority) | Pass | J6-* |
| 7 | Email | Pass | J7-*; outbox rows checked by SQL |
| 8 | Modules and subscription | Pass | J8-* |
| 9 | Permissions | Pass | J9-* |
| Languages | ar 390, ar 1280, fr 390 | Pass | 81 SWEEP-* |

**1. Settings (Pass)**
- Procedure type changed to 18 months, with a new optional section added in three languages.
- Category IPC added; a duplicate code was refused on screen.
- A route ending with a review step was refused; Procedure route step 2 now names Sam.
- Language that applies set to Arabic: the change warning and its counts were shown.
- The department manager sees the "whole organization only" message.

**2. Draft to publication (Pass)**
- Version 1 written in English and Arabic with the toolbar (bold, lists, heading); the preview renders them. A link was refused as `unsupported_markup`.
- The first send was refused `no_assignee` (see J6).
- Returned with a comment; the writer saw it and the "changes since returned" view; revised and sent again.
- The reviewer's wrong password got "That password is not right. Nothing was signed", audited once; the page carried on and the next try signed.
- Alba approved and the writer published.
- Checks:
  - number POL-SAF-001, counter POL-SAF = 1;
  - the control block lists prepared, reviewed and approved with names and times, in force from 27 Nov 2026 (client's day), next review 27 Nov 2029;
  - the version records `authoritativeLocale: ar`;
  - I recomputed the content hash from the database row: it matches the version's `contentHash` and both signatures;
  - history and audit trail are correct;
  - print view and PDF in all three languages show the QR code, "printed copies are not controlled", "printed on … valid that day only" and page x of y. Arabic is right-to-left.

**3. Acknowledgement (Pass)**
- Staff was notified by number, saw "To acknowledge" in the library, and acknowledged (the "I have read and understood" tick plus password). The signature carries the version hash; a second attempt got 409 `already_acknowledged`.
- staff2 can read the document but has no `acknowledge` move; the API answers 403 `not_in_audience`.
- The manager's late screen sorts 7 days late before 2 days late. The figures page shows counts by unit and by person.
- The daily check sent `acknowledgement_overdue` to writer and manager, `acknowledgement_due` (half-time) to staff, and the weekly digest (2 overdue, 2 people) to the manager only.
- CSVs downloaded through the screens (acknowledgements as manager and as admin; library in en and ar):
  - BOM, CRLF, every cell quoted, `Content-Disposition: attachment`, `no-store`;
  - `=cmd|' /C calc'!A0`, `=SUM(…)` and an RLM-prefixed `=1+1` title are all given a leading apostrophe;
  - the employee number is empty for the manager and filled for the admin;
  - four export audit entries were written.

**4. Periodic review (Pass)**
- With the review due, "Confirm no change" (comment and password) wrote a `no_change` review with a `reviewed_no_change` signature, and moved the next review to 2029-11-27.
- Version 2 changed Arabic only:
  - a change summary was required in Arabic;
  - English was flagged "Not updated" at review;
  - the review was done in Arabic at 390 and the approval in French at 390.
- Publishing version 2 superseded version 1 and recorded a `revised` review. Readers get 404 on version 1, and their history shows version 2 only.
- Retiring OPS/WI/07 (with reason and confirmation) recorded a `retired` review. Readers get 404 and it leaves their library; managers still see it under Retired.

**5. Import (Pass)**
- **Window from the portal:**
  - a close date before the earliest, beyond a year, or with an empty reason was refused 400;
  - closed, both screens say so (the batch file chooser and the "Check before signing" button are disabled), and the API answers 403 `import_window_closed`;
  - reopened to 31 Dec, the change was audited in the client's log with the staff member.
- **Single import through the screen:** prc-saf-7 was kept as given, and the PRC-SAF counter rose to 7.
- **Batch of 25 from CSV:**
  - split 20 + 5, two signatures, three batches in total;
  - I recomputed every `listHash`, and every signature means `imported`;
  - WI-OPS-050 moved the counter so the documents Trustline numbered took 051–069;
  - `عمل-٣` is stored as `عمل-3`, and "Legacy  WI   11" with its spaces collapsed.
- **Every refusal (API and batch screen):**
  - approved after start;
  - window closed;
  - mixed scripts (Latin+Arabic);
  - other script (Cyrillic, Greek);
  - normalised numbers taken (`wi-ops-50`, full-width digits, Arabic-Indic and Persian digits, other capitals);
  - number taken;
  - more than nine digits;
  - future effective date, review before approval, review too far;
  - no Arabic text, a web address in the text;
  - duplicate in the batch.
  - A refused import never asks for the password or counts it.
- **"Approved before Trustline" and re-issue:**
  - shown with the original's details and "Re-issue required";
  - `confirm_review` is not offered and the API answers 409 `reissue_required`;
  - the importer is a contributor of the re-issue and cannot decide it;
  - after Rory's review and Sam's approval, publishing records `revised` due on the imported date and sets the next review 18 months on.
  - The library CSV's last column says Yes or No.
- **Closed again from the portal:** both screens refuse.

**6. Roles (Pass)**
- With nobody holding the Approving authority, Roles shows "Nobody holds it yet" with the route warning.
- Sending gets 409 `no_assignee` at position 2, shown on screen to the writer and (with a link) to the admin.
- After giving Alba the role through the Users screen, the warning is gone.

**7. Email (Pass)**
- **Queue and outbox:**
  - immediate rows for `document_step_assigned`, and for `incident_reported`, `sentinel_flagged` and `sign_off_requested` on a death-graded incident (made only for this);
  - skipped `opted_out` and `organization_off` where they should be;
  - the weekly digest, and the daily digest for 8 people with the right sections, in en, ar (`dir=rtl`, references in `<bdi>`) and fr.
- **Content:** none of the 15 stored emails holds a title, name, area, description or harm level beyond "serious". Every link goes to Trustline only, and the headers are as the spec says.
- **Preferences:** set in Arabic at 390 and French at 390.
- **Organization switch** in Settings: off and back on, audited twice.
- **Unsubscribe links:**
  - GET shows one button and no personal data, with the right CSP, referrer and cache headers;
  - POST by the button, and RFC 8058 one-click, both switch the kind off and write `email_turned_off` once;
  - after the person turns that kind back on, the old link gets 404 for both GET and POST;
  - this held for the immediate links (en) and the digest link (ar).

**8. Modules and subscription (Pass)**
- **Plan Safety (policies off):**
  - every policies route answers 404 exactly like an unknown route;
  - no links, no notifications, and the screens say "not part of your subscription".
- **Plan Complete, suspended:**
  - create, edit metadata, new version, settings, category, approve and import are refused 403 `subscription_suspended`, before any password is asked or counted;
  - moves offer only retire (and acknowledge for staff);
  - acknowledging (Arabic 390 screen), publishing an approved version and retiring all worked;
  - the "changes paused" banner is shown.
- Reactivated afterwards.

**9. Permissions (Pass)**
- Reporter, department manager, Approving authority, writer (`same_person`), importer admin (`not_assignee`) and the named approver were each refused what they must not do. A step decided earlier by the same person is refused 403 `decided_earlier_step`; I gave the reviewer the role for this only, then took it back.
- A step that is not yet current gets 409 `not_current_step`.
- Other checks: no session gets 401, strict bodies 400, a stale revision 409.
- Another client's document gets 404 to read and to edit.
- A Trustline staff session gets 401 on the client's routes, and a client admin gets 401 on the portal's import window.
- Screens show "not allowed", except the New document screen (D3).

**Languages and widths (Pass)**
- 81 page and language combinations (admin and staff, ar 390, ar 1280, fr 390): no horizontal overflow, correct `dir`, no raw keys, no NaN or undefined, no English dictionary text leaking in.
- I looked at the screenshots and PDFs myself: mirroring is correct.

## Defects, most severe first

### D1 (medium): in a language other than the one that applies, the review screen hides sections written only in that language
- **Steps:**
  1. Language that applies: Arabic.
  2. Import a procedure with Steps written in Arabic only.
  3. Start its re-issue and add Scope and Responsibilities in Arabic only. Send it.
  4. The reviewer opens the version in English.
- **What happens:** "No section has changed in this language", and Scope, Responsibilities and Steps are marked "Empty — No text in this language".
  - The API's `languageStatus` marks them `fallback`, and the Arabic text that applies was added.
  - The reviewer is about to sign "in every language".
  - Text that was changed in Arabic and already existed in English is flagged correctly ("Not updated"). Only sections never written in that language are affected.
- **Expected:** show the Arabic text with the fallback note, or flag "changed in Arabic".
- **Screenshot:** J5-en-1280-10-reissue-review-screen.png

### D2 (low): "Its re-issue is in progress. Continue it from the version in progress." when none is
- **Where:** an imported document with no version in progress, whenever `new_version` is not in its moves. Seen while suspended on OPS/WI/07: `inProgress` null, moves `["retire"]`.
- **Cause:** apps/web/src/components/policies/document-page.tsx lines 921–923 pick `actionHelpBusy` whenever `new_version` is missing.
- **Screenshot:** I saw it, but the file was later overwritten by the after-retire state of J4-en-1280-09-retired.png. The API state and the code are the evidence.

### D3 (low): the New document screen opens for people who cannot create documents
- **Who:** Reporter and department manager, by URL.
- **What happens:**
  - The full form is shown with an empty "Responsible area" list.
  - Two background 403s fire (`/policies/roles`, `/policies/people`).
  - No message says why it cannot be used. Settings, import, overdue and figures do show a "not allowed" message.
- The API refuses with 403, so there is no data risk.
- **Screenshots:** J9-en-1280-staff-new-document-form-shown.png, J9-en-1280-staff-_policies_new.png

### D4 (low): number wording says "Latin letters and digits" only
- **Where:**
  - the "Number on the original" help on the single import;
  - the layout page;
  - the mixed-scripts refusal: "Use the number as written on the original, in Latin letters and digits."
- This client works in Arabic, so Arabic-letter numbers are accepted (`عمل-3` was imported). The "other script" refusal message is worded correctly.
- **Screenshots:** J5-en-1280-refusals-01-checked.png, J5-en-1280-08-layout.png

### D5 (low): French plain-text emails lack U+00A0 before ":" on link lines
- **Examples:** "Ouvrir Trustline: http…", "Modifier vos préférences d’e-mail: …", "Ne plus recevoir ces e-mails de synthèse: …", "- WI-OPS-051: http…".
- **Cause:** apps/api/src/email/render.ts lines 204–205 hard-code `${text}: ${href}`. The other French lines are right.
- **Evidence:** code points read from `email_outbox` (0x65 or 0x6c before the colon, against 0xa0 elsewhere).

### D6 (low): a French reader of a document not written in French sees two different titles
- The page heading shows the English title (main language), while the control block and the print/PDF show the Arabic title (the language that applies).
- **Evidence:** SWEEP-fr-390-admin-version.png, J2-fr-print.pdf

### D7 (low): the French PDF drops the "not written in French, shown in Arabic" note
- The note is `print:hidden`, so the printed copy shows Arabic sections under French headings, with only "Langue qui fait foi : arabe" to explain why.
- **Evidence:** J2-fr-print.pdf against J2-fr-1280-print-view.png

### D8 (cosmetic): the administrator is told to ask an administrator
- The `no_assignee` text tells the admin "Ask whoever manages users…", though the same screen offers them "Give the role to someone".
- The module-off page tells the administrator "ask your administrator".
- Same family as D3 of the previous report.
- **Screenshots:** J6-en-1280-admin-refusal-with-link.png, J8-en-1280-03-policies-page-off-admin.png

## Observations and spec questions (not counted as defects)
- **Stale docs:** email.md and policies-and-procedures.md ("Built: decisions 1 to 3") still say their web screens are not built; they are.
- **Unsubscribe token:** email.md says it holds nothing but organization, person, switch and times. It also carries the email's language (`l`); this is documented in code.
- **Script precedence:** Latin+Cyrillic is answered with reason `script`, not `mixed_scripts`. Mixed scripts shows with Latin+Arabic.
- **No `document_published` to the publisher:** the writer was asked to acknowledge version 1 but got no notification. The digest lists it.
- **`listHash`** is built from the import signatures' hashes, not the versions' `contentHash`. The spec is ambiguous here.
- **Confirmations:** publishing happens on one click, while retiring asks twice.
- **Import link when closed:** the library still shows "Import documents" while the window is closed; the page then says it is closed.
- **Imported section numbers:** an imported version renumbers only its written sections (Steps shows as "2.").

## What I did not cover
- **Daily check items:** `document_step_overdue`, `document_publish_failed`, scheduled publishing on a later date, and the 60/30/7-day review reminders arriving as notifications (review due was seen in Awaiting and the digest only).
- **Email:** SMTP mode, retries, expiry and retention; no approval-step emails while suspended; dropping as `module_off`. `language_mismatch` on preferences is untestable here, because the client uses all three languages.
- **Other actions:** lockout after five wrong passwords, recall and withdraw, editing the review period with a reason, the changes history, two deciders at once, the 2 MB body limit, and JSON batch files.
- **Browsers and reading:** only Chromium headless. Arabic was judged by me, not a native reader.
- **Not run:** `pnpm lint`, `typecheck` and `test` (only `pnpm build`, which passed).

## Clean-up
- Both servers are stopped (ports 3000 and 3001 do not answer).
- I removed the client and the portal admin with `removeTestData('zz-r2-9d4a17e7', 'jad-r2-9d4a17e7@test.invalid')`. Afterwards no tenant-table row has my tenant id, no `jad-r2-%` portal admin exists, and no platform audit rows target my client; only the three demo clients remain.
- The working tree is clean.

## Files
- Screenshots and PDFs: /tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/work/shots-regression-2/
- Scripts, CSVs and logs: /tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/r2/
  - results.log: every check
  - sweep-summary.txt: the language sweep
  - browser-events.log: console and network events
  - api.log