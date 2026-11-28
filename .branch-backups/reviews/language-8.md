# Language review 8: quality-3 wording (658a486..a48e929)

## Decisions
- Accept every item (M1 to M9, all tables, W1 to W8, A1 to A8) as proposed.
- M4/M5: the wording is corrected to what the system does (the morning summary lists only incidents assigned to the person); no change to the digest.
- M6: build a list of overdue approval steps: API route GET /policies/steps/overdue (same data and scope as library.overdueSteps, numbers and steps only) and a web screen; the in-app weekly notice and the weekly email link to it; A3 both-kinds subject.
- Web items to the web engineer (also show reviewOpensOn in advance); API email wording, CSV headings, render.ts and the overdue-steps route to the API engineer.

I've finished bilingual review 8 of 658a486..a48e929, concentrating on everything from 51b98da on. I changed no repository file and started no server. My scratch files (key diffs, crops, one scan script) are in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour8/`. French proposals below use ordinary spaces, so run them through `frs()` as before.

**Overall:** language review 7 is in, except three email items. The new screens follow the rules. The serious problems are wording that is now untrue: the D1 review count, the "relied on" warnings, and the steps-only weekly summary.

## What is already right
- **Key parity:** each file has 1,952 keys, none missing or empty, and the placeholders match. 123 keys are new or changed since 51b98da; one was removed (`notifications.kinds.acknowledgements_overdue_digest`, now split into variants).
- **French typography** is clean in all three dictionaries and in `email/wording/fr.ts`. D5 landed: `w.colon` puts U+00A0 before « : ».
- **Language review 7 landed in the web app:** M1 (the date is now isolated: ⁦2024-03-01⁩, and it reads correctly on screen), M2 « contrôle », M7, M8, M10, the roles rows, «اللغة المرجعية» everywhere (web and print), and « e-mail » everywhere. There is no «اللغة المعتمدة», «حادثة», « courriel » or «جهة الاعتماد» left in the web app or the API.
- **Language review 7 landed in the emails:** E1–E9, E11–E15 and E17. For E16, the digest day is formatted per language and wrapped in FSI/PDI in Arabic, so it reads 2026/11/28, as the app does.
- **Changed components are clean:** no branching on a language, no left/right classes, and no wording in the markup (one exception: row W7). The opt-out bar uses `border-s-4`; the switch knob mirrors correctly.
- **D1–D8 are all fixed.** D7: the French PDF now prints « Ce document n’est pas rédigé en français. Il est affiché en anglais. »
- **The print header** "Version 1 (Rev. 4 on the original)" isolates each part and reads correctly in the Arabic PDF.
- **Fingerprints and numbers** are `dir="ltr"`. The email address on the preferences screen keeps its period on the correct side in Arabic.

---

## Must fix

