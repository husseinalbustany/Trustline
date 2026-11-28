## Decisions (taken by the lead; apply all of this)

Every row of the Arabic, French and English tables is accepted, optional ones included, and every
layout fault with its proposed fix (separate confirm and keep buttons, the limit pairs as one
unbreakable "{name}: {value}" piece, the portal title on a phone, the notification button on a phone).
Retake the stale screenshots.

On the five decisions:
1. Accepted: "changes are paused" replaces "read-only" in the banner, the refusals and the status
   labels, in the three languages, as rows 2 propose.
2. Accepted: «لم تعد تُطرح» and «إيقاف طرح الباقة» for a retired plan throughout.
3. Accepted: apply the whole neutral-wording table now. Per-sector variants (harm definitions,
   "sentinel event" in en and fr, the accreditation field, categories, "patient" help lines) wait
   for a business decision on recording a sector per client: leave those strings as they are.
4. The harm definitions go to a clinician; leave them unchanged in this pass, except Arabic rows 3
   and 25 and French row 19, which are wording fixes, not clinical changes.
5. Accepted: the public pages name the organization. Add {organization} to publicReport.description
   and publicReport.privacy (and anywhere else on the public pages the sentence reads better with
   the name), filled with pick(name) for the organization; keep the neutral word where no name is known.

---

## Language review 5: modules, plans, subscriptions, quality and regression rounds (en / ar / fr)

I reviewed HEAD 91cae29. I changed no repository file and started no server. My scratch files are in `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour5/`: the diff and typography scripts, `out-changed.txt`, `out-new.txt`, `sector.txt` and `crops/`.

French proposals below use ordinary spaces. Run them through `frs()` as before. Apostrophes are already typographic.

---

## Checks you asked for

- **Parity:** 968 keys in each file, none missing or empty.
  - 258 keys are new since 32fbd07 and 210 changed.
  - 23 were removed: the old `modules.incidents/organization/users/settings.*` and the three hard-coded plan options.
- **Placeholders:** identical in the three languages for every key.
- **French typography:** clean across all 968 strings.
  - U+00A0 before `:` and inside « ».
  - U+202F before `; ? !`.
  - U+2019 everywhere, with no straight apostrophe left.
  - Arabic uses «؟» and «؛» throughout, with no Latin `?` or `;`.
- **Code (58 changed web files):**
  - No physical classes.
  - No branching on a language.
  - No wording in the markup.
  - `fill()` isolates every value.
  - Module lists use `Intl.ListFormat`.
- **Plural forms around `{max}` and counts:**
  - The engineer has mostly avoided counted nouns («باقة منشأتك {max}», « limite les utilisateurs à {max} », "Clients: {count}"), which is the right approach.
  - Two plural faults remain: French `meter.inUse`, shown as « 1 utilisés » (`fr-390-portal-client-subscription.png`), and `public_form_paused` in English and French ("{limit} reports").
  - The Arabic users and facilities limit sentences are grammatical, but the bare figure after «منشأتك» reads awkwardly («…في باقة منشأتك 1، وقد بلغته»). The proposals below put it in brackets.
- **Review 4 went in as decided:**
  - All rows of the three tables are in.
  - Decisions 1, 2, 4, 5 and 7 are in. Decision 7 came as the new keys `followUp.endedNoForm` and `endedSinceNoForm`.
  - All 20 Arabic notification sentences now lead with the reference. In `ar-390-notifications.png` the colon sits correctly after the reference and the sentence reads well.
  - Layout:
    - the reference is now one unbreakable `<bdi>`;
    - the bell badge is mirrored;
    - the portal header fits at 390;
    - the activity line reads in order;
    - "Time there now" has lost its double bracket.
  - Two small things were left behind:
    1. **`anonymousWarning` order.** The new clause says "come back with the code" one sentence before the code is introduced (rows below).
    2. **Arabic `followUp.commentTooMany`.** It still says «بعد هذا الوقت: {time}», while English and French were simplified.

---

