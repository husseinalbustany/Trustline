## Language review 2: incident list, dashboard, timeline, Organization screen (en / ar / fr)

**The report file was not written.** My instructions for this run forbid me from creating report files, so `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/reviews/language-2.md` does not exist. The full report is below, ready to save as it stands. No project files changed, no server started.

## Summary

**Changes proposed:** Arabic 35, French 13, English 6. Parity, placeholders, French spacing, physical classes and language branching are all clean.

**The three that matter most**

1. **Arabic uses two words for "inactive" in the same field.** The option reads «المختبر (غير مفعَّل)» and the help line under it reads «هذا القسم موقوف» (`ar-1280-detail.png`, `ar-1280-user-outside-scope.png`). «غير مفعَّل» is also the wording the last review replaced with «غير نشط». This covers 23 strings and needs a choice (decision 1).
2. **"Median time to report" reads as the delay between the event and the report**, a standard quality indicator. The tile measures how long the form takes to fill in. All three languages need a new label.
3. **Two errors tell the user to use controls that are no longer on screen.** `harm_not_applicable` says "Choose “No harm”" and `sentinel_not_applicable` says "Untick “This is a sentinel event”". Both forms now hide those fields for a near miss or hazard.

**Needs a decision, not a fix**

1. **Arabic vocabulary for a switched-off unit.**
   - Option A (my recommendation, used in the table): state «غير نشط», actions «إلغاء التفعيل» / «تفعيل». It matches the existing status label «نشط».
   - Option B: «موقوف» / «إيقاف» throughout, as on the client screen. The catch is that «مرفق موقوف» can also read as "endowed facility" (waqf).
2. **Arabic duration on the dashboard tile ("1 د و36 ث").** It is correct and understandable, but reads as shorthand on a figure this size. Fixing it means changing `durationFormat` for every language (options under "Relative times and durations").
3. **"{name} (inactive)" cannot agree in gender when the unit type is unknown.** The user and incident records carry no type. Either the API adds it, or the wording names the noun: «{name} (قسم غير نشط)», «{name} (service inactif)». The table uses the second.
4. **Left-to-right inputs sit at the left edge on Arabic pages**, away from their right-aligned label. This is the app-wide pattern (email fields do the same) and item 13 of the last review got no decision. It now shows on the reference search and the code field.

**The engineer's three choices**

- **«الخطيرة» for "serious": keep.** It stays clear of «حدث جسيم» and «ضرر شديد», and matches the «الأحداث الخطيرة» change from the last review.
- **«ما كُلِّفتُ به» and «أنت المكلَّف»: keep both.** One change on the dashboard: «كُلِّفتَ» and «كُلِّفتُ» sit one line apart and differ by a single vowel mark (see the Arabic table).
- **French order labels: accepted.** «Plus graves d'abord» fits at 390. No shot shows «Plus récents d'abord» beside «Plus de filtres (2)», which is the tightest case; check it once.

---

## How I checked

- **Read in full:** the `074b6be..HEAD` diff of the three dictionaries; `incident-detail.tsx`, `incidents-list.tsx`, `dashboard-view.tsx`, `triage-panel.tsx`, `org-tree.tsx`, `org-unit-form.tsx`, `lib/format.ts`, `lib/incidents.ts`, `lib/org-units.ts`; the diffs of `user-form.tsx`, `users-list.tsx`, `pills.tsx`, `pill.tsx`, `button-link.tsx`, `report-form.tsx`, `types.ts` and the organization pages.
- **Ran:** a script for key parity, placeholders, French spacing and stray digits; searches for physical classes, language branching and wording in markup; Node's `Intl` for the relative-time and duration output.
- **Screenshots opened (26 of 80):**
  - Arabic: `ar-1280-dashboard`, `ar-390-dashboard`, `ar-1280-list-filters-open`, `ar-390-list-filters-open`, `ar-390-list-filters-rows`, `ar-390-list-by-harm-final`, `ar-1280-timeline`, `ar-390-timeline`, `ar-1280-detail`, `ar-390-detail`, `ar-1280-detail-unknown-status`, `ar-1280-user-outside-scope`, `ar-1280-users-mona`, `ar-390-user-form-mona`, `ar-tree-1280`, `ar-tree-390`, `ar-edit-1280`, `ar-edit-390`, `ar-add-1280`, `ar-add-390`.
  - French: `fr-390-dashboard`, `fr-390-list-by-harm-final`, `fr-390-list-filters-open`, `fr-390-timeline`, `fr-390-detail`, `fr-1280-detail-unknown-status`, `fr-tree-390`, `fr-edit-390`, `fr-edit-1280`, `fr-add-1280`.
  - English: `en-1280-detail-serious-refused`, `en-1280-signed-out`, `en-tree-inactive-1280`.
