## Being fixed now (decided by the lead)

Conditions 1, 2, 3, 5, 6, 7 and 8, and points D2, D4 to D11 and C (earlier review rounds visible,
comparison against what was returned), as follows:
- C1 Missing section in a language: readers see the main (default) language text with a plain note;
  a section changed in the main language but not in another is flagged "translation not updated" at
  review and to readers. The client's default language is the authoritative one for now (the
  business may later choose another).
- C2 Retired and superseded versions are clearly marked "not in force" on screen and in print;
  printing a retired document is watermarked, not offered as a controlled copy.
- C3 Every printed page carries number, version, title, page x of y, "printed on <date>, valid on
  that day only", and a QR code to the current version.
- C5 CSV exports: the master document list; acknowledgements per version (any version, people who
  have left included and marked).
- C6 The acknowledgement measure counts only acknowledgements whose due date has passed.
- C7 A maximum review period per organization (36 months by default); changing a document's review
  period needs a reason; metadata changes (period, audience, owner, confidentiality, unit, title)
  show in a history on the document; periodic review comments are required; withdrawing needs a
  reason.
- C8 Overdue approval steps notify the document's managers; overdue acknowledgements go weekly, in
  the app, to the managers of the person's unit (email waits for the mail decision).
- D10 A scheduled version whose signatures fail is reported to the document's managers.
- D11 While suspended, publishing an approved version and retiring a document stay open.
- A version records its source (written here, imported, AI-drafted) for later.
- Earlier review rounds and their comments stay visible; a reviewer can compare with what they
  returned, not only with the published version.

## Waiting for a business decision

Migration of an existing library and legacy records (Q1); browser print as the PDF for now (Q3,
assumed yes with C2 and C3); the authoritative language beyond the default (Q4); an "Approving
authority" role (Q5); email digests (Q8); plan placement (Q10); signing for SSO-only clients (Q2).

---

# Quality review: policies and procedures (HEAD 44d5358)

## Verdict

**Ready for a supervised pilot, with conditions.** Conditions 1 to 4 below must be met before go-live. Conditions 5 to 8 must be met before the pilot's first accreditation survey or ISO audit.

The control cycle itself is sound, and a surveyor would accept it. Every approval is signed with the password re-entered. Signed text cannot change, even at database level. The person who prepared a version cannot approve it, and no one can decide two steps of one run. Retired documents are kept with who, when and why. Periodic reviews are signed. What is not ready is everything around that cycle: getting the hospital's existing library in, documents in two languages, and getting evidence out.

**The three things that matter most:**

1. **A document in two languages can publish two different procedures, and the reader is not told.** If the Arabic text lags behind the English, the Arabic reader sees a shorter, older text under the same number and version, and signs that they read it.
   - Evidence: `ar-1280-version2.png` (PRC-SAF-002 version 2). The English step 4 is "Go to the assembly point in the rear garden" and there is a step 5, "The floor warden counts everyone". The Arabic step 4 is only "go to the assembly point", there is no step 5, and the Definitions section is missing entirely. The change summary is shown to the Arabic reader in English.
   - The reader view drops any section that has no text in the chosen language (`/home/user/Trustline/apps/web/src/components/policies/controlled-document.tsx:93-95`), so section numbers differ between languages.
   - The editor promises the opposite: "Readers of this language see the main language where a section is not written here" (`editor.otherLanguageHelp`). The spec says the same ("a reader sees the default language with a plain note", spec line 101-104). The plain note only appears when a version has no text at all in the reader's language (`controlled-document.tsx:159-168`, `content.ts:115`).
   - For an Arabic-first product this is a patient-safety and staff-safety defect, not a translation detail.

2. **There is no way to bring in a pilot's existing library.** A hospital arrives with 200 to 800 approved documents, and a factory with its whole ISO manual. Each one would have to be retyped into plain text boxes:
   - no upload;
   - no tables (refused: `markupProblems.table`) and no images or flowcharts;
   - 20,000 characters per section per language, which is about 7 pages, so the steps of a long procedure do not fit;
   - a new number (no legacy number);
   - version 1 again, with the original approval and review dates lost;
   - a full two-signature route for each document;
   - a fresh acknowledgement from every member of staff.

   Upload was excluded on purpose. But nothing was put in its place, and the business document sells "data migration from legacy systems". Without a migration path there is no pilot library.