## Arabic (26 rows; the first 5 matter most)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | `platform.subscription.confirmSave` + `form.cancel` (buttons under `confirmCancel` / `confirmSuspend`) | «نعم، احفظ» beside «إلغاء» | New keys: `confirmCancelButton` «نعم، ألغِ الاشتراك»; `confirmSuspendButton` «نعم، أوقف الاشتراك»; `keep` «إبقاؤه كما هو». End the two sentences with «اختر «نعم، ألغِ الاشتراك» للتأكيد.» / «…«نعم، أوقف الاشتراك»…» | The question «إلغاء اشتراك {name}؟» sits above a button labelled «إلغاء». The safe button and the destructive question use the same word. Code: `client-subscription.tsx:510-517` |
| 2 | `subscription.suspendedTitle` | حساب منشأتك متاح للقراءة فقط في الوقت الحالي | التعديلات موقوفة مؤقتًا في حساب منشأتك | The title says "read only" and the next line says reporting and handling incidents work as usual. It is shown to everyone, so a handler may stop working. The same phrase is used by `subscription.refused`, `incidents.errors.subscription_suspended`, `admin.users.form.rolesReadOnly`, `enableReadOnly` and `admin.roles.form.permissionsReadOnly`: replace «حساب منشأتك متاح للقراءة فقط في الوقت الحالي» with «التعديلات موقوفة مؤقتًا في حساب منشأتك». For the two refusals: «لم يُحفظ التغيير: هذا النوع من التعديلات موقوف مؤقتًا في حساب منشأتك. …». Status pill `admin.settings.subscription.status.suspended`: «التعديلات موقوفة». Portal `statuses.suspended`: «موقوف (التعديلات متوقفة)». See decision 1 |
| 3 | `incidents.harmHelp.moderate` | …أو إلى إطالة مدة الإقامة… | ضرر احتاج إلى علاج إضافي أو إلى إطالة مدة البقاء في المستشفى، لكنه غير دائم. | In the Gulf «الإقامة» first reads as the residence permit (iqama). «مدة التنويم» is the Saudi clinical term, if you prefer it |
| 4 | Retired plan: `platform.plans.retired`, `subscription.planRetired`, `plans.description`, `form.retire`, `retireConfirm`, `retireConfirmButton`, `retiredDone`, `retiredHelp`, `subscription.planHelp`, both `plan_retired` errors | متوقفة / إيقاف الباقة / نعم، أوقفها / أُوقفت الباقة | لم تعد تُطرح / إيقاف طرح الباقة / نعم، أوقف طرحها / أُوقف طرح الباقة. يحتفظ بها عملاؤها. / «{name} (لم تعد تُطرح)» / «هذه الباقة لم تعد تُطرح، فلا يمكن…» / «يمكن الإبقاء على باقة لم تعد تُطرح، لا اختيارها.» | On the client page «إيقاف» now means both suspending a subscription («إيقاف اشتراك») and retiring a plan, beside the client's own «إيقاف العميل». «طرح» means offering for sale, which is exactly what stops. `reactivate` «إتاحتها من جديد» can stay |
| 5 | `platform.subscription.confirmSuspend` | …لن يتمكن موظفوه حينها إلا من… | إيقاف اشتراك {name}؟ لن يتمكن موظفو هذا العميل حينها إلا من الاطلاع، والإبلاغ عن الحوادث ومعالجتها، وسحب صلاحيات الدخول؛ ويُرفض كل ما عدا ذلك حتى تتغير الحالة. | A masculine pronoun points back to an inserted name, the agreement fault from review 3. A «شركة» or «مدرسة» needs «موظفوها» |
| 6 | `subscription.limit.users` | لم يُحفظ: الحد الأقصى لعدد المستخدمين في باقة منشأتك {max}، وقد بلغته المنشأة… يُفرغ مكانًا… | لم يُحفظ: بلغت منشأتك الحد الأقصى لعدد المستخدمين في باقتها ({max})، فلا يمكن إضافة مستخدم أو إعادة تفعيل حساب. يحتفظ كل من لديه صلاحية الدخول بها. تعطيل حساب من غادر المنشأة يتيح مكانًا. لرفع الحد، تواصل مع مسؤول النظام؛ ويمكن لمسؤولي النظام أن يطلبوا من Trustline تغيير الباقة. | The bare figure followed by a comma reads awkwardly («منشأتك 1،», `ar-390-limit-sites-add.png`). «يُفرغ مكانًا» means "empties a place" |
| 7 | `subscription.limit.sites` | (same pattern) | لم يُحفظ: بلغت منشأتك الحد الأقصى لعدد المرافق المفعّلة في باقتها ({max})، فلا يمكن إضافة مرفق أو إعادة تفعيله. لا تتأثر المرافق والأقسام والوحدات الموجودة، ويمكن إضافة أقسام ووحدات. إلغاء تفعيل مرفق لم يعد مستخدمًا يتيح مكانًا. لرفع الحد… | Same |
| 8 | `platform.administrator.limitReached` | الحد الأقصى لعدد المستخدمين في باقة هذا العميل {max}، وقد بلغه. | بلغ هذا العميل الحد الأقصى لعدد المستخدمين في باقته ({max}). ارفع حد المستخدمين من لوحة الاشتراك، ثم أنشئ حساب مسؤول النظام. | Same |
| 9 | `platform.subscription.overridesHelp` | …خفض الحد إلى ما دون ما لدى العميل لا يؤثر في أي موجود. | يتبع كل حد الباقة ما لم يُحدَّد هنا. خفض الحد إلى ما دون العدد الموجود لدى العميل لا يحذف شيئًا: يبقى الموجود كما هو، ويُرفض الجديد فقط. | «أي موجود» is left without a noun |
| 10 | `subscription.notIncluded.body` | هذا الجزء من Trustline غير مشمول فيما تستخدمه منشأتك… | لا يشمل اشتراك منشأتك هذا الجزء من Trustline، فلا يوجد ما يُعرض هنا. إذا احتجت إليه، فتواصل مع مسؤول النظام. | Plainer, and it echoes the title |
| 11 | `platform.plans.form.errors.dependency`, `dependencyAnyOther`, `clientDependency` | الجزء {module} يتطلب {requires}. أضفه إلى الباقة… / …الجزء {module} إضافةً… | جزء {module} يتطلب {requires}. أضف {requires} إلى الباقة، أو ألغِ تحديد جزء {module}. / جزء {module} يتطلب جزءًا آخر واحدًا على الأقل. أضف جزءًا، أو ألغِ تحديده. / لدى أحد عملاء هذه الباقة جزء {module} جزءًا إضافيًا، وهذا التغيير يتركه دون الجزء الذي يحتاج إليه. … | «الجزء الحوادث» puts a definite name in apposition. The construct «جزء الحوادث» is natural. «أضفه» is singular before a list joined with «أو». `fill()` handles a repeated placeholder |
| 12 | `platform.plans.modules` | الأجزاء: | أجزاء النظام: | The agreed term, as in the form and settings |
| 13 | `admin.settings.subscription.comingLater` | لاحقًا | سيتوفر لاحقًا | The pill reads «مشمول · لاحقًا» ("Included · Later", `ar-390-limit-settings.png`) |
| 14 | `admin.settings.subscription.notInUse` | غير مستخدم بعد | لا يُحتسب بعد | Under "Storage" it reads "you have not used any yet". It means the limit is not applied, as the portal's «لا يُحتسبان بعد» says |
| 15 | `platform.plans.form.limitHelp.storageMb`, `.aiCreditsPerMonth` | يُحفظ ولا يُطبَّق بعد. | يُحفظ مع الباقة، ولا يُطبَّق بعد. | Says what is saved |
| 16 | `platform.plans.form.extrasHelp` | …ولا تفعّل الباقة أيًّا منها ولا تلغيه بعد. | تُسجَّل مع الباقة، ولا تفعّل الباقة أيًّا منها ولا تُلغي تفعيله بعد. | Option A vocabulary: «إلغاء التفعيل», not «إلغاء» |
| 17 | `platform.plans.form.notBuilt` | لم يُبنَ بعد | غير متاح بعد | «يُبنى» is a calque of "built". This matches `modulePage.notBuilt` |
| 18 | `platform.subscription.addOnsHelp` | أجزاء فوق الباقة، لهذا العميل وحده. | أجزاء تُضاف إلى الباقة لهذا العميل وحده. | «فوق الباقة» is a calque of "on top of" |
| 19 | `platform.login.invalid`, `auth.login.invalid` | …على رمز لا يمكن أن يكون جزءًا منه… | …على حرف غير مسموح به، ربما بسبب النسخ واللصق… | «رمز» means "code" throughout (follow-up code, plan code, unit code) |
| 20 | `platform.plans.form.pricesHelp` | تُحفظ بيانات للرجوع إليها… | تُحفظ للرجوع إليها فقط. لا يُحصَّل أي مبلغ من هنا، ولا يرى العملاء الأسعار أبدًا. | «بيانات» adds nothing |
| 21 | `platform.plans.form.term` | المدة | دورة الفوترة | «المدة» already means the time allowed in deadline settings |
| 22 | `platform.plans.form.errors.language_mismatch` | اكتب الاسم بالإنجليزية والعربية والفرنسية… | اكتب الاسم بكل لغات Trustline. وإذا كان هناك وصف، فاكتبه بها كلها أيضًا. | Names the three languages instead of following the locale list, so it is wrong the day a fourth language is added. `nameHelp` already says it this way |
| 23 | `incidents.form.anonymousWarning` | …ولن تصلك إشعارات بالردود عليه: عُد برمز المتابعة لقراءتها. بعد الإرسال يظهر لك رمز متابعة… | لا يُحفظ اسمك… ولن يظهر البلاغ ضمن «بلاغاتي». بعد الإرسال يظهر لك رمز متابعة مرة واحدة فقط، وبه تستطيع العودة لقراءة الردود وإضافة تعليق، إذ لن تصلك إشعارات بها. لا تعرف المنشأة عنك إلا ما تكتبه هنا. | The code is named before it is introduced. The last sentence is the neutral wording (next table) |
| 24 | `followUp.commentTooMany` | …يمكنك المحاولة مرة أخرى بعد هذا الوقت: {time}. | …يمكنك المحاولة مرة أخرى ابتداءً من {time}. | Follows en/fr from review 4. «ابتداءً من» reads well with a time and with a weekday and time |
| 25 | `incidents.harmHelp.severe` | …أو إلى تدخل كبير. | …أو إلى تدخل علاجي كبير. | «تدخل» alone is vague |
| 26 | `publicReport.busy` | …كان المستشفى يستقبل بلاغًا آخر في اللحظة نفسها… | لم يُرسَل بلاغك: كان بلاغ آخر يصل في اللحظة نفسها. ما كتبته ما زال هنا: أرسله مرة أخرى بعد لحظات. | Neutral, and less odd to a visitor |