- **Read only, never rendered in Arabic or French:**
  - Organization: empty state, "all inactive", not found, "cannot add here", every error, and the edit page of a switched-off unit.
  - Incident list: empty filtered list, and the «Attribué à vous» pill.
  - Incident detail: the "behind" banner and the stale, signed-out and serious-refused errors.
  - Dashboard: "no tasks".
- **Extra keys the list missed:** `incidents.inactiveUnit`, `incidents.triage.ownerInactiveOption`, `admin.users.form.departmentInactive`, `admin.users.form.unknownUnit`, and the reworded `incidents.errors.unknown_org_unit`.
- **During the review** commit `17ca28e` landed. It does not touch `apps/web`.

---

## Arabic (35)

Vocabulary rows assume option A. French and Arabic proposals show ordinary spaces; apply the usual French no-break spaces when pasting.

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `admin.organization.inactive.facility`, `.department` | غير مفعَّل | غير نشط | One word for the state; pairs with «نشط» |
| 2 | `admin.organization.inactive.unit` | غير مفعَّلة | غير نشطة | Same |
| 3 | `admin.organization.inactiveNamed.facility` | {name} (غير مفعَّل) | {name} (مرفق غير نشط) | The adjective reads against the name: «الصيدلية (غير مفعَّل)» is wrong agreement. Naming the noun is always correct |
| 4 | `admin.organization.inactiveNamed.department` | {name} (غير مفعَّل) | {name} (قسم غير نشط) | Same |
| 5 | `admin.organization.inactiveNamed.unit` | {name} (غير مفعَّلة) | {name} (وحدة غير نشطة) | Same |
| 6 | `admin.users.form.inactiveDepartment` | {name} (غير مفعَّل) | {name} (قسم غير نشط) | Type unknown here; a unit such as «وحدة العناية المركزة» gets a masculine adjective. Field label is «القسم» |
| 7 | `incidents.triage.ownerInactiveOption` | {name} (غير مفعَّل) | {name} (قسم غير نشط) | Same |
| 8 | `incidents.triage.ownerInactive` | هذا القسم موقوف. اختر القسم المعني بمعالجة الحادث الآن ثم احفظ. | هذا القسم غير نشط. اختر القسم الذي سيتولى معالجة الحادث، ثم احفظ. | Sits directly under row 7 with a different word |
| 9 | `admin.users.form.departmentInactive` | هذا القسم موقوف. يبقى المستخدم فيه إلى أن تختار قسمًا آخر. | هذا القسم غير نشط. يبقى المستخدم فيه إلى أن تختار قسمًا آخر. | Sits directly under row 6 |
| 10 | `admin.users.form.unknownUnit` | أحد الأقسام المختارة هنا أُوقف. … | أحد الأقسام المختارة هنا أُلغي تفعيله. أعد تحميل الصفحة واختر قسمًا آخر. | Vocabulary |
| 11 | `incidents.errors.unknown_org_unit` | هذا القسم لم يعد متاحًا: أُوقف أو أُزيل. … | هذا القسم لم يعد متاحًا: أُلغي تفعيله أو أُزيل. أعد تحميل الصفحة واختر قسمًا آخر. | Vocabulary |
| 12 | `incidents.inactiveUnit` | قسم لم يعد مفعَّلًا | قسم لم يعد نشطًا | Vocabulary |
| 13 | `admin.organization.showInactive` | إظهار غير المفعَّلة | إظهار العناصر غير النشطة | Vocabulary; the adjective had no noun |
| 14 | `admin.organization.allInactive` | كل ما في الهيكل موقوف. فعّل خيار «إظهار غير المفعَّلة» لعرضه، أو أضف مرفقًا. | كل عناصر الهيكل غير نشطة. حدّد خيار «إظهار العناصر غير النشطة» لعرضها، أو أضف مرفقًا. | «فعّل» for ticking a box clashes with «تفعيل» as the unit action |
| 15 | `admin.organization.form.parentMissing` | … غير موجود أو موقوف. … | لا يمكن الإضافة هنا: هذا المرفق أو القسم غير موجود أو غير نشط. عد إلى الهيكل التنظيمي وأضف من هناك. | Vocabulary |
| 16 | `admin.organization.form.activeHelp` | الإيقاف يزيله من القوائم… | إلغاء التفعيل يزيله من القوائم المستخدمة في الحوادث الجديدة والمستخدمين ونطاقات الأدوار والفرز. لا يُحذف شيء: تبقى الحوادث والمستخدمون المرتبطون به كما هم، ويمكنك تفعيله من جديد. | Vocabulary |
| 17 | `admin.organization.form.switchOff` | إيقاف | إلغاء التفعيل | Clear opposite of «تفعيل» |
| 18 | `admin.organization.form.switchedOff` | تم الإيقاف. | تم إلغاء التفعيل. | Follows row 17 |
| 19 | `admin.organization.form.inactiveHelp` | هو موقوف، فلا يمكن اختياره… | هذا العنصر غير نشط، فلا يمكن اختياره لحوادث جديدة ولا لمستخدمين ولا لنطاقات الأدوار ولا للفرز. سجله محفوظ. فعّله لاستخدامه من جديد. | A sentence opening on a bare «هو» is awkward |
| 20 | `admin.organization.errors.parent_inactive` | المرفق أو القسم الذي يتبعه موقوف. فعّله أولًا، أو اختر غيره. | المرفق أو القسم الذي يتبعه هذا العنصر غير نشط. فعّله أولًا، أو اختر غيره. | Vocabulary; «يتبعه» had no clear subject |
| 21 | `admin.organization.errors.code_taken` | هذا الرمز مستخدم من قبل، وربما في عنصر موقوف. … | هذا الرمز مستخدم بالفعل، وربما في عنصر غير نشط. أدخل رمزًا آخر. | «من قبل» reads as "used in the past" |
| 22 | `admin.organization.errors.has_active_children` | ما زال بعض ما يتبعه مفعَّلًا. أوقف كل ما يتبعه أولًا، ثم أوقفه. | ما زال بعض ما يتبعه نشطًا. ألغِ تفعيل كل ما يتبعه أولًا، ثم ألغِ تفعيله. | Vocabulary |
| 23 | `dashboard.tiles.timeToReport` | وسيط مدة الإبلاغ | وسيط مدة تعبئة البلاغ | See "three that matter most", 2 |
| 24 | `incidents.errors.harm_not_applicable` | … اختر «بلا ضرر» ثم حاول مرة أخرى. | الحادث الوشيك ومصدر الخطر لم يُلحقا ضررًا بأحد، فلا يُحدَّد لهما مستوى ضرر. أعد تحميل الصفحة ثم حاول مرة أخرى. | The field is hidden (`report-form.tsx:307`, `triage-panel.tsx:241`) |
| 25 | `incidents.errors.sentinel_not_applicable` | … ألغِ تحديد «هذا حدث جسيم» ثم احفظ مرة أخرى. | لا يمكن أن يكون الحادث الوشيك أو مصدر الخطر حدثًا جسيمًا. أعد تحميل الصفحة ثم حاول مرة أخرى. | Same |
| 26 | `incidents.errors.serious_cannot_be_rejected` | لا يمكن استبعاد حادث فيه ضرر شديد أو وفاة أو حدث جسيم. … | لا يمكن استبعاد حادث نتج عنه ضرر شديد أو وفاة، ولا حادث حُدِّد على أنه حدث جسيم. إذا كان مستوى الضرر أو تحديد الحدث الجسيم غير صحيح، فصحّحه في الفرز أولًا ثم حاول مرة أخرى. | «حادث فيه … حدث جسيم» says an incident contains an event; the incident is the event |
| 27 | `incidents.actions.moveTo` | النقل إلى «{status}» | تغيير الحالة إلى «{status}» | «النقل» suggests moving the incident somewhere, next to «التحويل إلى {unit}». The panel and timeline already say «تغيير الحالة» |
| 28 | `dashboard.assignedToMe` | الحوادث المفتوحة التي كُلِّفتَ بها | حوادث مفتوحة أنت المكلَّف بها | Reads after a number ("3 حوادث…") and reuses the row mark; no reliance on one vowel |
| 29 | `dashboard.noTasks` | لا توجد حوادث مفتوحة كُلِّفتَ بها. | لا توجد حوادث مفتوحة أنت المكلَّف بها. | Follows row 28 |
| 30 | `dashboard.viewTasks` | عرض ما كُلِّفتُ به | عرض هذه الحوادث | Ends the me / you switch inside one small panel |
| 31 | `incidents.timeline.changedTo` | تغيّر إلى | ثم أصبح | Screen readers only. «حدث جسيم: لا تغيّر إلى نعم» is heard as "do not change to yes" |
| 32 | `admin.organization.form.codeHelp` | من 2 إلى 40 من الأحرف الإنجليزية الكبيرة (A إلى Z) والأرقام والشرطات، مثل ICU-2. لا يمكن تغييره لاحقًا. | من 2 إلى 40 خانة: أحرف إنجليزية كبيرة (A إلى Z) أو أرقام أو شرطات، مثل ICU-2. لا يمكن تغيير الرمز لاحقًا. | Double «من»; "and" where English says "or" |
| 33 | `admin.organization.addFirst` | أضف أول مرفق | إضافة أول مرفق | Every other button is a verbal noun («إضافة مرفق») |
| 34 | `incidents.list.reference` | الرقم المرجعي يبدأ بـ | بداية الرقم المرجعي | Optional. A label ending on a dangling «بـ» |

