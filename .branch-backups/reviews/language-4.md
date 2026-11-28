## Decisions (taken by the lead; apply all of this)

Every row of the three tables is accepted, optional ones included (Arabic row 12 as corrected
under the table), and every layout fault with its proposed fix, including the two older portal ones.
Retake the stale follow-up "ended" screenshots, in Arabic and French too.

On the seven points that needed a decision:
1. Reword `admin.settings.deadlines.applies` as proposed, in the three languages (the code stays).
2. Accepted: add the clause to `incidents.form.anonymousWarning`.
3. Accepted: Arabic notification sentences lead with the reference, following the three examples
   given; write all of them in that pattern and list them in your report.
4. Accepted: move fr.json to typographic apostrophes (U+2019) in the same pass as the spacing;
   update anything that matches French text with a straight one.
5. Drop the zone from `publicReport.deviceTime`; keep the short sentence proposed.
6. Leave the interface as it is.
7. Accepted: `followUp.ended` and `endedSince` end with "or speak to a member of staff" when
   there is no link.

---

## Language review 4: deadlines, notifications, hospital time (en / ar / fr)

Reviewed at d631907; no repository file changed and no server started. HEAD moved to 0504b51 while I worked, with nothing changed under `apps/web`.

The wording is in good shape: parity, placeholders and French spacing are clean, and the deadline sentences read correctly with `Intl` in Arabic. The problems worth your time are these:
- A reference that breaks across lines inside a notification.
- An Arabic button that reads "Select all".
- French "À trier dans 5 heures", which can be read as "do it in 5 hours".
- One settings sentence that the code contradicts.

French proposals below show ordinary spaces; run them through `frs()` as before.

---

## Checks you asked for

