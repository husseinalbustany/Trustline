# Language review 9: audit wording and new notifications (224733a..8cbffe4)

## Decisions
- Accept every item in every table (must, should and low).
- Needs decision 1: keep "Incident reported" in English and French; Arabic «تقديم بلاغ».
- Needs decision 2: keep the "by a Trustline update" suffix on the *_by_system labels.
- Settled terms for the viewer: ar «القيد / القيود», «الختم / الأختام»; fr « entrée », « sceau / scellement ».
- English apostrophes: U+0027 as in en.json.
- API (wording files, registry details mismatch, a details test): the API engineer, after the audit steps 4 to 7.
- Web (N1 to N4): the web engineer now.

## Bilingual review 9: audit-trail wording and new notifications (224733a..8cbffe4)

I changed no files. I opened no screens and took no screenshots. The audit viewer does not exist yet (step 4), so the 70 labels are read only in `apps/api/src/audit/wording/{en,ar,fr}.ts`. For the notifications I read the code (`notifications-view.tsx`, `lib/notifications.ts`, `chain-check.service.ts`, `provisioning.service.ts`, `settings.service.ts`) and did not open the screen. My scratch file is `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour9/tri.txt`: the three web dictionaries side by side, 2,072 keys each, none missing.

### What is already right
- **Keys match.** Each wording file has 70 actions and 4 actors, the same keys as `AUDIT_ACTIONS`. No label has a placeholder. `review_approval_turned_off` has `{type}` in all three languages.
- **French typography is clean.** All apostrophes are U+2019, and « e-⁠mail » has the word joiner, as in `fr.json`. No label needs a no-break space.
- **Nothing blames anyone.** Labels say what happened, not whose fault it was. One actor label is the exception: «مجهول الهوية» (Arabic row AR1).
- **The form is mostly consistent.** English uses a noun with a past participle, Arabic a verbal noun, French a noun phrase. The outliers are listed below.
- **Gender:** no label agrees with the actor, as the spec intends. «المبلّغ» and « Le déclarant » are the usual masculine forms for someone unknown, which suits masking.

### Must fix across languages (notifications and permissions, web)

| # | Where | Problem | Proposed |
|---|---|---|---|
| N1 | `notifications.kinds.audit_chain_broken` (missing in all 3 `.json`) | `sentenceFor` falls back to `kinds.other` with an empty `{reference}`. With `serious: true`, a broken audit trail shows as en "There is an update on .", ar «الحادث : هناك جديد بشأنه.», fr « Du nouveau concernant l’incident . ». It is called an incident, and gives no next step. | Add the key, with one variant per `data.kind` (like `signing_pin_changed`), and a variant without `{seq}`. en "The daily check found that the audit trail no longer matches its seals from entry {seq} ({kind}). Contact Trustline so the cause can be found." ar «سجل التدقيق: تبيّن في الفحص اليومي أنه لم يعد مطابقًا لأختامه بدءًا من القيد رقم {seq}، إذ {kind}. تواصل مع Trustline لمعرفة السبب.» fr « Journal d’audit : la vérification quotidienne a constaté qu’il ne correspond plus à ses sceaux à partir de l’entrée {seq} ({kind}). Contactez Trustline pour en déterminer la cause. » Kind phrases are listed after this table. |
| N2 | `notifications.kinds.policies_import_granted` (missing in all 3) | Same fallback, and the person is never named. `person.name` is a `Localized` and needs `pick()`. The Arabic must avoid agreeing with the person's gender. | en "{name} can now import existing documents. If you did not expect this, check their roles under “Users and roles”." ar «أصبح بإمكان {name} استيراد الوثائق القائمة. إن لم يكن ذلك متوقعًا، فراجع أدوار هذا الشخص في «المستخدمون والأدوار».» («أصبح بإمكان» does not agree with the name.) fr « {name} peut désormais importer des documents existants. Si ce n’était pas prévu, vérifiez les rôles de cette personne dans « Utilisateurs et rôles ». » |
| N3 | `review_approval_turned_off`: `settings.service.ts:234` stores `typeName`; `notifications-view.tsx:273-275` never reads it | The type's name is stored per language but unused. If `/policies/types` does not list the type (it was made inactive in the same change, or the call fails), the sentence shows the raw code: «وثائق النوع «policy»». The `data` type in `lib/notifications.ts:60` also lacks `typeName`. | Name the type from the current list first, then `pick(n.data.typeName, lang, defaultLocale)`, then the code. Add `typeName?: Localized` to the type. |
| N4 | `admin.permissions.audit.view` (missing in all 3) | `role-form.tsx:222` falls back to the key, so the Administrator and Quality officer roles show "audit.view" in every language. | en "View the audit trail", ar «الاطلاع على سجل التدقيق», fr « Consulter le journal d’audit » |

