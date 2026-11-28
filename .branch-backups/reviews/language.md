## Decisions

Recorded from the coordinator's message after the review was accepted. They settle the open points in the report below.

- **Item 4: accepted.** Use "Handling department" and its Arabic and French translations as given in item 4.
- **Item 11: accepted.** Soften "Rejected" to "Not taken forward" and its Arabic and French translations as given in item 11, and give the "New" status a neutral tone.
- **Item 14: both category changes accepted** (`facility` ar «سلامة المباني والبيئة»; `medication` fr «Circuit du médicament»).
- **Optional `incidents.form.intro` line (item 2): accepted.**
- **Out-of-scope `fr.json` notes: accepted**, namely «authentification unique (SSO)» and the `admin.users.form.resetHelp` pronoun fix. **Exception: «Enquêtes» stays for now.**

---

## Bilingual review: incident reporting screens (en / ar / fr)

No files changed, no servers started, no builds run.

**Verdict:** key parity, digits, logical classes and language-branching are clean. The problems are tone on the report form, one mixed-direction defect in the Arabic timeline, French typography and agreement, and a set of Arabic term and consistency fixes.

### How I checked

- **Read in full:** `en.json`, `ar.json`, `fr.json`, the five incident components, `dashboard-view.tsx`, `lib/format.ts`, `lib/incidents.ts`, `lib/localized.ts`, `i18n/config.ts`, `apps/api/src/incidents/categories.ts`, and the report path of `incidents.service.ts` (to check the anonymous warning against what is stored).
- **Screenshots viewed:** all eight `ar-*` and all nine `fr-*` shots at 1280 and 390, plus `en-1280-anonymous-sent`, `en-1280-officer-scope-warning`, `en-1280-reporter-view`, `en-1280-detail-new`, `en-1280-detail-closed`.
- **Not rendered in Arabic or French (dictionary only):** the triage panel, the status-change note form, the "report sent" screen, the anonymous box when ticked, every error message, empty states, and the reporter view.
- **One stale shot:** `fr-390-detail.png` shows the header pills running about 12 px past the right padding. The later `fr-390-detail-viewer.png` shows them wrapping, and commit b56d542 added `max-w-full flex-wrap` to `page-header.tsx`. I treat it as fixed.

---

## Problems, most noticeable first

### 1. Arabic and French call every incident an "error" (first control on the report form)

English is neutral ("Something went wrong…"). Arabic «خطأ وقع…» and French «Une erreur s'est produite…» imply fault, and are wrong for falls, equipment failures and aggression.

| Key | Replacement |
|---|---|
| `incidents.typeHelp.incident` (ar) | «حدث غير مرغوب فيه وصل أثره إلى مريض أو زائر أو أحد الموظفين.» |
| `incidents.typeHelp.near_miss` (ar) | «حدث غير مرغوب فيه اكتُشف قبل أن يصل أثره إلى أحد.» |
| `incidents.typeHelp.incident` (fr) | «Un événement indésirable qui a touché un patient, un visiteur ou un membre du personnel.» |
| `incidents.typeHelp.near_miss` (fr) | «Un événement indésirable détecté avant de toucher qui que ce soit.» |

### 2. The anonymous option discourages its own use (all three languages)

The warning is accurate: the API stores no reporter on the incident, the timeline or the audit log. Three things work against it.

- **The box turns red when ticked.** `report-form.tsx:282` uses `has-checked:border-danger has-checked:bg-danger-soft`. Use `has-checked:border-accent has-checked:bg-accent-soft`, as the type cards do.
- **The text leads with what the reporter loses**, and never says the people handling the report cannot see who sent it.
- **"So write down the reference" does not follow.** The reference cannot be used in the app to find the report; it is only useful when asking the quality team.

`incidents.form.anonymousWarning`:
- en: "Your name is not stored with the report, so the people who handle it cannot see who sent it. Because it is not linked to your account, it will not appear under “Reported by me” and you will not be able to follow its progress. You will be given a reference after sending: write it down in case you want to ask the quality team about the report later."
- ar: «لا يُحفظ اسمك مع البلاغ، فلا يستطيع من يعالجه معرفة مَن أرسله. ولأنه غير مرتبط بحسابك، لن يظهر ضمن «بلاغاتي» ولن تتمكن من متابعة سير معالجته. سيظهر لك رقم مرجعي بعد الإرسال؛ دوّنه إن أردت الاستفسار عن البلاغ لاحقًا لدى فريق الجودة.»
- fr: «Votre nom n'est pas enregistré avec la déclaration : les personnes qui la traitent ne peuvent pas savoir qui l'a envoyée. Comme elle n'est pas rattachée à votre compte, elle n'apparaîtra pas dans « Déclarés par moi » et vous ne pourrez pas suivre son traitement. Une référence s'affichera après l'envoi : notez-la si vous souhaitez interroger l'équipe qualité par la suite.»

