## Being fixed now

- **Q2**: age on each row, oldest-first and by-harm ordering, an assigned-to-me filter feeding My tasks, a count of serious open incidents.
- **Q3 in part**: near miss and hazard always "no harm"; severe, death and sentinel reports cannot be rejected.
- **Q4**: triage stays possible while in progress.
- **Q5**: previous and new values on every triage event; names resolved for the timeline.
- **Q7**: neutral wording and a filter.
- **Q8 in part**: the patient-details warning on every text box.
- **Q10 in part**: where it happened defaults to the reporter's unit; the time the form was opened is recorded so the two-minute measure can be produced.
- **Q12 in part**: filters by type, harm, sentinel, department, date and reference.

## Waiting for a business decision

- **Q1**: who sees a named reporter.
- **Q6**: an anonymous follow-up code and a no-sign-in channel.
- The second sign-off for closing a sentinel event.
- Redaction of free text.
- Deadlines and notifications.

---

# Quality review: incident reporting (first release)

## 1. Verdict

**Ready for a supervised pilot only with named conditions; not ready to be presented as the Phase 1 "sellable MVP" the business document describes.**

The core is sound: reporting, triage, closure with a mandatory reason, and a per-incident timeline that cannot be edited. Three things would make a quality department object on day one:

- The reporter's name is shown to their own department manager.
- Nothing draws attention to a serious or ageing report.
- Classification and ownership are frozen once work starts.

Conditions before a pilot hospital uses it for real reports are findings Q1 to Q8 below. Separately, the business must be told that QR/no-sign-in reporting, deadlines with escalation, and notifications are not in this release although its own roadmap puts them in Phase 0 or 1.

## 2. Business check

### Delivered

- **Any signed-in employee can report an incident, near miss or hazard.** Screen `/[lang]/incidents/new`, route `POST /incidents`. Covered by the "reporting" tests in `/home/user/Trustline/apps/api/test/incidents.e2e-spec.ts`, which I ran (85 pass).
- **Mobile-friendly reporting.** The 390-wide screenshots in English and Arabic show a single column with large targets and a full-width send button.
- **Severity and sentinel-event flags.** The reporter sets a harm level, triage corrects it and can tick "sentinel event". They are flags only (see Q3).
- **Triage.** `POST /incidents/:id/triage` sets harm, sentinel, category, responsible department and optional assignee. Covered by the "triage" tests.
- **Closure discipline.** Closing, rejecting and reopening each require a written reason. Covered by "needs a note to close, reject or reopen".
- **Three languages.** `en.json`, `ar.json` and `fr.json` have identical keys (409 each, checked by script). Category, unit and person names are stored per language with fallback.
- **Dashboard.** "Open incidents", "Awaiting triage" and "Recent incidents" show live figures, scoped to what the caller may see.

### Delivered differently

| Asked | Built | Does it matter to a client? |
|---|---|---|
| Mobile-friendly **wizard** | One single-page form | No. One page is at least as fast. |
| **Anonymous option** (with QR and reporting by contractors and visitors) | A checkbox for signed-in staff only | Yes. See Q6. |
| **Routing** so "every report reaches the right people" | A responsible department and optional assignee are recorded and gain visibility; nobody is told | Yes. The right people can see it but are not reached. See Q2. |
| **Feedback to the reporter** | A reporter view with status, triage result, closure summary, rejection reason and shared comments, with two-way comments | Partly. It is pull-only, and anonymous reporters get none. |
| **Department response** | Comments only; every status change needs `incidents.triage`, which the built-in Department manager role lacks | Yes for hospitals where departments answer formally. See Q11. |
| **Tamper-evident audit trail surveyors can review** | A per-incident timeline (append-only by database permission) plus an `audit_log` table with no screen | Partly. The timeline is good evidence; "tamper-evident" and "can review" overstate what exists. |

### Deferred on purpose