3. **Evidence cannot leave the system, and old copies are not marked as old.**
   - Nothing exports anything. There is no master document list, no acknowledgement list, and no audit trail screen for anyone at all (no audit-log GET route in `apps/api/src/**/*.controller.ts` is open to a client).
   - Pages after the first in a print carry no number, version or page count (no `@page` rules; `globals.css:83-100` only sets colours).
   - A **retired** document still has a "Print view" button. It prints as "Controlled document ... In force from" with a next review date and no retired mark (`en-1280-retired.png`; `print-view.tsx`).
   - A **superseded** version is laid out exactly like the current one ("Controlled document"). Only a small pill in the page header says otherwise (`version-page.tsx:291-297`). It can also be printed through `?version=`.
   - ISO 9001 clause 7.5.3.2(d) and the JCI and CBAHI document-control standards ask specifically for obsolete documents to be identified.

---

## A. Does it do what the business asked for in the first release?

### Delivered
- **Numbering**: `<prefix>-<category>-<nnn>`, never reused (`numbering.ts`). Tested in `apps/api/test/policies.e2e-spec.ts:535`.
- **Versioning and history**: one published version and one in progress; superseded and withdrawn versions are kept. Tested at `policies.e2e-spec.ts:1314`, `:1369`.
- **Approval cycle with e-signature**: password re-entry, the meaning of each signature recorded, content hash, signatures insert-only, signed text fixed in the database. Tested at `:1131-1290`. Seen in `en-1280-sign-prompt-sami.png` and `en-1280-review-v2-changes.png`.
- **Same-person rules**: tested at `:967`, `:1051`.
- **Periodic review reminders**: 60, 30 and 7 days and overdue, in-app; confirm "no change" with a signature. Tested in `policies-check.e2e-spec.ts:282`, `policies.e2e-spec.ts:1446`.
- **Read-and-acknowledge**:
  - password signature, figures by unit and by person (`en-1280-acknowledgements.png`);
  - people who join the audience later are added;
  - reminders at half the allowed time and when overdue (`policies-check.e2e-spec.ts:329`).
- **Retire**: with reason, who and when, kept for those with full sight (`en-1280-retired.png`).
- **Both business measures on the dashboard**: `en-1280-dashboard.png`; `library.service.ts:243-323`.
- **Settings**: types with their sections, categories, routes (`en-1280-settings*.png`).
- **Suspension rule**: acknowledgement stays open, everything else is read-only (`policies-check.e2e-spec.ts:538`; `en-1280-suspended-document-mona.png`). This matches `modules-and-subscriptions.md`.

### Delivered differently
- **Templates.** What was built is a list of sections per type, not a layout template. There is no logo, header or footer; branding was excluded on purpose. A client will expect "our template" to mean the look of the page as well. Acceptable for a pilot if it is said up front.
- **Bilingual output.**
  - Each language is shown and printed separately. There is no side-by-side bilingual layout.
  - Missing sections are dropped instead of falling back to the main language (see the first thing that matters most).
  - No language is recorded as authoritative.
  - This difference matters to a client.
- **PDF export.** Only the browser's print. The business table lists "bilingual PDF export" as a key capability, and `ai-policy-drafting.md` step 1 says "export to PDF ... already in the first-release scope". The spec excluded "a PDF produced by the server". **The business must be told.**
- **Configurable approval cycles.**
  - One route per document type for the whole organization, not per category or unit.
  - Steps run one after another, each decided by one person.
  - No committee and no unit head as an approver.
  - The default approver is the **Administrator** role, which the Arabic text calls "مسؤول النظام", the system administrator (`ar-1280-version2.png`, `en-1280-settingsRoutes.png`).
  - A quality department will object that the person who manages user accounts signs clinical or safety policies.
- **E-signature.** Password only (`signatures.ts:74`). A client that signs in only through SSO (`signInMethod: 'sso'`, `schema.ts:90`) has no password hash. Its staff could not approve, review or acknowledge anything (`auth.service.ts:347-349`).
- **Versioning.** Whole numbers only. Fixing a typo needs the full route again. Acknowledgement is ticked by default, so 2,000 staff are asked again unless the author unticks it (`en-1280-editor-english.png`).

### Deferred on purpose (spec "Out of scope", line 24-30)