`incidents.form.doneAnonymous`:
- en: "Write this reference down now: it will not be shown again, because the report is not linked to your account. Quote it if you want to ask the quality team about this report."
- ar: «دوّن هذا الرقم المرجعي الآن، فلن يُعرض مرة أخرى لأن البلاغ غير مرتبط بحسابك. اذكره إن أردت الاستفسار عن البلاغ لدى فريق الجودة.»
- fr: «Notez cette référence maintenant : elle ne sera plus affichée, car la déclaration n'est pas rattachée à votre compte. Indiquez-la si vous souhaitez interroger l'équipe qualité au sujet de cette déclaration.»

Optional new key `incidents.form.intro`, shown above the form:
- en: "Reports are used to make care safer, not to blame anyone."
- ar: «تُستخدم البلاغات لتحسين السلامة، لا لمحاسبة الأفراد.»
- fr: «Les déclarations servent à améliorer la sécurité, pas à désigner un coupable.»

### 3. Arabic timeline: a Latin-script name breaks the date apart

This is derived from the bidi algorithm, not seen in a shot: the Arabic shots only have Arabic names. `pick()` falls back to another language when a user has no Arabic name, so this will occur at English-default tenants.

- **Where:** `incidents.timeline.byline` (`{name} · {date}`), filled at `incident-detail.tsx:300` and `:322`.
- **What happens:** with `Amal Admin` and `24‏/11‏/2026، 7:02 م`, the day "24" joins the Latin run. The line shows "24 · Amal Admin" on the right and "/11/2026، 7:02 م" detached on the left.
- **Fix, in `lib/format.ts:20-23`:** isolate every inserted value, so all filled sentences are protected at once:
  `key in values ? `\u2068${values[key]}\u2069` : whole`
- **Related, lower priority:** the "type · category · unit" lines put several client-written names in one run, so two Latin names next to each other swap order for a right-to-left reader.
  - `incidents-list.tsx:147-151` and `dashboard-view.tsx:114-120`: wrap each piece in `<bdi>`.
  - `incident-detail.tsx:207-211`: render pieces with `<bdi>` instead of `.join(" · ")`.
  - `triage-panel.tsx:199-201`: an `<option>` cannot hold elements, so wrap each part in `\u2068…\u2069`.

### 4. "Responsible department" reads as "the department at fault"

The reporter sees this label on the report and the timeline. French «Service responsable» is the strongest case. Arabic «القسم المسؤول» has the same ambiguity and differs from the existing «الأقسام المعنية» in `modules.incidents.scope`.

| Key | en | ar | fr |
|---|---|---|---|
| `incidents.detail.ownerUnit`, `incidents.triage.ownerUnit` | Handling department | القسم المعني بالمعالجة | Service chargé du traitement |
| `incidents.timeline.ownerUnit` | Handling department: {unit} | القسم المعني بالمعالجة: {unit} | Service chargé du traitement : {unit} |
| `incidents.triage.help` | Confirm the harm level, then hand the incident to the department that will handle it. | أكّد مستوى الضرر، ثم حوّل الحادث إلى القسم المعني بمعالجته. | Confirmez le niveau de préjudice, puis transmettez l'incident au service chargé de le traiter. |

### 5. French: colon orphaned at the start of a line

- **Seen in** `fr-1280-detail.png`, timeline "Tri effectué": the line ends "· Catégorie" and the next starts ": Médicaments".
- **Cause:** every space before `: ; ? !` and inside `« »` in `fr.json` is an ordinary breaking space.
- **Fix:** U+00A0 before `:` and inside guillemets, U+202F (or U+00A0) before `; ? !`.
- **Keys in the new sections:** `incidents.form.noUnits`, `.form.type`, `.form.occurredAtHelp`, `.form.description`, `.form.anonymousWarning`, `.form.doneHelp`, `.form.doneAnonymous`, `.detail.reporterView`, `.timeline.note`, `.timeline.ownerUnit`, `.timeline.category`, `.timeline.events.status_changed`, `.comments.visibilityInternal`, `.actions.note.close`, `.errors.unknown_assignee`, `.errors.invalid_transition`.
- The rest of `fr.json` has the same habit.

