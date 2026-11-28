# Language review 7: import, roles, language that applies, emails

## Decisions
- Accept every must-fix (M1 to M10) and every table row as proposed.
- M6: build the email preferences screen now (web, at /notifications/preferences); the email footer link and the unsubscribe page's "turn back on" point there. Keep turnBackOn wording.
- Arabic "authoritative language": switch to «اللغة المرجعية» with «يُعتدّ بنصها», everywhere (web, print, API export wording if any).
- French email: « e-mail », not « courriel » (E14).
- E16: format the digest day per locale and time zone. E17: remove unused keys.
- Web items go to the web engineer; API email wording, render.ts, pages.ts, footer link go to the API engineer.

## Bilingual review 7: import screens, Approving authority, the language that applies, emails (en / ar / fr)

I reviewed HEAD 658a486 against 684fa5b. I changed no repository file and started no app server. My only renders were small headless-Chrome bidi tests. Scratch files (key diff, typography script, crops, bidi tests) are in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour7/`. French proposals use ordinary spaces, so run them through `frs()` as before.

### What is already right
- **Key parity:** each file has 1,802 keys, none missing or empty. 252 keys are new or changed, none removed.
- **Placeholders:** the same in all three languages.
- **Dictionary French typography:** clean, with one exception (row F9).
- **No language branching, no physical classes, no wording in the markup** in any changed component.
- **Settled terms are in place:** «صاحب صلاحية الاعتماد» / « Autorité d’approbation » (`permissions.ts:146`, migration 0045). The CSV heading is «معتمدة قبل Trustline» (`export-wording.ts:70`). «المنشأة» / « établissement » are used throughout.
- **Bidi that renders correctly:** document numbers, slash dates, the `section.<key>.<language>` code (I measured it: key first), the start-side red bar on rows, and text areas taking their own direction.
- **Two different language concepts, correctly kept apart:**
  - The title and "where the original is kept" follow the **main language** (`fitsLanguages`).
  - Sections and the change summary follow the **language that applies** (`imports.service.ts:556`).

---

## Must fix

| # | Where | Lang | Problem | Proposed |
|---|---|---|---|---|
| M1 | `policies.importing.layout.rules[3]` (screen `ar-1280-import-layout.png`) | ar | **The example date shows reversed as "01-03-2024".** After Arabic letters, digits joined by "-" fall into right-to-left runs. I confirmed this on the screenshot crop and in Chrome. Anyone copying what they see writes the wrong format. | Isolate the date in ar.json: `مثل ⁦2024-03-01⁩.` Or render the rule with `<bdi dir="ltr">`. |
| M2 | Every import "check" string: `importing.check`, `checkAgain`, `checkFailed`, `checkedOk`, `checking`, `toCorrectTitle`, `changedSinceCheck`, `batchDescription`, `errors.batch_refused`, `errors.invalid_document`, `layout.columnHelp.owner`; also `settings.authoritativeWillChange` ("vérifiés par rapport à") | fr | **« vérification » now means two things.** Decision 1 of review 6 made it the review step. Here it also names the pre-signing check, on screens that also say « soumis à vérification » (`fr-390-batch-reloaded.png`). | Use « contrôle / contrôler » for the check: « Contrôler avant de signer », « Contrôler de nouveau », « Non contrôlé », « Contrôlé : il peut être importé. », « Contrôle en cours… », « À corriger avant contrôle : {count} », « …depuis le contrôle : rien n’a été importé. Le lot est contrôlé de nouveau. », « …puis vous signez » → « Chaque document est d’abord contrôlé, sans votre mot de passe… », « Corrigez-les et relancez le contrôle. », « Contrôlez-le et réessayez. », « …lors du contrôle du fichier. », « Les brouillons sont ensuite contrôlés par rapport à {to}… » |
| M3 | API `email/wording/ar.ts` | ar | **The emails use different words from the app:** «حادثة» (the app has 0 uses; it says «حادث»); «جسيمة» for serious (the app says «خطير»); «حدثًا جسيمًا منذرًا» (the app's sentinel term is «حدث جسيم»). The email's "serious" and the app's "sentinel" now share one word. «أُسندت/مسندة» (the app says «كُلِّف/المكلَّف»). «الإقرار بها» (the app says «الإقرار بالاطلاع»). | See the email table (rows E1–E10). |
| M4 | API `email/wording/fr.ts` | fr | « attend votre revue », « Documents à revoir ou approuver », « Revues périodiques » contradict « vérification » and « Révision périodique ». « Documents à prendre en compte » means "to take into account", not acknowledgement. « courriel » is used while the app says « e-mail ». | See the email table. |
| M5 | `fr.ts` lines 12, 16, 28, 43–44, 48, 50–54, 60, 67–68 | fr | Ordinary space (U+0020) before « : » and « ? ». | U+00A0 before `:`, U+202F before `?`, as in the dictionaries. |
| M6 | `email/wording/*` `footer.preferences`, `page.turnBackOn`; `email-worker.service.ts:633` | all | **The emails promise a screen that does not exist.** The footer link "Change your email preferences" opens `/notifications`. No web screen calls `/me/notification-preferences` (no match in `apps/web/src`). The unsubscribe page says "You can turn them back on in Trustline, in your notification preferences." That is not true today. | Build the preferences screen before release. Otherwise, drop the preferences link and `turnBackOn`, and say instead: "To receive them again, ask your administrator." / «لإعادة تلقيها، تواصل مع مسؤول النظام.» / « Pour les recevoir de nouveau, adressez-vous à votre administrateur. » |
| M7 | `policies.errors.no_assignee_person` (screen `ar-390-no-assignee.png` family) | ar | **Masculine forms are used for a named person who may be a woman:** «{name}، وهو لا يستطيع… حسابه… أدواره… أنه شارك». This is the same fault as review 6 row 1. | «لم يُرسل الإصدار للمراجعة بعد: الخطوة {position} من مسار اعتماده ({kind}) محدَّدة باسم {name}، ويتعذّر اتخاذ القرار فيها بهذا الحساب لأحد الأسباب التالية: الحساب غير نشط، أو لا يوجد بين أدواره ما يسمح بذلك، أو أُعدّ هذا الإصدار به. اطلب ممن يدير إعدادات الوثائق تعديل المسار، ثم أرسل الإصدار مرة أخرى.» (every pronoun now refers to «الحساب») |
| M8 | `settings.tsx:356`, `policies.settings.authoritativeMain` (screens `ar-390-settings-language-change.png`, `fr-390-settings-language-saved.png`) | ar, fr | **A language's own name inside a sentence:** «اللغة الرئيسية (English)» and « La langue principale (English) », while the help line under it says «العربية» / « anglais ». | Fill `{language}` with `named()` (`languageNameIn(lang)`), as the help line does. Keep own names only on the plain options. |
| M9 | `roles-list.tsx` (screens `fr-390-roles.png`, `ar-390-roles.png`) | fr, ar | **The roles table at 390 px.** In French the users column is cut off ("Utilisateur…", "Personne ne…") because of `whitespace-nowrap` on `nobodyYet`. The new warning is squeezed into a column about 100 px wide: 13 lines in Arabic, 18 in French. | Drop `whitespace-nowrap` and shorten `nobodyYet` (F12). Render the warning in its own full-width row (`<tr><td colSpan={3}>`) under the role. |
| M10 | `policies.importing.saveCorrection` | ar | «اعتماد التصحيح» uses the module's word for approval («اعتماد») for a plain Save button. | «حفظ التصحيح» |

---

## Web: Arabic

| Key / file:line | Problem | Proposed |
|---|---|---|
| `importing.batchDescription`, `chooseFileHelp`, `signBatchHelp` | Without vowel marks, «ثم توقّع» and «قبل أن توقّع» read first as "expect". This is review 6 row 2 again. | «…فتصحّح ما يُرفض، ثم تُوقِّع.» / «لا يُستورد شيء قبل توقيعك.» / «…وتُوقَّع كل دفعة أخرى على حدة.» |
| `importing.batchDescription` | «كما تبيّن صفحة طريقة إعداد الملف» is clumsy, and «لـ20 وثيقة» joins a prefix to a digit. | «من ملف CSV أو JSON مُعدّ وفق «طريقة إعداد الملف». … تتسع الدفعة الواحدة لما لا يزيد على {documents} وثيقة و{characters} حرف من النص…» (same change in `layout.limits`) |
| `admin.roles.nobodyApproves` | «يسمّي أحد مسارات الاعتماد هذا الدور» is a calque of "names". «لا أحد يحمله» is unnatural. | «هذا الدور محدَّد في أحد مسارات الاعتماد ولم يُمنح لأحد بعد، فلا يمكن إرسال الوثائق التي تمر بهذا المسار للمراجعة حتى يُمنح لشخص واحد على الأقل.» |
| `admin.roles.nobodyYet` | Same calque. | «لم يُمنح لأحد بعد» |
| `admin.roles.giveToSomeone` | Repeats «المستخدمين». | «امنحه لأحد المستخدمين من تبويب «المستخدمون».» |
| `errors.no_assignee_role` | The role name is not quoted («منح الدور صاحب صلاحية الاعتماد»). «سوى من أعدّوا» says the preparers hold the role, which is false when nobody holds it (the screenshot shows 0 holders). | «…من مسار اعتماده ({kind}، يتولاها دور «{role}»). فلا أحد يحمل هذا الدور للجهة المسؤولة عن هذه الوثيقة، أو لا يحمله إلا من أعدّ هذا الإصدار. اطلب ممن يدير المستخدمين منح دور «{role}» للشخص الذي يتخذ القرار في هذه الخطوة، ثم أرسل الإصدار مرة أخرى.» |
| `importing.signOne` | The gender drifts: «بيانات اعتماده» (masculine), then «تُنشر… بوصفها» with no feminine subject named. | «بالتوقيع بكلمة المرور، تؤكد أن النص المُدخل هنا مطابق لنص الأصل المعتمد، وأن بيانات اعتمادها مطابقة لما في الأصل. وتُنشر الوثيقة فور التوقيع بوصفها معتمدة قبل Trustline.» |
| `imported.importedBy` | «…يشهد بأن هذا النص هو نص الأصل» is stilted. | «الاستيراد إلى Trustline: {name}، {date}، بتوقيع يشهد بأن هذا النص مطابق للأصل.» |
| `reissue.at` (screen `ar-390-reader-imported.png`) | «مراجعتها القادمة، في …، إعادة إصدار» has no predicate. | «ستكون مراجعتها القادمة، في {date}، إعادة إصدار.» |
| `reissue.help`, `errors.reissue_required` | «بالنسبة لها» is a calque. «لا تأكيد لعدم الحاجة إلى تغيير» is heavy. | «…ولا يكفي فيها تأكيد أنها لا تحتاج إلى تغيير.» (in both keys) |
| `reissue.editorHelp`, `reissue.actionHelp` | «من خطوات هذه المراجعة»: the restriction applies to the re-issue. | «…اتخاذ القرار في أي خطوة من خطوات إعادة الإصدار هذه.» |
| `importing.putBack` / `leaveOut` | «إعادتها» clashes with «إعادة» (send back, re-issue). The two buttons beside it read «تصحيح» / «استبعادها», which do not match each other. | «إلغاء الاستبعاد» / «استبعاد» |
| `importing.local.missing` | «{field}: غير موجود» is masculine before feminine fields («الفئة»). | «{field}: الحقل فارغ.» |
| `errors.approved_after_start_by`, `importing.latestApproval` | «في {date} أو قبله» | «في {date} أو قبل ذلك» |
| `imported.approvedBy`, `importing.approvedBy`, `columns.approvedBy`, `layout.columnHelp.approvedBy` | «جهة الاعتماد» means a body, but the value is a person's name or a position. It also blurs with «صاحب صلاحية الاعتماد». | «مَن اعتمدها (كما ورد في الأصل)» / column: «مَن اعتمدها» |
| `settings.authoritativeWillChange` | «يُتحقق من المسودات مقابل {to}» is a calque. | «…ومن ذلك الحين لا تُرسل المسودات للمراجعة إلا بعد أن تُكتب أقسامها المطلوبة وملخص تغييراتها باللغة {to}.» |
| `columns.acknowledgeDays`, `layout.columnHelp.reviewMonths`, `importing.reviewMonthsHelp` | «أيام الإقرار بالاطلاع» and «عدد أشهر المراجعة» are vague. | «مهلة الإقرار بالاطلاع بالأيام» / «دورة المراجعة بالأشهر بعد إعادة إصدارها. إن تُرك فارغًا: دورة المراجعة الخاصة بنوعها.» |
| `layout.columnHelp.keywords`, `appliesTo`, `roles`, `references`, `rules[4]`, `importing.listHelp`, `appliesToHelp`, `rolesHelp` | «مفصولة بـ|»: the bar attached to the tatweel is easy to miss. | «مفصولة بالخط العمودي |» |
| `imported.revisionLabel`, `importing.revisionLabel`, `columns.revision` | Optional. «رقم المراجعة» sits beside «المراجعة القادمة», which is a different kind of review. | «رقم التنقيح في الأصل» |
| **Decision: `settings.authoritative` and family** | «اللغة المعتمدة» is the usual legal phrase. But on the control block and the print it sits among «تاريخ الاعتماد», «معتمدة قبل Trustline» and «جهة الاعتماد», where it can read as "the approved language". | Keep it, or switch to «اللغة المرجعية» with «يُعتدّ بنصها». The print footer already says «لا يُعتدّ بها». I lean towards switching. |

## Web: French

| # | Key | Problem | Proposed |
|---|---|---|---|
| F1 | `errors.no_assignee_role` | The role is not quoted («par le rôle Autorité d’approbation») and has the same logic slip as the Arabic. | « …({kind}, par le rôle « {role} »). Personne n’a ce rôle pour l’entité responsable de ce document, ou seule une personne qui a préparé cette version l’a. Demandez… de donner le rôle « {role} » à la personne qui décide de cette étape… » |
| F2 | `admin.roles.nobodyApproves` | « personne ne l’a encore… tant que personne ne l’a » is colloquial. | « Un circuit d’approbation désigne ce rôle, mais il n’est encore attribué à personne : les documents qui suivent ce circuit ne peuvent pas être soumis à vérification tant qu’il ne l’est pas. » |
| F3 | `admin.roles.giveToSomeone` | A bare infinitive used as a sentence. | « Attribuez-le à quelqu’un dans l’onglet « Utilisateurs ». » |
| F4 | `permissions.ts` description of `approving_authority` | « y compris restreints et brouillons » has no nouns. | « …et lit tous les documents, y compris les documents restreints et les brouillons. » |
| F5 | `settings.authoritativeChanged` | « est désormais : anglais » | « Langue qui fait foi désormais : {language}. » |
| F6 | `reissue.editorHelp` | « de cette vérification »: it is the whole re-issue. | « …ne peut décider d’aucune étape de cette réédition. » |
| F7 | `reissue.helpReader` | Wrong tense. | « …le rééditeront par le circuit d’approbation. » |
| F8 | `reissue.at` | No final period (the same in en). | « Sa prochaine révision, le {date}, sera une réédition. » |
| F9 | `errors.batch_too_large` | « 600 000 » uses U+0020, so the number can break across lines. The limits are also hard-coded in all three languages. | Use `{documents}` / `{characters}` filled with `numberFormat`, as `layout.limits` does. That also gives U+202F. |
| F10 | `importing.putBack` | | « Réintégrer » |
| F11 | `importing.saveCorrection` | | « Enregistrer la correction » |
| F12 | `admin.roles.nobodyYet` | | « Attribué à personne » |

## Web: English

| Key | Problem | Proposed |
|---|---|---|
| `imported.notWrittenLabel`, `reissue.editorHelp` | "Sections the original came without" | "Sections missing from the original" / "Write the sections missing from the original, …" |
| `reissue.editorHelp`, `actionHelp` | "a step of this review" | "a step of this re-issue" |
| `reissue.help` | "Confirming that nothing changed is not possible for it." | "It cannot simply be confirmed as unchanged." |
| `reissue.at` | No period. | "Its next review, on {date}, will be a re-issue." |
| `errors.no_assignee_role` | Role not quoted; "apart from those who prepared" (see F1). | "…({kind}, by the role “{role}”). Nobody holds this role for this document's responsible area, or only someone who prepared this version does. Ask whoever manages users to give the role “{role}” to…" |
| `importing.correct` | "Correct" reads as an adjective. | "Correct it" |
| `imported.importedBy` | "with a signature that this text is the original's" | "Imported into Trustline by {name} on {date}, who signed that this text matches the original." |

---

## API emails (`apps/api/src/email/wording/*.ts`, `render.ts`, `pages.ts`)

| # | Key | Lang | Problem | Proposed |
|---|---|---|---|---|
| E1 | `immediate.incident_reported` | ar | «حادثة», «جسيمة»; «في نطاق يحق لك فرزه» means "a scope you may triage". | subject «بلاغ عن حادث خطير: {reference}»; body «ورد بلاغ عن حادث خطير، {reference}، ضمن نطاق تتولى فرز بلاغاته.» |
| E2 | `incident_handed_over` | ar | Same words. | «أُحيل حادث خطير إلى قسمك: {reference}» / «أُحيل حادث خطير، {reference}، إلى قسم يقع ضمن نطاق مسؤوليتك.» |
| E3 | `sentinel_flagged` | ar | «حدثًا جسيمًا منذرًا» is not the app's term. | «أصبح الحادث {reference} حدثًا جسيمًا» / «حُدِّد الحادث {reference} على أنه حدث جسيم، وسيتطلب إغلاقه اعتماد شخص ثانٍ.» |
| E4 | `incident_assigned`, `daily.incidents` | ar | «أُسندت/مسندة» | «كُلِّفتَ بمعالجة الحادث {reference}» / «تم تكليفك بمعالجة الحادث {reference}.» / «حوادث أنت المكلَّف بها: {count}» |
| E5 | `sign_off_requested` | ar | «توقيعًا ثانيًا» is not the app's «اعتماد الإغلاق». | «طلب اعتماد إغلاق: الحادث {reference}» / «إغلاق الحادث {reference} بانتظار اعتماد من شخص ثانٍ، ويمكنك أنت اعتماده.» |
| E6 | `weekly.*`, `daily.acknowledge` | ar | «الإقرار بها» drops «بالاطلاع». | «إقرارات بالاطلاع متأخرة هذا الأسبوع» / «لم يُقرّ بعض أفراد فرقك بالاطلاع على وثائق مطلوبة منهم في موعدها.» / «إقرارات بالاطلاع متأخرة: {overdue}» / «وثائق مطلوب منك الإقرار بالاطلاع عليها: {count}» |
| E7 | `overdue` | ar | «متأخر» is masculine but follows document numbers too (`digest.service.ts:52,71,89`). | «(تجاوز الموعد)» |
| E8 | `footer.member` | ar | «عضوًا» is masculine. | «تصلك هذه الرسالة لأنك من مستخدمي Trustline في {organization}.» |
| E9 | `open`, `daily.open`, `page.button`, `footer.unsubscribe*` | ar | Imperatives on buttons; the app uses verbal nouns. | «الفتح في Trustline» / «فتح Trustline» / «إيقاف هذه الرسائل» / «إيقاف هذه الرسائل الفورية» / «إيقاف رسائل الملخص هذه» |
| E10 | `page.title`, `page.invalid` | ar | «رسائل» alone can mean any message (text messages included). | «رسائل البريد الإلكتروني من Trustline» / «هذا الرابط غير صالح أو انتهت صلاحيته.» |
| E11 | `document_step_review`, `daily.approve`, `daily.reviews` | fr | revue / revoir | « Le document {number} attend votre vérification » / « …version {version}, attend votre vérification. » / « Documents à vérifier ou à approuver : {count} » / « Révisions périodiques à faire : {count} » |
| E12 | `weekly.*`, `daily.acknowledge` | fr | « à prendre en compte » | « Des personnes de vos équipes n’ont pas confirmé à temps leur prise de connaissance de certains documents. » / « Documents dont vous devez confirmer la prise de connaissance : {count} » |
| E13 | `incident_reported` | fr | « un périmètre que vous pouvez trier »: you sort incidents, not a scope. The app says « déclaration ». | « Incident grave déclaré : {reference} » / « Un incident grave, {reference}, a été déclaré dans un périmètre dont vous assurez le tri. » |
| E14 | all `courriel` | fr | The app says « e-mail ». | Pick one. I recommend « e-mail », to match the sign-in screens. |
| E15 | `incident_reported`, `sentinel_flagged`, `sign_off_requested`, `weekly.body`, `footer.noDetails` | en | Stilted. | "…has been reported in an area you triage." / "Incident {reference} has been marked as a sentinel event." / "Incident {reference} is waiting for a second person to sign off its closure. You can sign it off." / "Some people in your teams have not acknowledged documents by their due date." / "Emails from Trustline carry no details of the incident or document: sign in to see them." |
| E16 | `render.ts:144` with `email-worker.service.ts:338` | all | The digest subject inserts the raw ISO day (2026-11-28). The app shows 2026/11/28 in Arabic and « 28 nov. 2026 » in French. A client that ignores U+2066/U+2069 also reverses the hyphenated date in Arabic (see M1). | Format `{day}` with `Intl.DateTimeFormat(locale, {dateStyle: "medium", timeZone})`. |
| E17 | `serious`, `version` | all | Defined but never used by `render.ts`. | Remove them, or use them. |

**What I found correct in the emails:**
- `<html dir="rtl">` is set on emails and pages.
- References are isolated with LRI/PDI in text and subjects, and with `<bdi dir="ltr">` in HTML lists.
- The confirm page has one POST button (RFC 8058), and a plain visit changes nothing.
- No names or titles reach an email.

---

## Layout and mixed direction (screenshots)

| Screenshot | Fault | Fix |
|---|---|---|
| `ar-1280-import-layout.png`, rules | Date reversed. | M1 |
| `fr-390-roles.png`, `ar-390-roles.png` | Cut column; squeezed warning. | M9 |
| `ar-1280-batch-reloaded.png`; `import-batch.tsx:364` | `{file}` is not isolated. My test with an Arabic file name («سياسات-2024.csv: 25.») scrambles the order. | Render it with `Words` and `<bdi dir="auto">` around the file name. |
| `import-layout.tsx:165` and `:221`; `import-batch.tsx:260` and `:321` | Lists joined with Latin ", " inside Arabic text. | `new Intl.ListFormat(lang, {type: "unit"})` for column names and section keys; codes inside `<bdi dir="ltr">`. |
| `ar-390-awaiting.png`, OLD-007 | The "overdue" pill sits over «إعادة الإصدار في موعد أقصاه 2026/11/23». The code at `awaiting.tsx:191` shows `wasDue` when overdue, so the shot probably predates the commit. | Retake the shot and confirm. |
| `ar-1280-import-window-closed.png` | "Choose a file" still looks enabled under the closed-window warning. | Low. Disable or hide it. |
| `ar-390-notifications-reissue.png` | The title is in English, while the same document shows an Arabic title elsewhere. Unverified: it may be a different tenant. | Check `pick()` on the notification title. |

---

## Screens opened, and screens only read
- **Opened:**
  - Arabic: `ar-1280-import-form-top`, `ar-390-import-form-top`, `ar-1280-import-layout` (with crops), `ar-390-import-layout`, `ar-1280-batch-reloaded`, `ar-390-batch-reloaded`, `ar-1280-import-window-closed`, `ar-390-import-window`, `ar-1280-imported-version`, `ar-1280-reader-imported`, `ar-390-reader-imported`, `ar-1280-roles`, `ar-390-roles`, `ar-390-no-assignee`, `ar-390-notifications-reissue`, `ar-390-settings-language-change`, `ar-390-awaiting`, `ar-390-library`, and page 1 of `ar-print-imported.pdf`.
  - French: `fr-390-roles`, `fr-390-batch-reloaded`, `fr-390-reader-imported`, `fr-390-no-assignee`, `fr-390-import-form-top`, `fr-390-settings-language-saved`, `fr-390-notifications-reissue`.
- **Not opened:** all `en-*` shots, `ar-1280-awaiting`, `ar-1280-library`, `ar-390-imported-version`, `fr-390-import-layout`, `fr-390-import-window`, `fr-390-imported-version`, `fr-390-library`, `fr-390-awaiting`, `fr-390-settings-language-change`, and the en/fr print PDFs.
- **Read only (no screenshot in Arabic or French):**
  - the batch sign prompt, the correction editor, duplicate and "all done" states;
  - every email and the unsubscribe pages (no rendered email exists).

## Files
- `/home/user/Trustline/apps/web/src/i18n/dictionaries/en.json`, `/home/user/Trustline/apps/web/src/i18n/dictionaries/ar.json`, `/home/user/Trustline/apps/web/src/i18n/dictionaries/fr.json`
- `/home/user/Trustline/apps/web/src/components/admin/roles-list.tsx` (warning and `nobodyYet`, lines 128–165)
- `/home/user/Trustline/apps/web/src/components/policies/settings.tsx:356`
- `/home/user/Trustline/apps/web/src/components/policies/import-batch.tsx:260, 321, 364`
- `/home/user/Trustline/apps/web/src/components/policies/import-layout.tsx:165, 221`
- `/home/user/Trustline/apps/web/src/components/policies/use-submit-refusal.ts`
- `/home/user/Trustline/apps/api/src/identity/permissions.ts:146`
- `/home/user/Trustline/apps/api/src/email/wording/en.ts`, `/home/user/Trustline/apps/api/src/email/wording/ar.ts`, `/home/user/Trustline/apps/api/src/email/wording/fr.ts`
- `/home/user/Trustline/apps/api/src/email/render.ts`, `/home/user/Trustline/apps/api/src/email/pages.ts`, `/home/user/Trustline/apps/api/src/email/email-worker.service.ts:338, 633`