| Item | Did the business expect it in this phase? |
|---|---|
| Upload of Word/PDF files | Not by name, but implied by the "data migration" service and by any pilot. **Tell the business.** |
| Attachments | Not by name. ISO clients will miss controlled forms and checklists. |
| Quizzes | No. The roadmap puts "acknowledgement campaigns and quizzes" in Phase 2. Consistent. |
| AI drafting, translation | No. Removed by the decision taken since the document. Consistent. |
| Change requests | Not in the business document. |
| Links between documents | Not by name. The AI spec needs "related documents" and "existing documents it drew on". |
| Committees, delegation | Not by name. |
| Email | The business promises "approve documents from Teams or email" in Phase 3. In-app only for now. |
| Branding / document design | The AI spec puts the document design in the policy module. |
| Server PDF | **Yes**, see above. |

### Missing (asked for, not excluded, not built)
1. **Fall back to the main language for a missing section, with a note.** Asked by the spec (line 101-104) and promised by the editor wording, but not built in the reader view. This is the first thing that matters most.
2. **An audit trail surveyors and auditors can review.** The business promises it ("Every action in the system is recorded in a tamper-evident audit trail, which accreditation surveyors and auditors can review"). Entries are written, but there is no screen or export. This is platform-wide, but it bites hardest here. For example, a change to a document's review period, audience or owner leaves no visible trace on the document.
3. **Print view as a controlled-copy layout.** The spec asks for "the document in the client's layout for printing". What was built has no number, version or page count on every page, no printed-on date, and no obsolete mark (see the third thing that matters most).
4. The spec's "Built" section still says "The web screens are not [built]" (`/home/user/Trustline/docs/specs/policies-and-procedures.md:295-297`). The spec has not been updated for the screens, so the decisions taken in the screens are not recorded anywhere.

### What a pilot would miss, most missed first
1. Bringing in existing documents: upload or assisted migration, legacy number, revision, approval date and review date.
2. Being able to print or export to PDF something a document controller can hand out or file. That means number, version and "page x of y" on every page, a printed-on date, and an obsolete mark.
3. Tables and images in procedures and work instructions: responsibility tables, inspection frequencies, dosing tables, PPE pictograms, flowcharts.
4. Attachments, meaning controlled forms and records. For ISO 9001 and ISO 45001 clients this is core: the form is the controlled document they use most.
5. Links between documents: policy to procedure to work instruction to form. Today there is only a free-text reference list.
6. Email or digest notifications. Nurses and operators who rarely sign in never see an in-app request.
7. Change requests: "this procedure is wrong" from the floor. Today the reader has no route except telling someone.
8. Quizzes. Planned for Phase 2. They will be asked for, but nobody will refuse a pilot over them.

---

## B. Would it pass an accreditation survey or an ISO audit on document control?

Each line below is a question a surveyor would ask, and what the product can show.

| Question a surveyor asks | Can it be shown? | Evidence |
|---|---|---|
| Who approved which version, and when? | **Yes**, on screen: names, meaning, timestamp, content fingerprint | `en-1280-document.png` control block; `version-page.tsx:311-343` |
| Who prepared it? | On the version page only. Not on the control block or the print, where JCI and CBAHI templates usually expect "Prepared / Reviewed / Approved". | `controlled-document.tsx:98-106` |
| The same person not approving their own work | **Yes**, enforced in the API and the database, with clear wording | `errors.same_person_*`; tests at `:967`, `:1051` |
| Can signed text change afterwards? | **No.** Strong. | migration 0041; test at `:1203` |
| Review comments and returns | Only the latest run is shown. Once a version is resubmitted, the earlier "returned with comments" disappears from every screen. | `documents.service.ts:614-624` |
| Proof that staff read the current version | **On screen only.** 100 per page, no export, no print layout. | `acknowledgements.tsx:21` |
| Proof that a person who has since left had read it (typical after an incident) | **No.** Anyone no longer active is dropped from the per-person list, not only from the measure. | `library.service.ts:507-510` |
| Who had acknowledged the version that was in force on a given date | **No screen.** The page shows the published version only (`acknowledgements.tsx:70`). The API would answer for an older version. The version list shows "In force from" but never "until". | `en-1280-suspended-document-mona.png` |
| Uncontrolled copies | Print carries "Printed copies are not controlled" at top and bottom. Good. But no printed-on date, no page identification, and retired or superseded documents print as "Controlled document". | `en-1280-print.png`, `en-1280-retired.png` |
| Retired documents kept | **Yes**, with who, when and why, and their versions | `en-1280-retired.png` |
| Review history | **Yes**: the periodic reviews panel with outcome, signer, date, next date and comment. Two flaws: (1) "Last reviewed" shows the publish date while the panel says "No periodic review has been recorded yet" (`en-1280-document.png`), which looks inconsistent to an auditor; (2) a "no change" review needs one signature and no comment. | `document-page.tsx:348-391` |
| Master list of controlled documents, with revision and review dates | On screen (library), with no export or print | `library.tsx` |
| Changes to metadata: review period, audience, owner, confidentiality | Audited in the database, but **visible nowhere**. A manager can stretch the review period up to 120 months (`input.ts:78`). That moves the next review date at once (`documents.service.ts:947-952`), without a signature and without a trace on the document. This also flatters the "past review under 5%" measure. | |
| Withdrawing a version | The reason is optional (`input.ts:166`; `actions.withdrawReason` "(optional)"). An auditor will ask why. | |

