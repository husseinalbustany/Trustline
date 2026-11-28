# Quality review 3: policies module finished (HEAD 709ae9a)

## Decisions (pending business answers on the section 4 questions)
- M1: already satisfied. 709ae9a verified: web lint, typecheck, build, identical keys; API lint, typecheck, 852 tests at e47472c. Browser re-checks of D1 to D8 by the web engineer (shots-fix-r2).
- M2: build. Optional "last reviewed on the original" date; next review no later than max(approvedOn, lastReviewedOn) + the client's maximum period; both dates shown in the "Approved before Trustline" block, on print and in the master list.
- M3: build. Optional "differences from the original" note, signed with the import (in the signed content), shown in the block and on print; signature wording "matches the approved original, except as noted below"; guidance on tables in the layout page.
- S1: build. Import register (API route + screen + CSV) with batch and listHash; library filters "Approved before Trustline" and "Re-issue due"; notice to the owner when an import makes them owner.
- S2: build. Overdue approval steps in the managers' daily digest and weekly email.
- S5: build. CSV of the late acknowledgements list; per-person acknowledgement record for managers (screen + CSV).
- S3: build the minimum now: a warning on the switch for people who approve or triage, and an administrator view of who has opted out of which kind. Compulsory emails wait for question 4.
- S4, S6 (measure history and reports, audit-trail viewer, full exit export): platform-wide; planned as the next piece of work after this, specs first.
- Could-improve: do "sections not in the original" on reader and print, and "Version 1 (Rev. 4 on the original)" in the print header, now. "Confirm no change" only within 60 days before the due date: do now (reversible if the business answers question 6 otherwise). Others later.

# Quality review: policies and procedures, finished feature (HEAD 709ae9a)

## 1. Verdict

**Ready for a supervised pilot, on named conditions.** Three things must be done before release (M1 to M3). Six more should be done before the pilot's first accreditation survey or ISO audit (S1 to S6). The feature is not ready for a client that signs in only through SSO, because the signing question for SSO users is still undecided.

**What is ready, plainly:**
- **The document-control cycle would satisfy a JCI or CBAHI surveyor and an ISO 9001 auditor.** That covers identification, review and approval with meaningful signatures, signed text fixed in the database, the same-person rules, change summaries and comparison, and earlier review rounds kept.
- **Obsolete documents and printed copies:**
  - retired and superseded versions are marked "not in force";
  - every printed page carries number, version, title, page x of y, "printed on … valid that day only" and a QR code (I read `J2-en-print.pdf` and `fr-print-d7.pdf`).
- **Evidence and reminders:**
  - a master-list CSV, and an acknowledgement CSV per version that includes people who have left;
  - a review period capped at 36 months, with a reason for each change and a visible history of changes to the details;
  - overdue approval steps and overdue acknowledgements now reach someone.
- **The language that applies is handled well:**
  - it is recorded on each version;
  - it is shown in the control block and on print;
  - a section that has no text in a language falls back to the text that applies, with a note;
  - a section not updated is flagged at review and to readers, with the text that applies shown beside it;
  - the approver's signature says plainly "in every language it is written in".
- **Emails are useful and leak nothing:** they carry numbers and counts only, honour opt-outs, and the screen says when mail is not actually being sent.

## 2. Business check

**Delivered**
- **Numbering, versioning, approval cycle with e-signature, same-person rules, periodic review reminders, read-and-acknowledge, retiring.**
  - Where: the library, document, version, "Awaiting me" and settings screens.
  - How I know: covered by `apps/api/test/policies*.e2e-spec.ts`, and regression 2 journeys J2 to J4 passed.
- **Obsolete marking and controlled print.** `controlled-document.tsx:120-252` and `print-view.tsx`; the PDFs from regression 2 (J2) and `shots-fix-r2/fr-print-d7.pdf`.
- **Decision 1, importing existing documents** (one at a time and in batches, the import window, the "Approved before Trustline" block, re-issue at the next review). Journey J5 passed; `policies-import*.e2e-spec.ts`; screenshot `J5-en-1280-07-imported-document.png`.
- **Decision 2, the Approving authority role**, and the starting route that ends with it (J6).
- **Decision 3, the language that applies** (J1, J4; the D1 fix in `shots-fix-r2/en-1280-d1-review.png`).
- **Decision 4, email:** immediate emails, the morning digest, the weekly digest to managers, preferences and unsubscribe (J7; `email.e2e-spec.ts`).
- **Both business measures on the dashboard** (`J2-en-1280-20-dashboard-admin.png`). The acknowledgement measure now counts only acknowledgements whose due date has passed.
- **Suspension rules:** publishing, retiring and acknowledging stay open while suspended (J8).