| Item | Did the business document expect it in the first release? |
|---|---|
| QR codes and reporting without signing in | **Yes.** Phase 1 scope names "QR and anonymous reporting", and the risk table relies on it for adoption. The business must be told. |
| Response deadlines with escalation | **Yes.** It is in the "Incident handling" row, and the measure "95% triaged within deadline" depends on it. The business must be told. |
| Email notifications | **Yes, earlier.** "Notifications" is in Phase 0 Foundation. The business must be told. |
| Corrective actions (CAPA) | Yes, as its own Phase 1 module. Until then the closure summary is the only record of what was done. |
| Category-specific forms (including medication details) | Yes by the module table, though the Phase 1 line does not name it. It takes the NCC MERP index with it, which the compliance table claims as built in. |
| Regulator-reporting tracking | In the module table, not named in the Phase 1 line. It matters for the CBAHI pilot (sentinel notification). The business should confirm the phase. |
| Attachments | Not promised for reporting. Hospitals will still ask for photos of hazards and equipment. |
| People involved | Not promised. A non-identifying "who was affected" field is a different matter (see Q9). |
| Contributing factors, investigations | No. Phase 2. |
| No patient identifier | Not promised for Phase 1 (launch from the patient record is Phase 3). It has a practical consequence (see Q8). |

### Missing

- **Anything that measures the two-minute promise.** No start time is recorded (see section 3).
- **A way for a hospital to manage its categories.** The business asks for configurable categories, and `/home/user/Trustline/apps/api/src/incidents/categories.ts` says a client "may later rename, reorder or switch off" them. There is no route or screen, and the spec does not list it as excluded.
- **A "Rejected" filter and any search.** The spec's filter list omits Rejected, so this follows the spec, but nobody decided to exclude it and a surveyor will ask for it (see Q7).

## 3. Success measures: can the system produce the number?

| Measure | Can it? | Why |
|---|---|---|
| Time to submit under 2 minutes | **No** | Only `reported_at` is stored. Nothing records when the form was opened. |
| Change in reporting volume at the pilot site | **Data yes, number no** | `reported_at`, type and unit are stored, but no screen, report or export counts by month. The paper baseline must come from the hospital. |
| 95% of reports triaged within deadline | **No** | No deadline exists. `triaged_at` is overwritten on every re-triage, so first-triage time survives only in `incident_events`. Whether rejection counts as triage is undefined. |
| Overdue corrective actions | Not applicable | Actions are not built. |

## 4. Quality check, ordered by how much a hospital would care

**Q1. The reporter's name is shown to their own department manager.**
- Saw: `detail()` in `/home/user/Trustline/apps/api/src/incidents/incidents.service.ts` returns the reporter's name to anyone with view rights over the unit. The built-in Department manager role has `incidents.view`.
- Objection: a nurse reporting a problem on her ward is named to her head of department. Her only alternative is full anonymity, which costs her all feedback. This is the commonest reason staff stop reporting.
- Would satisfy: a confidential mode where the name is visible to the quality team only, ideally as the default, with a line on the form saying who will see it.

**Q2. An incident can sit untouched indefinitely and nobody is prompted.**
- Saw: no deadline, no age shown, no overdue marker, no notification. The list is newest first only. "My tasks" on the dashboard says "No data yet". There is no "assigned to me" filter, so an assignee learns of an assignment only by browsing.
- Objection: JCI and CBAHI both expect a defined process with timeframes. A report with harm "Death" arrives in the same position as a wet floor.
- Would satisfy before the pilot, even without the deferred deadline engine:
  - age in days on each row;
  - an "oldest untriaged first" order and sorting by harm;
  - an "assigned to me" filter feeding "My tasks";
  - a visible alert for severe, death and sentinel reports.

**Q3. A sentinel event is a red label and nothing more.**
- Saw:
  - one triager can close it from "Triaged" with a one-line note;
  - a report with harm "Death" can be rejected by one person in one click, and "Reject report" sits beside the triage form;
  - choosing Severe or Death does not prompt the sentinel question;
  - no clock starts when the flag is set;
  - contradictory combinations are accepted. The demo incident in `en-1280-detail.png` is a near miss with moderate harm flagged sentinel.
- Objection: accreditors expect sentinel events to trigger leadership notification and a root cause analysis within a fixed period. From memory this is 45 days for JCI, and five working days' notification plus about 30 days for CBAHI; the pilots' quality leads should confirm.
- Would satisfy:
  - a prompt to review the sentinel flag when harm is Severe or Death;
  - no rejection of such reports, and a second sign-off to close them;
  - the date identified as sentinel shown with a countdown;
  - a block or warning on near miss or hazard with harm above "none".

**Q4. Once "Start work" is pressed, classification and ownership are frozen.**
- Saw: triage is accepted only in New or Triaged (test "is refused once work has started or the incident has ended"). In `en-1280-detail.png` the reopened incident offers only "Close incident".
- Objection: outcomes evolve (a "mild" fall becomes a death three days later), staff leave, and departments are assigned wrongly. The record then shows a harm level the hospital knows is wrong.
- Would satisfy: let triagers change harm, sentinel, category, department and assignee while In progress, each change on the timeline.