Kind phrases for N1:

| kind | en | ar | fr |
|---|---|---|---|
| content_changed | an entry changed after it was sealed | تغيّر محتوى قيد بعد ختمه | contenu d’une entrée modifié après son scellement |
| missing_entry | a sealed entry is missing | فُقد قيد مختوم | entrée scellée manquante |
| missing_seal | an entry has no seal | يوجد قيد بلا ختم | entrée sans sceau |
| gap | entry numbers are missing | توجد أرقام ناقصة في تسلسل القيود | numéros d’entrée manquants |
| head_rewound | fewer entries than at an earlier check | صار عدد القيود أقل مما كان عند فحص سابق | moins d’entrées que lors d’une vérification précédente |
| backdated | an entry dated before an earlier check | يوجد قيد مؤرَّخ بما يسبق فحصًا سابقًا | entrée datée d’avant une vérification précédente |
| bad_checkpoint | a checkpoint’s signature does not hold | لم يثبت توقيع إحدى نقاط التحقق | signature d’un point de contrôle non valide |

Terms to settle before step 4 (viewer and status notice): ar «القيد / القيود» for entry, «الختم / الأختام» for seal; fr « entrée », « sceau / scellement ».

---

### English (`apps/api/src/audit/wording/en.ts`)

| Key | Problem | Proposed |
|---|---|---|
| **Must fix** | | |
| `password_confirmation_failed` | Not true for people who sign with a PIN (`auth.service.ts` writes it for wrong PINs too), nor for the `signing_pin_change` purpose, which is not a signature. It is also the only label not in the past-participle form. | Password or PIN check failed |
| `response_rules_changed` | "Response times" appears on no screen, and in a hospital it suggests call or alarm response. The screen is "Deadlines for triage and closure". | Triage and closure deadlines changed |
| `document_submitted` | The screen says "Send for review"; the route starts with review steps. | Version sent for review |
| `document_step_approved` | It is also written for review steps, which are "Sign as reviewed". The step's status on screen is "Signed". | Approval step signed |
| **Should fix** | | |
| `public_reporting_changed` | "Public reporting" is not the screen's term. | Reporting without sign-in switched on or off |
| `public_reporting_limit_reached` | Same term problem. | Reporting without sign-in paused (hourly limit reached) |
| `email_setting_changed` | Vague: the screen setting is an on/off switch. | Email switched on or off for the organization |
| `sign_in_link_created` | The link sets a password (invitation or reset); it does not sign anyone in. | Password link created |
| `org_unit_created` / `org_unit_updated` | "Unit" is one of three types. A surveyor reading "Unit added" for a new facility is misled. | Facility, department or unit added / Facility, department or unit changed |
| `org_unit_moved` | Only departments and units can move. | Department or unit moved |
| `role_created`, `approval_route_created` | The screens say "Add role" and "Add a route", and users, units, types and categories are already "added". | Role added / Approval route added |
| `document_recalled` | The screen says "Take it back to draft". | Version taken back to draft |
| `document_returned` | The screen says "Return with comments", and this wording keeps it apart from a recall. | Version returned with comments |
| `document_import_signed` | It is a batch signature (`batchId`, `size`). | Import batch signed |
| `*_by_system` vs people's labels | "Document type changed" (a person) and "Document type updated" (a migration) would sit side by side in the action filter as synonyms. Give both the same verb and say why the System acted. | Built-in roles changed by a Trustline update · Document type changed by a Trustline update · Approval routes changed by a Trustline update · Default type and category names reworded by a Trustline update · Import confirmations corrected by a Trustline update · Import confirmations recorded by a Trustline update |
| `policy_defaults_reworded_by_system` | "Starting wording" is a spec term, and the migration also renames categories. | (see the row above) |
| `administrator_created_by_platform`, `subscription_changed`, `import_window_changed` | "by Trustline" repeats the actor column ("Trustline staff") and breaks the spec's rule that a label does not say who acted. The admin portal calls it the "Import window". | Administrator added / Subscription changed / Import window changed |
| `audit_chain_started` | "Audit trail sealed" can read as "closed to new entries", the opposite of what happened. | Audit trail sealing started |
| `acknowledgements_exported` | Easily confused with the overdue export; this one is about one version. | Version acknowledgements exported |
| `person_acknowledgements_exported` | The only label that starts with an article. The screen is "Acknowledgement record". | Acknowledgement record exported |
| `overdue_acknowledgements_exported` | The page title is "Overdue acknowledgements" (the menu item says "Late"). | Overdue acknowledgements exported |
| **Low** | | |
| `document_category_created` / `_updated` | Optional, to keep them apart from incident categories. | Document category added / Document category changed |
| `user_updated`, `user_roles_changed`, `person_acknowledgements_exported` | `en.ts` uses U+2019 and `en.json` uses U+0027. When the labels are copied into `en.json` in step 4, use one. | Use U+0027, as in `en.json` |