### 6. French agreement errors and awkward wording

| Key | Problem | Replacement |
|---|---|---|
| `incidents.form.occurredAtHelp` | «Réglé… Modifiez-le… il» are masculine singular, but refer to «Date et heure» | «Par défaut, la date et l'heure actuelles. Modifiez-les si l'événement s'est produit plus tôt ; elles ne peuvent pas être dans le futur.» |
| `incidents.actions.note.start` | «Note» is feminine | «Note (facultative)» |
| `incidents.errors.unknown_assignee` | «recevoir d'attribution» is not French | «Cet incident ne peut plus être attribué à cette personne : son compte n'est pas actif. Choisissez quelqu'un d'autre.» |
| `incidents.errors.occurred_in_future` | «renvoyez» has no object and also means "send back" | «La date de l'événement est dans le futur. Corrigez-la, puis envoyez de nouveau la déclaration.» |
| `incidents.errors.internal_not_allowed` | «Renvoyez-le» is ambiguous | «Vous ne pouvez pas ajouter de commentaire interne. Sous « Qui peut le lire », choisissez l'option qui inclut le déclarant, puis ajoutez de nouveau le commentaire.» |
| `incidents.detail.reporterView` | «Vous voyez la vue» | «Vous consultez cet incident en tant que déclarant : vous voyez votre déclaration, son avancement et les commentaires qui vous sont destinés.» |
| `incidents.timeline.events.status_changed` | «modifié de… à» is a calque | «Statut passé de « {from} » à « {to} »» |
| `incidents.form.immediateAction`, `incidents.detail.immediateAction` | Not the wording French incident forms use | «Mesures immédiates prises (facultatif)» / «Mesures immédiates prises» |
| `incidents.form.type` | Stiff | «Que souhaitez-vous déclarer ?» |
| `incidents.form.view` | Vague | «Consulter la déclaration» |
| `incidents.form.another` | Excludes dangers and presque-accidents | «Faire une autre déclaration» |
| `incidents.detail.report` | Other panel titles have no article | «Déclaration» |
| `incidents.detail.ownerUnitNone` | — | «Pas encore défini» |

Timeline events mix bare nouns («Clôture», «Rejet») with «Tri effectué» and «Commentaire ajouté». Pick one pattern; simplest is `triaged` → «Tri».

### 7. Arabic: literal translations, agreement and mixed terms

| Key | Problem | Replacement |
|---|---|---|
| `incidents.form.immediateAction`, `incidents.detail.immediateAction` | «ما الذي تم فعله فورًا» is a calque; incident forms use a set phrase | «الإجراء الفوري المتَّخَذ (اختياري)» / «الإجراء الفوري المتَّخَذ» |
| `incidents.actions.note.close` | Same calque | «ملخص الإغلاق: ما تبيّن وما اتُّخذ من إجراءات» |
| `incidents.actions.note.start` | «ملاحظة» is feminine | «ملاحظة (اختيارية)» |
| `incidents.typeHelp.incident`, `.timeline.events.assignedSomeone`, `.triage.usersError` | Staff is «العاملين» here but «الموظفين» in the rest of `ar.json` | «أحد الموظفين»، «قائمة الموظفين» (keep «العاملون على معالجة…» in comments: different meaning) |
| `incidents.sentinel` vs `modules.investigations.description` | «حدث جسيم» is right for sentinel event, but «الأحداث الجسيمة» already means "serious events" | Change the modules line to «التحقيق وتحليل السبب الجذري للأحداث الخطيرة.» |
| `incidents.errors.unknown_assignee` | «غير مفعَّل» reads as "never activated"; the status label is «نشط» | «لا يمكن تكليف هذا الشخص لأن حسابه غير نشط. اختر شخصًا آخر.» |
| `incidents.form.occurredAt`, `incidents.detail.occurredAt` | «وقت الوقوع» beside «تاريخ البلاغ», both showing date and time | «تاريخ ووقت الوقوع» |
| `incidents.errors.occurred_in_future` | Follows from the above | «تاريخ ووقت الوقوع في المستقبل. صحّحهما ثم أعد إرسال البلاغ.» |
| `incidents.errors.internal_not_allowed` | «فقط» is misplaced; «أعد إرساله تعليقًا للجميع» is unclear | «لا يمكنك إضافة تعليق داخلي. اختر تحت «من يمكنه قراءته» الخيار الذي يشمل المبلّغ، ثم أضف التعليق مرة أخرى.» |
| `incidents.errors.invalid_transition` | «حالته الحالية» jars | «عدّل مستخدم آخر هذا الحادث للتو. تعرض الصفحة الآن آخر حالة له؛ راجعها ثم حاول مرة أخرى.» |
| `incidents.detail.reporterView` | «وما تم فيه» is vague | «تظهر لك هنا طريقة عرض المبلّغ: بلاغك وسير معالجته والتعليقات الموجّهة إليك.» |
| `incidents.form.type` | Correct but very high register | «ما الذي تريد الإبلاغ عنه؟» |
| `incidents.form.another` | Excludes hazards and near misses | «تقديم بلاغ آخر» |
| `incidents.comments.visibilityEveryone` | — | «…، بمن فيهم المبلّغ» |

