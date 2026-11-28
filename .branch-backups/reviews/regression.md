# Incident reporting: browser regression, HEAD a244e5b

Tested by Jad (test engineer), 27 Nov 2026. The API was built and run with `node dist/main.js` on :3001, and the web app with `next start` on :3000. Browser: Chromium headless through Playwright. The device clock was Europe/London (UTC).

Throwaway client `zz-reg-d1db6b1b`, created through the admin portal: time zone Pacific/Auckland (UTC+13, already 28 Nov there during the run, so hospital day and UTC day differed), languages English and Arabic. Structure, built through the screens: North Campus with Medicine (Ward M1) and Surgery (Ward S1), and South Campus with Pharmacy (Dispensary P1). Users, created through the screens, each choosing their own password from the invite link:
- administrator
- two organization-wide quality officers (qo1, qo2)
- a department manager over Medicine (dm)
- a reporter (rep)
- a quality officer scoped to Surgery (sq), the "user scoped to another department"

About 95 incidents were made. All data has been removed.

**Result:** every journey works end to end in all three languages. I found **no failure in permissions, tenant or reporter privacy, sign-off, deadlines or notifications**. I found **5 defects**: one medium, one low-to-medium, two low and one cosmetic. All are listed below with screenshots, plus some observations and spec questions.

## Defects (most severe first)

### D5 (medium): the "Triaged on time" tile describes a different figure from the one it shows
- **Who and where:** quality officer (also department manager and scoped officer), en/fr/ar, 1280.
- **Steps:**
  1. Have reports from the last 30 days that were triaged, and at least one still `new` past its triage deadline. Here INC-00008 and INC-00011 were moved back with SQL.
  2. Open the Dashboard.
- **What happens:** the tile shows **86%** (88% later), with "Of the reports from the last 30 days that have been triaged". In French: "…déjà triées"; in Arabic: "…التي تم فرزها".
  - The API counts 23 reports: 21 triaged or set aside (20 on time) plus 2 never triaged and past deadline, counted as late. That follows the spec's change after the second quality review.
  - Of the reports actually triaged, 20 of 21 (95%) were on time.
  - A quality department reading the tile as written gets the wrong figure.
- **Expected:** the help text says what is counted: reports triaged or set aside, plus those still waiting past their deadline (counted as late). The other option is to change the figure, but the spec decided the calculation.
- **Where:** `dashboard.triagedOnTimeHelp` in all three dictionaries.
- **Screenshot:** `work/regression/DEFECT-D5-en-1280-triaged-on-time-label.png`. The figure was checked against SQL: 20/23 = 87%, matching the API.

### D1 (low to medium): retry times on the public pages are on the device's clock, while the page says its times are the hospital's
- **Who and where:** anonymous public reporter, en and ar, 390. The device is in London and the hospital in Auckland. This is exactly the case where the page shows its clock note.
- **Steps:**
  1. Open `/en/follow-up/<slug>` and enter a code whose incident already has 10 comments by code in the last 24 hours.
  2. Write a comment and send it.
- **What happens:**
  - The page says "Times on this page are in the organization's time: New Zealand Daylight Time (GMT+13)".
  - The refusal says "You can try again after **Saturday 12:22 PM**". That is London time. In the stated organization time the moment is **Sunday 1:22 AM**.
  - A reader who believes the note will try again 13 hours too early and be refused again.
  - Arabic is the same ("السبت 12:22 م").
- **Expected:** one clock on the page. Either give the retry time on the hospital's clock, as the note promises, or label it as the device's time.
- **Cause:** `clockTimeIn()` in `apps/web/src/lib/format.ts` always formats with `deviceTime`. Three places use it:
  - the follow-up comment cap (shown above);
  - the follow-up attempts limit;
  - the public form's hourly-ceiling refusal. Its "Enter it in the hospital's time" note sits on the same form: "try again after 1:21 PM" is London time while "When it happened" is NZ time.
- **Screenshots:**
  - `work/regression/DEFECT-D1-en-390-crop.png` (the note and the message together)
  - `work/regression/DEFECT-D1-en-390-followup-retry-time-device-clock.png`
  - `work/regression/DEFECT-D1-ar-390-followup-retry-time-device-clock.png`
  - `work/regression/DEFECT-D1b-en-390-public-form-retry-time-device-clock.png`