**Good as written:**
- the subscription banners apart from the title;
- `pastDue`;
- every plain status and event;
- the sentinel question and its help;
- the comment visibility lines;
- `seriousNote` apart from the hospital wording;
- `signOff.*`, which quote the permission and «المستخدمون والأدوار» exactly as the screens show them;
- `handedOff`, `channel*`, `timeNote`, `paused*`;
- the two new notifications;
- the portal statuses, dates and meters;
- `usedOf` «من أصل».

## French (23 rows; the first 6 matter most)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | Buttons under `confirmCancel` / `confirmSuspend` | Oui, enregistrer / Annuler | `confirmCancelButton` « Oui, résilier l’abonnement »; `confirmSuspendButton` « Oui, suspendre l’abonnement »; `keep` « Ne rien changer ». Sentences end « Choisissez « Oui, résilier l’abonnement » pour confirmer. » | As Arabic row 1. « Annuler » is less ambiguous in French than in the other two, but "Yes, save" says nothing about what happens |
| 2 | `subscription.suspendedTitle` and the same family as Arabic row 2 | Le compte de votre établissement est en lecture seule pour le moment | Les modifications sont suspendues pour le compte de votre établissement. Refusals: « Rien n’a été enregistré : ce type de modification est suspendu pour le compte de votre établissement. … » Pill: « Modifications suspendues ». Portal: « Suspendu (modifications bloquées) » | As Arabic row 2 |
| 3 | `platform.subscription.meter.inUse`, `admin.settings.subscription.meter.inUse` | {used} utilisés | Utilisés : {used} | Shows « 1 utilisés · Illimité » (`fr-390-portal-client-subscription.png`) |
| 4 | `platform.plans.extraNames.publicReporting` | Déclaration sans connexion | Déclaration sans authentification | Review 3 vocabulary: « sans connexion » means "offline" |
| 5 | `platform.plans.form.removePrice` | Retirer | Supprimer ce prix | On the same form « Retirer l’offre » retires the plan |
| 6 | `publicReport.form.harmLevel`, `publicReport.harm.none`, `.moderate`, `.severe` | Quelqu’un a-t-il subi un préjudice ? / Personne n’a subi de préjudice / … | Quelqu’un a-t-il été blessé ? / Personne n’a été blessé / Quelqu’un a été blessé / Quelqu’un a été gravement blessé ou est décédé | « Préjudice » is quality-department and legal vocabulary on the plain public form (review 3, decision 7). English says "hurt", Arabic «تضرّر» |
| 7 | `notifications.kinds.public_form_paused` | …: {limit} déclarations sont arrivées par le lien public… | La déclaration sans authentification est suspendue : le lien public a reçu au cours de la dernière heure le maximum de déclarations qu’il accepte ({limit}). Elle reprendra… | Plural fault when the limit is 1, and it keeps all three languages in step |
| 8 | `platform.subscription.overridesHelp` | …ne touche personne parmi l’existant. | Chaque limite suit l’offre, sauf si elle est fixée ici. Abaisser une limite sous l’existant ne retire rien : seuls les nouveaux ajouts sont refusés. | « Parmi l’existant » is stiff |
| 9 | `platform.subscription.statusHelp.suspended` | …sauf la déclaration et le traitement des incidents et le retrait d’accès. | Lecture seule pour le personnel du client, sauf pour déclarer et traiter des incidents, et retirer des accès. Le lien de déclaration public reste ouvert. | Two « et » in one list |
| 10 | `platform.subscription.usePlan` | Comme l’offre : {value} | Selon l’offre : {value} | Calque of "As the plan" |
| 11 | `platform.subscription.since` | Abonnement commencé le {date}. | Début de l’abonnement : {date}. | « commencé » is a calque |
| 12 | `platform.plans.form.limitHelp.storageMb`, `.aiCreditsPerMonth` | Enregistrée, pas encore appliquée. | Valeur enregistrée avec l’offre, pas encore appliquée. | The feminine has no noun under the label « Stockage (Mo) » |
| 13 | `platform.plans.form.pricesHelp` | Conservés comme données, pour référence… | À titre indicatif seulement. Rien n’est facturé d’ici, et les clients ne voient jamais les prix. | Calque |
| 14 | `platform.plans.form.term` | Durée | Périodicité | It is a billing period (Mensuel / Annuel) |
| 15 | `platform.plans.form.basis` | Base | Base de calcul | Bare « Base » is unclear |
| 16 | `subscription.notIncluded.body` | Cette partie de Trustline n’est pas incluse dans ce qu’utilise votre établissement… | L’abonnement de votre établissement ne comprend pas cette partie de Trustline : il n’y a donc rien à afficher ici. Si vous en avez besoin, adressez-vous à votre administrateur. | As Arabic row 10 |
| 17 | `platform.plans.form.errors.language_mismatch` | Écrivez le nom en anglais, en arabe et en français… | Écrivez le nom dans chaque langue de Trustline. Une description, s’il y en a une, doit l’être aussi. | As Arabic row 22 |
| 18 | `incidents.form.anonymousWarning` | (clause before the code) | …Elle n’apparaîtra pas dans « Déclarés par moi ». Après l’envoi, un code de suivi s’affiche une seule fois : il vous permet de revenir lire les réponses et d’ajouter un commentaire, car vous ne serez pas averti des réponses. L’établissement ne sait de vous que ce que vous écrivez ici. | As Arabic row 23 |
| 19 | `incidents.harmHelp.none` | L’événement a touché quelqu’un, sans symptôme ni traitement nécessaire. | L’événement a touché quelqu’un, sans provoquer de symptôme ni nécessiter de traitement. | "Necessary symptom" is a possible misreading |
| 20 | `admin.settings.subscription.notInUse` | Pas encore utilisé | Pas encore comptabilisé | As Arabic row 14 |
| 21 | `platform.plans.form.errors.dependency` | …Ajoutez-le à l’offre, ou décochez le module qui en a besoin. | Le module {module} nécessite {requires}. Ajoutez {requires} à l’offre, ou décochez {module}. | « le » before a list joined with « ou » |
| 22 | `platform.plans.form.nameHelp` | Dans chaque langue de Trustline : n’importe quel client peut le voir. | Saisissez-le dans chaque langue de Trustline : il peut être montré à n’importe quel client. | Optional |
| 23 | `platform.subscription.datesHelp` | Les dates sont indicatives… | Les dates servent seulement de repère : aucun statut ne change tout seul quand l’une d’elles passe. | Optional. « Indicatives » can read as "approximate" |