**Q5. Two things change without a trace.**
- Saw (a): triage overwrites the reporter's harm level and category. The "reported" event has `details: null`, and the "triaged" event and audit entry hold only the new values. In the screenshots the report started as "No harm" and after triage nothing shows that.
- Saw (b): assignment events store only the user id. If that person is deactivated, or the reader lacks the triage right, the timeline reads "Assigned to a member of staff".
- Objection: a surveyor comparing what staff reported with what quality decided cannot. "Who had this in March?" may have no answer.
- Would satisfy: store previous and new values on every triage event, and return the assignee's name with the event.

**Q6. Anonymity is real in the database but thin in practice.**
- Real: the tests prove no reporter on the incident, no actor on the timeline, no actor or IP in the audit log, and a 404 for the reporter afterwards. The form wording is accurate.
- Weak:
  - the reporter must sign in and sees their own name on screen while ticking the box;
  - contractors, agency staff and visitors cannot report at all;
  - "write down the reference" has no use: there is no status lookup, and the quality list has no search by reference;
  - anonymous reporters get no feedback and quality cannot ask them a question;
  - the form does not warn that unit, time and description can identify someone on a small ward;
  - I could not check web-server or proxy logs, which would link the session to the request.
- Would satisfy:
  - a random follow-up code, separate from the guessable INC number, that opens the reporter's view without identity;
  - a sentence stating that neither quality nor administrators can see who sent it;
  - the warning about identifying detail;
  - a statement on log retention.
- What I would tell the business: the cited study says systems must "guarantee anonymity". What is built is "we do not record your name", which is weaker in staff's eyes. Signed-in anonymity is defensible as a first step, but do not sell it as the anonymous channel in the roadmap.

**Q7. "Rejected" is the wrong word and is poorly controlled.**
- Saw:
  - the reporter sees a "Rejected" label, though the reason is mandatory and visible to them, which is good;
  - there is no reason category (duplicate, not an incident, insufficient information);
  - one person decides;
  - there is no Rejected filter, so rejected reports appear only under "All";
  - they drop out of the dashboard counts;
  - a duplicate found after triage must be "Closed".
- Objection: a just-culture programme does not "reject" a concern. A surveyor will ask to see everything dismissed and why.
- Would satisfy: neutral wording such as "Not taken forward", a reason list plus free text, a filter, and a link to the original for duplicates.

**Q8. Patient details will be typed into free text and cannot be removed.**
- Saw: the warning "Do not type patient names or record numbers" is present on the description, staff comments and status notes. It is absent on "What was done immediately" and on the reporter's comment box. All text is immutable.
- Objection: with no patient field, investigators have nowhere to record which patient, so identifiers will be typed or kept on a side list. Once typed they are visible to everyone in scope for good, with no encryption.
- Would satisfy: the warning on every box, a traced redaction action for quality, and a business decision on linking to a patient.

**Q9. The harm scale is right but used loosely, and medication has no index.**
- Good: the five levels are the WHO degree-of-harm scale exactly, and the three types match WHO's reportable circumstance, near miss and incident.
- Gaps:
  - no definitions are shown, so nurses will pick mild, moderate and severe inconsistently;
  - there is no "not yet known";
  - harm is a required choice even for a hazard;
  - there is no NCC MERP A to I field, and five levels cannot reproduce it;
  - nothing records who was affected (patient, staff, visitor), so staff-safety incidents cannot be separated;
  - the ten default categories lack several WHO types, including blood products, behaviour and violence, documentation, nutrition, and staffing and resources.
- Would satisfy: one-line definitions under each level, automatic "No harm" for hazard and near miss, an "affected" choice, and a fuller default list the hospital can edit.

**Q10. The two-minute promise is achievable for the form but not for the whole journey.**
- Count: five required choices (type, category, where, when pre-filled, harm level), one required text, two optional items. About 60 to 90 seconds on a phone for a two-sentence description if already signed in. This is an estimate; I did not time it.
- Risks:
  - sign-in by password on a phone with an 8-hour session and no QR or embedded button;
  - "Where" is not pre-set to the reporter's own unit although the session knows it, and it is one long list of the whole hospital;
  - the harm-level hesitation in Q9;
  - no saved draft if interrupted.
- Would satisfy: default "Where" to the user's unit, keep a local draft, and record the form-open time.