### D2 (low): a link to an incident opened while signed out lands on the dashboard after sign-in
- **Who and where:** department manager (any role), en, 1280.
- **Steps:**
  1. Signed out, open `/en/incidents/<id>`. You are sent to `/en/login`.
  2. Sign in.
- **What happens:** you land on `/en/dashboard`, and the incident has to be found again by hand.
- **Expected:** you are returned to the incident you asked for. This matters for a link passed by a colleague, and for e-mailed notification links later.
- **Cause:** the login has no return-to support.
- **Screenshot:** `work/regression/DEFECT-D2-en-1280-deep-link-lands-on-dashboard.png`

### D4 (low): after a hand-off outside one's own scope, nothing confirms it was saved
- **Who and where:** quality officer scoped to Surgery, en, 390.
- **Steps:**
  1. qo1 hands a Ward M1 near miss (INC-00003) to Surgery.
  2. The Surgery officer opens it and picks Pharmacy as the handling department. The warning "outside the area your role covers" appears, which is correct.
  3. Save the triage.
- **What happens:** the API answers 200 `handedOff: true`. The screen jumps to the incidents list with no message, and the incident is simply gone. Back then shows "This incident does not exist, or your role does not let you see it."
- **Expected:** a short confirmation on the list, such as "INC-… handed to Pharmacy", so the officer knows the save happened and was not lost.
- **Screenshot:** `work/regression/DEFECT-D4-en-390-handoff-no-confirmation.png`

### D3 (cosmetic): an administrator is told to "ask an administrator"
- **Who and where:** administrator, en, 390.
- **Steps:**
  1. The two quality officers are disabled. Here that was done through Users, for this test only.
  2. Choose "Ask for sign-off to close" on a death-graded incident.
- **What happens:** "Nobody but you can sign off this closure … Ask an administrator first to give the permission …". The reader is the administrator and can give the permission themselves. The text that shows while waiting (`signOff.nobody`) has the same wording.
- **Expected:** wording that fits someone who manages users, or neutral wording.
- **Screenshot:** `work/regression/DEFECT-D3-en-390-admin-told-ask-an-administrator.png`

## Observations and spec questions (not counted as defects)
- **The paused public form still opens.** The GET answers 200, so a sender writes the whole report before learning the hospital is paused. The text is kept and a time is given (apart from D1). The spec's "the public form answers 429 until the hour moves on" can be read either way.
- **A report set aside from `new`, then reopened, goes straight to "In progress"** with no handling department and no triage (seen on INC-00026). This is allowed by the moves table, but a quality team may not expect it.
- **List filters replace the history entry.** Back leaves the list rather than undoing the last filter. Reload keeps the filters.
- **A half-typed report is lost on reload** (no draft). The spec does not ask for one.
- **"Where it happened" for a switched-off unit shows the name without an "inactive" mark.** The triage form does mark a switched-off handling department.
- **Native form-validation messages** ("Please select one of these options.") come from the browser's own language, not the page's.

## What passed, journey by journey

Each script was rerun after fixing its own selector mistakes. These were mine, not product faults: Arabic names in selects, a checkbox driven by the address, and Next's route announcer also having `role=alert`. The results below are from the final runs. **Console and network log across all runs:** no page errors, no 5xx, no failed requests. Every 4xx (404, 403, 409, 429, 401) came from a deliberate negative check.

**1. Staff report** (reporter): en 1280, fr 390, fr 1280, ar 390, ar 1280. For each, I sent a named incident, an anonymous incident, a near miss and a hazard.
- "When it happened" starts on the hospital clock (01:07 NZ while the device was 12:07 London) and says so. A typed 09:15 is sent as 20:15Z the day before, which is correct. A future time is refused by the field.
- The privacy text changes when "Report anonymously" is ticked. Near miss and hazard ask no harm level.
- Every report gets a reference. The anonymous one shows the code once, with no "View" link, and the code is gone after back and forward, or after leaving to another page and coming back.
- The reporter's list excludes the anonymous report, which answers 404 to its own author.
- The reporter's detail shows no deadlines, no assignee and no internal comments.
- A reload mid-form empties the form.
- The page is right-to-left in Arabic.