(Rows 1 and 2 cover three keys, so the count is 35.)

**Reviewed and good as written:** «الأشد ضررًا أولًا», «عوامل تصفية أخرى», «مسح عوامل التصفية», «تاريخ البلاغ من / إلى», «أُبلغ عنه {ago}», `detail.behind`, `stale_incident`, `occurred_too_long_ago`, `signedOut`, `outsideScope`, `note.required`, `events.other`, the three "Not taken forward" keys («سبب استبعاد هذا البلاغ», «الاستبعاد», «سبب الاستبعاد»), and the Organization title, description, types, add buttons, `typeHelp`, `parentHelp` and `invalid_parent`. «مرفق» for facility and «منشأة» for the hospital stay distinct.

## French (13)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `dashboard.tiles.timeToReport` | Durée médiane de déclaration | Durée médiane de saisie | Reads as the delay before declaring; the tile measures form entry |
| 2 | `incidents.errors.harm_not_applicable` | … Choisissez « Aucun préjudice », puis réessayez. | Un presque-accident ou un danger n'a causé de préjudice à personne : il n'a pas de niveau de préjudice. Rechargez la page, puis réessayez. | The field is hidden |
| 3 | `incidents.errors.sentinel_not_applicable` | … Décochez « Il s'agit d'un événement sentinelle », puis enregistrez de nouveau. | Un presque-accident ou un danger ne peut pas être un événement sentinelle. Rechargez la page, puis réessayez. | Same |
| 4 | `incidents.errors.serious_cannot_be_rejected` | … Si le niveau de préjudice ou la mention d'événement sentinelle est inexact, corrigez-le d'abord… | Un incident ayant entraîné un préjudice grave ou un décès, ou signalé comme événement sentinelle, ne peut pas être classé sans suite. En cas d'erreur sur le niveau de préjudice ou sur la mention d'événement sentinelle, corrigez-la d'abord dans le tri, puis réessayez. | «inexact … corrigez-le» agrees with the farther noun; «la mention» is feminine |
| 5 | `admin.organization.inactiveNamed.facility` | {name} (inactif) | {name} (site inactif) | «Pharmacie (inactif)» reads as wrong agreement with the name |
| 6 | `admin.organization.inactiveNamed.department` | {name} (inactif) | {name} (service inactif) | Same |
| 7 | `admin.organization.inactiveNamed.unit` | {name} (inactive) | {name} (unité inactive) | Same |
| 8 | `admin.users.form.inactiveDepartment` | {name} (inactif) | {name} (service inactif) | Type unknown: «Unité de soins intensifs (inactif)» is wrong |
| 9 | `incidents.triage.ownerInactiveOption` | {name} (inactif) | {name} (service inactif) | Same; it shows in `fr-390-detail.png` as «Laboratoire (inactif)» |
| 10 | `incidents.list.assignedToYou` | Attribué à vous | Vous est attribué | French uses the clitic pronoun |
| 11 | `admin.organization.addFirst` | Ajoutez votre premier site | Ajouter votre premier site | Buttons are infinitives («Ajouter un site») |
| 12 | `dashboard.viewTasks` | Voir les incidents qui me sont attribués | Voir ces incidents | Optional. Ends the «vous» / «me» switch in one panel |
| 13 | `incidents.errors.signedOut` | … et réessayez : ce que vous avez saisi est toujours là. | … et réessayez. Ce que vous avez saisi est toujours là. | Optional. Two colons in one message |