**Q11. Department scope matches hospital practice, with three caveats.**
- Good: central quality sees everything; a department sees what happened in it or was handed to it; an assignee sees their incident; out-of-scope returns "not found".
- Caveats:
  - a department manager can only comment and cannot record a formal response or mark work done;
  - only one responsible department is possible, though a ward and pharmacy often share an incident;
  - a manager automatically sees reports about their own unit, including ones about themselves.

**Q12. Evidence for one incident is good; evidence across incidents is absent.**
- Saw: the detail page answers "show me how you handled this incident" on one screen. There is no print or export. The list cannot filter by date, department, type, harm or sentinel, and there is no search.
- Objection: "show me all sentinel events this year" or "medication incidents last quarter" cannot be answered.
- Would satisfy: those filters, search by reference, and a printable incident record.

**Q13. Languages.**
- A French-only or Arabic-only hospital can use every screen.
- Limits:
  - only English, Arabic and French are compiled in, so a fourth language needs a release;
  - free text is not translated, so a report written in French may be unreadable to an Arabic-reading manager;
  - the date-and-time control follows the device language, so the Arabic page shows "11/24/2026, 07:02 PM";
  - the language switcher appears to offer all three languages whatever the hospital chose (read in code, not verified).
- Wording: the English type help says "Something went wrong", while Arabic and French say "an error occurred", which leans towards blame. That is for the bilingual reviewer.

## 5. Questions for the business

1. Who may see a named reporter: the quality team only, or the department manager too?
2. Is signed-in anonymity acceptable for the two pilots, or is the no-sign-in/QR channel required before go-live? Should anonymous reporters get a follow-up code?
3. What is the triage deadline behind the 95% measure? Does it vary by harm level, and does rejecting count as triaging?
4. For each pilot, what is the sentinel-event policy: who is alerted, in what time, and who may close?
5. How will a hospital tie an incident to a patient while no identifier is stored? Is a side list acceptable to them, and when does encryption arrive?
6. Is the NCC MERP index required for the pilots, given the compliance table claims it?
7. Who closes an incident: quality only, or the responsible department?
8. Is "Rejected" acceptable wording? Should dismissing a severe-harm report need a second person?
9. How will "under two minutes" be evidenced: system timing or an observed study? Does it include signing in?
10. Is a pilot with no notifications of any kind acceptable?
11. Which languages do the pilots need, and what happens when reporter and reader do not share one?
12. What may sales claim for "tamper-evident audit trail"?
13. Who collects the paper-based baseline for the reporting-volume measure?

## 6. What I checked and how

**Ran**
- `/home/user/Trustline/apps/api/test/incidents.e2e-spec.ts`: 85 tests pass.
- A script comparing the three dictionaries: 409 identical keys each.

**Looked at (screenshots in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/work/shots/`)**
- `en-1280-new.png`, `en-390-new.png`, `ar-390-new.png`
- `en-1280-report-sent.png`, `en-1280-anonymous-sent.png`
- `en-1280-list.png`, `en-1280-dashboard.png`
- `en-1280-detail.png`, `en-1280-detail-new.png`, `en-1280-reporter-view.png`, `fr-390-detail.png`

**Read only**
- `/home/user/Trustline/docs/business-requirements.md` and `/home/user/Trustline/docs/specs/incident-reporting.md`
- `/home/user/Trustline/apps/api/src/incidents/incidents.service.ts`, `incidents.controller.ts` and `categories.ts`
- `/home/user/Trustline/apps/api/drizzle/0010_incidents.sql` and `0011_incidents_grants.sql`
- `/home/user/Trustline/apps/api/src/identity/permissions.ts`
- `/home/user/Trustline/apps/web/src/components/incidents/` (all files), `/home/user/Trustline/apps/web/src/components/dashboard/dashboard-view.tsx` and `/home/user/Trustline/apps/web/src/lib/incidents.ts`
- The `incidents` wording in all three dictionaries

**Could not check**
- I did not start the apps, as instructed, so I did not time the form or use it as each role.
- I did not open the remaining screenshots (the other Arabic and French ones, `en-1280-detail-closed.png`, `en-1280-officer-scope-warning.png`, and the phone list, detail and dashboard).
- Web-server and proxy logging, which bears on anonymity.
- Behaviour for a hospital configured with a single language.
- The accuracy of the Arabic and French wording.
- The JCI and CBAHI timeframes in Q3 are from memory.

I changed no repository files.