**On balance:** the approval and signature side would satisfy a JCI or CBAHI surveyor and an ISO auditor, and is better than many incumbents. Training records, obsolete-document identification, and the master list would draw findings or observations. So would anything that has to be handed over on paper or as a file.

---

## C. Daily use

**Writing a 20-page procedure.**
- One plain text box per section, with a live preview beside it (`en-1280-editor-english.png`).
- There is no autosave. A session that ends loses what was typed ("what you typed here is not kept", `errors.signedOut`). Only a browser leave-warning protects it.
- 20,000 characters per section per language is about 7 pages. The "Steps" of a long procedure will not fit, and an author cannot add sections to one document; only the type's sections exist.
- Content pasted from Word is refused for tables, deep indentation (taken as code) or control characters. The error names the problem but does not fix it.
- The comparison is line by line and shows raw markup ("## Before you start" in `en-1280-review-v2-changes.png`). One word changed in a long paragraph shows the whole paragraph removed, then added again, with no word-level highlight.
- After a version is returned and resubmitted, the reviewer sees changes against the *published* version, not against what they returned. They have to hunt for whether their comments were dealt with.

**Bilingual documents where one language lags.**
- Nothing warns the author or the approver that the main language changed in sections where the other language did not.
- The approver signs a hash that covers both languages while probably having read one.
- Readers of the lagging language get a shorter, older text with no note (see the first thing that matters most).
- What is needed:
  - an authoritative-language setting;
  - a per-section "translation not updated" flag that is shown at review and to readers;
  - the main-language text shown in place of a missing or out-of-date section.

**Approval route for a small organization with one quality officer.**
- The default route is a review by the Quality officer role, then approval by the Administrator role.
- If the only quality officer writes the document, step 1 has no one else to decide it. The send is refused with `no_assignee`, and the message tells them to "ask whoever manages document settings", which is themselves.
- They must change the route to a single approval step by someone else. The two-step default needs three different people.
- This is correct control, but the first-day experience will read as "the system is broken". Onboarding should set the route with the client.

**An approver on leave.**
- Delegation is excluded.
- Role steps survive if another person holds the role over the owning unit. Named-person steps stall.
- An overdue step sends nothing and escalates to no one (spec "Not built"). It shows only on that version's page.
- There is no list of "versions in review, overdue" for the quality manager: library filters are by document status only, and the row just says "Version 2: In review".
- The only way out is recall, change the route, and resubmit, which collects every signature again.
- A version can sit in review indefinitely without anyone noticing.

**Reminders and their noise.**
- One notification per document per person (`policy-check.service.ts:502-514`, `:586-595`), in-app only, never grouped.
- A new hire in a hospital with 150 documents that need acknowledgement gets 150 "please acknowledge" notices on day one. Then 150 at half the allowed time, then 150 overdue, all due on the same day.
- After the one overdue notice, nothing more happens. The line manager is never told.
- Old notices for a retired document still say "Please read and acknowledge" with "no longer available to you" (`en-1280-rana-notifications.png`).
- Too much at the start, silence at the end. A digest, and a weekly overdue summary to the unit manager, would fix both.

**A reader in a hurry on a phone** (`en-390-library-rana.png`, `ar-390-document-rana-before.png`).
- The library card is clear, with "To acknowledge" and "Acknowledge by ...".
- The document reads well. The acknowledgement box is under the text, which is good.
- The reader ticks "I have read and understood" and types their password.
- Five wrong passwords lock **sign-in** for 15 minutes, because the counter is shared with sign-in (by design, spec line 393-396). A nurse fumbling on a phone can lock herself out of Trustline, including incident follow-up.
- On SSO clients there is no password to type at all.
- In Arabic the document number breaks across lines in the acknowledgement sentence ("PRC-SAF- / 002", `ar-390-document-rana-before.png`). The bilingual reviewer should check this.

