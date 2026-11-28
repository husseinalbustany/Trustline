# Language review 10: audit wording, external reviewers, emails (8cbffe4..52b530e)

## Decisions
- Accept every item in every table.
- Arabic "External reviewer" becomes «مقيّم خارجي» everywhere (labels, role name by a new migration, emails, notifications, screens).
- Detail sentences are worded in the API, per language, in one place (audit wording files, a details section), field first, no arrows in Arabic. The viewer answer returns worded detail lines for the request's language (`detailLines`), and the CSV uses the same sentences. Route paths map to screen names.
- The CSV time column names the organization's time zone.
- API items: the API engineer, before continuing reports. Web items (the two notifications, code field naming, reviewer label): the web engineer, inside the audit screens.
- `platformAdminEmail` in administrator_created_by_platform: to the security reviewer (and fixed by the API engineer if confirmed).

# Bilingual review 10: audit-trail wording, external reviewers, new emails (8cbffe4..52b530e)

I changed no project files.

**What I opened and what I only read**
- **Screens:** I opened none. The web has no audit viewer, no external-access screens and no screen for entering the sign-in code yet. Nothing in `apps/web` reads `audit.*`, and none of the new error codes are worded.
- **Emails:** I rendered both new emails, in plain text, in all three languages with `tsx`. The script is `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour10/render.ts`. I did not view the HTML in a mail client.
- **Read only:** everything else.

**Already right**
- **Review 9 applied in full.** Every must, should and low item, both decisions and AR1 are in all three languages. I found no item missed or mistyped.
- **Typography in the wording files:**
  - English uses U+0027 for apostrophes.
  - French uses U+2019 (70 of them), has the word joiner in « e-⁠mail », and puts a no-break space before the colon in the new email sentences.
- **Same keys in all three files:** 114 strings each (80 actions, 8 areas, 10 entities, 12 CSV words, 4 actors).
- **Web items N1, N2 and N4** are in all three dictionaries. They use «القيد / الختم» and « entrée / sceau ».
- **Arabic emails:** the renderer wraps `{count}`, `{hash}` and `{code}` in LRI…PDI, so they keep their order.

---

## 1. Action labels (review 9 checks and new actions)

| Key | Lang | Problem | Proposed |
|---|---|---|---|
| **Must fix** | | | |
| `external_reviewer_viewed` | all | The interceptor writes it for **every** read by a reviewer: lists, reports, the trail itself and downloads, not only one record. "Record viewed" is often false. The Arabic «على ملف» means "a file". | en "Viewed by an external reviewer" · ar «اطلاع مراجع خارجي» · fr « Consultation par un évaluateur externe ». What was viewed goes in the details (area 4). |
| `SYSTEM_ROLES.external_reviewer.description` (`permissions.ts:754-756`) | ar | «والحوادث دون أسماء المُبلِّغين والتقارير» reads as "without the names of reporters **and without the reports**". It also uses «المؤسسة» (0 uses in `ar.json`, where «المنشأة» has 32) and «المُبلِّغين» (review 9 settled «المبلّغ»). | «يطّلع لمدة محدودة على سجل التدقيق وجميع الوثائق والتقارير، وعلى الحوادث دون أسماء المبلّغين. للمقيّمين والمدققين من خارج المنشأة.» |
| same | fr | Ordinary space before « : ». "Pour quelques jours" is wrong, since access can last up to 30 days and be extended once. The sentence form also differs from the other built-in roles, which start with a verb. | « Consulte pour une durée limitée le journal d’audit, tous les documents, les rapports et les incidents sans le nom des déclarants. Pour les évaluateurs et auditeurs extérieurs. » |
| same | en | Same problems as French. "Incidents without their reporters" is unclear. | "Reads, for a limited time, the audit trail, all documents, reports, and incidents without the reporters' names. For surveyors and auditors from outside." |
| **Should fix** | | | |
| `external_access_granted` / `_extended` / `_ended` | ar | «منح صلاحية مراجع خارجي» reads as "granting an external reviewer's permission". | منح صلاحية وصول لمراجع خارجي / تمديد صلاحية وصول مراجع خارجي / إنهاء صلاحية وصول مراجع خارجي |
| `audit_addresses_cleared` | all | Next to names, "addresses" suggests email or street addresses. These are IP addresses. | en "Old sign-in IP addresses cleared" · ar «مسح عناوين IP القديمة لتسجيل الدخول» · fr « Effacement des anciennes adresses IP de connexion » |
| `audit_chain_exported` | ar, fr | «ملف السلسلة» means nothing without context. Use the settled «الختم». | ar «تنزيل ملف سلسلة الأختام» · fr « Téléchargement du fichier de la chaîne » |
| **Low** | | | |
| `audit_entries_exported` | all | Could be confused with the chain file in the same area. | en "Audit trail exported (CSV)" · ar «تصدير سجل التدقيق (CSV)» · fr « Exportation du journal d’audit (CSV) » |
| `docs/specs/audit-trail.md` "Starting wording" and actors | all | Still shows the old wording («مجهول الهوية», «المُبلِّغ», "Audit trail sealed"). | Update it to `wording/*.ts`. |