| # | Key / file:line | Lang | Problem | Proposed |
|---|---|---|---|---|
| M1 | `policies.review.changedCount`, used by `version-page.tsx` `Comparison` (D1 fix) | all | The count now includes sections changed in the language that applies. `en-1280-d1-review.png` says "2 of 9 sections changed **in this language**", but both changed in Arabic. The reviewer is about to sign. | Add a key used when any section is shown in another language. en "{count} of {total} sections changed, in this language or, where it has no text, in {other}." ar «الأقسام التي تغيّرت: {count} من {total}، بهذه اللغة أو باللغة {other} حيث لا يوجد نص بهذه اللغة.» fr « Sections modifiées : {count} sur {total}, dans cette langue ou, là où elle n’a pas de texte, en {other}. » |
| M2 | `policies.review.changedIn` | fr | « Modifié en {language} » is masculine. Its sibling pills are feminine (they agree with « section »): « Modifiée », « Inchangée », « Non mise à jour ». | « Modifiée en {language} ». Optional in Arabic, to match the sibling «تغيّر»: «تغيّر باللغة {language}» |
| M3 | `version-page.tsx` ~590–630 (`<div lang={shownIn} dir={direction(shownIn)}>`) and the `<ol dir={direction(locale)}>` | all | Interface text sits inside a container set to the content's direction. The English "Show the text ◄" is right-aligned in `en-1280-d1-review.png` (new with D1). French shows « .Pas de texte dans cette langue », with the period on the wrong side, in `fr-390-d1-review.png`. | Give the `emptyHere` paragraph and the `<summary>` `lang={lang} dir={direction(lang)}`. Keep only the diff lines and `<Markup>` in the content's direction. |
| M4 | `notifications.preferences.reliedOnTriages`, `admin.settings.optOuts.reliedHelp` | all | **Untrue.** "…reaches you only in Trustline **and in the morning summary**." `digest.service.ts:127` lists only incidents *assigned* to the person, so a newly reported serious incident never reaches a triager's summary. | en "You triage incidents: without immediate emails, a serious incident reported in your area reaches you only in Trustline. The morning summary lists only incidents assigned to you." ar «أنت تتولى فرز الحوادث: من دون الرسائل الفورية، لا يصلك البلاغ عن حادث خطير في نطاقك إلا في Trustline، إذ لا يذكر الملخص الصباحي إلا الحوادث المكلَّف بها.» fr « Vous triez les incidents : sans e-mails immédiats, un incident grave déclaré dans votre périmètre ne vous parvient que dans Trustline ; le récapitulatif du matin ne liste que les incidents qui vous sont attribués. » In `reliedHelp`, split the approver and triager cases the same way. |
| M5 | `preferences.tsx:228` and `settings-view.tsx` (`relied && !person.immediate`) | all | **Untrue when both switches are off.** With the morning summary also off, the warning still says "…and in the morning summary". | Add `reliedOnApprovesNoDigest` / `reliedHelpNoDigest`. en "…a step waiting for your decision reaches you only in Trustline, and the steps after it wait." ar «…لا تصلك الخطوة التي تنتظر قرارك إلا في Trustline، وتنتظر الخطوات التالية لها.» fr « …ne vous parvient que dans Trustline, et les étapes suivantes attendent. » |
| M6 | `notifications.kinds.acknowledgements_overdue_digest.steps`; `notifications-view.tsx:216`; `email-worker.service.ts:812` | all | The steps-only weekly summary links in-app to **Late acknowledgements**, which is empty in that case, and by email to **/dashboard**. Neither shows overdue steps, so the notice leads nowhere. | Link both to a list of the overdue steps (the data is `library.overdueSteps`). Until one exists, say where to look. en "…Approval steps overdue: {stepsOverdue}. Open each document from the morning summary email." Better to build the list. |
| M7 | `email/wording/*.ts` `page.turnBackOn` | all | It names "notification preferences", but the screen the footer opens is now **Email preferences** / «تفضيلات البريد الإلكتروني» / « Préférences d’e-mail ». | en "You can turn them back on in Trustline, in your email preferences." ar «يمكنك إعادة تفعيلها في Trustline، من تفضيلات بريدك الإلكتروني.» fr « Vous pouvez les réactiver dans Trustline, dans vos préférences d’e-mail. » |
| M8 | `email/wording/ar.ts:76` `page.invalid` | ar | It lost its "what to do" sentence; en and fr keep it. That is my fault: E10 gave only the first sentence. | «هذا الرابط غير صالح أو انتهت صلاحيته. يمكنك تغيير تفضيلات بريدك الإلكتروني في Trustline.» |
| M9 | `policies.errors.invalid_number` against `number_script` (and `numberHelp`, `layout.rules[6]`, `number_mixed_scripts`) | all | **Two sets of allowed characters.** One says "spaces, -, ., / or _"; the other says "- . / _ ( )", with no spaces. `input.ts:371` allows both spaces and brackets. In Arabic the bare list renders as «و( ) _ / . -.», where the last "." reads as a full stop. | One wording everywhere. en "…letters (Latin, or those of your organization's languages) and digits, with spaces, hyphens, full stops, slashes, underscores or brackets between them, at most 40 characters." ar «…بحروف لاتينية أو بحروف لغات منشأتك، وبالأرقام، ويمكن أن تفصل بينها مسافات أو شرطات (-) أو نقاط (.) أو شرطات مائلة (/) أو شرطات سفلية (_) أو أقواس، على ألا يتجاوز 40 حرفًا.» fr « …en lettres (latines, ou celles des langues de votre établissement) et en chiffres, séparés au besoin par des espaces, tirets, points, barres obliques, tirets bas ou parenthèses : 40 caractères au plus. » |

---

## Web: Arabic

