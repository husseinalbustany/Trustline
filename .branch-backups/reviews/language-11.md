# Language review 11: reports, data export, Approving authority, AI drafting (52b530e..5f21929)

## Decisions
- Accept every item in every table.
- Trustline is grammatically masculine in Arabic everywhere.
- The conversational AI feature is named "Chat assistant" / «المحادثة مع المساعد الذكي» / « Assistant conversationnel ».
- The fixed AI notices (drafting and suggestion) are added in three languages to design-guidelines-and-branding.md, with the code pointing to one source.
- The Approving authority description rewording needs a new migration with its own audit entry (after the risk merge).
- Who: API reports, export, audit, email, permissions wording: the API engineer (Ziad). API AI and drafting wording (prompts.ts colon, audit labels ai_*, organization_profile_updated): the AI engineer (Karim). Web (reports, AI and drafting dictionaries, data export keys and screens): the web engineer (Maya).

# Bilingual review 11: reports, data export, Approving authority, AI drafting (52b530e..5f21929)

I changed no project files. My scratch files are in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour11/`: dictionary dumps, two crops and `details.ts`, which renders audit detail lines with `tsx`.

The biggest problems:
- Audit detail lines still print raw codes: `policies`, `snapshot`, `ar` and measure codes.
- The settled terms are not used in the new detail fields or in the export (harm level, language that applies, owner and responsible area, modules, plan).
- The French export and email wording says « organisation » throughout and has no no-break spaces.
- Several drafting refusals do not say what to do.

## What I opened and what I only read
- **Screens:** I opened none live.
  - I started `pnpm dev`, but the working tree has an uncommitted `apps/api/src/database/schema.ts` change from another session. The API did not compile against it (2 TS errors in `email-worker.service.ts:289` and `incidents/notifier.ts:24`).
  - I stopped both servers at once so I would not get in that session's way.
- **Screenshots I viewed:**
  - `ar-1280-reports`, `ar-1280-reports-chart-focus`, `ar-1280-reports-revisions`, `ar-390-reports`, `ar-390-reports-revisions`, `ar-1280-report-settings`;
  - `en-1280-reports`, `en-390-reports-revisions`;
  - `fr-390-reports-revisions`.
  - They were taken at 10:30–10:36. `reports-view.tsx` changed again in 5f21929 (11:29), so re-check the layout points at HEAD.
- **Emails:** I read them and did not render them.
- **Read only:** everything else.

## What is already right
- The three dictionaries have the same 2,920 keys, with matching placeholders and no empty values.
- The new components have no text in the markup, no physical classes, no branching on a language and no direction-implying arrows.
- The web `fill()` isolates the values it inserts.
- **Arabic chart, read right to left:**
  - The first month is at the right and the last at the left.
  - The scale is at the inline start and the target label at the end.
  - The point buttons use `insetInlineStart`, so keyboard order follows time.
  - The hover caption matches the point. I checked July 2026, fourth from the left.
- An English reason inside an Arabic revision line renders correctly.
- Review 10 was applied to the audit labels, the CSV headings, the templates and the emails. «مقيّم خارجي» is used everywhere.
- The web `audit.actions` labels equal the API labels, except the 9 `data_export_*` labels, which are missing on the web.

---

## 1. Reports

| Key or file:line | Lang | Problem | Proposed |
|---|---|---|---|
| **Must fix** | | | |
| `reports.noAccess` | all | It quotes a permission name that does not exist. The label is "View reports and dashboards". | en "Reports are for those who hold “View reports and dashboards”." · ar «…لمن يحمل صلاحية «الاطلاع على التقارير ولوحات المعلومات».» · fr « …« Consulter les rapports et tableaux de bord ». » |
| `audit/details.ts:24` `CODED` (seen in `measures_snapshot_taken`) | all | `module` and `method` are not worded. The output is "Module: policies", "How it was taken: snapshot" and «الوحدة: policies». | Add `module` and `method` to `CODED`. The values already exist. |
| `report_settings_changed` details | all | The output is "Targets: incidents.triaged_on_time: 95 → incidents.triaged_on_time: 85", with raw measure codes. | One line per changed measure, named from `REPORTS_WORDING.measures`. en "Triaged on time: 95% → 85%" · ar «الفرز في الموعد: من 95% إلى 85%» · fr « Tri dans les délais : 95 % → 85 % ». Do the same for `measure_correction_requested.values` and `measures`. |
| `measures_exported` and `measures_snapshot_taken` details | all | "Language: ar" and "Month: 2026-10" are raw values. | The language name (`languages`: «العربية», « arabe »), and the month as the web writes it. |
| `audit.details.fields.module` (`ar.ts:184`) | ar | «الوحدة» means an organizational unit in Reports. The settled word for a module is «جزء النظام» (6 uses). | «جزء النظام» |
| `reports.noMeasures` | ar | «الوحدات المتاحة لمنشأتك» reads as "units". | «…فهي تتوقف على أجزاء النظام المتاحة لمنشأتك، وعلى ما يمكنك الاطلاع عليه في هذه الوحدة.» |
| `reports.target.unknown` | ar | «غير محكوم عليه» means "not sentenced". | «لم يُقيَّم» |
| `reports.targetSource.business`, `settings.targetsHelp`, `settings.business` | en | "Business target" is Trustline's own jargon (seen in `en-1280-reports`). | "the default target" / "Leave a target empty to use the default target." / "Default target: {value}" |
| same | fr | « objectif de référence » clashes with « référence » for the baseline («votre référence»), on the same screen. | « l’objectif par défaut » / « Objectif par défaut : {value} » |
| `reports.trend.openRevisions`, `reports.history.title`, `reports.trend.chart` | fr | There is no elision before a vowel: « Révisions de août 2026 » (seen in `fr-390`), « de octobre ». | « Historique des chiffres : {month} » and « {measure}, mois par mois : {first} – {last} » |
| **Should fix** | | | |
| `reports.trend.how` vs API `csv.method` and `details.fields.method` | ar, fr | The same column has two names. ar has «طريقة التسجيل» on the web and «طريقة الحساب» in the API; fr has « Mode de relevé » and « Méthode ». The values are «مسجَّل / معاد بناؤه / مصحَّح». | ar «طريقة التسجيل» and fr « Mode de relevé » everywhere. |
| `reports.trend.counted` vs `csv.numerator` | ar, fr | ar «المحسوب» vs «العدد المحتسب»; fr « Comptés » vs « Compté ». | ar «العدد المحتسب» · fr « Comptés » in both. |
| `reports.organization` vs API `organization` (reports and export) | ar, fr | ar «المنشأة كلها» vs «المنشأة كاملة». fr export has « Toute l’organisation ». | ar «المنشأة كلها» · fr « Tout l’établissement » in all three places. |
| `reports.trend.revisions`, `history.*`, `settings.correction.done`, `csv.revision` | ar | «مراجعة» is the settled word for document review, so «مراجعات أكتوبر» reads as "October's reviews". | «التنقيحات» / «التنقيح {revision}» / «ولكل رقم الآن تنقيح جديد» |
| `reports.targetSource.baseline` | ar | «لديكم» is plural, but the same screens use the singular «منشأتك». | «خط الأساس لدى منشأتك» |
| `reports.settings.note` (label «مصدره · English») | ar | A bare pronoun is used as a field label (seen in `ar-1280-report-settings`). | «مصدر الرقم» |
| `reports/wording/*.ts` `csv.asAt` | all | No time zone is named. Review 10 settled this for the audit CSV. | en "As at ({zone})" · ar «حتى تاريخ ({zone})» · fr « Arrêté au ({zone}) » |
| `reports.service.ts:309` unit path | all | `name ->> locale` has no fallback. A unit with no Arabic name leaves an empty segment. | Use `pickText` per segment. |
| Percent display in Arabic (`reports-view.tsx:39`) | ar | Big figures and table cells show "40%". The target and caption lines show "%85" (`ar-1280-reports-chart-focus`). | Isolate every formatted figure the same way, for example `<bdi dir="ltr">` inside sentences too. |
| Figures table (`ar-1280-reports-revisions`, `en-390`, `fr-390`) | all | At 1280, the month column is cut off at the inline start. At 390, the open revisions make the whole page wider than the screen, in all three languages. | Wrap the method pill, or keep the month column sticky. Contain the scroll inside the panel. Re-check at HEAD. |
| **Low** | | | |
| `reports.values.seconds` | ar | «ث» is a rare abbreviation. | «{value} ثانية» |
| `reports.measures.actions.overdue.help` | ar | «كنسبة من» is a calque. | «…منسوبةً إلى الإجراءات المفتوحة» |
| `reports.settings.correction.notFound` | fr | « choisi » does not agree. | « Un des indicateurs ou des unités choisis ne fait pas partie de ce que vous pouvez voir. » |
| `reports/wording/fr.ts` `csv.unitPath` | fr | « organisation » | « Place dans la structure » |
| Target line "(the default target)" after "Target:" | ar | «الهدف: … (الهدف الافتراضي)» repeats «الهدف». | «(القيمة الافتراضية)» |

## 2. Data export

| Key or file:line | Lang | Problem | Proposed |
|---|---|---|---|
| **Must fix** | | | |
| `exports/wording/fr.ts`, `email/wording/fr.ts` (`data_export_*`), the contract's permission label | fr | « organisation » is used 16 or more times. The settled word is « établissement ». | « votre établissement », « l’établissement », « fuseau horaire de l’établissement » |
| `exports/wording/fr.ts` (whole file) | fr | All 33 spaces before « : ; » are ordinary spaces. « e-mail » has no word joiner. `audit/wording/fr.ts:418-419` also has 4 ordinary spaces. | Apply U+00A0 before « : », U+202F before « ; ? ! », and « e-⁠mail » (U+2060). |
| Contract permission label (fr) | fr | It uses a straight apostrophe and « organisation ». | « Demander, approuver et télécharger une exportation complète des données de l’établissement » |
| `csv.incidents.harm_level` | ar, fr | ar «درجة الضرر» and fr « Niveau de gravité ». The settled terms are «مستوى الضرر» (9 uses) and « Niveau de préjudice ». | «مستوى الضرر» · « Niveau de préjudice ». The same fix applies to `audit details.fields.harmLevel`. |
| `html.fallback`, `html.lagging` | ar | «اللغة المعتمدة» should be «اللغة المرجعية» (review 7). Also, «بـ{language}» renders as «بـالإنجليزية». | «لم يُكتب بهذه اللغة، فيُعرض باللغة {language}، وهي اللغة المرجعية.» / «لم تُحدَّث الترجمة: تغيّر النص باللغة المرجعية في هذا الإصدار، ولم يتغيّر هذا النص.» |
| `csv.documents.owner_id`, `owner_unit_id`, `html.owner`, `html.ownerUnit` | all | These are not the settled terms: «المالك / الوحدة المالكة», « Propriétaire / Unité propriétaire », "Owning unit". | en "Owner" / "Responsible area" · ar «المسؤول عن الوثيقة» / «الجهة المسؤولة» · fr « Responsable » / « Entité responsable » |
| `csv.incident_events.incident_id` | ar | «الحادثة»: the settled word is «الحادث». | «الحادث» |
| `readme.folders.incidents`, `personal[0]`, `notIncluded[1]` | ar | «المجهول» / «غير مجهول». The settled wording is «دون ذكر الاسم». | «البلاغ المقدَّم دون ذكر الاسم لا يذكر أحدًا، هنا كما في Trustline.» / «ومقدّم كل بلاغ ذُكر فيه الاسم» / «الرمز السري الذي يتابع به من أبلغ دون ذكر اسمه بلاغَه.» |
| `readme.personal[0]`, `notIncluded[0]` and `[3]` | all | "sign-in addresses" / «عناوين الدخول»: review 10 settled IP addresses. Also «رموز الدخول». | en "their sign-in times and IP addresses" · ar «أوقات تسجيل دخولهم وعناوين IP التي دخلوا منها»، «رموز تسجيل الدخول»، «عناوين IP لتسجيل الدخول التي مُسحت» · fr « leurs heures et adresses IP de connexion » |
| `values.acknowledged` | fr | « Pris connaissance » is not French. | « Prise de connaissance » |
| `values.facility`, `readme.folders.structure` | fr | « Établissement » here means a facility, which clashes with the organization. The settled word is « Site ». | « Site » / « structure/ : sites, services et unités. » |
| `readme.folders.settings` | ar | «وحدة من وحدات النظام» uses the word for unit. | «وفي ملفات أخرى إعدادات كل جزء من أجزاء النظام.» |
| `data_export_*` labels (`audit/wording/fr.ts:108-116`) | fr | Every other label is a noun phrase; these use a participle. | « Demande d’exportation complète des données » · « Approbation de… » · « Refus de… » · « Annulation de… » · « Expiration de la demande d’exportation complète, sans approbation » · « Mise à disposition de… » · « Échec de la préparation de… » · « Téléchargement de… » · « Expiration de l’exportation complète des données » |
| `data_export_ready`, `data_export_lapsed` (`ar.ts:112-113`) | ar | These are sentences, not verbal nouns like the other labels. | «إتاحة التصدير الكامل للبيانات للتنزيل» / «انقضاء مهلة اعتماد طلب التصدير الكامل للبيانات» |
| Details of `data_export_requested` | all | "Language: ar" is a raw code. | The language name. |
| Missing web keys | all | `admin.permissions["data.export"]`, the role editor's warning, `notifications.kinds.data_export_changed`, and the 9 `audit.actions.data_export_*` labels are all missing. | Labels: en "Ask for, approve and download a full export of the organization's data" · ar as in the contract · fr as above. **Warning:** en "This gives everything the organization holds in Trustline: reporters' names, internal comments, restricted documents and the whole audit trail. A full export needs two people who hold it: one asks, the other approves. Give it only to those who will answer for the data once it leaves Trustline." · ar «تتيح هذه الصلاحية كل ما لدى المنشأة في Trustline: أسماء المبلّغين، والتعليقات الداخلية، والوثائق المقيّدة، وسجل التدقيق كاملًا. ويحتاج التصدير الكامل إلى شخصين يحملانها: أحدهما يطلب والآخر يعتمد. لا تمنحها إلا لمن يتحمّل مسؤولية البيانات بعد خروجها من Trustline.» · fr « Cette permission donne accès à tout ce que l’établissement détient dans Trustline : noms des déclarants, commentaires internes, documents restreints et journal d’audit complet. Une exportation complète demande deux titulaires : l’un la demande, l’autre l’approuve. Ne la donnez qu’aux personnes qui répondront des données une fois sorties de Trustline. » |
| **Should fix** | | | |
| Emails `data_export_requested.body`, `cancelled`, `refused`, `lapsed` | ar | «لا يُعدّ» and «لم يُعدّ شيء» read as "is not counted". | «ولن يبدأ إعداده قبل أن يعتمده شخص آخر» / «ولم يُنشأ أي ملف.» |
| Email `data_export_requested.body` | all | It does not say what to do if the request is unexpected. | en "…Open Trustline to see who asked. If you do not expect it, refuse it there." · ar «…افتح Trustline لمعرفة من طلبه، وإن لم تكن تتوقعه فارفضه من هناك.» · fr « …Ouvrez Trustline pour voir qui l’a demandée ; si vous ne l’attendiez pas, refusez-la. » |
| Email `data_export_ready.body` | all | It leaves out the 5-download limit (spec decision 8). | en "…can download it in Trustline, up to 5 times within 7 days." · ar «…تنزيله من Trustline 5 مرات على الأكثر خلال 7 أيام.» · fr « …jusqu’à 5 fois dans les 7 jours. » |
| « export » in labels, emails, README and the permission | fr | The audit trail and `fr.json` say « Exportation(s) » (7 uses); the new wording says « export ». | « exportation complète des données » (feminine: « a été demandée »). |
| `README.ar.txt`, folder lines (`archive.ts:749`) | ar | "- organization/: …" starts with a Latin letter, so in a text viewer the line runs left to right. | Start with Arabic: «- مجلد ‎organization/‎: المنشأة…» |
| `html.ts:173` fallback section | all | It has `lang` but no `dir`. English text shown in an Arabic page runs right to left. | Add `dir` from the language of the text shown. |
| Export HTML of an `ai_drafted` document not yet owned | all | It has no "AI draft" mark. The design guidelines keep the mark until a person takes ownership. | Add `html.aiDraft`: "AI draft" / «مسودة ذكاء اصطناعي» / « Brouillon IA », and the notice. |
| `csv.incident_events` `occurred_at`, `kind`, `actor_id`, `from_status` and `to_status` | en, ar | "When", "What happened" and "By" are vague. «بواسطة» and «الحالة قبل / بعد» are calques. | en "Date and time" / "Event" / "Done by" / "Status before" / "Status after" · ar «التاريخ والوقت» / «الحدث» / «القائم بالإجراء» / «الحالة السابقة» / «الحالة الجديدة» |
| `csv.incidents.owner_unit_id`, `occurred_at`, `immediate_action` | ar | Not the settled terms. | «القسم المعني بالمعالجة»، «تاريخ ووقت الوقوع»، «الإجراء الفوري المتَّخَذ» |
| `data_export_failed` detail `kind` | all | "Kind: TypeError" | Label: "Technical cause" / «السبب التقني» / « Cause technique » |
| **Low** | | | |
| `html.effective`, `html.approvedBy` | ar | «سارية من» agrees with a feminine noun. «اعتمدها» is a verb used as a label. | «تاريخ السريان» / «المعتمِد» |
| `csv.documents.retired_at`, `due_on`, `org_units.parent_id` | ar | | «تاريخ إيقاف العمل بها»، «تاريخ الاستحقاق»، «تابع لـ» |
| `values.commented`, `sign_off_requested` | fr | Participles among noun phrases. | « Ajout d’un commentaire », « Demande de validation » |
| `.note { font-style: italic }` (`html.ts:117`) | ar | Arabic has no italic, so browsers slant it artificially. | `:lang(ar) .note { font-style: normal }` |

## 3. The Approving authority's new description (migration 0067, `permissions.ts:191-195`)

| Where | Lang | Problem | Proposed |
|---|---|---|---|
| **Should fix** | | | |
| description | en | "restricted ones and drafts included" reads as a third item in the list. "Reports on documents" is vague: the role sees the document measures. | "Gives the final approval of controlled documents, reads every document (restricted ones and drafts included), and reads the document measures in Reports." |
| description | fr | « documents » appears four times. | « Donne l’approbation finale des documents maîtrisés, lit tous les documents (brouillons et documents restreints compris) et consulte les indicateurs documentaires des rapports. » |
| description | ar | «يمنح الاعتماد» is a calque, and «تقارير الوثائق» is vague. | «يتولى الاعتماد النهائي للوثائق المضبوطة، ويقرأ كل الوثائق بما فيها المقيّدة والمسودات، ويطّلع على مؤشرات الوثائق في التقارير.» |

If 0067 has already run anywhere, this rewording needs a new migration with its own audit entry. 0067 only rewrites the exact old English text.

## 4. AI foundation and drafting

| Key or file:line | Lang | Problem | Proposed |
|---|---|---|---|
| **Must fix** | | | |
| `drafting/prompts.ts:56` `colon()` | fr | « [À décider : …] » uses an ordinary space and can break before the colon. | `' : '`. The `\s?:` regexes in `prompts.ts` and `web lib/ai.ts:98` already accept it. |
| `policies.drafting.notice` | ar | «مساعد بالذكاء الاصطناعي» is not the settled term. «قبل الاعتماد عليه» uses the word for approval, next to «يُعتمد». «دون أشخاص» is awkward. | «كتبه المساعد الذكي، وقد يحتوي أخطاء أو نقصًا: راجِع كل جزء منه في ضوء طريقة العمل في منشأتك قبل الأخذ به. ولا يُعتمد شيء مما يكتبه ولا يُنشر إلا بقرار من شخص.» |
| `policies.drafting.notice` | en, fr | en "without people" is awkward. In fr, « Il » after « Rédigé par » is ambiguous. | en "Written by an AI assistant. It can be wrong or incomplete: check every part against how your organization works before you rely on it. Only a person can approve or publish what it writes." · fr « Ce texte a été rédigé par un assistant d’IA. Il peut contenir des erreurs ou des oublis : vérifiez chaque partie au regard du fonctionnement de votre établissement avant de vous y fier. Seule une personne peut approuver ou publier ce qu’il rédige. » |
| «بمساعدة المساعد الذكي» (10 keys: `withAssistant`, `newTitle`, `notActive`, `conversationTitle`, `historyLink`, `historyTitle`, `notOwned`, `ownedBy`, `errors.not_ai_draft`; audit `ai_draft_started`, `values.ai_drafted`) | ar | This literally says "with the help of the helper". | «مع المساعد الذكي»: «صِغها مع المساعد الذكي»، «الصياغة مع المساعد الذكي»، «صيغت مع المساعد الذكي»، «مُعدّة مع المساعد الذكي» |
| `ai.markExample`, `policies.drafting.aiDraft`, `errors.ai_draft_not_owned`, `handOverHelp`, audit `ai_draft_ownership_taken` | ar | «مسودة بالذكاء الاصطناعي» is unidiomatic, and the audit label uses a third form. | Mark: «مسودة ذكاء اصطناعي». In sentences: «مسودة أعدّها الذكاء الاصطناعي». |
| `policies.errors.ai_not_offered` | all | "AI is not available for this." It is vague and says nothing to do. | en "AI drafting is not offered to your organization. You can still write the document yourself." · ar «الصياغة بالذكاء الاصطناعي غير متاحة لمنشأتك، ويمكنك كتابة الوثيقة بنفسك.» · fr « La rédaction avec l’IA n’est pas proposée à votre établissement. Vous pouvez toujours rédiger le document vous-même. » |
| `policies.errors.not_asking`, `not_ready`, `not_drafted` | all | None says what to do. | en "The assistant has finished asking questions. Reload the page to see where the draft is." / "This conversation cannot be drafted yet: answer the open questions first, or reload the page." / "There is no draft yet. Choose “Draft it now” first." · ar «…أعد تحميل الصفحة لترى ما وصلت إليه المسودة.» / «لا يمكن صياغتها بعد: أجب عن الأسئلة المفتوحة أولًا، أو أعد تحميل الصفحة.» / «لا توجد مسودة بعد. اختر «صِغها الآن» أولًا.» · fr similarly. |
| `ai.inference.regional` | ar | «لـ {region}» renders as «لـ الإمارات» or «لـ الاتحاد الأوروبي». | «ضمن النطاق الجغرافي الذي تقع فيه {region}» |
| `ai.inference.in_region` and `regions.*` | fr | « dans la région les Émirats arabes unis », « dans les États-Unis » | `in_region` « uniquement {region} », with locative region names: « aux Émirats arabes unis », « aux États-Unis », « dans l’Union européenne », « dans toute région ». `regional`: « dans la zone géographique {region} » with the same names, or a separate genitive form. |
| `ai.reasons.plan`, `platform.ai.planAllowance`, `followPlan` | ar | «خطة» is used for plan; the settled word is «الباقة» (38 uses). | «غير مشمول في باقة منشأتك.» / «حصة الباقة: {value}» / «اتباع الباقة» |
| `notifications.kinds.ai_allowance_reached` | all | "so it is paused": it is unclear what is paused. In fr, « suspendu » has no subject. | en "AI, {feature}: this month's allowance of {allowance} is used up. It is paused until {resetsOn}; you can still write by hand." · ar «…نفدت حصة هذا الشهر البالغة {allowance}، فتوقف حتى {resetsOn}، وتظل الكتابة اليدوية متاحة.» · fr « IA, {feature} : l’allocation du mois ({allowance}) est épuisée ; l’IA est suspendue jusqu’au {resetsOn}. La rédaction à la main reste possible. » |
| `ai_use_changed` details | all | "From: No · To: Yes" | Word it from `to`: en "Now: on" / "Now: off" · ar «الحالة الآن: مفعّل / غير مفعّل» · fr « Désormais : activée / désactivée » |
| `organization_profile_updated` | ar, fr | «للمؤسسة» and « de l’organisation ». | «تعديل الملف التعريفي للمنشأة» · « Modification du profil de l’établissement » |
| `policies.design.fonts.sans` / `.serif` | ar | «بدون تذييل / بتذييل» uses the word for footer, and «التذييل» is the footer on the same form. | «بلا زوائد» / «بزوائد» |
| **Should fix** | | | |
| "the assistant" (drafting) vs the "Assistant" feature (`ai.features.assistant`, `platform.ai.features.assistant`) | all | Two different things share one name on the AI settings screen. | Rename the conversational feature: "Chat assistant" / «المحادثة مع المساعد الذكي» / « Assistant conversationnel ». |
| Gap vocabulary | all | en uses "gap", "To be decided" and "Gaps to fill". ar uses «فجوة», «ثغرات» and «نقاط لم تُحدَّد بعد». fr uses « point à compléter » and « Points à décider ». | Match the mark: "points to decide" · «نقاط لم تُحدَّد بعد» · « points à décider », in `emptyIsUndecided`, `noQuestionsYet`, `gaps` and audit `fields.gaps`. |
| Allowance vocabulary | all | en "allowance" (18 uses) vs "AI credits" (`admin.settings.subscription.ai`); ar «حصة» (10) vs «أرصدة» (subscription and audit `aiAllowances` / `allowances`); fr « allocation » (8) vs « Crédits ». | "allowance" / «حصة» / « allocation » everywhere. |
| `policies.errors.ai_switched_off`, `draft_changed`, `handed_over`, `already_owned`, `subscription_suspended` | all | They say what happened but not what to do. | Add en "Ask your administrator to switch it on." / "Check it, then try again." / "Open the document instead." / "Reload the page to see who." / "Ask your administrator." |
| `policies.drafting.keptFor` | en | Fronted participles are hard to read, and "Handed over" does not match the button. | "Only you can see this conversation. If you make it a document, it is kept with the document. If you discard it, it is removed the next day. If it is left untouched for 90 days, it is removed." |
| `policies.drafting.requestHelp`, `profile.organizationTypeHelp`, `profile.measuresHelp` | all | "Do not name patients", "a general hospital…" and "beds" are not neutral for every organization. | "Do not write anyone's name." · «لا تكتب اسم أي شخص.» · « N’écrivez le nom de personne. ». For the examples, add a non-hospital one: "a general hospital, or a food plant with three lines". |
| `policies.drafting.status.drafted`, `.handed_over`, `.asking` | ar, en | Bare verbs used as status pills, and a vague "Questions". | ar «تمت الصياغة» / «حُوّلت إلى وثيقة» / «بانتظار الإجابات» · en "Waiting for your answers" |
| Singular vs plural address (`design.sourceHelp.defaults` «ملفكم», `profile.fromSettings` «إعداداتكم», `ai.reasons.module` «اشتراككم») | ar | The same screens use the singular «منشأتك». | «ملفك التعريفي»، «إعداداتك»، «اشتراك منشأتك» |
| `profile.edition`, `profile.standardKinds.regulation` | ar | «الإصدار» is document version, and «نظام» clashes with «النظام» (system) on the same form. | «الطبعة» / «لائحة تنظيمية» |
| `ai_settings_changed` | ar | «من قِبل» is a calque. | «تعديل فريق Trustline لإعدادات الذكاء الاصطناعي» |
| `ai_draft_questions_asked`, `ai_draft_version_created` | ar | The first reads as a sentence. The second is fine. | «أسئلة من المساعد الذكي» |
| API `details.ts:87` `fill` | ar | Values are not isolated, unlike the web. A Latin name or a code inside an Arabic detail line can reorder, and the same text goes to the CSV. | Wrap each value in U+2068 … U+2069. |
| `platform.ai.featureUse` | ar | «{requests} طلبًا» is only right for 11–99. | «عدد الطلبات: {requests}» |
| `platform.ai.limitHelp` | en, fr | "Reached, every client's AI pauses" / « Atteinte, … » | "Leave empty for no limit. When it is reached, AI pauses for every client until the next month." · « Laissez vide pour ne fixer aucune limite. Une fois atteinte, l’IA de tous les clients est suspendue jusqu’au mois suivant. » |
| `platform.ai.errors.inference_type_not_offered`, `unknown_connection`, `connection_inactive`, `credential_env_mismatch`; `policies.design.unknownSection` | all | They do not say what to do. | Add "Choose global or regional processing." / "Choose another connection." / "Use a name that starts with this provider's prefix." / "Remove that guidance, or add the section to a document type." |
| **Low** | | | |
| `policies.drafting.assumptionsHelp` | ar | «المسؤول … مسؤول» | «فالمسؤول عن الوثيقة يتحمّل تبعتها.» |
| `policies.drafting.gaps` | en | It is identical to `gap`. | "Points still to decide" |
| `ai.notice` usage on the questions panel | all | The notice says "Written by…" above the assistant's questions. | Acceptable. A shorter variant for questions would read better. |
| « assistant IA » | fr | Other keys use « d’IA » (« réglages d’IA », « Crédits d’IA »). | « assistant d’IA » |
| Trustline's grammatical gender | ar | It is masculine in the new AI keys («يتيح / أوقفه Trustline») and feminine in the subscription and README («تديره / تنشرها Trustline»). | Pick one. I suggest masculine, since it is the more common form in `ar.json`. |

**Gap marks.** "[To be decided: …]" and «[لم يُحدَّد بعد: …]» read well, and the brackets mirror correctly in Arabic. Only the French space needs fixing (above). The mark names in the spec (`ai-policy-drafting.md:313-315`) match the code.

**AI mark and notice.** `design-guidelines-and-branding.md` gives the mark as "AI draft" / "AI suggestion" but not the notice's wording. The notice exists only in `policies.drafting.notice`. The suggestion notice is in `ai-insights.md:242`. Either add both texts, in three languages, to the guidelines, or point the guidelines to those two places.

## Other wording added since review 10 (audit detail fields)

| Key | Lang | Problem | Proposed |
|---|---|---|---|
| `details.fields.authoritative`, `authoritativeLocale` | ar | «اللغة المعتمدة» (review 7 settled «اللغة المرجعية») | «اللغة المرجعية» / «اللغة المرجعية (المختارة)» |
| `details.fields.ownerUnitId` | all | "Owning unit" / «الوحدة المسؤولة» / « Unité responsable » (review 6) | "Responsible area" / «الجهة المسؤولة» / « Entité responsable » |
| `details.fields.harmLevel` | ar, fr | «درجة الضرر» / « Niveau de gravité » | «مستوى الضرر» / « Niveau de préjudice » |
| `details.values.rejected` | en, fr | "Set aside" / « Écarté » (review 1) | "Not taken forward" / « Classé sans suite » |
| `details.fields.requestedBy` | ar | «طلبها» agrees with a feminine noun, but «تصحيح» is masculine. | «مقدِّم الطلب» |
| `details.fields.version` on `ai_draft_*` | ar | «الإصدار» is the word for a document version; the drafting screens say «النسخة». | Use «النسخة» for drafting actions. |

## Files
- `/home/user/Trustline/apps/api/src/reports/wording/{en,ar,fr}.ts`, `/home/user/Trustline/apps/api/src/reports/reports.service.ts` (lines 296-345)
- `/home/user/Trustline/apps/api/src/audit/wording/{en,ar,fr}.ts`, `/home/user/Trustline/apps/api/src/audit/details.ts` (lines 24, 87)
- `/home/user/Trustline/apps/api/src/exports/wording/{en,ar,fr}.ts`, `/home/user/Trustline/apps/api/src/exports/archive.ts` (lines 739-767), `/home/user/Trustline/apps/api/src/exports/html.ts` (lines 117, 173)
- `/home/user/Trustline/apps/api/src/email/wording/{en,ar,fr}.ts` (lines 58-91)
- `/home/user/Trustline/apps/api/drizzle/0067_approving_authority_reports.sql`, `/home/user/Trustline/apps/api/src/identity/permissions.ts` (lines 185-197)
- `/home/user/Trustline/apps/api/src/drafting/prompts.ts` (lines 54-61), `/home/user/Trustline/apps/web/src/lib/ai.ts` (line 98)
- `/home/user/Trustline/apps/web/src/i18n/dictionaries/{en,ar,fr}.json` (`reports.*`, `ai.*`, `policies.drafting.*`, `policies.errors.*`, `policies.design.*`, `profile.*`, `platform.ai.*`, `notifications.kinds.ai_*`)
- `/home/user/Trustline/apps/web/src/components/reports/reports-view.tsx`, `trend-chart.tsx`, `/home/user/Trustline/apps/web/src/components/ai/ai-mark.tsx`
- `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/export-api-contract.md`
- Scratch: `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour11/details.ts` (detail rendering), `dump.py`, `crop-reason.png`, `crop-table.png`