**Delivered differently**
- **"Bilingual PDF export"** became browser print, one language per print, with no side-by-side layout. This matters to clients. It was assumed acceptable (question 3 of my last review); see question 10 below.
- **"Templates"** are the sections of each document type. There is no page layout, logo, header or footer.
- **"Configurable approval cycles"** are one route per document type, with steps one after another and one decider per step. There are no committees, no unit head as approver, and no delegation.
- **E-signature** is by password only. SSO-only clients cannot sign anything.
- **Email** tells people what is waiting. Nobody can approve from email; the business document puts that in Phase 3, so this is consistent.
- **Import** is limited to a 90-day window that Trustline staff set, and to documents approved before the module started. The business decision did not mention either limit; they came from the security review.

**Deferred on purpose (spec "Out of scope")**
- Upload, attachments (including the original PDF), change requests, links between documents, committees, delegation, branding, a server-made PDF, quizzes and AI. Quizzes are Phase 2 and AI was removed by a later decision, so both are consistent.
- **The server PDF is the one item the business expected in this phase** ("bilingual PDF export" is a key capability in the business document). Someone must confirm the business was told.
- Not built yet, by the email spec (`email.md:409`): an email for an overdue approval step, and choosing the digest hour per organization.

**Missing (asked for, not excluded, not built)**
- **An audit trail that clients and surveyors can review.** The business document promises "a tamper-evident audit trail, which accreditation surveyors and auditors can review". Clients still have no audit screen or export: the only route that reads the audit log is `GET documents/:id/changes`, which covers document details only. I also found no hash chain in the schema or the migrations. Entries cannot be changed by the application (insert-only), but an auditor cannot verify that themselves. This is platform-wide and carried over from my last review.
- **The success measures over a period.** Both measures are figures for this moment only (`library.service.ts:527-536`). Nothing records monthly values, so nobody can report "under 5% past review" or "90% acknowledged" over a pilot month. The Reports page is still a placeholder (`apps/web/src/app/[lang]/(app)/reports/page.tsx`).
- **An export of the client's data at the end of a contract.** `modules-and-subscriptions.md:137` says "the client can export its data first". There is no export of document text, versions or signatures, only the two CSV lists and printing one document at a time.

**Success measures: can the feature produce them?**
- **"Policies past their review date under 5%":** yes for today, but there is no history. It can also be made to look better at import (M2).
- **"Policy acknowledgement completion 90% or more":** yes for today, but there is no history. Imported documents count only when staff were asked to acknowledge them, which is the honest choice.

## 3. Quality check: findings ranked

### Must fix before release

**M1. The commit under review is unverified.**
- Evidence: `git show 709ae9a` says "not yet linted, type-checked or built". The D1 to D8 fixes from regression 2 exist only as screenshots in `shots-fix-r2/`.
- Why it matters: a release cannot rest on unverified code.
- What would satisfy: pass `pnpm lint`, `typecheck`, `test` and `build`, then re-run J5 (re-issue review), J9 (new-document screen) and the French print in a browser.

**M2. An import can give an old document a fresh review date, which hides overdue reviews and makes the "past review" measure look better.**
- Standard: JCI and CBAHI document standards (documents reviewed at least every 2 to 3 years), and ISO 9001 7.5.2.
- Evidence:
  - `imports.service.ts:423` sets the latest accepted date as `addMonths(today, maxReviewMonths)`;
  - `:535-541` checks only that the next review is after `approvedOn` and no later than today plus the maximum.
- What can happen: a procedure approved in 2015 and never reviewed can be imported with a next review in 2029. It then shows green, and nothing marks it as eleven years old.
- There is also no field for "last reviewed on (on paper)". A document that was genuinely reviewed on paper after its approval cannot say so.
- What would satisfy:
  - add an optional "last reviewed on the original" date;
  - refuse a next review later than (the later of the approval date and that date) plus the client's maximum period;
  - show both dates in the "Approved before Trustline" block.

