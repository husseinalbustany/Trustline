## Decisions (taken by the lead; apply all of this)

Every row of the Arabic, French, English and starting-data tables is accepted, optional ones
included, and every layout fault with its fix. On the six decisions:
1. Accepted: French « vérification / vérifié » replaces « relecture / relu » throughout, and the
   seed follows.
2. Accepted: the signing prompts name every language the version is written in ({languages}).
3. Accepted: counted durations through Intl unit formatting (days, months), dropping the stilted
   "duration in days: {days}" patterns.
4. Accepted: the control block adds "Prepared by" (الإعداد / Rédigé par), and every printed page
   carries "Printed on {date}".
5. English "Owning unit" becomes "Responsible area" (and "Some areas only" / "Areas" where it lists
   them); Arabic «الجهة المسؤولة» and French « entité responsable » stay.
6. The title is not in the signed content; reword in_review_title so it says the title cannot
   change while a version is in review, not that it is part of what is reviewed.

---

## Language review 6: policies and procedures (en / ar / fr)

I reviewed HEAD 44d5358 against 357eb44. I changed no repository file and started no server. My scratch files (key diff, crops) are in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour6/`. French proposals use ordinary spaces, so run them through `frs()` as before.

### Checks
- **Parity:** each file has 1,475 keys, with none missing or empty.
  - 509 keys are new and 4 changed (`nav.items.policies`, `dashboard.tiles.policiesDue`, `admin.permissions.policies.view` and `.manage`, now "Documents").
  - 5 were removed (`modules.policies.*`).
- **Placeholders:** the same in all three languages for every key.
- **French typography:** clean. No-break spaces and U+2019 apostrophes are used throughout.
- **Arabic punctuation:** «؟» and «؛» are used throughout. The only Latin text is in codes and examples.
- **Code in `components/policies`, the dashboard and notifications:** there are no physical classes, no wording in the markup and no branching on a language.
  - Numbers are `<bdi dir="ltr">`, and `Sentence` keeps a document number in one piece.
  - The list icons are mirrored (`rtl:-scale-x-100`), and each text area takes its own language's direction.
- **Review 5 held.** I spot-checked 13 keys from all three tables, including the banner, the confirm and keep buttons, «لم تعد تُطرح», `limitPair`, `meter.inUse`, `{organization}` on the public form and the neutral wording. All are in.

---

## Arabic (24 rows; the first 6 matter most)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `policies.document.reviewedBy`, `approvedBy`, `retiredBy`, `review.preparedBy`, `review.scheduled`, `acknowledgements.acknowledgedOn` | راجعها {name} في {date} / اعتمدها {name} في {date} / أوقف العمل بها: {name} / أعدّه / (جدوله: {name}) / أقرّ في {date} | المراجعة: {name}، {date} / الاعتماد: {name}، {date} / أُوقف العمل بها بقرار من {name} / الإعداد / معتمد، وموعد نشره {date}. الجدولة: {name}. / تاريخ الإقرار: {date} | Each verb is masculine, but a woman's name is put after it. In the screenshots: «اعتمدها أمل المسؤولة» on the control block of the printed copy (`ar-1280-print.png`), «رنا القارئة · أقرّ في…» (`ar-390-acks.png`) and «أعدّه منى المديرة» (`ar-390-review-v2-changes.png`). The noun forms are also the Saudi control-block layout «إعداد / مراجعة / اعتماد». «جدوله» also reads as "its table" |
| 2 | `policies.review.signReview`, `signApprove` | توقّع بكلمة المرور أنك راجعت… / أنك تعتمد… كما هي معروضة هنا | بتوقيعك بكلمة المرور تؤكد أنك راجعت الوثيقة {number}، الإصدار {version}، بكل اللغات المكتوبة بها ({languages})، كما هي معروضة في هذه الصفحة. / بتوقيعك بكلمة المرور تعتمد الوثيقة {number}، الإصدار {version}، بكل اللغات المكتوبة بها ({languages})، كما هي معروضة في هذه الصفحة. | Without vowel marks, «توقّع» reads first as "expect!" (تَوَقَّعْ), not "you sign" (تُوقِّع). The signature also covers every language (`signed-content.ts`), but "as it reads here" suggests the one language on screen (decision 2) |
| 3 | `notifications.kinds.document_published`, `acknowledgement_assigned`, `acknowledgement_due`, `policies.acknowledge.due`, `list.ackDue` | …قبل {date} | …في موعد أقصاه {date} (ackDue: أقِرّ بالاطلاع في موعد أقصاه {date}) | An acknowledgement is overdue only when `dueOn < today` (`documents.service.ts:401`), so the due day itself is allowed. «قبل» excludes that day |
| 4 | `notifications.kinds.acknowledgement_overdue`, `acknowledge.wasDue`, `list.ackWasDue`, `acknowledgements.wasDue`, `acknowledgements.dueOn`, `review.dueBy` | …على الإصدار {version} {date}. / كان موعد… {date} / الموعد {date} / الموعد النهائي {date} | الوثيقة {reference}: انتهى في {date} موعد إقرارك بالاطلاع على الإصدار {version}. / انتهى موعد إقرارك بالاطلاع في {date}. / انتهى موعد الإقرار بالاطلاع في {date} / انتهى الموعد في {date} / الموعد النهائي: {date} / الموعد النهائي: {date} | Two numbers end up side by side («الإصدار 2 2026/12/07»), and the labels have no colon or preposition |
| 5 | `policies.errors.unsupported_markup` | قسم «{section}» ({language}) يحتوي على {problem}. احذفه ثم احفظ مرة أخرى. | قسم «{section}» ({language}) يتضمن {problem}. صحّح ذلك ثم احفظ مرة أخرى. | The `markupProblems` values are accusative («عنوانًا», «جدولًا», «سطرًا»), which is wrong after «على». «يتضمن» takes them as they are. «احذفه» is masculine before «صورة» or «وسوم», and an indented line is to be corrected, not removed |
| 6 | `admin.permissions.policies.approve` and the quote of it in `errors.role_cannot_approve` | اعتماد الوثائق عند تكليفه بخطوة اعتماد | مراجعة الوثائق واعتمادها عند التكليف بخطوة في مسار الاعتماد | «تكليفه» has no antecedent. The permission also covers review steps: the same check guards `approve` and `return` (`policies.controller.ts:270,289`) |
| 7 | `policies.editor.tools.heading1/2/3` | عنوان / عنوان فرعي / عنوان ثانوي | عنوان من المستوى 1 / عنوان من المستوى 2 / عنوان من المستوى 3 | «فرعي» and «ثانوي» are near-synonyms, so the order is unclear. The icons show H1/H2/H3, and the markup error speaks of "levels" |
| 8 | `policies.review.stepStatus.waiting`, `.skipped` | بالانتظار / تُجووزت | لم يحن دورها بعد / لم تصل إليها المراجعة | «بالانتظار» beside «بانتظار القرار» (`ar-390-review-v2-changes.png`) does not say which step can be acted on. «تُجووزت» is an awkward passive, and a skipped step means it was never reached because the version was returned (`approval-engine.service.ts:558`) |
| 9 | `policies.errors.password_locked` | …التوقيع مقفل 15 دقيقة، كما هو تسجيل الدخول… | أُدخلت كلمة مرور خاطئة مرات كثيرة، فقُفل حسابك 15 دقيقة: لا يمكنك التوقيع ولا تسجيل الدخول حتى ينقضي هذا الوقت. لم يُوقَّع شيء. | Signing and signing in share one counter and one lock (`auth.service.ts:322`). The current sentence does not say that sign-in is locked too |
| 10 | `policies.document.months`, `actions.publishAcknowledge`, `review.acknowledgementWithin`, `settings.stepLine`, `settings.typeLine` | المدة بالأشهر: {months} / …خلال مدة بالأيام: {days} | {months} (filled with «36 شهرًا») / سيُطلب من كل من تنطبق عليهم الإقرار بالاطلاع عليها خلال {days} من النشر. / مطلوب من كل من تنطبق عليهم خلال {days} من النشر / {position}. {kind}: {who}، خلال {days} / دورة المراجعة: {months} · {sections} | «دورة المراجعة» over «المدة بالأشهر: 36» is a label inside a label (`ar-1280-document.png`), and «خلال مدة بالأيام: 7» is stilted (`ar-390-settingsRoutes.png`). This needs decision 3 |
| 11 | `policies.actions.recall`, `recallYes`, `recalled`, `recallConfirm` | إعادته إلى مسودة / نعم، أعِده / أُعيد إلى مسودة | استعادته للتعديل / نعم، استعِده للتعديل / استُعيد الإصدار للتعديل / استعادة هذا الإصدار للتعديل؟ تتوقف المراجعة، ويجب إرساله للمراجعة من جديد. | A reviewer sees «إعادة مع ملاحظات» and «إعادته إلى مسودة» one above the other (`ar-390-review-v2-changes.png`). Both say «إعادة» for two different acts by two different people |
| 12 | `policies.review.approveReview`, `confirmReviewed` | التوقيع بالمراجعة | توقيع المراجعة | «التوقيع بالمراجعة» is not idiomatic |
| 13 | `policies.document.effectiveOn`, `policies.actions.effectiveOn` | سارية من | تاريخ السريان | This is the standard control-block label. It also reads correctly for a future date |
| 14 | `policies.form.ownerHelp` | الشخص المساءَل عن الوثيقة… | الشخص المسؤول عن الوثيقة، ويُبلَّغ عند اقتراب موعد مراجعتها. | «المساءَل» sounds like someone being questioned |
| 15 | `policies.errors.stale_document`, `stale_version` | …تعرض الصفحة الآن آخر نسخة؛ راجعها… | …تعرض الصفحة الآن آخر ما حُفظ؛ راجعه ثم حاول مرة أخرى. | «نسخة» is the word for "copy" («النسخ المطبوعة»), and next to «الإصدار» it reads as "version" |
| 16 | `policies.actions.published` | نُشرت. | نُشر الإصدار. | What is published is the version (masculine). `submitted` and `recalled` are already masculine |
| 17 | `policies.settings.active`, `.inactive` | نشط / غير نشط | قيد الاستخدام / خارج الاستخدام | These are used for a type (masculine), a category (feminine) and a route. The noun phrases need no agreement |
| 18 | `policies.errors.no_assignee` | …أو لا يمكن أن يقرر كل خطوة شخص مختلف عمّن أعدّوه وقرروا الخطوات السابقة… | لا يمكن إرسال هذا الإصدار للمراجعة: في مسار اعتماده خطوة لا يوجد من يستطيع أن يقررها. يجب أن يقرر كل خطوة شخص لم يُعدّ الإصدار ولم يقرر خطوة سابقة. اطلب ممن يدير إعدادات الوثائق تعديل المسار. | Split into short sentences |
| 19 | `policies.review.samePerson`, `errors.same_person`, `same_person_decided` | …أو قررتَ خطوة سابقة… | …أو اتخذتَ القرار في خطوة سابقة… | «قرّر خطوة» is a calque of "decide a step" |
| 20 | `policies.form.categoryHelp` | جزء من رقم الوثيقة، الذي لا يتغيّر أبدًا. | تدخل في رقم الوثيقة، والرقم لا يتغيّر أبدًا. | It is unclear what «الذي» refers to |
| 21 | `policies.editor.totalCharacters` | {count} من أصل {max} حرف كحد أقصى في كل اللغات معًا | مجموع الأحرف بكل اللغات: {count} من أصل {max} | Simpler, and the noun no longer follows the number |
| 22 | `policies.list.searchExample` | الرقم أو العنوان أو كلمة مفتاحية أو كلمات من النص | الرقم أو العنوان أو كلمة من النص | At 390 px the placeholder is cut at its start (layout table) |
| 23 | `dashboard.tiles.policiesDue`, `dashboard.policiesDueHelp` | وثائق تستحق المراجعة / تستحق المراجعة خلال… | وثائق تستحق المراجعة الدورية / تستحق مراجعتها الدورية خلال الثلاثين يومًا القادمة | Optional. The tile sits beside «بانتظار مراجعتي أو اعتمادي», which is a different kind of review |
| 24 | `subscription.suspendedAcknowledge` | الإقرار بالاطلاع على الوثائق يعمل كالمعتاد أيضًا. | ويبقى الإقرار بالاطلاع على الوثائق متاحًا كالمعتاد. | Optional, for smoother wording |

**Vocabulary I confirm:**
- «وثيقة/الوثائق» and «وثيقة مضبوطة» match ISO 9001 in Arabic («ضبط المعلومات الموثقة»).
- «الإصدار» for a version, with «نسخة» kept for copies.
- «الإقرار بالاطلاع», with the button «أُقِرّ بالاطلاع» and the first-person tick box «قرأتُ… وفهمتُها», which is the same for women and men.
- «مراجعة / اعتماد» and «مسار الاعتماد».
- «الجهة المسؤولة», which is rightly generic, since a facility can own a document.
- «النسخ المطبوعة غير مضبوطة».
- «أُوقف العمل بها» for a retired document. It is unambiguous inside this module and avoids «إلغاء», which already means Cancel. «ملغاة» is the shorter hospital usage if you want a shorter status pill.
- «سارية», «حلّ محله إصدار أحدث», «مسحوب» and «مقيّدة», all with correct agreement.

---

## French (22 rows; the first 6 matter most)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `notifications.kinds.document_published`, `acknowledgement_assigned`, `acknowledgement_due`, `policies.acknowledge.due`, `list.ackDue` | …avant le {date} | …au plus tard le {date} (ackDue: « À confirmer au plus tard le {date} ») | « Avant le » excludes the due day. Same reason as Arabic row 3 |
| 2 | `policies.review.signReview`, `signApprove` | Vous signez, avec votre mot de passe, avoir relu… / l’approbation du document… tel qu’il figure ici. | En signant avec votre mot de passe, vous attestez avoir vérifié le document {number}, version {version}, dans toutes ses langues ({languages}), tel qu’il figure sur cette page. / En signant avec votre mot de passe, vous approuvez le document {number}, version {version}, dans toutes ses langues ({languages}), tel qu’il figure sur cette page. | « Signer avoir relu » is not idiomatic. Decision 2 covers the languages; decision 1 covers « vérifié » |
| 3 | Review vocabulary (decision 1): `stepKind.review`, `versionStatus.in_review`, `actions.submit`, `submitted`, `submitHelp`, `document.approvals`, `reviewedBy`, `review.*` (`approveReview`, `confirmReviewed`, `reviewedDone`, `yourReview`, `openReview`, `outOfSight`), `editor.changeSummaryHelp`, the `errors.in_review*` family, `dashboard.tiles.awaitingMyApproval`, `awaiting.*`, the `document_step_assigned.review` notification | relecture / relu / En relecture / Envoyer en relecture | vérification / vérifié / En vérification / Soumettre à vérification; « Rédigé, vérifié et approuvé » and « Vérifié par {name} le {date} »; « Signer la vérification »; « Votre vérification est signée. »; « attend votre vérification » | The French cartouche is « Rédigé par / Vérifié par / Approuvé par », and quality-document software uses rédaction → vérification → approbation. A French ISO auditor reads « relecture » as proofreading. « Révision » stays for the periodic review |
| 4 | `policies.document.effectiveOn`, `effectiveFrom`, `list.versionEffective`, `actions.effectiveOn` | En vigueur depuis le / … depuis le {date} / En vigueur à partir du | En vigueur à compter du / En vigueur à compter du {date} / Version {version}, en vigueur à compter du {date} / Date d’entrée en vigueur | « Depuis » is wrong for a version scheduled for a later day |
| 5 | `policies.confidentialityHelp.restricted` | Seuls les personnes concernées, son responsable et ceux qui le gèrent peuvent le lire. | Seuls son responsable, les personnes concernées et ceux qui le gèrent peuvent le lire. | « Seuls les personnes » is a gender-agreement error |
| 6 | `policies.confidentialityHelp.all_staff` | Une fois publié, toute personne autorisée… peut le lire. | Une fois publié, ce document peut être lu par toute personne autorisée à lire les documents. | Dangling participle |
| 7 | `admin.permissions.policies.approve` (and its quote in `role_cannot_approve`) | Approuver des documents quand on est désigné dans une étape d’approbation | Vérifier et approuver des documents lorsqu’on est désigné dans une étape d’un circuit d’approbation | As Arabic row 6 |
| 8 | `policies.errors.password_locked` | …la signature est bloquée pendant 15 minutes, comme la connexion… | Trop de mots de passe erronés : votre compte est bloqué pendant 15 minutes, pour la signature comme pour la connexion. Rien n’a été signé. | As Arabic row 9 |
| 9 | `policies.document.months` | Durée en mois : {months} | {months} mois | « Mois » is the same in singular and plural. The current text gives « Périodicité de révision / Durée en mois : 36 » (`fr-390-document.png`) |
| 10 | `policies.review.stepStatus.waiting`, `.skipped` | En attente / Passée | Pas encore ouverte / Non atteinte | As Arabic row 8 |
| 11 | `policies.errors.unsupported_markup` | …contient {problem}. Supprimez-le puis enregistrez de nouveau. | …contient {problem}. Corrigez cela, puis enregistrez de nouveau. | « -le » after « une image » or « des balises » |
| 12 | `policies.acknowledge.confirm` | Confirmer | Confirmer la prise de connaissance | On its own it does not say what is confirmed. It is the signature button |
| 13 | `policies.errors.stale_document` | …affiche maintenant la dernière version ; vérifiez-la… | …affiche maintenant son dernier état ; vérifiez-le puis réessayez. | « Version » is the term for a document version. `stale_version` already says it this way |
| 14 | `dashboard.acknowledgementHelp` | {acknowledged} sur {targeted} personnes sollicitées, pour les versions en vigueur | Ont confirmé : {acknowledged} sur {targeted}, pour les versions en vigueur | « 1 sur 1 personnes » |
| 15 | `nav.items.policiesAwaiting`, `policies.awaiting.title` | En attente de moi | À traiter | « En attente de moi » is a calque |
| 16 | `policies.settings.active`, `.inactive` | Actif / Désactivé | En usage / Plus en usage | The same keys apply to « catégorie » (feminine) |
| 17 | `policies.editor.tools.heading1/2/3` | Titre / Sous-titre / Intertitre | Titre de niveau 1 / Titre de niveau 2 / Titre de niveau 3 | As Arabic row 7 |
| 18 | `policies.form.typeFixed` | …pour toute la vie du document. | Le type ne peut plus être modifié après la création du document. | Calque |
| 19 | `policies.editor.otherLanguageHelp` | Facultatif. … | Facultative. … | Refers to the language |
| 20 | `dashboard.tiles.awaitingMyApproval` | En attente de ma relecture ou approbation | En attente de ma vérification ou de mon approbation | Each noun needs its own determiner |
| 21 | `policies.errors.no_assignee` | (one long sentence) | Cette version ne peut pas être envoyée en vérification : une étape de son circuit n’a personne pour la décider. Chaque étape doit revenir à une personne qui n’a ni préparé la version ni décidé d’une étape précédente. Demandez à la personne qui gère les paramètres des documents de modifier le circuit. | As Arabic row 18 |
| 22 | `actions.publishAcknowledge`, `review.acknowledgementWithin`, `settings.stepLine`, `typeLine` | …dans le délai fixé (en jours) : {days} | …dans un délai de {days} après publication / {kind} : {who}, sous {days} | Decision 3. Filled with « 7 jours » |

**Vocabulary I confirm:**
- « document maîtrisé » and « Les copies imprimées ne sont pas maîtrisées ». One addition: « Seule la version publiée dans Trustline fait foi. » is the usual wording; I use it in the seed table.
- « circuit d’approbation » and « prise de connaissance ».
- « entité responsable », which is rightly generic.
- « Retiré » / « Retirer ce document ».
- « Abandonnée » for a withdrawn version, which stays clear of « Retiré ».
- « Révision périodique ».
- **To replace:** « relecture » (row 3).

---

## English (14 rows; the first 4 matter most)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `policies.review.signReview`, `signApprove` | You are signing, with your password, that you have reviewed {number}, version {version}, as it reads here. | By signing with your password, you confirm that you have reviewed {number}, version {version}, in every language it is written in ({languages}), as shown on this page. / By signing with your password, you approve {number}, version {version}, in every language it is written in ({languages}), as shown on this page. | "Signing that" is not idiomatic. Decision 2 covers the languages |
| 2 | `admin.permissions.policies.approve` (and `role_cannot_approve`) | Approve documents when named in an approval step | Review and approve documents when named in a step of an approval route | It also covers review steps |
| 3 | `policies.errors.password_locked` | …signing is locked for 15 minutes, as signing in is… | Too many wrong passwords: your account is locked for 15 minutes, for signing and for signing in. Nothing was signed. | As Arabic row 9 |
| 4 | `dashboard.pastReviewHelp` | {percent} of {of} current documents | {percent} of current documents ({of}) | "0% of 1 current documents" (`en-1280-dashboard.png`). Arabic and French already use the bracket |
| 5 | `policies.confidentialityHelp.all_staff` | Once published, anyone who may read documents can read it. | Once it is published, anyone who may read documents can read it. | Dangling participle |
| 6 | `policies.editor.ackRequired` | Ask everyone it applies to to acknowledge it | Ask everyone concerned to acknowledge it | "to to" |
| 7 | `policies.document.months`, `actions.publishAcknowledge`, `review.acknowledgementWithin`, `settings.stepLine` | {months} months / within {days} days | {months} / within {days} (filled as "36 months", "1 day") | "1 months" and "1 days" (decision 3) |
| 8 | `policies.review.stepStatus.waiting`, `.skipped` | Waiting / Skipped | Not open yet / Not reached | "Waiting" beside "To decide" (`en-1280-sign-prompt-sami.png`) |
| 9 | `policies.errors.unsupported_markup` | …contains {problem}. Remove it and save again. | …contains {problem}. Correct that and save again. | "Remove it" after "HTML tags", or after an indented line that should only be moved to the margin |
| 10 | `policies.editor.tools.heading1/2/3` | Heading / Subheading / Minor heading | Heading level 1 / Heading level 2 / Heading level 3 | Matches the H1/H2/H3 icons and the "levels" error |
| 11 | `policies.editor.missingCount` | {count} required to write | Required, not written: {count} | Ungrammatical |
| 12 | `policies.errors.no_assignee` | (one long sentence) | This version cannot be sent for review: a step of its approval route has no one who can decide it. Each step needs someone who did not prepare the version and did not decide an earlier step. Ask whoever manages document settings to change the route. | Readability |
| 13 | `policies.settings.typesHelp` | A change counts for versions started after it… | A change applies to versions started after it… | Wording |
| 14 | `policies.document.ownerUnit`, `form.ownerUnit`, `form.someUnits`, `form.units`, `list.ownerUnit` | Owning unit / Some units only / Units | (decision 5) | In English "unit" is the third level of the structure (facility, department, unit), but the screenshots show "Owning unit: Main site", which is a facility |

---

## Starting data for every client (`apps/api/src/policies/defaults.ts`) and the seed's example documents (`apps/api/src/database/seed-documents.ts`)

| Where | Current | Proposed | Reason |
|---|---|---|---|
| seed `POL-GOV-001` purpose (ar) | …وفق النسخة السارية والمعتمدة… | …وفق الإصدار الساري والمعتمد… | «نسخة» means copy; the screens say «الإصدار» |
| seed `POL-GOV-001` scope, statement 1 (ar) | الوثائق الخاضعة للرقابة / لكل وثيقة خاضعة للرقابة | الوثائق المضبوطة / لكل وثيقة مضبوطة | The screens say «وثيقة مضبوطة». The title of this very policy is «ضبط الوثائق» |
| seed `POL-GOV-001` statement 3 (ar) | النسخة الموجودة في Trustline وحدها هي السارية. **النسخ المطبوعة غير خاضعة للرقابة.** | الإصدار المنشور في Trustline وحده هو الساري. **النسخ المطبوعة غير مضبوطة.** | It must match the print stamp word for word |
| seed `POL-GOV-001` statement 3 (fr) | Seule la version dans Trustline est en vigueur. | Seule la version publiée dans Trustline fait foi. | « Fait foi » is the usual phrase |
| seed statement 1 and responsibilities (ar) | ومالك / **المالكون** | والمسؤول عنها / **المسؤولون عن الوثائق** | The screens say «المسؤول عن الوثيقة» |
| seed `PEOPLE` names (ar) | مالك الوثائق (مثال) / المراجع (مثال) / المعتمِد (مثال) | المسؤول عن الوثائق (مثال) / مُراجِع الوثائق (مثال) / مُعتمِد الوثائق (مثال) | «مالك» is also a man's first name (Malik). Without vowel marks, «المراجع» reads as «المَراجِع», "references", which is also a section name |
| seed `PEOPLE` and responsibilities (fr) | Vérificateur (exemple) / Les vérificateurs et les approbateurs | Keep if decision 1 is accepted; otherwise « Relecteur » | Must match the screens |
| seed, all French texts (4 places) | l’organisation | l’établissement | Review 5 confirmed « établissement » as the neutral word |
| seed `PRC-SAF-001` title, purpose and change summary (ar) | الإبلاغ عن الأخطار / الإبلاغ عن الخطر… / يُبلَّغ عن الخطر فورًا | الإبلاغ عن مصادر الخطر / الإبلاغ عن مصدر الخطر فور ملاحظته… / يُبلَّغ عن مصدر الخطر فورًا | «مصدر خطر» is the incident type the procedure tells people to choose (review 1) |
| seed `PRC-SAF-001` scope (ar) | في أي موقع | في أي مرفق من مرافقها | «مرفق» is the agreed term for a site |
| seed `PRC-SAF-001` responsibilities and steps (ar) | مدير المكان | المسؤول عن المكان | «مدير المكان» is unnatural |
| seed `PRC-SAF-001` purpose (fr) | dès qu’il est vu | dès qu’il est repéré | Wording |
| seed `PRC-QUA-001` step 4 (ar) | سجّل ما تم تعلّمه. | سجّل الدروس المستفادة. | The standard term |
| seed `PRC-QUA-001` scope (fr) | …de toute personne que l’organisation sert, quelle que soit la façon dont elles sont faites. | Les réclamations de toute personne bénéficiant des services de l’établissement, quel que soit le moyen utilisé. | Calque |
| seed `POL-INF-001` statement 1 (ar) | مع من يحتاجها لعمله | مع من يحتاج إليها في عمله | «احتاج» takes «إلى» |
| defaults section `steps` | Steps / الخطوات / Étapes | Steps / خطوات العمل / Déroulement | Settings shows both a procedure's "Steps" section and a route's "Steps", in all three languages |
| defaults section `exceptions_and_escalation` (fr) | Exceptions et escalade | Exceptions et procédure d’alerte | « Escalade » is an anglicism. Review 5 uses « procédure d’alerte » |
| defaults section `safety_notes` (ar) | ملاحظات السلامة | تنبيهات السلامة | Optional. They are warnings, not notes |
| defaults section `policy_statements` (fr) | Énoncés de la politique | Dispositions | Optional. « Énoncé de politique » is Canadian usage |
| defaults category `INF` | Information / المعلومات / Information | Information management / إدارة المعلومات / Gestion de l’information | The bare word does not say what the category holds |
| defaults types, other sections, other categories, route names | — | — | Good as written: «سياسة / إجراء / تعليمات عمل», « Objet », « Champ d’application », « Enregistrements », «اعتماد السياسات» |

---

## Layout faults

| Screenshot | Fault | Fix |
|---|---|---|
| `fr-390-print.png`, and the Arabic editor `ar-390-editor.png` | **Language names inside sentences are the languages' own names.** It shows « Ce document n’est pas rédigé en Français. Il est affiché en English. », « doivent être rédigées en English », and in Arabic «باللغة English». This affects `shownIn`, `notInYourLanguage`, `editor.intro`, `missing_sections` and `unsupported_markup`, in all three languages | In `controlled-document.tsx:12`, `version-editor.tsx:52` and `use-explain.ts`, fill `{language}` with the name in the reader's language: `new Intl.DisplayNames([lang], {type: "language"}).of(locale)` gives «الإنجليزية», « anglais », "French". Keep the languages' own names on the language buttons |
| `ar-1280-print.png`, `ar-390-acks.png`, `ar-390-review-v2-changes.png` | Masculine verbs before women's names | Arabic row 1 |
| `ar-390-library.png` | The Arabic search placeholder is cut at its start («م أو العنوان…»). `dir="auto"` on an empty input falls back to left-to-right (`library.tsx:228`) | Use `dir={query ? "auto" : direction(lang)}` and shorten the placeholder (Arabic row 22) |
| `fr-390-print.png` | The approval line wraps between the date and the time (« 27 nov. 2026, » then « 23:56 ») | Low. Put the date and time in one `whitespace-nowrap` span (`controlled-document.tsx:140`) |
| `ar-1280-edit.png` | The details page of a document that can no longer be edited shows one line and no way back | Low. Add the `policies.review.backToDocument` link |
| All 135 screenshots | They were taken at 20:47–21:01, before the final commit at 21:03. They still show «بـEnglish», «عند تسميته», a retired document listed as «سارٍ» and a document number broken as "PRC-SAF-" / "002" in `en-1280-sign-prompt-sami.png`. The code at HEAD fixes all four | Retake after this round |

**Right-to-left checks that passed:**
- Section numbers read «1. الغرض» from the right, in both the print view and the editor.
- Numbered and bulleted lists put their markers at the start, and the list icons are mirrored.
- Each text area and preview takes its own language's direction. Raw `##`, `-` and `**` sit at the correct end.
- Document numbers are unbroken `<bdi>` inside Arabic sentences, and an Arabic comma after a number lands correctly.
- The fingerprint is left-to-right.
- Percentages appear as «%0» and « 0 % ».
- Notifications lead with «الوثيقة {reference}:».
- Tick boxes sit at the start, and the disclosure triangles point the right way.
- The print stamp appears at the top and the foot, and the app shell is hidden in print.