### Arabic (`apps/api/src/audit/wording/ar.ts`)

| Key | Problem | Proposed |
|---|---|---|
| **Must fix** | | |
| AR1 `actors.anonymous` | «مجهول الهوية» suggests a suspect, and the settled term is «دون ذكر الاسم» (`incidents.detail.anonymous`, review 1). | دون ذكر الاسم |
| `email_setting_changed` | «المؤسسة»: the settled word is «المنشأة». | تفعيل البريد الإلكتروني للمنشأة أو إيقافه |
| `document_category_created` / `_updated` | Document categories are «الفئة / الفئات» on every documents screen. «تصنيف» is for incident categories. | إضافة فئة / تعديل فئة |
| `built_in_roles_changed_by_system` | The screen says «الأدوار الافتراضية», not «المدمجة». | تعديل الأدوار الافتراضية بتحديث من Trustline |
| `public_reporting_changed` | «الإبلاغ العام» also reads as "general reporting". The screen is «الإبلاغ دون تسجيل الدخول», and switching off is «إلغاء التفعيل». | تفعيل الإبلاغ دون تسجيل الدخول أو إلغاء تفعيله |
| `response_rules_changed` | «مُهل الاستجابة» appears on no screen. | تعديل المواعيد النهائية للفرز والإغلاق |
| `document_submitted` | The screen says «إرسال للمراجعة». | إرسال إصدار للمراجعة |
| `document_step_approved` | Review steps are signed, not approved; the status is «موقَّعة». | توقيع خطوة في مسار الاعتماد |
| `password_confirmation_failed` | Not a verbal noun, and wrong for PIN signers and PIN changes. | فشل التحقق من كلمة المرور أو رمز التوقيع |
| **Should fix** | | |
| `public_reporting_limit_reached` | «النموذج العام» is not the screen's term, and «بلوغ الحد في الساعة» is clumsy. | إيقاف الإبلاغ دون تسجيل الدخول مؤقتًا (بلوغ الحد الأقصى في الساعة) |
| `actors.reporter` | «المُبلِّغ» has more marks than `ar.json`'s «المبلّغ» (15 uses). A search in the CSV for one does not find the other. | المبلّغ |
| `signing_pin_locked` | «التوقيع … رمز التوقيع» repeats itself. | قفل رمز التوقيع |
| `sign_in_link_created` | The link is for setting a password. | إنشاء رابط لتعيين كلمة المرور |
| `org_unit_created` / `_updated` / `_moved` | «وحدة» is only one of the three types. | إضافة مرفق أو قسم أو وحدة / تعديل مرفق أو قسم أو وحدة / نقل قسم أو وحدة في الهيكل التنظيمي |
| `role_created`, `approval_route_created` | The screens say «إضافة دور» and «إضافة مسار». | إضافة دور / إضافة مسار اعتماد |
| `document_recalled` | The screen says «استعادته للتعديل». | استعادة إصدار للتعديل |
| `document_returned` | The screen says «إعادة مع ملاحظات». | إعادة إصدار مع ملاحظات |
| `document_import_signed` | It is a batch («الدفعة» on screen). | توقيع دفعة استيراد |
| `*_by_system` | «تحديث» next to «تعديل» are synonyms in the filter. | تعديل نوع وثيقة بتحديث من Trustline · تعديل مسارات الاعتماد بتحديث من Trustline · تعديل صياغة أسماء الأنواع والفئات الافتراضية بتحديث من Trustline · تصحيح تأكيدات الاستيراد بتحديث من Trustline · تسجيل تأكيدات الاستيراد بتحديث من Trustline |
| `administrator_created_by_platform`, `subscription_changed`, `import_window_changed` | «من قِبل» is a calque, and it repeats the actor column. The portal says «تغيير فترة الاستيراد». | إضافة مسؤول نظام / تعديل الاشتراك / تغيير فترة الاستيراد |
| `audit_chain_started` | «ختم» also means "to conclude": «ختم سجل التدقيق» can read as "audit trail closed". | بدء ختم سجل التدقيق |
| `acknowledgements_exported` | The plural «الإقرارات بالاطلاع» is awkward. The screen says «تصدير إقرارات هذا الإصدار». | تصدير إقرارات إصدار |
| `person_acknowledgements_exported` | The screen is «سجل الإقرار بالاطلاع». | تصدير سجل الإقرار بالاطلاع لشخص |
| **Low** | | |
| `sign_in_failed` | Match «تسجيل الدخول». | محاولة تسجيل دخول فاشلة |
| `import_confirmed` | «من» reads as "from". | تأكيد المسؤول عن الوثيقة للاستيراد |