---

## D. Built, but wrong, confusing or risky for a quality department

1. **Missing sections are dropped per language with no note.** This is a safety risk; see the first thing that matters most.
2. **Retired and superseded documents look and print like current ones.** Their control block still says "Controlled document", "In force from" and a next review date (`en-1280-retired.png`).
3. **The default approver is "Administrator" (system administrator).** This mixes up running the software with organizational authority.
4. **The acknowledgement measure turns red the moment a document is published.**
   - People whose deadline has not arrived are counted as not done (`library.service.ts:271-301`).
   - The dashboard shows "0% · Target not met" in red minutes after publishing (`en-1280-dashboard.png`).
   - It also pools all documents, so one document sent to the whole organization outweighs everything else.
   - Committees will learn to ignore it.
5. **The "past review" measure can be improved without doing a review**, by lengthening the review period (up to 10 years), with no visible trace. It is also a point-in-time figure only; there is no monthly history to report the "under 5%" target over time.
6. **People who left disappear from the acknowledgement evidence**, not only from the measure.
7. **Audience changes after approval.** Audience is outside the signed content and can be edited while a version is approved but not yet published. Approvers approve the text, while a manager can still change who must read it. This is low risk, but it should at least be visible in the history.
8. **"Confirm no change" can be signed at any time**, even on the day of publishing (`en-1280-retired.png` shows a "no change" review the same minute). It needs one signature by the owner alone, with no comment required.
9. **Earlier review rounds vanish from view after resubmission**, so consultation evidence is lost on screen.
10. **Approved but unpublished versions.** A version whose signatures no longer match is left approved and unpublished, and "named in the log" (spec line 411-414). The log is not something the quality team reads. Nobody in the client is told.
11. **Suspension blocks publishing and retiring.** While suspended, a corrected safety procedure that is already approved cannot be published, and an unsafe document cannot be retired. Review reminders keep arriving for actions that are blocked. The modules spec says "a billing matter never blocks safety work".

---

## E. Verdict and conditions

**Ready for a supervised pilot, with conditions.**

Before go-live:
1. A section missing in one language shows the main-language text with a plain note. Publishing a version whose other language did not change where the main one did shows a warning at review and to readers. Record which language is authoritative.
2. Retired and superseded versions carry a clear "Retired / Superseded, not in force" mark on screen and in print. Remove "Print view" from retired documents, or watermark them.
3. The print layout carries number, version, title, "page x of y" and "printed on <date>, valid on that day only" on every page.
4. An agreed migration path for the pilot's library. At minimum: a legacy number, the original revision, approval date and next review date kept as "approved before Trustline" history. In practice also a Trustline-assisted load, with documents re-issued under signature at their next review.

Before the first survey or audit:
5. An export (CSV is enough) of the master document list and of acknowledgements per version. This must include people who have left, marked as such, and older versions.
6. The acknowledgement measure counts only acknowledgements whose due date has passed.
7. Review-period changes are capped and shown on the document. Periodic review comments are required.
8. Overdue approval steps and overdue acknowledgements reach someone: the document's managers for steps, and the unit manager in a weekly digest for acknowledgements.

Not for an SSO-only client until question 2 below is decided.

### Questions for the business, each with my recommendation