- **Parity:** 733 keys in each of `en`, `ar`, `fr`; none missing or empty.
- **Placeholders:** identical across the three languages for every key.
- **French spacing:** clean across all of `fr.json` (U+00A0 before `:` and inside « », U+202F before `; ? !`).
- **Code:** no left/right classes, no branching on a language and no wording in markup in the 28 changed web files.
- **Deadline sentences with `Intl`** (Node 22, ICU 78, Western digits; a browser's own data may differ slightly):

| | One | Two | A few | Many |
|---|---|---|---|---|
| ar, ahead | الفرز مطلوب خلال ساعة واحدة | خلال ساعتين / خلال يومين | خلال 3 ساعات / خلال 10 أيام | خلال 11 يومًا / خلال 47 ساعة / خلال 100 يوم |
| ar, past | فات الموعد النهائي للإغلاق قبل ساعة واحدة | قبل ساعتين / قبل يومين | قبل 3 أيام | قبل 11 يومًا / قبل 100 يوم |
| fr, ahead | À trier dans 1 heure | dans 2 heures | dans 5 heures | dans 11 jours |
| fr, past | Échéance de tri dépassée il y a 1 heure | il y a 2 jours | il y a 3 jours | il y a 100 jours |

  - **Arabic reads correctly in every form.** «خلال» and «قبل» take exactly the case `Intl` supplies, and «مطلوب خلال» means "required within", which is the sense wanted.
  - **French is grammatical, but the "ahead" form is ambiguous** (French row 1). The "past" form is good.
- **Full stop after a Latin reference in Arabic:** it lands at the far left, after the reference in reading order, which is the correct place (`ar-1280-notifications.png`). It sits tight against the "I" of INC and inside the link colour. See decision 3 for an option that removes the question.
- **Bell count:** Western digits, the exact number in the link's name, "99+" above 99, and it matched the list total (43) in the shots. One small fault: the badge is not mirrored (layout table).
- **Right-to-left layout:**
  - **Deadline line in list rows:** correct at 390 and 1280. Sentence first, date after, red when late, the «متأخر» pill beside the status.
  - **Settings table:** columns run right to left, row names at the right, figures at the start edge of their fields under the heading, both editable and read-only.
  - **Notifications list:** the unread bar is on the leading edge and the time line reads correctly. One fault that matters: the reference can break (layout table).
  - **Portal time zone field:** the Latin name is aligned under its label, and the options are mirrored with the clock at the far side. Two faults (layout table).

### Review 3 spot-check (19cb81c)

Applied as written:
- **Code:** one left-to-right hyphenated line (`follow-up-code.tsx:46-52`, seen in `ar-390-public-sent.png`), with the address and its copy button under it.
- **Promise about who sees a name:** reworded in `whoSeesName` and `reporterHidden` in the three languages. «سوى الموظفين» is the correct case.
- **Date fields:** now start under their label in Arabic (`ar-390-public-form.png`, `ar-390-list-filters.png`).
- **Public form:** `publicReport.urgent` is on the form and with the "too many" message, and the place list has lost its dashes.
- **`followUp.behind`:** removed together with its use, because the comment call now returns the whole report. Nothing on that page says "reload".
- **`publicReport.form.*` (3 labels) and `publicReport.errors.*` (7):** in the agreed vocabulary. None says "reload the page", and each quotes its field label exactly as the form shows it. Two of them open differently from the other five (last row of each table).

---

## Arabic (17 changes, 5 of them optional)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `notifications.markAll` | تحديد الكل كمقروء | اعتبار الكل مقروءًا | «تحديد الكل» is "Select all" on every Arabic interface, and «تحديد / حدّد» means select or tick in `ar.json` (lines 169, 837, 869). «كمقروء» is a calque of "as read". Second choice, as phones say it: «تمييز الكل كمقروء» |
| 2 | `notifications.markRead` | تحديد كمقروء | اعتباره مقروءًا | Same |
| 3 | `notifications.actionError` | تعذّر تحديد الإشعار كمقروء. تحقق من الاتصال ثم حاول مرة أخرى. | تعذّر حفظ حالة الإشعار. تحقق من الاتصال ثم حاول مرة أخرى. | Same |
| 4 | `notifications.kinds.sign_off_decided.withdrawn` | سحب شخص آخر طلب اعتماد إغلاق الحادث {reference} الذي قدّمتَه. | سحب شخص آخر طلبك لاعتماد إغلاق الحادث {reference}. | «الذي قدّمتَه» attaches to the nearest noun, so it reads "the incident you submitted". Shorter, and the reference no longer sits mid-sentence |
| 5 | `incidents.actions.revisionHelp` | …إذا عدّله مستخدم آخر منذ ذلك الحين فلن يُحفظ شيء، وستعرض الصفحة آخر نسخة منه لتراجعها. | يُسجَّل قرارك على الحادث كما تعرضه هذه الصفحة. إذا عدّله مستخدم آخر بعد أن فتحتَ الصفحة فلن يُحفظ شيء، وستعرض الصفحة أحدث نسخة منه لتراجعها. | «منذ ذلك الحين» has nothing to refer back to |
| 6 | `admin.settings.deadlines.what` | (after the first sentence) | add: تُحتسب المدتان من لحظة إرسال البلاغ. | Nothing says where the count starts. "Close within 30 days" is easily read as 30 days from triage; both run from the report |
| 7 | `incidents.list.sort.due` | حسب الموعد النهائي | الموعد النهائي الأسبق أولًا | The other three orders say what comes first («الأحدث أولًا»). This one does not say which end |
| 8 | `platform.form.timeZone.now` | الوقت هناك الآن: {time} ({zone}) | الوقت هناك الآن: {time} – {zone} | `{zone}` already ends in a bracket, so the line shows «(التوقيت العربي الرسمي (غرينتش+3))» (`ar-390-portal-time-zone.png`) |
| 9 | `notifications.empty` | …عند حدوث جديد في حادث أبلغتَ عنه… | لا توجد إشعارات بعد. عندما يستجدّ شيء في حادث أبلغتَ عنه أو تتولى معالجته سيظهر هنا. | «حدوث … حادث» repeats the root; «يستجدّ» matches the page description |
| 10 | `publicReport.loadTooMany` | فُتح هذا النموذج مرات كثيرة خلال الساعة الماضية. يمكنك… | تجاوز عدد مرات فتح هذا النموذج خلال الساعة الماضية الحد المسموح به. يمكنك المحاولة مرة أخرى بعد الساعة {time}. | "Opened many times" does not say a limit was reached (as review 3, row 14) |
| 11 | `publicReport.loadTooManyLater` | فُتح هذا النموذج مرات كثيرة… حاول مرة أخرى لاحقًا. | تجاوز عدد مرات فتح هذا النموذج خلال الساعة الماضية الحد المسموح به. حاول مرة أخرى لاحقًا. | Same |
| 12 | `platform.form.timeZone.none` | …جرّب اسم مدينة كبيرة في المنطقة الزمنية نفسها. | لا توجد منطقة زمنية مatching → لا توجد منطقة زمنية مطابقة. اكتب بالأحرف الإنجليزية اسم مدينة كبيرة في المنطقة الزمنية نفسها. | Whoever sees this has most likely typed in Arabic; the list holds Latin names only |
| 13 | `admin.settings.deadlines.hours` | الفرز خلال (ساعات) | مدة الفرز (بالساعات) | Optional. A preposition left hanging before a bracket; «المدة» is the word the paragraph above uses |
| 14 | `admin.settings.deadlines.days` | الإغلاق خلال (أيام) | مدة الإغلاق (بالأيام) | Same |
| 15 | `notifications.kinds.incident_assigned` | تم تكليفك بالحادث {reference}. | تم تكليفك بمعالجة الحادث {reference}. | Optional. One is charged with a task, not with an incident. «تكليف» itself is confirmed |
| 16 | `publicReport.errors.occurred_in_future` | تاريخ ووقت الوقوع في المستقبل. صحّحهما ثم أرسل البلاغ مرة أخرى. | لم يُرسَل بلاغك: تاريخ ووقت الوقوع في المستقبل. صحّحهما ثم أرسله مرة أخرى. ما كتبته ما زال هنا. | Optional. The other five errors open with "not sent" and end with "still here" |
| 17 | `publicReport.errors.occurred_too_long_ago` | تاريخ الوقوع قديم جدًّا. راجع التاريخ، وخصوصًا السنة، ثم أرسل البلاغ مرة أخرى. | لم يُرسَل بلاغك: تاريخ الوقوع قديم جدًّا. راجع التاريخ، وخصوصًا السنة، ثم أرسله مرة أخرى. ما كتبته ما زال هنا. | Same |

Correction to row 12: the proposed text is «لا توجد منطقة زمنية مطابقة. اكتب بالأحرف الإنجليزية اسم مدينة كبيرة في المنطقة الزمنية نفسها.» (ignore the stray arrow in the cell).

**Good as written:**
- All of `incidents.deadline.*`.
- `overdue`, `overdueHelp`, `hospitalDays`, `hospitalTime`, `deviceTime`.
- Both dashboard tiles and their help lines.
- The other 14 notification sentences.
- `ended`, `endedSince`, `newReport`, both `commentTooMany`.
- The three explanatory sentences in settings («مستشفاكم», «صف الوفاة» matching the row «وفاة»), `limits`, `invalid`, `readOnly`.
- `timeZone.help`, which rightly says to type in Latin letters.

## French (15 changes, 3 of them optional)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `incidents.deadline.due.triage` | À trier {when} | Échéance de tri {when} | « À trier dans 5 heures » can be read as "triage it five hours from now"; « dans » names a moment, not a limit, and `Intl` cannot give « sous » or « d'ici ». « Échéance de tri dans 5 heures » has one reading and mirrors the late form « Échéance de tri dépassée il y a 3 jours » |
| 2 | `incidents.deadline.due.closure` | À clôturer {when} | Échéance de clôture {when} | Same: « À clôturer dans 11 jours » (`fr-390-list-deadlines.png`) |
| 3 | `followUp.commentTooMany` | …Vous pourrez réessayer après l'heure suivante : {time}. | …Vous pourrez réessayer à partir de {time}. | « L'heure suivante » reads "the next hour". « à partir de 06:12 » and « à partir de jeudi 06:12 » both read naturally |
| 4 | `admin.settings.deadlines.hours` | Tri sous (heures) | Délai de tri (heures) | « sous » hangs before the bracket (`fr-390-settings-deadlines.png`); « délai » is your word for the time allowed |
| 5 | `admin.settings.deadlines.days` | Clôture sous (jours) | Délai de clôture (jours) | Same |
| 6 | `dashboard.tiles.triagedOnTime` | Triés dans les délais | Tri dans les délais | Masculine title over a feminine help line (« déclarations… déjà triées »). The noun needs no agreement |
| 7 | `notifications.kinds.sign_off_decided.withdrawn` | Votre demande de validation de la clôture de l'incident {reference} a été retirée par une autre personne. | Une autre personne a retiré votre demande de clôture de l'incident {reference}. | Four « de » in a row; active voice. « Demande de clôture » is what the fallback sentence says |
| 8 | `admin.settings.deadlines.what` | (after the first sentence) | add: Les deux délais courent à partir de la déclaration. | As Arabic row 6 |
| 9 | `incidents.list.sort.due` | Par échéance | Échéance la plus proche d'abord | As Arabic row 7 |
| 10 | `platform.form.timeZone.now` | Heure sur place en ce moment : {time} ({zone}) | Heure sur place en ce moment : {time} – {zone} | Double closing bracket, as Arabic row 8 |
| 11 | `platform.form.timeZone.help` | …Pour chercher, saisissez une partie du nom d'une ville ou d'une région, par exemple Riyadh. | …Pour chercher, saisissez en anglais une partie du nom d'une ville ou d'une région, par exemple Riyadh. | The list holds English names only: « Le Caire » or « Londres » finds nothing (`time-zone-field.tsx:76-81`). The Arabic says so; the French does not |
| 12 | `platform.form.timeZone.none` | …Essayez le nom d'une grande ville du même fuseau. | Aucun fuseau horaire ne correspond. Essayez le nom anglais d'une grande ville du même fuseau. | Same |
| 13 | `notifications.kinds.sign_off_decided.signed_off` | La clôture de l'incident {reference} a été validée. | La clôture de l'incident {reference} a été validée : il est clôturé. | Optional. English and Arabic both say it is now closed |
| 14 | `publicReport.errors.occurred_in_future` | La date de l'événement est dans le futur. Corrigez-la, puis envoyez de nouveau la déclaration. | Votre déclaration n'a pas été envoyée : la date de l'événement est dans le futur. Corrigez-la, puis envoyez-la de nouveau. Ce que vous avez écrit est toujours là. | Optional. As Arabic row 16 |
| 15 | `publicReport.errors.occurred_too_long_ago` | La date de l'événement est trop ancienne. Vérifiez la date… | Votre déclaration n'a pas été envoyée : la date de l'événement est trop ancienne. Vérifiez la date, en particulier l'année, puis envoyez-la de nouveau. Ce que vous avez écrit est toujours là. | Same |

**Good as written:** both late forms, `by.*`, `title`, `current`, `overdue`, `overdueHelp`, the settings title and three sentences, `readOnly`, `hospitalDays`, `hospitalTime`, `deviceTime`, `revisionHelp`, the three `loadTooMany*`, `ended`, `endedSince`, the notifications page, and the other 15 notification sentences. « échéance » for the date and « délai » for the time allowed are used consistently in every new string.

## English (12 changes, 5 of them optional)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `notifications.kinds.due_soon.closure` | The deadline to close {reference} is close. | The deadline to close {reference} is approaching. | "Close" in two senses in one short sentence |
| 2 | `notifications.kinds.due_soon.triage` | The deadline to triage {reference} is close. | The deadline to triage {reference} is approaching. | Same word as row 1 |
| 3 | `notifications.kinds.due_soon.other` | A deadline for {reference} is close. | A deadline for {reference} is approaching. | Same |
| 4 | `incidents.list.sort.due` | By deadline | Earliest deadline first | The other three say what comes first |
| 5 | `platform.form.timeZone.now` | Time there now: {time} ({zone}) | Time there now: {time} – {zone} | Shows "(Arabian Standard Time (GMT+3))" (`en-1280-portal-time-zone-chosen.png`) |
| 6 | `admin.settings.deadlines.what` | (after the first sentence) | add: Both are counted from the moment the report is made. | As Arabic row 6 |
| 7 | `incidents.actions.revisionHelp` | …If someone has changed it since, nothing is saved… | Your decision is recorded for the incident as this page shows it. If someone has changed the incident since you opened this page, nothing is saved and the page shows the latest version for you to check. | "Since" what? |
| 8 | `followUp.commentTooMany` | …You can try again after this time: {time}. | …You can try again after {time}. | Optional. "After Thursday 6:12 AM" reads well in English and drops a third colon |
| 9 | `admin.settings.deadlines.hours` | Triage within (hours) | Time to triage (hours) | Optional, to keep the three languages in step |
| 10 | `admin.settings.deadlines.days` | Close within (days) | Time to close (days) | Same |
| 11 | `publicReport.errors.occurred_in_future` | The time it happened is in the future. Correct it, then send your report again. | Your report was not sent: the time it happened is in the future. Correct it, then send it again. What you wrote is still here. | Optional. As Arabic row 16 |
| 12 | `publicReport.errors.occurred_too_long_ago` | The date it happened is too far in the past. Check the date… | Your report was not sent: the date it happened is too far in the past. Check the date, especially the year, then send it again. What you wrote is still here. | Same |

---

## Layout faults

| Screenshot | Fault | Fix |
|---|---|---|
| `fr-390-notifications.png`, `fr-390-notifications-unavailable.png` | **A reference breaks across two lines at its hyphens** (« INC-2026- / 00022. »), in most rows at 390. In Arabic it is worse: in a scratch render of the built markup the first line ends «الحادث -INC-2026», with the hyphen jumping in front, and the next line starts «.00042». The Arabic shots escape it only because the sentences shown happen to fit; `due_soon.closure`, `withdrawn` and `incident_handed_over` are long enough to wrap | `notifications-view.tsx:174-198`: do not put the reference in with `fill()`. Split the sentence at `{reference}` and render it as `<bdi dir="ltr" className="whitespace-nowrap">`, as the incidents list does (`incidents-list.tsx`). Checked on a scratch file only: `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour4/n.png` |
| `en-1280-portal-time-zone-chosen.png`, `ar-390-portal-time-zone.png` | "Time there now" ends in a double bracket, because the zone label already carries one (`time-zone.ts:59-61`) | Wording rows above (ar 8, fr 10, en 5) |
| Every Arabic app shot, for example `ar-1280-notifications.png` | The bell's count is not mirrored: it sits at the top right in Arabic as in French. `app-shell.tsx:234-237` puts `dir="ltr"` on the same element as `-end-1`, and the logical offset then follows that element's own direction | Low. Leave `-end-1` on the outer span and put `dir="ltr"` on an inner span around the figure. Checked on the same scratch file |
| `ar-390-portal-time-zone.png` (foot of the page) | The activity line reads «2026/11/Maya deadlines check · 25، 9:10 ص»: the day is torn from its date by the Latin name. Not from this commit | `client-form.tsx:398-403`: name in `<bdi>`, date in its own `<time>`, instead of one joined string |
| `ar-390-portal-time-zone.png`, `ar-390-portal-time-zone-search.png` | Both images are 414 px wide for a 390 viewport and the sign-out button is cut at the edge, so the portal scrolls sideways in Arabic. Inferred from the image width; not checked in English or French, and the header is not from this commit | Low. `portal-frame.tsx:66`: let the title shrink (`min-w-0 truncate`) or hide the user name earlier |
| `en-390-follow-up-ended.png`, `en-390-follow-up-ended-while-typing.png` | The link follows the sentence on the same line: "…send a new report. Send a new report". The shots are from 09:12:00 and `follow-up.tsx` was saved at 09:12:17 with the link on its own line (lines 316-317, 336-337) | Retake. No Arabic or French shot of this state exists |
| `fr-390-report-form.png`, `fr-390-list-filters.png` | « heure normale de l’Arabie » carries a typographic apostrophe inside a sentence written with straight ones | Decision 4 |
| `ar-390-list-deadlines.png`, `fr-390-list-deadlines.png` | At 390 the date always wraps under the deadline sentence and starts with its dot | Not a fault: it is the rule from review 3, and it reads correctly in both directions |

---

## Summary

**Counts:** Arabic 17 (5 optional), French 15 (3 optional), English 12 (5 optional). Layout: 1 fault that matters, 2 small ones from this commit, 2 older ones in the portal, 1 stale set of screenshots.

**Vocabulary**
- **«الموعد النهائي»: confirmed** throughout, with «المدة» for the time allowed in settings. My rows keep that pair.
- **« échéance » / « délai »: confirmed**, and consistent.
- **«تم تكليفك»: confirmed.** It matches «ما كُلِّفتُ به» and «أنت المكلَّف». «بمعالجة الحادث» is the optional polish.
- **«متأخر» / « En retard » / "Overdue": confirmed**, the same word as for corrective actions.
- **«حُوِّل» matches the timeline's «التحويل إلى».**
- **«البلاغ» before triage and «الحادث» after** (« déclaration » / « incident ») is held consistently in the notifications.

**The three that matter most**
1. **The reference breaks inside a notification.** Seen in French on most rows at 390; in Arabic the pieces come out reordered. Render it as one unbreakable left-to-right piece.
2. **«تحديد الكل كمقروء».** The first two words are "Select all" to any Arabic user, on the one button that changes every row at once.
3. **« À trier dans 5 heures » / « À clôturer dans 11 jours ».** On the line a handler reads to decide what to do first, it can be taken as "not before". « Échéance de tri dans 5 heures » cannot.

**Needs a decision, not a fix**
1. **"A change applies to new reports only" is not quite what the code does.** When a later triage changes the harm level or the sentinel flag, the closure deadline is worked out again "under the rules as they are now" (`incidents.service.ts:1316-1327`). Either the code keeps the old table for such incidents, or `admin.settings.deadlines.applies` says so:
   - en: "A change applies to new reports, and to an incident whose harm level or sentinel flag is changed afterwards: its closure deadline is then worked out again from this table. Other deadlines already set do not move."
   - ar: «أي تغيير يسري على البلاغات الجديدة، وعلى الحادث الذي يُعدَّل مستوى ضرره أو يتغيّر تصنيفه حدثًا جسيمًا بعد ذلك: يُعاد عندئذٍ احتساب موعد إغلاقه النهائي من هذا الجدول. أما بقية المواعيد النهائية المحدَّدة من قبل فلا تتغير.»
   - fr: «Une modification s'applique aux nouvelles déclarations, ainsi qu'à un incident dont le niveau de préjudice ou le caractère sentinelle est modifié par la suite : son échéance de clôture est alors recalculée d'après ce tableau. Les autres échéances déjà fixées ne bougent pas.»
2. **Someone signed in who reports anonymously is told nothing about notifications.** The notifications page says "the incidents you reported", so they may wait for one that never comes. One clause in `incidents.form.anonymousWarning` would cover it:
   - en: "It will not appear under “Reported by me”, and you will not be notified of replies: come back with the code to read them."
   - ar: «ولن يظهر البلاغ ضمن «بلاغاتي»، ولن تصلك إشعارات بالردود عليه: عُد برمز المتابعة لقراءتها.»
   - fr: «Elle n'apparaîtra pas dans « Déclarés par moi », et vous ne serez pas averti des réponses : revenez avec le code pour les lire.»
3. **Arabic notifications could lead with the reference.** 13 of the 18 Arabic sentences end on it. Leading with it lines the references up at the right edge for scanning, keeps the full stop away from the Latin, and is ordinary Arabic topic-then-comment order. For example:
   - «الحادث {reference}: فات الموعد النهائي لإغلاقه.»
   - «البلاغ {reference}: جديد بانتظار الفرز.»
   - «الحادث {reference}: تم تكليفك بمعالجته.»
   
   I recommend it, but the current sentences are correct. If you want it I will write all 18.
4. **French apostrophes.** `fr.json` has 197 strings with straight apostrophes and none typographic; `Intl` gives « l’Arabie ». I would move the dictionary to U+2019 in the same `frs()` pass: it is the French norm and matches the care already taken with spaces. The cost is that any test matching French text with a straight apostrophe must follow.
5. **The zone name on the public form.** A visitor now reads three sentences of help under "When it happened", the last ending «توقيت وسط أوروبا الرسمي (غرينتش+1)» (`ar-390-public-form.png`). A visitor assumes their own phone's clock anyway. I would drop `{zone}` from `publicReport.deviceTime`, or the sentence altogether, and keep the zone for staff, where the hospital's clock can differ from the laptop's. If you keep the sentence without the zone:
   - en: "Use the time your phone or computer shows."
   - ar: «استخدم الوقت الظاهر على هاتفك أو حاسوبك.»
   - fr: «Utilisez l'heure affichée sur votre téléphone ou votre ordinateur.»
6. **Incidents already overdue when deadlines arrived.** `deadlines.what` says the people responsible "are notified". For those incidents nobody was. I would leave the sentence and say it once in the release note to hospitals, not in the interface.
7. **`followUp.ended` when the hospital takes no reports without sign-in.** The sentence then ends on "send a new report" with no link (`en-390-follow-up-ended-no-link.png`). That is fine for staff. A visitor whose hospital has since switched public reporting off has no way to do it; "or speak to a member of staff" at the end would cover that rare case.

**Screens opened and screens only read**
- **Opened, 45 of 110** in `shots-deadlines`, most as crops at full size. Nothing reopened from `shots-lang3`: the public form and sent screens after review 3 are in the newer set.
  - **Arabic, 24 of 37:**
    - at 390: notifications, notifications-unavailable, list-deadlines (first 3000 px), list-filters, detail-closeLate, detail-dueSoonish, settings-deadlines, settings-read-only, dashboard, both portal shots, follow-up-view, follow-up-commented, follow-up-staff-reply, public-form, public-form-too-many, public-sent, report-form;
    - at 1280: notifications, notifications-unavailable, list-deadlines (top), detail-closeLate, settings-deadlines, dashboard.
  - **French, 14 of 18:** all but follow-up-commented, follow-up-entry, follow-up-staff-reply and list-overdue.
  - **English, 7 of 55:** the four follow-up ended and comment-limit shots, `en-1280-notifications-unavailable`, `en-1280-portal-time-zone-chosen`, `en-1280-sign-off-revision-help`.
- **Not opened:**
  - Arabic at 1280: detail-dueSoonish, the four follow-up shots, list-filters, list-overdue, public-form, public-sent, report-form, settings-read-only.
  - Arabic at 390: follow-up-entry, list-overdue.
  - English: the other 48.
- **No screenshot exists, dictionary and code only (Arabic and French):**
  - The follow-up page of a closed report, which you asked for: the Arabic and French follow-up shots are of an open report.
  - The comment-limit message and the form-load limit with a weekday.
  - `revisionHelp`.
  - A notification row marked unavailable with its button: the two shots named "unavailable" show none on their first page.
  - Notification kinds other than new report, comment, assigned, overdue and sign-off requested.
  - The French portal, and any French screen at 1280.

**Files**
- `/home/user/Trustline/apps/web/src/i18n/dictionaries/en.json`, `ar.json`, `fr.json`
- `/home/user/Trustline/apps/web/src/components/notifications/notifications-view.tsx` (reference in the sentence, lines 174-198)
- `/home/user/Trustline/apps/web/src/components/shell/app-shell.tsx` (badge, lines 234-237)
- `/home/user/Trustline/apps/web/src/components/platform/time-zone-field.tsx` (search on English names, lines 76-81; "now" line, 199-211)
- `/home/user/Trustline/apps/web/src/lib/time-zone.ts` (zone label with its bracket, lines 56-62)
- `/home/user/Trustline/apps/web/src/components/platform/client-form.tsx` (activity line, 398-403)
- `/home/user/Trustline/apps/web/src/components/platform/portal-frame.tsx` (header, line 66)
- `/home/user/Trustline/apps/web/src/components/public/follow-up.tsx` (ended message and link, 205-216, 313-338)
- `/home/user/Trustline/apps/web/src/components/incidents/deadlines.tsx` and `/home/user/Trustline/apps/web/src/lib/format.ts` (`deadlineFormat`, lines 74-91): read, nothing to change
- `/home/user/Trustline/apps/api/src/incidents/incidents.service.ts` (closure deadline worked out again at triage, lines 1316-1327)
- Scratch files, outside the repository: `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour4/n.html`, `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour4/n.png`, and the `Intl` and parity scripts `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour4/rel.mjs` and `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour4/parity.mjs`