**Good as written:**
- « offre » and « abonnement » throughout, and « site » consistent with the structure screens;
- « Retirée » / « Retirer l’offre »;
- « Résilié » / « Résilier »;
- the plain statuses, with feminine agreement on « déclaration »;
- `seriousNote` with « procédure d’alerte »;
- `sentinelAsk`;
- the two new notifications apart from row 7;
- the limit messages, where « limite les utilisateurs à {max} » has no plural problem.

## English (17 rows; the first 4 matter most)

| # | Key | Current | Proposed | Reason |
|---|---|---|---|---|
| 1 | Buttons under `confirmCancel` / `confirmSuspend` | "Cancel the subscription of {name}? … Choose “Yes, save” to confirm." with buttons "Yes, save" and "Cancel" | `confirmCancelButton` "Yes, cancel the subscription"; `confirmSuspendButton` "Yes, suspend the subscription"; `keep` "Keep it as it is". End the sentences with "Choose “Yes, cancel the subscription” to confirm." | "Cancel" is the safe button under "Cancel the subscription?" (seen as "Yes, save" and "Cancel" in `en-1280-portal-sub-suspend-confirm.png`) |
| 2 | `subscription.suspendedTitle` and family (`refused`, `incidents.errors.subscription_suspended`, `rolesReadOnly`, `enableReadOnly`, `permissionsReadOnly`, settings pill, portal status) | Your organization's account is read-only for now | "Changes are paused for your organization's account". Refusals: "This was not saved: changes like this are paused for your organization's account. Contact your administrator; administrators can contact Trustline." Pill: "Changes paused". Portal: "Suspended (changes paused)" | As Arabic row 2 |
| 3 | `subscription.limit.users` / `.sites`, `platform.administrator.limitReached` | Not saved: your organization's plan has a limit of {max} on users, and it has been reached… / …a limit of {max} on facilities switched on… | "Not saved: your organization has reached its plan's limit on users ({max}), so no one can be added or enabled again. …" / "Not saved: your organization has reached its plan's limit on active facilities ({max}), so no facility can be added or switched on again. …" / "This client has reached its plan's limit on users ({max}). Raise the users limit…" | Easier to read, and the bracket keeps it free of plural forms |
| 4 | `notifications.kinds.public_form_paused` | …: {limit} reports arrived through the public link in the last hour, the most it accepts… | "Reporting without sign-in is paused: the public link has taken the most reports it accepts in an hour ({limit}). It takes reports again on its own as the hour passes; until then, anyone who tries is asked to come back later." | "1 reports" if the limit is ever 1 |
| 5 | `platform.plans.form.errors.language_mismatch` | Write the name in English, Arabic and French… | "Write the name in every language Trustline has. A description, if there is one, needs every language too." | Names the languages instead of following the locale list |
| 6 | `publicReport.busy` | …the hospital was receiving another report at the same moment… | "Your report was not sent: another report was arriving at the same moment. What you wrote is still here: send it again in a moment." | Neutral and plainer |
| 7 | `platform.plans.limitNames.sites`, `platform.plans.form.bases.per_site` | Sites (facilities) / Per site | Facilities / Per facility | English says "facility" everywhere else, including `admin.settings.subscription.sites` and both limit messages |
| 8 | `subscription.notIncluded.body` | This part of Trustline is not included in what your organization uses… | "Your organization's subscription does not include this part of Trustline, so there is nothing to show here. If you need it, ask your administrator." | Plainer |
| 9 | `platform.subscription.overridesHelp` | …A limit lowered below what the client already has affects nobody already there. | "Each limit follows the plan unless it is set here. Lowering a limit below what the client already has removes nothing: only new additions are refused." | Says what happens |
| 10 | `platform.subscription.usePlan` | As the plan: {value} | Same as the plan: {value} | Reads as an option (`en-1280-portal-sub-suspend-confirm.png`) |
| 11 | `admin.settings.subscription.notInUse` | Not in use yet | Not counted yet | As Arabic row 14 |
| 12 | `platform.plans.form.limitHelp.storageMb`, `.aiCreditsPerMonth` | Stored, not enforced yet. | Saved with the plan, not applied yet. | Plainer |
| 13 | `platform.plans.form.pricesHelp` | Kept as data, for reference… | For reference only. Nothing is charged from here, and clients never see prices. | Plainer |
| 14 | `platform.plans.form.term`, `basis`, `bases.flat` | Term / Basis / Flat | Billing period / Price basis / Flat fee | Bare words |
| 15 | `platform.plans.form.errors.dependency` | {module} needs {requires}. Add it to the plan, or untick the module that needs it. | {module} needs {requires}. Add {requires} to the plan, or untick {module}. | "it" before "Incidents or Risks" |
| 16 | `incidents.form.anonymousWarning` | (clause before the code) | "…It will not appear under “Reported by me”. After sending, you get a follow-up code, shown once: with it you can come back to read the replies and add a comment. You will not be notified of replies, so come back with the code to check. The organization knows about you only what you write here." | As Arabic row 23 |
| 17 | `platform.plans.form.removePrice` | Remove | Remove this price | Optional; the button is read out of context by screen readers |