**M3. The import signature makes the importer state something that often cannot be true.**
- Standard: ISO 9001 7.5.3 (integrity of documented information), and the integrity of the signature itself.
- Evidence:
  - `en.json:2050` (`importing.signOne`): "you confirm that the text entered here is that of the approved original" (the batch wording at `:2083` says the same);
  - the content rules refuse tables and images (`unsupported_markup`, spec lines 450-461);
  - the import screens and the layout page say nothing about tables, flowcharts or figures.
- What can happen: a legacy procedure that holds a dosing or responsibility table, or a flowchart, is rewritten as a list or left out, and is still signed as identical. Once Trustline is the "current version", staff read a text that lacks part of what was approved.
- What would satisfy:
  - an optional "differences from the original" note, signed with the import and shown in the "Approved before Trustline" block and on print (for example "Table 2 written as a list; Appendix B flowchart not reproduced, see the original");
  - signature wording that admits it ("…matches the approved original, except as noted");
  - a line in the import guidance on how to transcribe tables.
- Whether tables must be supported for the pilot's library is question 3 below.

### Should fix (before the first survey or audit)

**S1. There is no migration record and no notice of imports.**
- Evidence:
  - no `GET` route for imports or batches in `policies.controller.ts`;
  - the master-list CSV has only a yes/no "Approved before Trustline" column, with no importer, batch or details from the original;
  - the library cannot be filtered by "approved before Trustline" or "re-issue due" (`library.tsx` only shows a pill);
  - the document's owner is not told an import made them owner (`imports.service.ts:743-767` notifies only when acknowledgement is asked).
- Why a surveyor would ask: "How was your library migrated, by whom, and how do you know each copy matches its original?" Today that answer lives only in audit entries nobody can read.
- What would satisfy:
  - an import register (screen and CSV) listing number, title, original number, revision, approved on and by, where the original is kept, differences, importer, time, and batch with its `listHash`;
  - a library filter for "re-issue due", so the quality manager can plan the re-issue workload;
  - a notice to the owner.

**S2. Stalled approvals still escalate only inside the app.**
- Evidence:
  - `email.md:409`: there is no email for an overdue approval step;
  - `document_step_overdue` goes to managers in-app only;
  - the managers' weekly email covers overdue acknowledgements only.
- Why a quality department would object: managers who rarely sign in, which is exactly who escalation is for, never hear of it.
- What would satisfy: overdue approval steps in the managers' digest, or in their weekly email.

**S3. Anyone can switch off the emails their role depends on, and nobody can see that they did.**
- Evidence:
  - the preferences screen (`J7-en-1280-01-preferences.png`) has one "Immediate emails" switch, which covers sentinel events, serious incidents and approval steps;
  - the organization has only an on/off switch for everyone (`J7-en-1280-02-admin-settings.png`).
- What can happen: the Approving authority, or a whole-organization triager, opts out. Approvals then stall, and sentinel alerts arrive only in the app.
- What would satisfy, at minimum:
  - a warning on the switch for people who approve or triage;
  - an administrator view of who has opted out of which kind;
  - better, whichever kinds the business makes compulsory per role (question 4).

**S4. The measures have no history, and there are no reports.** See "Missing" above.
- What would satisfy: a monthly snapshot of both measures, per unit, with a CSV export. Committees and the pilot's exit criteria need trends, not today's figure.

**S5. Some evidence cannot be exported.**
- Evidence:
  - the "Late acknowledgements" screen has no CSV export (`overdue.tsx`, nothing for export);
  - there is no record per person ("which documents has this member of staff acknowledged?"), which surveyors check in staff files and orientation records.
- What would satisfy: a CSV of the late list, and a per-person acknowledgement record for managers.