| Key / file:line | Problem | Proposed |
|---|---|---|
| `notifications.kinds.email_turned_off.*` | «أوقف رابطٌ في إحدى رسائلك رسائلَ…» repeats «رسائل» and makes the link the subject. The notice also never says what to do if the person did not click it (a forwarded email can do this). | «أُوقفت رسائل الملخص الصباحي عبر رابط في إحدى رسائل البريد الإلكتروني المرسلة إليك. إن لم تكن أنت من أوقفها، أو أردت تلقيها مجددًا، فأعد تفعيلها من تفضيلات بريدك الإلكتروني.» (the same pattern for `immediate` and `other`) |
| `admin.settings.optOuts.help` | «من يعتمد عليه الآخرون» uses the module's root for approval («اعتماد») to mean "rely on", beside «خطوات الاعتماد». «بالأسماء فقط» is unclear. | «تظهر هنا الأسماء فقط. ويُميَّز من يتوقف عليه عمل غيره، أي من يتخذ القرار في خطوات الاعتماد أو يتولى فرز الحوادث.» |
| `policies.list.reissueDue` | «تلزم إعادة إصدارها قريبًا أو فات موعدها»: «قريبًا» is vague. The filter means 60 days (`REISSUE_DUE_DAYS`). | «إعادة الإصدار مستحقة خلال {days} يومًا أو فات موعدها», with `{days}` filled by `numberFormat` (same change in en and fr) |
| `policies.importing.register.importedBy`; CSV `IMPORT_REGISTER_HEADINGS.ar.importedBy` | Web says «الاستيراد»; the CSV says «استوردها», a masculine verb. | Both: «مَن استوردها» (web label: «مَن استوردها ومتى»), the same pattern as «مَن اعتمدها» |
| `register.signed`, `register.batchPlace` | «بصمة المحتوى الموقَّع» / «بصمة الدفعة» differ from `review.fingerprint` and the CSVs («البصمة الرقمية…»). | «البصمة الرقمية للمحتوى الموقَّع» / «…، والبصمة الرقمية للدفعة:» |
| `policies.person.left` | «يُحتفظ بسجله» is masculine for a named person. | «خارج المنشأة: يُحتفظ بالسجل دليلًا» |
| `policies.person.state.overdue` | «متأخر» sits beside a document title; the emails now say «تجاوز الموعد» (E7). | «تجاوز الموعد» |
| `policies.imported.notInOriginal` with `controlled-document.tsx` (`ListFormat` "conjunction") | Joining with «و» blurs where names end: «التعريفات وبنود السياسة والمسؤوليات والمراجع» (screen and PDF). | Quote each name: «التعريفات»، «بنود السياسة»… using `type: "unit"`, or one «» per item (fr « … » likewise) |
| `policies.errors.review_not_due` | It does not say what to do, and the button it answers is «تأكيد عدم الحاجة إلى تغيير». | «لم يحن الوقت بعد: يمكن تأكيد عدم الحاجة إلى تغيير ابتداءً من {opensOn}، مع اقتراب موعد المراجعة في {dueOn}. ولتعديل الوثيقة الآن، ابدأ إصدارًا جديدًا.» |
| `platform.importWindow.newClosesOnHelp` | «وهو يغلق فترة الاستيراد»: the antecedent is unclear. | «…اليوم السابق لأول يوم لوحدة «السياسات والإجراءات»، واختياره يغلق فترة الاستيراد…» |
| `layout.rules[7]`, `importing.differencesHelp`, `layout.example` | «الملحق ب»: a lone «ب» reads as the preposition. | «الملحق (ب)» |
| `notifications.preferences.weekly` | Stale: the weekly summary now also counts overdue approval steps. | «…يشمل هذا الخيار أيضًا الملخص الأسبوعي للإقرارات بالاطلاع وخطوات الاعتماد المتأخرة.» |

## Web: French