---

## Neutral wording: strings that read wrongly outside a hospital (43 keys)

Arabic uses «المنشأة» and French « l’établissement » for the organization, as they already do in most strings. Both read naturally for a school, a factory or a company. I confirm them as the neutral terms.

| Key(s) | en proposed | ar proposed | fr proposed |
|---|---|---|---|
| `app.tagline` | Quality, risk and incident management | إدارة الجودة والمخاطر والحوادث | Gestion de la qualité, des risques et des incidents |
| `incidents.typeHelp.incident` | Something went wrong and reached a person: a member of staff, a visitor or anyone else. | حدث غير مرغوب فيه وصل أثره إلى شخص: أحد الموظفين أو زائر أو أي شخص آخر. | Un événement indésirable qui a touché une personne : un membre du personnel, un visiteur ou toute autre personne. |
| `incidents.form.descriptionHelp`, `immediateActionHelp`, `comments.bodyHelp`, `comments.reporterHelp`, `actions.noteHelp`, `actions.noteHelpInternal` (7 keys) | …Do not type the names or identifying numbers of the people involved. | …لا تكتب أسماء الأشخاص المعنيين ولا أرقامًا تدل على هويتهم. | …N’indiquez ni le nom ni aucun numéro permettant d’identifier les personnes concernées. |
| `incidents.form.intro` (en only) | Reports are used to make things safer, not to blame anyone. | (already neutral) | (already neutral) |
| `incidents.list.hospitalDays` | Days are counted in the organization's time: {zone}. | تُحتسب الأيام بتوقيت المنشأة: {zone}. | Les jours sont comptés à l’heure de l’établissement : {zone}. |
| `incidents.form.hospitalTime` | Enter it in the organization's time: {zone}. | أدخله بتوقيت المنشأة: {zone}. | Saisissez-les à l’heure de l’établissement : {zone}. |
| `incidents.form.seriousNote` | …Follow your organization's escalation procedure now… | …اتّبع الآن إجراءات التصعيد المعتمدة في منشأتك… | …Suivez dès maintenant la procédure d’alerte de votre établissement… |
| `incidents.form.whoSeesName`, `incidents.detail.reporterHidden` | …staff your organization has authorised… | …الموظفين الذين أذنت لهم المنشأة… | …le personnel que l’établissement a autorisé… / autorisé par l’établissement |
| `incidents.form.anonymousWarning`, `publicReport.privacy` (last sentence) | The organization knows about you only what you write here. | لا تعرف المنشأة عنك إلا ما تكتبه هنا. | L’établissement ne sait de vous que ce que vous écrivez ici. |
| `publicReport.privacy` (fourth sentence) | …to come back and read any reply. | …تعود به لقراءة أي رد على بلاغك. | …de revenir lire toute réponse. |
| `publicReport.description` | Report something that went wrong, nearly went wrong, or could cause harm. It takes about two minutes. | أبلغ عن حدث غير مرغوب فيه وقع أو كاد يقع، أو عن وضع قد يسبّب ضررًا. يستغرق ذلك نحو دقيقتين. | (already neutral) |
| `publicReport.unavailable`, `publicReport.notSent` | …speak to a member of staff or to the quality team. | …تحدّث إلى أحد الموظفين أو إلى فريق الجودة. | …adressez-vous à un membre du personnel ou à l’équipe qualité. |
| `publicReport.busy` | (English row 6) | (Arabic row 26) | …: une autre déclaration arrivait au même moment… |
| `followUp.lost` (ar) | — | …لكنّ بلاغك قد وصل. | — |
| `incidents.timeline.staff` | A member of staff | أحد الموظفين | Un membre du personnel |
| `incidents.reader.anonymous`, `maybeAnonymous` | …and may not be a member of staff. | …وقد لا يكون من موظفي المنشأة. | …et ne fait peut-être pas partie du personnel. |
| `admin.settings.reporting.what` | …a visitor, a member of the public, or a member of staff with no account… | …زائر أو أي شخص من العامة أو موظف ليس لديه حساب… | …un visiteur, toute autre personne ou un membre du personnel sans compte… |
| `admin.settings.deadlines.what` | …how long your organization allows itself… | …المدة التي تمنحها منشأتكم لنفسها… | (already neutral) |
| `admin.organization.description` (en) | The facilities, departments and units of your organization… | (already neutral) | (already neutral) |
| `admin.organization.errors.language_mismatch` (en) | Write the name in the organization's default language. If the organization's languages… | (already neutral) | (already neutral) |
| `admin.organization.form.codeHelp` | …for example NORTH-2… | …مثل NORTH-2… | …par exemple NORTH-2… |
| `auth.login.orgHelp` | The identifier your organization gave you. | المعرّف الذي زوّدتك به منشأتك. | L’identifiant fourni par votre établissement. |
| `platform.clients.description` | Every organization using Trustline. | كل المنشآت التي تستخدم Trustline. | Tous les établissements qui utilisent Trustline. |
| `platform.form.newDescription` | Create the record for a new organization. | أنشئ سجلًّا لمنشأة جديدة. | Créez la fiche d’un nouvel établissement. |
| `platform.form.timeZone.help` | The client's own clock… | توقيت العميل نفسه… | L’heure du client… |
| `platform.administrator.title` | Client administrator | (already neutral) | Administrateur du client |
| `platform.administrator.exists` | …The client adds further administrators itself. | …يضيف العميل بقية المسؤولين بنفسه. | …Le client ajoute lui-même les suivants. |