---

## Summary

**Counts**
- Arabic: 24 rows (2 optional).
- French: 22 rows.
- English: 14 rows (1 waits on decision 5).
- Starting data and seed: 19 rows (2 optional).
- Layout: 2 faults that matter (language names in sentences, the gender of verbs before names), 3 small ones, and a stale set of screenshots.

**The three that matter most**
1. **Signatures and the control block.** In Arabic, the control block and the person lines use masculine verbs before women's names: «اعتمدها أمل», «أقرّ رنا». The sign prompt opens with «توقّع», which reads as "expect!". In all three languages the prompt says "as it reads here", but the hash covers every language, so a reviewer reading Arabic also signs for English text they may not have opened. In `ar-390-review-v2-changes.png`, Arabic shows "no change" while English changed.
2. **Language names inside sentences.** The screens show « rédigé en Français… affiché en English » and «باللغة English».
3. **Deadlines.** «قبل» and « avant le » exclude the due day, which the code allows. The overdue lines put the version and the date side by side.

**Needs a decision, not a fix**
1. **French review vocabulary:** replace « relecture / relu » with « vérification / vérifié », to match the French cartouche « Rédigé / Vérifié / Approuvé »? I recommend it.
2. **What a signature covers.** Either name every language in the prompt ({languages}, as proposed), or have each signer confirm each language. As it stands, the wording promises less than the signature records.
3. **Counted durations through `Intl`.** Add a formatter using `Intl.NumberFormat(lang, {style: "unit", unit: "day" | "month", unitDisplay: "long"})`. It gives «7 أيام», «36 شهرًا», « 36 mois » and "1 day", so the stilted «مدة بالأيام: {days}» patterns can go. Characters have no `Intl` unit, so they keep the "{count} / {max}" form.
4. **The control block and the print view.** Should the control block add «الإعداد» / « Rédigé par » / "Prepared by", as both the Saudi and the French layouts have it? Should the print stamp carry the print date ("Printed on {date}")?
5. **English "Owning unit".** "Unit" is the third level of the structure. Keep it as a generic word, or change it to something like "Responsible area" throughout?
6. **For the security reviewer, not wording:** `in_review_title` tells users the title is "part of what is being reviewed", but `signedVersion` does not include the title in the hash.