| Key / file:line | Problem | Proposed |
|---|---|---|
| `acknowledgements_overdue_digest.steps` | Two colons in one sentence. | « Récapitulatif hebdomadaire des documents que vous gérez. Étapes d’approbation en retard : {stepsOverdue}. » |
| `admin.settings.optOuts.approves` | « Décide d’étapes » reads "decides some steps". | « Décide des étapes d’approbation » |
| `admin.settings.optOuts.help` | « Noms seulement. » is unclear. | « Seuls les noms figurent ici. Les personnes dont dépend le travail des autres, parce qu’elles décident des étapes d’approbation ou trient les incidents, sont signalées. » |
| `email_turned_off.*` | « …a désactivé vos e-mails de récapitulatif du matin » is heavy and gives no next step if it was not them. | « Vos récapitulatifs du matin par e-mail ont été désactivés depuis le lien d’un de vos e-mails. Si ce n’était pas vous, ou pour les recevoir de nouveau, réactivez-les dans vos préférences d’e-mail. » |
| `errors.review_not_due` | Says nothing to do. | « Pas encore : la révision peut être confirmée sans modification à partir du {opensOn}, à l’approche de son échéance du {dueOn}. Pour modifier le document dès maintenant, commencez une nouvelle version. » |
| `importing.register.signed` | It differs from the CSV heading « Empreinte de ce qui a été signé ». | Keep « Empreinte du contenu signé » (it matches `review.fingerprint`) and change the CSV headings to it. |
| `notifications.preferences.weekly` | Stale, as in Arabic. | « …le récapitulatif hebdomadaire des prises de connaissance et des étapes d’approbation en retard. » |

## Web: English

| Key | Problem | Proposed |
|---|---|---|
| `acknowledgements_overdue_digest.steps` | Two colons. | "Weekly summary for the documents you manage. Approval steps overdue: {stepsOverdue}." |
| `admin.settings.optOuts.help` | "Names only." is unclear. | "Only names are shown here. People others depend on, because they decide approval steps or triage incidents, are marked." |
| `email_turned_off.*` | No next step if it was not them. | "Your morning summary emails were turned off from the link in one of your emails. If that was not you, or to get them again, turn them back on in your email preferences." |
| `errors.review_not_due` | Says nothing to do. | "Not yet: this review can be confirmed as unchanged from {opensOn}, as its due date ({dueOn}) approaches. To change the document now, start a new version." |
| `imported.notInOriginal` | "came without" was retired in review 7. | "These sections are not in the original, so this text does not have them: {sections}." |
| `imported.importedBy` (with `controlled-document.tsx:476`) | "except as noted" is shown even when nothing is noted. | Two keys. Without differences: "…who signed that this text matches the original." With differences: "…matches the original, except as noted above." (all three languages) |
| `errors.review_date_too_far` | "{max} from {from}": the reader does not know what {from} is. | "…: {max} after {from}, the later of its approval and its last review on the original, is your organization's longest review period." |
| `platform.importWindow.closesOn` against `newClosesOn` | One date has two labels ("Imports accepted until" / "Last day of imports"), and a closed window still says "accepted until". | Use "Last day of imports" for both (ar «آخر يوم للاستيراد», fr « Dernier jour d’importation »). |
| `platform.importWindow.newClosesOnHelp` | "…the first day of Policies and procedures, which closes the window": the "which" is ambiguous. | "The earliest is {earliest}, the day before Policies and procedures started: choosing it closes the window. The latest is a year from today." |
| `importing.register.original` | "On the original" does not say what is shown. | "Number and revision on the original" / «الرقم والتنقيح في الأصل» / « Numéro et indice de révision sur l’original » |
| `notifications.preferences.weekly` | Stale. | "…the weekly summary of overdue acknowledgements and approval steps." |

## Web: code and layout

| # | Where | Problem | Fix |
|---|---|---|---|
| W1 | `import-form.tsx` `NotedDifferences`: `` `${ownName(l)}: ` `` | A hard-coded colon: French shows "Français: " with no U+00A0. This is punctuation written in a component. | Add a key such as `importing.languageText` "{language}: {text}" (fr "{language} : {text}") and render it with `Words`. |
| W2 | `library.tsx:231` `ListChecks` | Not mirrored: in Arabic the ticks sit on the left (`crops/ar-listchecks.png`). | `className="size-4 rtl:-scale-x-100"` |
| W3 | `import-register.tsx` "On the original" value | Number and revision are joined in one `<bdi dir="auto">`, so an Arabic-letter number followed by "Rev. 4" takes one direction for both. | One `<bdi dir="auto">` each, joined with " · ". |
| W4 | `client-import-window.tsx:168` | `{reason}` is put into a plain string. A Latin reason inside Arabic text, or an Arabic one inside English, is not isolated. | Use `Words` with `<bdi dir="auto">` around the reason. |
| W5 | `ar-1280-import-register.png` | A fingerprint that wraps leaves 1–2 characters alone on the next line, aligned differently in the two columns. | Make the `code` a block with `dir="ltr"` (and `text-start`). |
| W6 | `person-acknowledgements.tsx`, `ar-390-person-record.png`, `fr-390-person-record.png` | A wrapped line begins with "· الموعد النهائي…" / "· Au plus tard…". | Put the separator before the break, or lay the dates out with gaps instead of " · ". |
| W7 | `preferences.tsx` email line, `fr-390-preferences-relied-on.png` | `break-all` splits "dina@zz-mayaimp.i / nvalid" when the address would fit on the next line. | `break-words` (`overflow-wrap: anywhere`) |
| W8 | Library row against filter (`en-1280-library-reissue-due.png`) and `ar-1280-imported-document.png` | Filtered on "Re-issue due", the row says "Review due". The document page shows both «تستحق المراجعة» and «تلزم إعادة الإصدار». | Imported documents show only the re-issue pill. |