**Good as written:** «Ordre» (rightly avoids «Tri», which means triage here), «Déclaré à partir du / jusqu'au», «Plus de filtres», «devient», «Passer à « {status} »», `ownerInactive`, `stale_incident`, and the whole Organization form and its errors. «Inactif / Inactive» per type on the tree pills is correct (`fr-tree-390.png`).

## English (6)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `dashboard.tiles.timeToReport` | Median time to report | Median time to fill in a report | "Time to report" is the event-to-report delay in quality work. The requirement is "time for staff to submit a report" |
| 2 | `incidents.errors.harm_not_applicable` | … Choose “No harm”, then try again. | A near miss or a hazard harmed no one, so it has no harm level. Reload the page, then try again. | The field is hidden |
| 3 | `incidents.errors.sentinel_not_applicable` | … Untick “This is a sentinel event”, then save again. | A near miss or a hazard cannot be a sentinel event. Reload the page, then try again. | Same |
| 4 | `incidents.errors.serious_cannot_be_rejected` | An incident with severe harm, a death or a sentinel event must be taken forward. … | An incident that caused severe harm or a death, or that is a sentinel event, must be taken forward. … | Optional. "An incident with a sentinel event" is loose |
| 5 | `dashboard.viewTasks` | View the incidents assigned to me | View these incidents | Optional. "My tasks" / "assigned to you" / "assigned to me" in three lines |
| 6 | `admin.organization.description` | … Incidents, users and role scopes point at them. | … Incidents, users and role scopes are linked to them. | Optional. "Point at" is developer wording |