1. **How does a pilot's existing library get in?** Recommend: Trustline-assisted migration as the paid service the business document already lists, using a "legacy" record (old number, revision, approval date and evidence location, review date). Each document is re-issued under Trustline signature at its next review, not all at once. Consider read-only attachment of the original PDF as an early addition.
2. **How do SSO users sign?** Recommend: re-authentication with the client's identity provider, where the user is forced to sign in again, recorded as the signature method. Until that exists, no SSO-only client uses policies.
3. **Is browser print acceptable as the "bilingual PDF export" for the first release?** Recommend: yes for the pilot, only with conditions 2 and 3 above. A server PDF with the client's document design comes in Phase 2; the AI drafting work needs that design anyway.
4. **Which language is authoritative when two disagree, and may a version be published with a lagging translation?** Recommend: the client sets one authoritative language. Publishing with a lagging section is allowed only with an explicit tick by the approver, and readers see "translation pending: the <language> text applies".
5. **Who approves by default?** Recommend: a built-in "Approving authority" role, separate from Administrator, named at onboarding (medical director or CEO for a hospital, plant manager for a factory). Also allow a route per category or unit as well as per type.
6. **How is "acknowledgement completion 90%" defined?** Recommend: "of acknowledgements due in the period, the share given by their due date", reported monthly. Today's live figure stays as a secondary view.
7. **Is there a maximum review period, and who may change it?** Recommend: a maximum per organization (36 months suits JCI and CBAHI practice). A change of period needs a reason and shows on the document. Keep a monthly snapshot of the "past review" measure.
8. **Email or digest notifications for the pilot?** Recommend: a daily digest by email for "to acknowledge" and "to approve" before the pilot. Staff who rarely sign in will otherwise sink the 90% target.
9. **Should overdue acknowledgements escalate to line managers?** Recommend: yes, a weekly digest per unit. Overdue approval steps go to the document's managers.
10. **Is read-and-acknowledge in Starter or Professional?** The plan table puts "acknowledgement campaigns" in Professional. Recommend: basic read-and-acknowledge in the policies module for every plan, and campaigns and quizzes in Professional.
11. **Paper copies at workstations for ISO clients.** Recommend: a QR code or short link on every print that opens the current version. A controlled-copy register comes later, if manufacturers ask.
12. **While suspended, should publishing an already-approved version and retiring a document stay open?** Recommend: yes. Both are safety work in the sense of the modules spec, and retiring only reduces what readers see.
13. **For the AI assistant later**, decide now:
    - a "source" field on a version (hand-written, imported, AI-drafted);
    - links between documents;
    - the authoritative language.

    The assistant spec needs all three, and adding them afterwards means migrating every document.

---

## What I checked by running it, what I only read, what I could not check

- **Ran:** nothing. As instructed: no servers, no tests, read-only.
- **Read:**
  - `/home/user/Trustline/CLAUDE.md`
  - `/home/user/Trustline/docs/business-requirements.md`
  - `/home/user/Trustline/docs/specs/policies-and-procedures.md`
  - `/home/user/Trustline/docs/specs/ai-policy-drafting.md`
  - the suspension sections of `/home/user/Trustline/docs/specs/modules-and-subscriptions.md`
  - the code in `/home/user/Trustline/apps/api/src/policies/` (mainly `documents.service.ts`, `library.service.ts`, `policy-check.service.ts`, `input.ts`, `content.ts`) and `/home/user/Trustline/apps/api/src/approvals/signatures.ts`
  - `/home/user/Trustline/apps/api/src/identity/auth.service.ts` (password confirmation and SSO)
  - the screens in `/home/user/Trustline/apps/web/src/components/policies/` (document page, version page, controlled document, print view, acknowledgements, editor, markup) and `/home/user/Trustline/apps/web/src/app/globals.css`
  - all policies wording in `/home/user/Trustline/apps/web/src/i18n/dictionaries/en.json`
  - the test names in `/home/user/Trustline/apps/api/test/policies.e2e-spec.ts` and `/home/user/Trustline/apps/api/test/policies-check.e2e-spec.ts`. The API tests cover the cycle, signatures, same-person rules, the daily check, both measures and suspension. There are no web tests for the module.
- **Looked at, as each user** (all in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/work/shots-policies/`):
  - document controller: `en-1280-library.png`, `en-1280-new-document-form.png`, `en-1280-editor-english.png`, `en-1280-settingsRoutes.png`, `en-1280-route-refused.png`;
  - approver: `en-1280-sign-prompt-sami.png`, `en-1280-review-v2-changes.png`;
  - reader: `en-390-library-rana.png`, `ar-390-document-rana-before.png`, `en-1280-rana-notifications.png`;
  - auditor: `en-1280-document.png`, `en-1280-retired.png`, `en-1280-print.png`, `en-1280-document-as-printed.png`, `en-1280-acknowledgements.png`, `ar-1280-version2.png`;
  - management: `en-1280-dashboard.png`, `en-1280-awaiting.png`, `en-1280-suspended-document-mona.png`.
- **Could not check:**
  - real printing across several pages, and Save-as-PDF output;
  - behaviour with a real SSO sign-in (SSO sign-in does not appear to be built yet; only the tenant setting exists);
  - how the daily check behaves at scale (hundreds of documents, thousands of staff);
  - whether the Quality officer role can see the role list when narrowing an audience to roles (the form says only those who manage users or roles see it);
  - the French screens beyond a glance, and the screens not named above.