**Timeline events use three patterns** in seven lines (seen in `ar-1280-detail.png`): «تم الإبلاغ», «أُعيد الفتح», «التكليف: …». A noun set is parallel, needs no gender agreement with the person's name, and separates the event from the status «تم الفرز»:

- `reported` «الإبلاغ», `triaged` «الفرز», `closed` «الإغلاق», `rejected` «الرفض», `reopened` «إعادة الفتح»
- `commented` «إضافة تعليق», `commentedInternal` «إضافة تعليق داخلي»
- `status_changed` «تغيير الحالة من «{from}» إلى «{to}»»
- `assigned` «التحويل إلى {unit} وتكليف {name}»
- `assignedSomeone` «التحويل إلى {unit} وتكليف أحد الموظفين»
- `assignedUnit` unchanged

### 8. "Assigned to {name}, {unit}" is ambiguous in all three languages

It reads as "Rami, of Pharmacy". The unit is the department the incident was handed to (`incidents.timeline.events.assigned` and `assignedSomeone`).

- en: "Handed to {unit} and assigned to {name}" / "Handed to {unit} and assigned to a member of staff"
- fr: «Transmission à {unit}, attribution à {name}» / «Transmission à {unit}, attribution à un membre du personnel»
- ar: as in item 7.

### 9. Reporters lose the "no patient names" warning on comments

`incident-detail.tsx:384` shows `reporterHelp` instead of `bodyHelp` to someone who sees only their own report (visible in `en-1280-reporter-view.png`). Add the warning to `incidents.comments.reporterHelp`:

- en: "The staff handling this incident will read your comment. Do not type patient names or record numbers."
- ar: «سيقرأ تعليقك العاملون على معالجة هذا الحادث. لا تكتب أسماء المرضى ولا أرقام ملفاتهم الطبية.»
- fr: «Le personnel qui traite cet incident lira votre commentaire. N'indiquez ni nom de patient ni numéro de dossier.»

### 10. "Could not load incidents" is shown where it is not true

`report-form.tsx:113` and `incident-detail.tsx:57` and `:80` reuse `incidents.loadError`. Two new keys are needed:

| New key | en | ar | fr |
|---|---|---|---|
| `incidents.form.loadError` | Could not load the report form. Reload the page. | تعذّر تحميل نموذج البلاغ. أعد تحميل الصفحة. | Impossible de charger le formulaire de déclaration. Rechargez la page. |
| `incidents.detail.loadError` | Could not load this incident. Reload the page. | تعذّر تحميل هذا الحادث. أعد تحميل الصفحة. | Impossible de charger cet incident. Rechargez la page. |

### 11. "Rejected" / "Reject report": a product-owner call

The reporter sees «مرفوض» / «Rejeté» on their own report. "Rejected" is the usual word in incident systems, and the mandatory reason softens it, so I rank this low. If softened:

- en: "Not taken forward" (status), "Do not take forward" (action).
- ar: «مُستبعَد» / «استبعاد البلاغ» / «سبب الاستبعاد».
- fr: «Classé sans suite» / «Classer sans suite» / «Motif du classement sans suite».
- Keys affected: `status.rejected`, `actions.reject`, `actions.note.reject`, `detail.rejectionReason`, `timeline.events.rejected`.

Related: `lib/incidents.ts:143` gives the "New" status the `danger` tone, so a reporter's fresh report carries a red pill. `ok` or `neutral` would read better.

### 12. English small points