English says "Inactive" on the pill and "switched off" in sentences. It reads naturally, so I leave it; the Arabic is where the split shows.

---

## Layout faults

| Screenshot | Fault | Fix |
|---|---|---|
| `ar-1280-detail.png`, `ar-390-detail.png`, `ar-1280-user-outside-scope.png`, `ar-390-user-form-mona.png` | «(غير مفعَّل)» in the select, «موقوف» in the help line under it | Arabic rows 6 to 9 |
| `ar-1280-dashboard.png`, `ar-390-dashboard.png` | Duration figure "1 د و36 ث" | Decision 2 |
| `fr-390-timeline.png` | Arrow left alone at the end of a line («Préjudice léger →» / «Préjudice grave»). Arabic will do the same with longer names | In `incident-detail.tsx:354-368`, wrap the arrow and the new value in one `inline-block` span, as `incidents-list.tsx:454` does |
| `ar-1280-list-filters-open.png`, `ar-390-list-by-harm-final.png`, `ar-edit-1280.png` | Reference placeholder and code "ER" at the left edge, label at the right; in the edit form the neighbouring «قسم» field is right-aligned | Decision 4 (`rtl:text-end` on left-to-right inputs) |
| `ar-1280-list-filters-open.png` | Date inputs show "mm/dd/yyyy" | Not new: the native control follows the browser's language (item 13 last time) |
| `fr-390-list-filters-open.png` | «Les plus graves d'ab» cut off | Stale: fixed by the shorter labels in `fr-390-list-by-harm-final.png` |
| `ar-390-list-filters-rows.png` | «القسم المعني / بالمعالجة: المختبر» split across lines | Stale: kept together in `ar-390-list-by-harm-final.png` |
| `en-1280-detail-serious-refused.png` | Top bar drawn across the middle of the page | Looks like a full-page capture artefact; not judged |