**Screens opened and screens only read**
- **Opened:**
  - Arabic: `ar-1280-print`, `ar-390-print`, `ar-1280-document`, `ar-1280-dashboard`, `ar-1280-edit`, `ar-390-editor` (with crops of the toolbar, counter, middle and bottom), `ar-390-review-v2-changes`, `ar-390-notifications`, `ar-390-settingsRoutes`, `ar-390-acks`, `ar-390-library`.
  - French: `fr-390-print`, `fr-390-editor` (top and bottom crops), `fr-390-document` (lower half), `fr-390-dashboard` (lower half).
  - English: `en-1280-sign-prompt-sami`.
- **Read in the dictionary and code only, no screenshot opened:**
  - the awaiting page, the settings pages for types and categories, the new-document form, version 2, the retired and scheduled screens, and role permissions;
  - the refusals: wrong password, same person and awaiting publication. These are not in the Arabic or French screenshot set.

**Files**
- `/home/user/Trustline/apps/web/src/i18n/dictionaries/en.json`, `/home/user/Trustline/apps/web/src/i18n/dictionaries/ar.json`, `/home/user/Trustline/apps/web/src/i18n/dictionaries/fr.json`
- `/home/user/Trustline/apps/web/src/components/policies/controlled-document.tsx`: language name at line 12, approval lines around line 140
- `/home/user/Trustline/apps/web/src/components/policies/version-editor.tsx`: language name at lines 52 and 433, toolbar at 393–401
- `/home/user/Trustline/apps/web/src/components/policies/use-explain.ts`: language name in refusals
- `/home/user/Trustline/apps/web/src/components/policies/library.tsx`: search input at line 228
- `/home/user/Trustline/apps/api/src/policies/defaults.ts`, `/home/user/Trustline/apps/api/src/database/seed-documents.ts`
- `/home/user/Trustline/apps/api/src/policies/signed-content.ts`: what a signature covers
- `/home/user/Trustline/apps/api/src/identity/auth.service.ts:322`: the lock shared with sign-in
- `/home/user/Trustline/apps/api/src/policies/documents.service.ts:401`: due-day rule