- `incidents.form.view` "View it" → "View the report".
- `incidents.form.another` "Report another" → "Report another incident".
- `incidents.errors.internal_not_allowed` → "You cannot add internal comments. Under “Who can read it”, choose the option that includes the reporter, then add the comment again."
- `incidents.list.emptyFiltered` is also shown when only "Reported by me" is ticked → "No incidents match these filters. Change the status or untick “Reported by me”." (ar: «لا توجد حوادث تطابق عوامل التصفية. غيّر الحالة أو ألغِ تحديد «بلاغاتي».» fr: «Aucun incident ne correspond à ces filtres. Changez de statut ou décochez « Déclarés par moi ».»)
- `incidents.detail.rejectionReason` "Reason for rejecting" → "Reason for rejection".
- `incident-detail.tsx:181` falls back to `t.actions.done` ("Status changed.") as a timeline headline, the only one with a full stop.

Every English error says what to do. No other English wording blames a person.

### 13. Date and time field in Arabic (`report-form.tsx:231-240`)

- **Alignment:** in `ar-1280-new.png` and `ar-390-new.png` the value sits at the left of the field while every other field starts at the right. Keep `dir="ltr"` and add `rtl:text-end`. I have not rendered this, so check the browser honours it on a date input.
- **Digits:** the native control follows the browser's language, not the page's. The shots show US "11/24/2026, 07:02 PM" on all three pages. I believe an Arabic-language browser may show Arabic-Indic digits there; check on a real one.

### 14. Default category names (`apps/api/src/incidents/categories.ts`)

All ten are acceptable. Two optional changes:

- `facility` ar «المرافق والبيئة»: «المرافق» already means the sites in the organization tree. Use «سلامة المباني والبيئة».
- `medication` fr «Médicaments»: a French quality department would write «Circuit du médicament».

---

## Checked and found fine

- **Key parity:** 409 leaf keys in each file, `incidents` and `dashboard` identical, `{placeholders}` match, no empty values, no Arabic-Indic digits.
- **Language branching:** none. `pick()`, `direction()`, `dateTimeFormat`, `numberFormat` and `fill` are used throughout.
- **Text in components:** no words. Only neutral punctuation (" · ", "–", the "— " indent in `lib/incidents.ts:158`).
- **Physical classes:** none. `border-s-2`, `ps-3` and gap utilities only; the two-column detail layout mirrors correctly.
- **Icons:** no directional icons on these screens; select chevrons mirror natively.
- **References:** `<bdi dir="ltr">` in the list, dashboard and detail title, and `dir="ltr"` on the sent screen. The reference never sits inside an Arabic sentence.
- **Dates and numbers:** Western digits and the Gregorian calendar in all three languages. Arabic dates render in the right order.
- **Free text:** `dir="auto"` on descriptions, notes and comments. English text inside Arabic pages renders correctly, including the wrapped note at 390.
- **Truncation:** none at 390 in Arabic or French. Pills, filter chips, tiles and pagination all wrap.
- **Arabic terms that match the rest of `ar.json`:** «الإجراءات التصحيحية», «مصدر خطر», «حادث وشيك», «المنشأة», «مسؤول النظام», «الفرز», «التحويل», «التصنيف», «التسلسل الزمني», «الرقم المرجعي».
- **Arabic harm levels and statuses:** correct and agree in gender. «ضرر شديد» rightly avoids colliding with «حدث جسيم».
- **«دون ذكر الاسم» for anonymous:** accurate and not frightening.
- **French terms that match `fr.json`:** «presque-accident», «danger», «Déclarer un incident», «service», «Événement sentinelle», «Synthèse de clôture», «périmètre». «Préjudice» is the WHO French term for harm; a quality department in France would say «gravité» or «dommage».
- **`actions.noteHelp` ("The reporter can read this note"):** true for every status change in the API.

## Seen in passing in `fr.json`, outside scope

- «connexion unique» for single sign-on (`modules.users.scope`, `modules.settings.scope`, `platform.options.signInMethod.sso`, `platform.administrator.ssoOnly`): «à la première connexion unique» reads as "the first unique connection". Use «authentification unique (SSO)».
- «Enquêtes» for investigations (`nav.items.investigations`, `modules.investigations`): it has a disciplinary ring. «Analyses des causes» fits a no-blame system; «Analyses» is already the "Insights" nav group, so that would need another name.
- `admin.users.form.resetHelp`: «lui permet… et la déconnecte» mixes pronouns → «permet à cette personne de choisir un nouveau mot de passe et la déconnecte partout».
- «tri» / «Trié» is understandable and consistent, but French quality teams more often say «qualification» or «analyse initiale».