**Derived from the bidi rules, not seen in a shot.** A Latin name ending in a bracket, such as "Ward 3 (East)", shown alone on an Arabic page puts the closing bracket at the wrong end. `pick()` falls back to such names when there is no Arabic one. Places added in this work:
- `org-tree.tsx:135` and `org-unit-form.tsx:251`: wrap the name in `<bdi>`.
- `org-unit-form.tsx:215` and `:231`, `lib/org-units.ts:67`: an option holds no elements, so wrap the name in `⁨…⁩`, as `triage-panel.tsx:327` does.

---

## The checks you asked for

- **French spacing:** clean in the whole of `fr.json`, not only the new strings. U+00A0 before every `:` and inside every « », U+202F before every `; ? !`.
- **Placeholders:** identical across the three files for every key. 531 keys in each, none missing, none empty, no Arabic-Indic digits.
- **Timeline "from → to" in Arabic:** correct. The label is at the right, the old value next, the arrow flipped to point left, the new value at the left (`ar-1280-timeline.png`, `ar-390-timeline.png`). Each value is in `<bdi>`, so a Latin name cannot reorder the line. Only the hidden screen-reader word needs changing (Arabic row 31).
- **No language special-cased, no wording in markup, no physical classes** in any changed file. The one directional icon (`ArrowRight`) is mirrored.

### Relative times and durations (browser `Intl`)

- **Arabic relative times are good.** «قبل دقيقتين», «قبل 3 أيام», «قبل 11 يومًا», «قبل ساعة واحدة»: correct dual and plural forms, Western digits. «أُبلغ عنه قبل 6 دقائق» reads naturally in `ar-1280-list-filters-open.png`.
- **Under one minute** gives "Reported now", «Déclaré maintenant», «أُبلغ عنه الآن». Arabic is fine. English wants "just now" and French «à l'instant». A `list.reportedJustNow` key would fix it without touching `Intl`. Low priority.
- **Arabic duration "1 د و36 ث":** these are the standard short forms and a hospital user will understand them. On a 24-pixel figure the single letters and the «و» joined to the digits look like shorthand, below what an Arabic-first product should show. Not a blocker. Two ways to fix it without branching on language:
  - `unitDisplay: "long"` in `durationFormat`, giving «دقيقة و36 ثانية», "1 minute 36 seconds", «1 minute 36 secondes». The figure then wraps in the 390 tile, so it needs a smaller size.
  - A clock figure with the unit from the dictionary: "1:36 min", «1:36 دقيقة». Compact and familiar to clinical staff.
- **English and French durations are fine:** "1 min 36 sec", «1 min 36 s» (`fr-390-dashboard.png`).