## 2. Emails

Wording is in `apps/api/src/email/wording/{en,ar,fr}.ts`; the renderer is `render.ts`.

| Key | Lang | Problem | Proposed |
|---|---|---|---|
| **Must fix** | | | |
| `immediate.audit_chain_head.body` | ar | «الإدخال» is not the settled term («القيد»). «مؤسستك» should be «منشأتك». In «وختمه» it is unclear whose seal it is (the trail's or the entry's). | «فُحص سجل التدقيق في منشأتك ووُجد سليمًا حتى القيد رقم {count}. ختم هذا القيد: {hash}. احتفظ بهذه الرسالة: لو عُدِّلت يومًا القيود حتى هذا القيد، أو حُذف منها قيد أو أُضيف إليها، فلن يطابقها هذا الختم.» |
| `immediate.audit_chain_head.subject` | ar | «ختم سجل التدقيق» can read as "closing the audit trail", the same problem as `audit_chain_started` in review 9. | «سجل التدقيق: ختم هذا الأسبوع» |
| `signInCode.expires` | ar | «خلال ⁦10⁩ دقيقة» is wrong agreement: 3 to 10 take the plural. `SIGN_IN_CODE_MINUTES` is 10. «المؤسسة» should be «المنشأة». The sentence also leaves out what matters: the code is only sent after the right password. | «يُستخدم مرة واحدة فقط، وتنتهي صلاحيته بعد {count} دقائق. لا تُطلع أحدًا عليه. إن لم تكن قد حاولت تسجيل الدخول للتو، فهناك من يعرف كلمة مرورك: أبلغ المنشأة التي منحتك صلاحية الوصول.» If the constant ever goes to 11 or more, the noun must become «دقيقة». |
| `signInCode.expires` | fr | « l’organisation » should be « établissement » (89 uses in `fr.json`). « qui vous a invité » assumes the reader is male. | « Il ne peut servir qu’une fois, dans les {count} minutes. Ne le communiquez à personne. Si vous n’avez pas tenté de vous connecter à l’instant, quelqu’un d’autre connaît votre mot de passe : prévenez l’établissement qui vous a donné cet accès. » |
| `signInCode.expires` | en | The "what to do" is too weak (see the Arabic row). | "It can be used once, within {count} minutes. Do not give it to anyone. If you did not just try to sign in, someone else knows your password: tell the organization that gave you access." |
| `audit_chain_head.body` | fr | « votre organisation » should be « votre établissement ». "Antérieur à cette entrée" leaves out the entry itself. | « Le journal d’audit de votre établissement a été vérifié : il est intact jusqu’à l’entrée {count}. Le sceau de cette entrée est {hash}. Conservez ce message : si une entrée jusqu’à celle-ci était un jour modifiée, supprimée ou ajoutée après coup, ce sceau ne correspondrait plus. » Subject: « Journal d’audit : le sceau de la semaine » |
| Footer of the sign-in code email (`render.ts:216-219`) | all | It uses `footer.member` ("as a member of {organization}" / «لأنك من مستخدمي Trustline في»). The spec says the reviewer is *not* a member of staff. `footer.noDetails` (incident or document) does not apply to a code. | Add `signInCode.footer` and leave out `noDetails`. en "You receive this email because {organization} gave you access to Trustline as an external reviewer." · ar «تصلك هذه الرسالة لأن لديك صلاحية وصول إلى Trustline بصفة مراجع خارجي لدى {organization}.» (no verb agrees with the name) · fr « Vous recevez cet e-⁠mail car vous disposez d’un accès d’évaluateur externe à Trustline pour {organization}. » |
| In-app `notifications.kinds.audit_chain_head` and `external_access_changed` (web, missing in all three `.json`) | all | The API now writes both kinds (`chain-check.service.ts:342`, `external-access.service.ts:287`). They fall back to `kinds.other`: «الحادث : هناك جديد بشأنه.» / "There is an update on .", the same defect as N1. | **audit_chain_head:** en "The audit trail passed this week's check up to entry {seq}. Its seal has been emailed to you: keep that email." · ar «سجل التدقيق: اجتاز فحص هذا الأسبوع حتى القيد رقم {seq}، وأُرسل إليك ختمه بالبريد الإلكتروني، فاحتفظ بتلك الرسالة.» · fr « Journal d’audit : la vérification de la semaine est réussie jusqu’à l’entrée {seq}. Son sceau vous a été envoyé par e-⁠mail ; conservez ce message. » **external_access_changed**, one variant per `data.change`, name after the colon (resolve `personId` as for `policies_import_granted`): en "External reviewer access granted / extended / ended: {name}." · ar «مُنحت صلاحية وصول لمراجع خارجي: {name}.» / «مُدِّدت صلاحية وصول مراجع خارجي: {name}.» / «انتهت صلاحية وصول مراجع خارجي: {name}.» (the verb agrees with «صلاحية») · fr « Accès d’évaluateur externe ouvert / prolongé / terminé : {name}. » |
| **Should fix** | | | |
| `signInCode.subject`, `.body` | ar | «رمز الدخول» should be «تسجيل الدخول» (the settled term). The colon form is easier to copy. | «رمز تسجيل الدخول إلى Trustline» / «رمز تسجيل الدخول الخاص بك: {code}» |
| `audit_chain_head.body` | en | "Before that entry" leaves out the entry itself. The seal is easier to compare if it ends a sentence. | "Your organization’s audit trail was checked and is unbroken up to entry {count}. The seal of that entry is: {hash}. Keep this email: if any entry up to that one were ever changed, removed or added afterwards, this seal would no longer match." (keep ’, as the rest of the email file does) |
| HTML of `audit_chain_head` | all | A 64-character hash inside a sentence does not wrap. At 390 px it widens the email, and it is hard to copy. | Put entry and seal in a paragraph of their own: `<p dir="ltr" style="font-family:monospace;word-break:break-all">`. |
| Footer of `audit_chain_head` | all | It shows "Stop these immediate emails", which does not stop this email. `page.alwaysOn` and the preferences screen (`pinEmailed`) do not say this email is always sent. | Add, for administrators: en "Administrators are always sent the weekly seal of the audit trail by email, whatever their email settings." · ar «تصل إلى مسؤولي النظام دائمًا رسالة أسبوعية بختم سجل التدقيق، أيًّا كانت إعدادات بريدهم الإلكتروني.» · fr « Les administrateurs reçoivent toujours par e-⁠mail le sceau hebdomadaire du journal d’audit, quels que soient leurs réglages. » |
| **Low** | | | |
| `audit_chain_head` | all | `data.checkedOn` is stored but not shown. Kept as evidence, the email is better if it says the day. Keep `{count}` without a thousands separator, so it matches `seq` in the chain file. | Add "on {day}", using the daily digest's FSI handling. |