**"Quality team" stays:** it is a normal name in industry (QHSE) and in schools. **Two vocabulary notes:** «حدث جسيم» is already sector-neutral in Arabic; "Triage" / «الفرز» / « tri » also reads fine outside healthcare.

### Must stay healthcare-specific for now (sector variant later)

| Key(s) | Why |
|---|---|
| `incidents.harmHelp.none`, `.mild`, `.moderate`, `.severe`, `.death` | Clinical scale. A workplace scale would be first aid, medical treatment, lost time, permanent disability, fatality. **For a clinician to check:** (1) `none` excludes, and `mild` includes, "extra observation". Under NCC MERP an error that reached the patient and needed only monitoring to confirm no harm (category D) counts as no harm, so monitoring-only events would be graded mild here. (2) No level mentions psychological harm. (3) `death` "caused the death or brought it forward" follows WHO ICPS, but ICPS adds "on balance of probabilities" and "in the short term". (4) `moderate` "longer stay" covers inpatients only |
| `incidents.sentinel`, `triage.sentinel`, `triage.sentinelAsk`, `sentinelAskHelp`, `timeline.changed.isSentinel`, `dashboard.seriousHelp`, `list.seriousHelp`, `notifications.seriousNote`, `notifications.kinds.sentinel_flagged`, `errors.serious_cannot_be_rejected`, `errors.sentinel_not_applicable`, `admin.settings.deadlines.sentinel`, `.applies` | "Sentinel event" (en) and « événement sentinelle » (fr) are Joint Commission and healthcare terms. A neutral variant would be "major event" / « événement majeur ». Arabic needs no variant |
| `platform.form.accreditationStandard` (JCI / CBAHI options) | Healthcare standards. Other sectors would want ISO 9001 / 45001 |
| `platform.plans.extraNames.clinicalAiSuggestions` | Clinical by nature. The name is correct for what it is |
| Incident categories (`apps/api/src/incidents/categories.ts`: Medication, Fall, Infection, Laboratory…) | Seed data outside the dictionaries, but every client sees them |
| `incidents.typeHelp.incident` and the "patient names" help lines | The neutral versions above work for hospitals too. A hospital variant naming "patient" and "medical record number" would still be clearer to clinicians |