**2. Public report and follow-up** (no session): en 390, en 1280, ar 390, ar 1280, fr 390, fr 1280.
- The link without a language goes to the browser's language. The unit QR link preselects Ward M1. Harm is asked in plain words (none, moderate, severe).
- The answer is `{followUpCode}` only, and no INC number appears anywhere.
- A code typed in lower case, with spaces and direction marks, opens the report. A wrong code gives the plain 404 message.
- Read and comment work. A staff "everyone" reply shows as "Hospital staff"; no staff names appear anywhere in the page or the JSON. The internal comment is not shown. The view's JSON has no incident id or reference.
- After closure the comment box is replaced by the "no longer being worked on" text. A page opened before staff set the report aside gets 409 `incident_ended`, explained in place, with the typed text kept. After reopening, comments are accepted again.
- The code of a signed-in anonymous report works on the follow-up page.
- Switching public reporting off while a form is open: the send is refused with "this link has just stopped taking reports" and the text is kept. A reload shows "not available", the unit page hides its QR code, and follow-up still works. Switched back on afterwards.
- Code comment cap: 10 accepted, the 11th gets 429 with Retry-After of about 23.6 hours and the text is kept (see D1).
- "Finish and hide", Back, leaving and returning, and reload never bring the report back.

**3. Triage, hand-off, assignment, comments, close** (en):
- A Surgery-scoped officer gets 404 on a Medicine incident.
- Handing a Ward S1 hazard to Medicine correctly keeps the Surgery officer's access, because it happened in their scope. The department manager is notified `incident_handed_over`.
- A real out-of-scope hand-off shows the warning and ends access at once (see D4).
- qo1 triages to Medicine and assigns the department manager, posts both kinds of comment, starts and closes. A reload in the middle of a move changes nothing.
- The assignee has full access, sees internal comments, can choose comment visibility, has no triage or moves, and does not see the reporter.
- The reporter sees the reply, the closure summary and the triager's name. That name is allowed for a signed-in named reporter. The reporter does not see the internal comment or the assignee.
- Back to the detail shows the closed status.

**4. Set aside, refusal, reopen** (en):
- Set aside from `new` (anonymous) and from `triaged` (named): the reporter sees the reason.
- A severe report offers no "Do not take forward", and a forced API call gets 409 `serious_cannot_be_rejected`. After lowering it to moderate it can be set aside.
- A death report lowered to moderate keeps `needsSignOff` and still cannot be set aside.
- Reopening a closed hazard gives a new closing deadline of the reopen time plus 30 days. The timeline shows "New closing deadline", and the reporter does not get that detail.
- Two windows: a stale triage and a stale status move each get the stale message, and the page shows the latest version.

**5. Sentinel and second sign-off**: en 1280, ar 390, ar 1280, fr 390, fr 1280.
- For severe harm the yes/no question is asked, and the form refuses to save while it is unanswered.
- "Yes" leaves the moves as start and request sign-off, with no close and no set-aside.
- The request form says "People other than you who can sign it off: 2".
- The requester has no sign-off button, and a forced call gets 403 `same_person`.
- The second officer sees who asked and when, and can sign off, send back or withdraw. Send back, ask again and sign off work. A reload mid sign-off changes nothing.
- The reporter sees plain wording, the sent-back note is withheld, and the summary is visible.
- Notifications: `sentinel_flagged` to qo2 and the administrator, not to the triager. `sign_off_requested` twice, `sign_off_decided` twice.
- Extra cases (en):
  - Signing off on a page that is out of date (the summary was rewritten meanwhile) gets 409 stale and shows the new summary.
  - A withdrawal by the second officer notifies the requester.
  - A reopened sentinel needs sign-off again and gets a new 45-day deadline.
  - With both officers disabled, the administrator sees the "nobody else" warning before asking and while waiting. After re-enabling them the count is back to 2.

**6. Reporter privacy for the department manager** (en): compared a named report and an anonymous report by the same reporter, both assigned to the department manager, plus a public report.
- Same `reporter: null`, `reporterShown: false` and `channel: null`.
- Same "Only staff the hospital has authorised…" line, and the same "If this report was sent anonymously…" note.
- The reported event and the reporter's comments say "The reporter" with `byReporter` on both.
- List items have the same `access` and `channel`.
- The channel filter gets 403 for both values and is not shown even with `?channel=public` in the address.
- Notifications are identical in kind and data.
- The detail JSON differs only by ids, dates and texts.
- Notification recipients follow the spec table in every case I traced: comments before and after triage, handover, status changes, and nothing to an anonymous reporter.