### French (`apps/api/src/audit/wording/fr.ts`)

| Key | Problem | Proposed |
|---|---|---|
| **Must fix** | | |
| `document_recalled` | « Rappel » in a hospital means a product recall or a reminder. The screen says « Remettre en brouillon ». | Remise en brouillon d’une version |
| `document_submitted` | The screen says « Soumettre à vérification » (decision 1 of review 6). | Soumission d’une version à vérification |
| `document_step_approved` | Review steps are signed (« Signée »). | Signature d’une étape du circuit d’approbation |
| `password_confirmation_failed` | Not an action noun, and wrong for PINs. | Échec de la vérification du mot de passe ou du code de signature |
| `public_reporting_limit_reached` | « Formulaire public suspendu » is a participle, the only label not a noun phrase, and not the screen's term. | Suspension de la déclaration sans authentification (limite horaire atteinte) |
| `email_setting_changed` | « l’organisation »: the dictionaries say « établissement ». | Activation ou désactivation de l’e-⁠mail pour l’établissement |
| `built_in_roles_changed_by_system` | The screen says « rôles par défaut ». | Modification des rôles par défaut par une mise à jour de Trustline |
| `response_rules_changed` | The screen says « Délais de tri et de clôture ». | Modification des délais de tri et de clôture |
| **Should fix** | | |
| `public_reporting_changed` | The screen term is « déclaration sans authentification ». | Activation ou désactivation de la déclaration sans authentification |
| `signing_pin_locked` | The screens say « bloquée ». | Blocage de la signature par code |
| `sign_in_link_created` | The link sets a password. | Création d’un lien de définition du mot de passe |
| `org_unit_created` / `_updated` / `_moved` | « unité » is only one of the three types. | Ajout d’un site, d’un service ou d’une unité / Modification d’un site, d’un service ou d’une unité / Déplacement d’un service ou d’une unité |
| `role_created`, `approval_route_created` | The screens say « Ajouter ». | Ajout d’un rôle / Ajout d’un circuit d’approbation |
| `document_returned` | The screen says « Renvoyer avec des remarques ». | Renvoi d’une version avec des remarques |
| `document_import_signed` | It is a batch (« lot »). | Signature d’un lot d’importation |
| `*_by_system` | « Mise à jour » next to « Modification » are synonyms in the filter. | Modification d’un type de document par une mise à jour de Trustline · Modification des circuits d’approbation par une mise à jour de Trustline · Reformulation des noms des types et catégories par défaut par une mise à jour de Trustline · Correction des confirmations d’importation par une mise à jour de Trustline · Enregistrement des confirmations d’importation par une mise à jour de Trustline |
| `administrator_created_by_platform`, `subscription_changed`, `import_window_changed` | « par Trustline » repeats the actor column. | Ajout d’un administrateur / Modification de l’abonnement / Modification de la période d’importation |
| `audit_chain_started` | Same ambiguity as English. | Début du scellement du journal d’audit |
| `acknowledgements_exported` / `person_acknowledgements_exported` | Say which; the screen says « relevé ». | Exportation des prises de connaissance d’une version / Exportation du relevé des prises de connaissance d’une personne |
| **Low** | | |
| `documents_exported`, `imports_exported`, `overdue_acknowledgements_exported` | « Export » next to « Importation »: make the pair match. | Exportation de la liste des documents / Exportation du registre des importations / Exportation des prises de connaissance en retard |
| `document_category_*` | Optional, as in English. | Ajout d’une catégorie de documents / Modification d’une catégorie de documents |