---

## Layout faults

| Screenshot | Fault | Fix |
|---|---|---|
| `en-1280-portal-sub-suspend-confirm.png` (code: `client-subscription.tsx:510-517`) | Suspend and cancel are confirmed with "Yes, save" beside "Cancel"; Arabic shows «نعم، احفظ» beside «إلغاء» under «إلغاء اشتراك…؟» | Separate confirm buttons and a "keep" button (row 1 of each table) |
| `fr-390-portal-client-subscription.png` | « 3 utilisés · Illimité », « 1 utilisés · Illimité » | French row 3 |
| `ar-390-portal-plans.png`, `fr-390-portal-plans.png`, `ar-390-portal-client-subscription.png` | **The limits line breaks between a name and its figure:** «(ميغابايت)» then «5,000» on the next line, « Crédits » then « IA par mois 0 ». The pair is also assembled in code as "name value" (`plans-list.tsx:22-36`, `client-subscription.tsx:299-307`), with no colon, which French needs | Add a key `platform.plans.limitPair`: "{name}: {value}" / «{name}: {value}» / « {name} : {value} ». Render each pair in a `whitespace-nowrap` span, joined by " · " |
| `ar-390-portal-plans.png`, `fr-390-portal-plans.png`, `ar-390-portal-header.png` | The header now fits at 390, but the title is truncated to «منصة …» / « Platef… », which loses the product name. In English "Trustline Pl…" survives | Low. `portal-frame.tsx:80`: below `sm`, show `app.name` and keep `t.title` for wider screens and the `title` attribute |
| `fr-390-notification-paused.png`, `ar-390-notifications.png` | A notification with a "Mark as read" button keeps the button beside the text at 390. The paused notice runs to 16 short lines in French | Low. At `max-sm`, put the button under the text |
| `ar-390-limit-settings.png` | Module rows read «مشمول» next to «لاحقًا» | Arabic row 13 |
| All of `shots-modules` (14:18) and `shots-final/ar-390-ask-sign-off-nobody.png` | Taken before the final dictionary (commit at 14:25). They show older text: «المواقع (المرافق)», the earlier suspended banner, the earlier `nobodyBefore`, and "Suspend Maya check: no incidents's subscription?" (now "the subscription of {name}", which fixes it) | Retake after this round |
| `ar-390-portal-client-subscription.png`, `fr-390-portal-client-subscription.png`, `*-report-form-harm.png` | Dates show "mm/dd/yyyy" and "02:10 PM" on Arabic and French pages | Not a fault: it is the native control in an en-US headless browser |

**Right-to-left checks that passed:**
- **Banners:** the lock and info icons sit at the start, and the text is aligned under them (`ar-390-suspended-dashboard.png`, `ar-390-past-due-admin.png`).
- **Usage bars:** they fill from the right.
- **"Not part of your subscription" page:** "Trustline" sits correctly inside the Arabic sentence, and the full stop after "Trustline" lands at the left end.
- **Plan form at 1280:** name and description fields are paired, chevrons are at the end, the add-on cards have their tick boxes at the start, and the codes are left-to-right `<bdi>`.
- **Sentinel question:** «نعم» comes before «لا» from the right.
- **Comment visibility:** the radios are at the start.
- **Notifications:** «البلاغ INC-…: …» reads in order, the badge is mirrored, and the «خطير» pill sits at the start.
- **Activity line and "Time there now":** both correct.

---

## Summary