---

## API emails and CSV headings

| # | Where | Lang | Problem | Proposed |
|---|---|---|---|---|
| A1 | `fr.ts` `sign_off_requested.body` | fr | « une seconde signature » does not match the app's « la validation d’une deuxième personne ». | « La clôture de l’incident {reference} attend la validation d’une deuxième personne. Vous pouvez la donner. » |
| A2 | `sentinel_flagged.body` | en, fr | Arabic now adds «وسيتطلب إغلاقه اعتماد شخص ثانٍ» (my E3); en and fr do not, so the languages say different things. | en "Incident {reference} has been marked as a sentinel event. Closing it will need a second person's sign-off." fr « …a été qualifié d’événement sentinelle. Sa clôture devra être validée par une deuxième personne. » |
| A3 | `render.ts:155` weekly subject | all | When both acknowledgements and steps are overdue, the subject speaks only of acknowledgements, and the link "See who" opens a page without the steps. | `bothSubject`: "Overdue acknowledgements and approval steps this week" / «إقرارات بالاطلاع وخطوات اعتماد متأخرة هذا الأسبوع» / « Prises de connaissance et étapes d’approbation en retard cette semaine ». The link follows M6. |
| A4 | `ar.ts` `weekly.stepsBody` | ar | The verb sits far from «موعدها». | «في الوثائق التي تديرها خطوات اعتماد تجاوزت موعدها.» |
| A5 | `ACKNOWLEDGEMENT_HEADINGS.fr.late` | fr | « En retard » is the same as the value `ack.overdue` « En retard » in the next column (`person-*.csv`). | « Hors délai », as on screen |
| A6 | `IMPORT_REGISTER_HEADINGS.approvedBy` | en, fr | "as on the original" / « selon l’original » differ from the screen and print: "as written on the original" / « tel qu’écrit sur l’original ». | Use the screen wording. |
| A7 | `EXPORT_VALUES.account.invited` against `policies.person.invited` | all | "Invited, never signed in" vs "Invited, not signed in yet"; «مدعو، لم يسجّل الدخول قط» vs «دعوة لم تُقبل بعد». | Pick one. In Arabic «دعوة لم تُقبل بعد» avoids gender, so use it in the CSV too. |
| A8 | `ACKNOWLEDGEMENT_HEADINGS.fr.acknowledgedAt`, `ack.acknowledged` | fr | « Confirmé » is masculine; the screen says « Confirmée » (the « prise de connaissance »). | « Confirmée le » / « Confirmée » |

The new CSV columns are fine in all three languages: "Last reviewed on the original", "Differences from the original", "Document title", "Days overdue" / «أيام التأخر», and the register headings apart from A6.

---

## Screenshots

**Problems I saw on screen:**
- **`en-1280-d1-review.png`:** "Show the text ◄" in the wrong direction (M3), and "2 of 9 … in this language" (M1).
- **`fr-390-d1-review.png`:** « .Pas de texte dans cette langue » with a leading period (M3).
- **`ar-390-number-cyrillic.png`:** the character list reads «و( ) _ / . -.» (M9).
- **`ar-390-library-reissue-due.png`:** the icon is not mirrored (W2).
- **`ar-1280-import-register.png`:** the fingerprint wrap (W5).
- **`ar-390-person-record.png` / `fr-390-person-record.png`:** the leading "·" (W6).
- **`fr-390-preferences-relied-on.png`:** the email split (W7).