The only external-access email is the code email. Granting, extending and ending access are told in the app only, and the one-time link goes back to the administrator.

## 3. CSV of the audit export

Headings and values are in `wording/*.ts` under `csv`, `areas`, `entities` and `actors`; the export is written in `trail.service.ts:319-372`.

| Key | Lang | Problem | Proposed |
|---|---|---|---|
| **Must fix** | | | |
| Details column (`trail.service.ts:359`) | all | It is `JSON.stringify(e.details)`. Every file, Arabic and French included, gets English keys, raw codes (`period_over`, `wrong_code`, `/incidents/:id`), UUIDs (`roleId`), and client text in all three languages at once. A surveyor cannot read it. | Word the details in the API, per language (area 4), and write those sentences here. |
| `csv.sealedLate` | fr | « Enregistré » refers to « entrée », which is feminine. | « Entrée antérieure au début du scellement » |
| `csv.sealedLate` | ar | «قُيِّد» can also read as "restricted" (the documents screens use «المقيّدة»). «السجل» does not say which record. It also no longer matches the new label «بدء ختم سجل التدقيق». | «قيد سابق لبدء الختم» |
| `csv.sealedLate` | en | Not aligned with "Audit trail sealing started". | "Recorded before sealing started" |
| **Should fix** | | | |
| `csv.record` / `csv.recordType` | all | The "Reference" column also holds names of people, roles and units. Arabic «السجل» clashes with «سجل التدقيق». French « Dossier » is wrong for a role or a person. | en "Record type" / "Record" · ar «نوع العنصر» / «العنصر» · fr « Type d’élément » / « Élément » |
| `csv.address` | all | Next to a person's name, "Address" reads as personal contact details. | en "IP address" · ar «عنوان IP» · fr « Adresse IP » |
| `csv.at` | all | The times are in the organization's time zone, but no zone is given. "When" and «الوقت» say little. | Fill the zone in, as the web does (`hospitalDays`): en "Date and time ({zone})" · ar «التاريخ والوقت ({zone})» · fr « Date et heure ({zone}) » |
| `csv.who`, `csv.action`, `csv.seq` | en | "What" and "No." are vague. | "Done by" / "Action" / "Entry no." |
| `csv.who` | ar | «المنفِّذ» has extra marks (review 9 rule) and suggests "executor". | «القائم بالإجراء» |
| `csv.seq` | fr | « N° » alone is vague. | « N° d’entrée » |
| `entities.org_unit` | all | "Unit" / «وحدة» / « Unité » is one of three types, the same problem fixed in the labels. | Word it by the unit's type, as the structure screen does: Facility / Department / Unit · مرفق / قسم / وحدة · Site / Service / Unité |
| Who column, external reviewer | all | Their name alone looks like a member of staff. | "{name} (external reviewer)" · «{name} (مراجع خارجي)» · « {name} (évaluateur externe) » |
| Who column, name gone | all | The cell is empty. The web says "A former user" / «مستخدم سابق» / « Un ancien utilisateur ». | Add `csv.formerUser` with the same words. |
| **Low** | | | |
| `entities.document_category` | en | Should match the labels. | "Document category" |
| `areas.exports` | fr | Should match the « Exportation » labels. The three audit downloads are under "Audit trail", not "Exports", so filtering by Exports does not find them. | « Exportations ». Consider adding a note to the filter. |