### Needs a decision
1. **`incident_reported` for near misses and hazards.** "Incident reported" / «الإبلاغ عن حادث» is wrong for a hazard («مصدر خطر»). Review 1 widened `form.another` for the same reason. My recommendation: keep "Incident" in English and French, where it is the record's name on every screen, and use «تقديم بلاغ» in Arabic, which fits all three types. Otherwise, change all three to "Report submitted" / « Envoi d’une déclaration ».
2. **The "by a Trustline update" suffix** on the six `*_by_system` labels. The simpler choice is just different verbs, but then the reason the System acted is lost.

### Outside the wording, for the API engineer
- **The registry's `details` do not match what is written**, and the viewer will word details from those keys:
  - `password_confirmation_failed` is registered as `byPin`, `pinLocksNow`, but the code writes `pin`, `pinFailures`, `pinLocked`.
  - `incident_triaged` is registered as `personChanged`, but the code writes `assignedTo` and spreads `changes`.
  - `policy_defaults_reworded_by_system`: migration 0043 also writes `categories`.
  - `approval_routes_changed_by_system`: migration 0045 also writes `step`.
  - A test like the action test would catch these.
- **For step 4:** the detail sentences that name a person ("Owner: {from} → {to}") should put the field name first, as above, so that no Arabic or French verb has to agree with the name.
- **For step 7:** the admin portal's own activity labels (`platform.activity.actions.*`) use a different form («أُضيف العميل», « Client ajouté »). Align them when step 7 mirrors those actions.

### Files
- `/home/user/Trustline/apps/api/src/audit/wording/en.ts`, `ar.ts`, `fr.ts`, `types.ts`
- `/home/user/Trustline/apps/api/src/audit/actions.ts`
- `/home/user/Trustline/apps/api/src/audit/chain-check.service.ts` (lines 400-421)
- `/home/user/Trustline/apps/api/src/identity/provisioning.service.ts` (lines 430-467)
- `/home/user/Trustline/apps/api/src/policies/settings.service.ts` (line 234)
- `/home/user/Trustline/apps/web/src/components/notifications/notifications-view.tsx` (lines 266-278)
- `/home/user/Trustline/apps/web/src/lib/notifications.ts` (lines 60, 141-170)
- `/home/user/Trustline/apps/web/src/components/admin/role-form.tsx` (line 222)
- `/home/user/Trustline/apps/web/src/i18n/dictionaries/en.json`, `ar.json`, `fr.json`