**Counts:**
- Arabic 26 rows.
- French 23 rows, 2 optional.
- English 17 rows, 1 optional.
- Neutral wording: 43 keys in 27 rows, plus 6 groups that must stay healthcare-specific.
- Layout: 2 faults that matter (the confirm buttons, « 1 utilisés »), 3 small ones, and one stale set of screenshots.

**Vocabulary you asked me to confirm**
- **«الباقة» / « offre »: confirmed.** One fix: `platform.plans.modules` «الأجزاء:».
- **«الاشتراك» / « abonnement »: confirmed.**
- **«أجزاء النظام» for modules: confirmed.** The engineer is right to keep «وحدة» for units. Use the construct «جزء {module}» in sentences (Arabic row 11).
- **«مرفق» / « site »: confirmed.** English must then say "facility" everywhere (English row 7).
- **«متوقفة» for a retired plan: replace with «لم تعد تُطرح»** and «إيقاف طرح الباقة», because «إيقاف» now also means suspending a subscription on the same page. **« Retirée »: confirmed.**
- **«للقراءة فقط» / « lecture seule »: correct as words, wrong as a description**, since incident work stays open. See decision 1.
- **«المنشأة» / « établissement »: confirmed as the neutral word for a client organization.**

**The three that matter most**
1. **"Cancel the subscription?" with a "Cancel" button.** In English and Arabic the safe choice and the destructive question use the same word, and the confirming button says only "Yes, save".
2. **The suspended banner says "read-only" to everyone, and its next line says incident work goes on.** Staff who handle incidents may stop working. "Changes are paused" is true and still clear.
3. **About 43 keys still say hospital, patient or clinical.** The ones every client's staff and visitors see are the report form help lines, the public form, "Hospital staff" in the timeline and the sign-in help. The neutral table covers them all, and the harm definitions need a clinician's check before any sector variant.

**Needs a decision, not a fix**
1. **Replace "read-only" with "changes are paused"** in the banner, the refusals and the status labels (row 2 of each table)? I recommend it.
2. **Retired plan in Arabic:** «لم تعد تُطرح» throughout (Arabic row 4)?
3. **Sector wording:** apply the neutral table now, and plan per-sector variants for the harm definitions, "sentinel event" (en/fr), the accreditation field, the categories and the "patient" help lines? That needs a sector on the client record. Until then the neutral versions read correctly in hospitals too.
4. **The harm definitions need a clinician's check** for the four points in the healthcare table, above all whether "extra observation" without harm is "No harm" or "Mild harm".
5. **The public form's voice:** with "hospital" gone, the public pages say "the organization". If you would rather they name it, add `{organization}` to `publicReport.description` and `privacy`, filled with `pick(name)`.

**Screens opened and screens only read**
- **Opened, 24 images, several as crops at full size:**
  - Arabic:
    - `ar-390-portal-client-subscription`, `ar-1280-portal-client-subscription`;
    - `ar-390-portal-plans`, `ar-1280-portal-plan-new`;
    - `ar-390-suspended-dashboard`, `ar-390-past-due-admin`;
    - `ar-390-limit-users-add`, which shows a successful add, not the limit message;
    - `ar-390-limit-sites-add`, `ar-390-limit-settings`, `ar-390-off-incidents`;
    - `ar-390-report-form-harm`, `ar-390-triage-sentinel-ask`, `ar-390-portal-header`;
    - `ar-390-notification-paused`, `ar-390-ask-sign-off-nobody`, `ar-390-notifications`.
  - French: `fr-390-portal-client-subscription`, `fr-390-portal-plans`, `fr-390-report-form-harm`, `fr-390-notification-paused`.
  - English: `en-1280-portal-sub-suspend-confirm`.
- **Checked by size only:** every image in the four sets. None is wider than its viewport; the narrow ones in `shots-final` are element crops.
- **Not opened:**
  - the rest of `shots-modules`: the other `ar-*-suspended-*`, `off-*` and limit shots, all other French portal shots, `*-cancelled-sign-in`;
  - all of `shots-regfix`;
  - the rest of `shots-quality` and `shots-final`, including the follow-up, public busy and paused, and reporter-view shots.
- **Read in the dictionary only, no Arabic or French screenshot:**
  - the suspend and cancel confirmations, the retire confirmation and the prices section;
  - the users limit message;
  - `subscription.suspendedNoReporting`;
  - the portal plan form in French at 1280.

**Files**
- `/home/user/Trustline/apps/web/src/i18n/dictionaries/en.json`, `/home/user/Trustline/apps/web/src/i18n/dictionaries/ar.json`, `/home/user/Trustline/apps/web/src/i18n/dictionaries/fr.json`
- `/home/user/Trustline/apps/web/src/components/platform/client-subscription.tsx`: confirm buttons, lines 495-517; storage line, 299-307
- `/home/user/Trustline/apps/web/src/components/platform/plans-list.tsx`: `limitsLine`, lines 22-36
- `/home/user/Trustline/apps/web/src/components/platform/portal-frame.tsx`: title, line 80
- `/home/user/Trustline/apps/web/src/components/shell/subscription.tsx`: banners and not-included page; read, nothing else to change
- `/home/user/Trustline/apps/web/src/components/ui/usage-meter.tsx` and `/home/user/Trustline/apps/web/src/components/platform/module-words.ts`: read, nothing to change
- `/home/user/Trustline/apps/api/src/incidents/categories.ts`: healthcare category seed