**Stale shots:** `shots-q3/*-imported-document.png` and the three `*-print-imported.pdf` were taken at 05:17, before the "except as noted" wording landed in a48e929 (05:25). They still show "…matches the original." Retake them after the variant in the English table.

**No overflow or mirroring fault** in: the import window panels (the portal window panel, `ar-390-portal-window-closed.png`, and the client's import window, `fr-390-import-window-open.png`), the late list, the opt-outs panel, the email preferences screen in Arabic (the knob is on the start side), the notifications, the layout page rules, or the Arabic print header.

## Screens opened, and screens only read
- **Opened:**
  - `shots-fix-r2/`: en-1280-d1, ar-1280-d1, fr-390-d1 (with a crop), fr-390-d2 (with a crop), ar-390-d3, ar-390-d4, fr-390-d6, ar-390-d8-no-assignee, fr-390-d8-module-off.
  - `shots-q3/`: ar-390 and en-1280 library-reissue-due, fr-390-library-reissue-due, ar-1280 and fr-390 import-register, ar-390 and fr-390 person-record, ar-390-late-list, ar-390, ar-1280 and fr-390 settings-opt-outs, ar-390 and fr-390 preferences-relied-on, ar-390-import-original-fields, ar-1280-imported-document, ar-1280-import-layout (with a crop of the rules), ar-390-import-layout (too small to read), ar-390 and fr-390 review-not-due, ar-390 notifications-mona and notifications-admin, en-1280-batch-sign-differences; all three print PDFs (text extracted; the Arabic page rendered).
  - `shots-import2/`: ar-390-notification-email-off, ar-390-portal-window-closed, ar-390 and fr-390 number-cyrillic, fr-390-import-window-open.
  - `shots-prefs/`: ar-390-menu-preferences-link.
  - The CSVs in `work/q3/dl/`: late, person and register (ar and en), and example-ar.
- **Not opened:** the rest of `shots-prefs/` and `shots-import2/`, most `en-*` shots, and the D2/D3/D6/D8 shots in the languages not listed above.
- **Read only, never seen rendered:**
  - an opt-out row for someone others rely on (no shot has one);
  - the "both switches off" warning;
  - the steps-only and both-kinds weekly emails;
  - the unsubscribe and "invalid link" pages;
  - every rendered email.

The working tree has an uncommitted change to `apps/api/src/policies/documents.service.ts`. It is not mine, and I did not review it.

## Files
- /home/user/Trustline/apps/web/src/i18n/dictionaries/en.json, /home/user/Trustline/apps/web/src/i18n/dictionaries/ar.json, /home/user/Trustline/apps/web/src/i18n/dictionaries/fr.json
- /home/user/Trustline/apps/web/src/components/policies/version-page.tsx (Comparison, about lines 500–630)
- /home/user/Trustline/apps/web/src/components/notifications/preferences.tsx (line 228)
- /home/user/Trustline/apps/web/src/components/admin/settings-view.tsx (OptOutsPanel)
- /home/user/Trustline/apps/web/src/components/notifications/notifications-view.tsx (line 216)
- /home/user/Trustline/apps/web/src/components/policies/import-form.tsx (NotedDifferences)
- /home/user/Trustline/apps/web/src/components/policies/import-register.tsx
- /home/user/Trustline/apps/web/src/components/policies/person-acknowledgements.tsx
- /home/user/Trustline/apps/web/src/components/policies/controlled-document.tsx (lines 293–305, 476)
- /home/user/Trustline/apps/web/src/components/policies/library.tsx (line 231)
- /home/user/Trustline/apps/web/src/components/platform/client-import-window.tsx (line 168)
- /home/user/Trustline/apps/api/src/email/wording/en.ts, /home/user/Trustline/apps/api/src/email/wording/ar.ts, /home/user/Trustline/apps/api/src/email/wording/fr.ts
- /home/user/Trustline/apps/api/src/email/render.ts (lines 150–163), /home/user/Trustline/apps/api/src/email/email-worker.service.ts (line 812), /home/user/Trustline/apps/api/src/email/digest.service.ts (line 127)
- /home/user/Trustline/apps/api/src/policies/export-wording.ts
- /home/user/Trustline/apps/api/src/policies/input.ts (line 371)