**7. Deadlines** (en 1280, fr 390). I moved dates back with SQL on six of my incidents, then restarted the API so the check ran.
- The check logged "21 notifications written". Recipients were right for due soon (triage and closure), overdue triage, overdue closure, and overdue while awaiting sign-off.
- The overdue filter, the list marks and "By deadline" order (overdue first, then ascending) were correct for qo1, dm and sq.
- Every dashboard tile's count equals the total of the list it links to, for qo1, dm, sq and rep.
- The reporter gets null deadlines, no marks and an overdue count of 0.
- The date filters use the hospital's day: 28 Nov in NZ returns today's reports, and 27 Nov returns none.
- `last30Days` is 2026-10-30 to 2026-11-28.
- The serious count matches SQL.

**8. Notifications** (en 1280, ar 390).
- The bell count equals `/notifications/count` and shows 99+ above 99.
- Opening one marks it read, opens the incident and lowers the bell.
- "Mark all" works, and is disabled when nothing is unread. The unread filter and its empty state work.
- Serious marks appear (10 for the department manager).
- An assignee removed from an incident sees "no longer available", with no link.
- Hourly ceiling, reached with public reports from 48 different X-Forwarded-For addresses on top of the 12 already sent:
  - Report 61 got 429.
  - One audit entry `public_reporting_limit_reached` (no actor, `{limit: 60}`), and the server log warning.
  - `public_form_paused` reached the administrator, qo1 and qo2. The administrator gets the "Open the reporting settings" link; qo1 gets only "Mark as read".

**9. Settings**:
- The administrator edits the deadline table (36 h and 20 d kept after reload; 0 refused) and switches public reporting on, which shows both links. The unit page then shows its link and QR code.
- Quality officers (org-wide and scoped) see a read-only table without the reporting switch. The department manager and the reporter see "not allowed" and have no menu item.
- New reports used the edited numbers.

**10. Languages and layout**:
- Journeys 1, 2 and 5 ran in en, ar and fr at both 390 and 1280.
- The sweep loaded 13 pages × 3 languages × 2 widths as the administrator: no horizontal overflow, `dir=rtl` in Arabic, no raw keys, no "undefined", "Invalid Date", "NaN" or "[object Object]", and no English dictionary sentence in ar or fr. The only flags were false positives: "Administration" is the same word in French, and my own fictional note text.
- Western digits are used throughout, with dates and times in the hospital's time.

**Also:**
- Sign out: Back after sign-out shows the login page, and `/auth/me` answers 401. Signing in again works.
- A disabled user is signed out at their next page.
- Reload and Back were exercised mid-flow in each journey.

## What I did not cover
- **Browsers and devices:** only Chromium headless. No Safari, Firefox, real phones, touch, bfcache in other browsers or screen readers. Arabic right-to-left was judged from screenshots plus the automated sweep, not by an Arabic reader.
- **Copy and print:** copy buttons (clipboard), printing the QR code, and decoding the QR content.
- **Time passing naturally:** I triggered the deadline check by restarting the API (it runs one second after start) instead of waiting for the 5-minute timer. The restart also cleared the in-memory per-address limits.
- **Hourly ceiling:** to run journey 2 at 1280 in ar and fr, I moved 20 of my own flood reports back two hours to free the ceiling.
- **Deployment:** several API processes, concurrent deadline checks, IPv6 /56 counting, the 60-openings and 30-attempts per-address limits, and the README's from-outside proxy check.
- **Not exercised:** session expiry after 8 hours, account lockout, password reset, the admin portal beyond creating the client, and branding (skipped as asked). E-mail is not built.
- **Journeys run in English only:** 3, 4 and 6 (their pages were in the language sweep). Journey 7 ran in en and fr, journey 8 in en and ar.
- **Not run:** `pnpm lint`, `typecheck`, `test` and `build` as a whole (only the two app builds, which passed).

## Clean-up
- Both servers were stopped.
- The client, its users and all its rows, the portal admin and the portal audit rows were removed with `removeTestData('zz-reg-d1db6b1b', 'jad-reg-d1db6b1b@test.invalid')` from `apps/api/test/cleanup.ts`. Afterwards the database had no tenant, users, incidents, portal admin or portal audit rows left.
- The working tree is clean; nothing was committed.
- Scripts are in `scratchpad/scripts/`, run logs in `scratchpad/logs/` and all screenshots in `scratchpad/work/regression/`.