## 4. Detail sentences

The API words no details anywhere. The registry only lists keys "for the viewer to word", and the viewer does not exist yet. So the field-first rule cannot be checked; it has to be set before step 4. To keep the CSV and the screen the same, the wording should live in the API (`wording/*.ts`, a `details` section) or in one shared place.

| Key | Lang | Problem | Proposed |
|---|---|---|---|
| **Must fix** | | | |
| All changes "from → to" | ar | An arrow is not mirrored in right-to-left text, so «→» points backwards. | Field first, then words, with no verb: «الحالة: من «مفتوح» إلى «مغلق»». Names the same way: «المسؤول عن الوثيقة: من {from} إلى {to}». en "Status: Open → Closed" · fr « Statut : Ouvert → Clôturé » |
| `external_access_granted` (organization, purpose, from, until, roleId) | all | `roleId` is a UUID; the reader needs the role's name. | en "Their organization: {organization} · Purpose: {purpose} · Access: {from} to {until} · Role: {role}" · ar «جهة المراجع: {organization} · الغرض: {purpose} · مدة الوصول: من {from} إلى {until} · الدور: {role}» · fr « Organisme d’origine : {organization} · Objet : {purpose} · Accès : du {from} au {until} · Rôle : {role} » |
| `external_access_extended` (from, to, reason) | all | | en "Last day: {from} → {to} · Reason: {reason}" · ar «آخر يوم: من {from} إلى {to} · السبب: {reason}» · fr « Dernier jour : {from} → {to} · Motif : {reason} » |
| `external_access_ended.by` | all | Raw values `administrator` and `period_over`. | en "Reason: ended before its last day ({until})" / "Reason: last day passed ({until})" · ar «السبب: إنهاء قبل آخر يوم ({until})» / «السبب: انقضاء آخر يوم ({until})» · fr « Motif : fin anticipée (dernier jour prévu : {until}) » / « Motif : dernier jour passé ({until}) » |
| `external_reviewer_viewed` (route, recordType, recordId) | all | `route` is a raw path such as `/incidents/:id`, so the client cannot show what was examined. | Map each route to the name of its screen, and name the record by its reference: en "Viewed: {screen} {record}" · ar «موضع الاطلاع: {screen} {record}» · fr « Consulté : {screen} {record} » |
| `sign_in_failed.reason` = `outside_access`, `wrong_code`; `sign_in.secondFactor` = `email_code` | all | New raw values. | en "Reason: outside the access period" / "Reason: wrong or expired sign-in code" / "Second step: one-time code by email" · ar «السبب: خارج فترة الوصول» / «السبب: رمز تسجيل الدخول غير صحيح أو منتهي الصلاحية» / «التحقق الثاني: رمز لمرة واحدة بالبريد الإلكتروني» · fr « Motif : en dehors de la période d’accès » / « Motif : code de connexion erroné ou expiré » / « Deuxième étape : code à usage unique par e-⁠mail » |
| **Should fix** | | | |
| `audit_entries_exported` (filters, locale, rows) | all | Raw filter object and a language code. | en "Rows: {rows} · Language: {language} · Filters: {filters}" · ar «عدد الصفوف: {rows} · اللغة: {language} · عوامل التصفية: {filters}» · fr « Lignes : {rows} · Langue : {language} · Filtres : {filters} » |
| `audit_chain_exported` (fromSeq, toSeq, entries, withheld) | all | `withheld` is not self-explanatory. | en "Entries: {fromSeq} to {toSeq} · Seal only, without content: {withheld}" · ar «القيود: من {fromSeq} إلى {toSeq} · بالختم فقط دون المحتوى: {withheld}» · fr « Entrées : de {fromSeq} à {toSeq} · Sceau seul, sans contenu : {withheld} » |
| `audit_checkpoints_exported`, `audit_addresses_cleared` | all | | en "Period: {from} to {to} · Checkpoints: {checkpoints}" / "Recorded before: {before} · Addresses cleared: {count}" · ar «الفترة: من {from} إلى {to} · نقاط التحقق: {checkpoints}» / «المسجَّلة قبل: {before} · العناوين الممسوحة: {count}» · fr « Période : du {from} au {to} · Points de contrôle : {checkpoints} » / « Date limite : {before} · Adresses effacées : {count} ». When from/to is missing: "all" / «الكل» / « toutes ». |
| `client_created_by_platform` (slug, plan) | all | The slug needs `dir="ltr"`. | en "Identifier: {slug} · Plan: {plan}" · ar «المعرّف: {slug} · الباقة: {plan}» · fr « Identifiant : {slug} · Formule : {plan} » |