**S6. There is no audit-trail viewer, and no full export at exit.** See "Missing" above.
- What would satisfy:
  - a read-only audit view per document, or for the client, with an export;
  - a full archive export (every version's text, signatures, reviews and acknowledgements) before a contract ends.

### Could improve
- **Sections that were not in the original** are listed only on the version page (`version-page.tsx:423`, `notWrittenLabel`). The reader's view and the print just renumber what exists ("2. Steps" on `J5-en-1280-07-imported-document.png`), so step references from the paper no longer match. Say so on the reader's view and on print.
- **Two version identifiers:** an imported document reads "Version 1", while the paper said "Rev. 4", and the re-issue becomes Version 2. Show "Version 1 (Rev. 4 on the original)" in the print header.
- **"Confirm no change" can be signed at any time, by the owner alone** (`documents.service.ts:326-333`), even the day after publishing, and it rolls the next review date forward. Limit it to the reminder window, for example 60 days before the due date (see also question 6).
- **The acknowledgement does not record which language the person read.** It would help after an incident ("did she read the Arabic that was not updated?").
- **Onboarding load:**
  - a new hire, or an import with acknowledgement asked, means one in-app notice and one password entry per document;
  - offer acknowledging several documents with one password, and group the in-app notices;
  - the import CSV's default of "no acknowledgement" is right; say why on the layout page.
- **The digest hour is fixed at 07:00,** which misses night shifts. It is already listed as not built.
- **No register of documents of external origin** (ISO 9001 7.5.3.2), such as ministry circulars or manufacturers' instructions.

## 4. Questions for the business

1. **Who confirms an import?**
   - Should a second person verify imports, a sample or all of them?
   - Should the Administrator (often IT) be allowed to import and sign for clinical documents, or only the Quality officer?
   - My recommendation: importing for Quality only, and owner confirmation within 30 days.
2. **Documents approved on paper after the module was switched on but before go-live** are refused (`approved_after_start`), so they must go through the route again. Is that acceptable, and will onboarding tell the client?
3. **Are tables and figures needed for the pilot's library?** If yes, add table markup now. If no, M3's "differences" note is essential.
4. **Should some emails be compulsory for some roles** (sentinel and serious-incident alerts for triagers, approval steps for approvers)?
5. **Should the language that applies be set per document** rather than once for the organization? In the Gulf, ministry and HR policies are often authoritative in Arabic while clinical ones are in English.
6. **Should a "no change" periodic review need the Approving authority's signature** as well as the owner's? Many hospital policies require re-approval at review.
7. **Controlled paper copies at points of use** (ISO clients, workstations): "valid on that day only" makes every posted work instruction technically uncontrolled. Is a numbered controlled-copy register needed?
8. **Retention:** how long are acknowledgement records of people who have left kept (PDPL and GDPR), and what must the exit export contain?
9. **Signing for SSO users** (carried over): until this is decided, policies cannot be sold to an SSO-only client.
10. **Has the business been told** that the "bilingual PDF" is browser print in one language, and that the measures are figures for today only?

## 5. What I ran, read, and could not check

- **Ran:** no servers and no tests. I extracted the text of the regression PDFs (`pdftotext`) and looked at the screenshots myself. I left no data behind.
- **Read:**
  - the business requirements, and the policies, email and modules specs in full or in their relevant parts;
  - my previous review, regression 2, security reviews 7, 8 and 9, and language review 7;
  - in the API: `imports.service.ts` (window, dates, signature, notifications), `documents.service.ts` (moves), `library.service.ts` (measures), `policies.controller.ts` (routes), `email/wording/en.ts`, and `auth.service.ts` (SSO);
  - in the web app: `print-view.tsx`, `controlled-document.tsx`, `version-page.tsx`, `library.tsx`, `overdue.tsx`, `acknowledgements.tsx`, and the import, imported and re-issue wording in `en.json`;
  - the list of test files and the daily-check tests in `policies-review-2.e2e-spec.ts`.
- **Screenshots looked at:**
  - in `shots-regression-2/`: `J5-en-1280-05`, `J5-en-1280-07`, `J7-en-1280-01`, `J7-en-1280-02`, `J2-en-1280-20`;
  - in `shots-fix-r2/`: `en-1280-d1-review.png`.
- **Could not check:**
  - whether HEAD 709ae9a builds and passes its tests;
  - SMTP delivery itself;
  - the daily-check reminders arriving in a browser (covered by the API tests only);
  - how a real pilot library behaves (hundreds of documents with tables);
  - Arabic wording with a native reader.

**Files:**
- /home/user/Trustline/apps/api/src/policies/imports.service.ts
- /home/user/Trustline/apps/api/src/policies/documents.service.ts
- /home/user/Trustline/apps/api/src/policies/library.service.ts
- /home/user/Trustline/apps/web/src/i18n/dictionaries/en.json
- /home/user/Trustline/apps/web/src/components/policies/version-page.tsx
- /home/user/Trustline/docs/specs/email.md
- /tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/work/shots-regression-2/
- /tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/work/shots-fix-r2/