French: a no-break space before every « : », and « · » between parts.

## Needs a decision
1. **Arabic name for "External reviewer":**
   - The trail and the menus already use «مراجعة» for document review («إرسال إصدار للمراجعة»), so «مراجع خارجي» will sit next to it in the action filter.
   - CBAHI and JCI call surveyors «المقيّمون», and the French already says « évaluateur ».
   - **My recommendation:** «مقيّم خارجي» everywhere: labels, role name, emails, notifications. The role name is seeded by migration 0061, so a change needs a migration.
   - Otherwise keep «مراجع خارجي» and apply the rows above as written.

## Outside the wording
- **Web screens not built yet:** none of the new API codes are in the dictionaries (`one_time_code_sent`, `code_not_sent`, `read_only_access`, `not_read_only`, `access_too_long`, `already_extended`, `stale_access`, `access_ended`, …). The web cannot take a reviewer through the code step yet. When the code field is built, name it «رمز تسجيل الدخول» / « code de connexion », as in the email.
- **Contact details in the trail:** `administrator_created_by_platform` still registers `platformAdminEmail`. The spec says new entries hold no contact details. This is for `security-reviewer`.

## Files
- `/home/user/Trustline/apps/api/src/audit/wording/en.ts`, `ar.ts`, `fr.ts`, `types.ts`
- `/home/user/Trustline/apps/api/src/audit/trail.service.ts` (lines 319-372)
- `/home/user/Trustline/apps/api/src/audit/reviewer-reads.interceptor.ts`
- `/home/user/Trustline/apps/api/src/audit/actions.ts` (lines 101-103, 171-184)
- `/home/user/Trustline/apps/api/src/email/wording/en.ts`, `ar.ts`, `fr.ts` (lines 58-67)
- `/home/user/Trustline/apps/api/src/email/render.ts` (lines 146-232)
- `/home/user/Trustline/apps/api/src/email/email-worker.service.ts` (lines 775-788)
- `/home/user/Trustline/apps/api/src/identity/permissions.ts` (lines 750-757)
- `/home/user/Trustline/apps/api/src/identity/external-access.service.ts` (lines 165, 215, 249, 276-292)
- `/home/user/Trustline/apps/api/src/audit/chain-check.service.ts` (lines 318-346)
- `/home/user/Trustline/apps/web/src/i18n/dictionaries/en.json`, `ar.json`, `fr.json` (`notifications.kinds`)
- Rendering script: `/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/nour10/render.ts`