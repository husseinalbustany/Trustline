# API contract for the web: the audit trail (steps 1 to 7)

> **[Maya 3] Confirmed, for the audit screens** (all three are in the API
> committed as 4acf9c5):
> 1. **`locale` is an accepted query field** of `GET /audit/entries`
>    (`?locale=en|ar|fr`, one of the client's languages; 400
>    `language_mismatch` otherwise; by default the client's own language).
>    Every item has `detailLines: string[]` in that language. Send it.
> 2. **The actor tells an external reviewer:** a person actor is
>    `{ kind: 'person', id, name, external: boolean }`. Show
>    "{name} (external reviewer)" when `external` is true. The other kinds
>    are `trustline_staff` (with `name`), `system`, `reporter` and
>    `anonymous`.
> 3. **The verifier requires the keys:**
>    `node verify-audit-chain.mjs <chain.jsonl> <keys.json> [--allow-unanchored-tail]`.
>    Without `keys.json` it stops with exit code 2. The keys must be the
>    answer of `/api/v1/audit/keys`, taken from Trustline's site, never from
>    the file. An earlier version of this contract called them optional:
>    they are not.

> **CHANGED by language review 10 and security review 14** (marked **[R10/14]**):
> - **Wording from the API:** every entry now has `detailLines`, its
>   details as sentences in the request's language (`?locale=`, one of the
>   client's, else its own). Show those lines, and stop wording `details`
>   yourself.
> - **Actors:** `actor.external` says whether a person is an external
>   reviewer. Show "{name} (external reviewer)" / «{name} (مقيّم خارجي)» /
>   « {name} (évaluateur externe) ».
> - **Masking:** only the report, and comments written as the reporter, are
>   masked. Whatever else the reporter did is shown under their name.
> - **What is withheld:**
>   - `ip` is always null for an external reviewer;
>   - `details` never hold `platformAdminEmail` or, when masked, `channel`.
> - **The chain file:** a withheld line has no `bodyHash`. The script takes
>   `<file> <keys.json>`; the keys must come from Trustline's site.
> - **New error codes:**
>   - 429 `export_in_progress`: one chain download per client at a time;
>   - 409 `held_by_external_reviewer`: on `PATCH /roles/:id` that would let
>     a role a reviewer holds do more than read;
>   - 503 `code_not_sent` in production when mail is not set up.
> - **Sign-in:** five wrong codes lock the account, as five wrong passwords
>   do. More than five codes in an hour are refused with 401.
> - **Arabic "External reviewer"** is «مقيّم خارجي» everywhere: the role
>   (renamed by migration), the labels, the email.
> - **Labels:** the tables at the end are regenerated.


The routes are under `/api/v1` and follow docs/specs/audit-trail.md (see its "Built" section).

Every route below answers:
- 401 without a session;
- 403 `{ code: 'missing_permission', permission }` without the permission;
- 400 for any input that is not strictly its own.

Dates are days on the organization's calendar (`YYYY-MM-DD`). Times are UTC ISO strings; show them in the organization's time zone.

## Who sees what

- **`audit.view`** (core, new). Only a grant for the whole organization opens the audit routes; a grant for one unit is refused with 403.
  - It is held by the built-in Administrator and Quality officer, and by the new built-in **External reviewer** role.
  - The role editor needs its label, `admin.permissions.audit.view`:
    - en "View the audit trail";
    - ar «الاطلاع على سجل التدقيق»;
    - fr « Consulter le journal d’audit ».
  - The role editor should say that only a grant for the whole organization counts.
- **New built-in role** `external_reviewer`. It holds `audit.view`, `policies.view_all`, `incidents.view` and `reports.view`. Its name and description in three languages come with the roles list, as for the other built-in roles.
- **`/auth/me`** now gives `user.kind`, which is `'staff'` or `'external_reviewer'`, and `user.access`, which is `{ from, until } | null`.
  - For an external reviewer, hide every action that writes: the API refuses each one with 403 `{ code: 'read_only_access' }`.
  - Show their access days.
  - Signing out still works.

## The viewer: `/admin/audit`

### `GET /audit/status`

- Needs `audit.view` for the whole organization. It takes no query (any query is a 400).
- Answer:
  ```json
  { "head": { "seq": 18422, "at": "…" },
    "lastCheck": { "at", "result": "passed|failed", "full": true, "fromSeq", "toSeq",
                   "kind": null, "firstBadSeq": null, "firstBadEntryId": null, "signed": true } | null,
    "broken": { "at", "kind", "firstBadSeq", "firstBadEntryId" } | null,
    "sealedOn": "2026-11-28" | null, "sealedBefore": 20,
    "signing": "signed" | "unsigned" }
  ```
- `broken` is the first break found. It stays set even after a later check passes. Show a permanent notice with the first entry found wrong.
- The notice from the spec: "Unbroken: entries 1 to {head.seq}. Checked every day; last check {lastCheck.at}, {result}. Entries 1 to {sealedBefore} were recorded before the trail was sealed, on {sealedOn}: the chain shows they have not changed since that day, not before it."
  - Leave out the last sentence when `sealedBefore` is 0.
- `signing: 'unsigned'`: this deployment has no signing key, so checkpoints are not signed. `lastCheck.signed` is true only when the checkpoint's signature holds.
- `kind` is one of `content_changed`, `missing_entry`, `missing_seal`, `gap`, `head_rewound`, `backdated`, `bad_checkpoint`. Wording is under "Notifications" below.

### `GET /audit/entries`

- Needs `audit.view` for the whole organization.
- **Query:**
  - `pageSize` (default 50, at most 200);
  - `before` (the `next` of the page before);
  - `from` and `to` (days);
  - `actorId`;
  - `actions` (comma-separated keys);
  - `area`;
  - `entityType` with optional `entityId`, **or** `reference` (an incident's reference or a document's number), not both.
  - **[R10/14]** `locale`: the language of `detailLines`. It must be one of the client's languages (otherwise 400 `language_mismatch`); by default, the client's own.
  - Refusals: `entityId` without `entityType`, `from` after `to`, a bad cursor, or an unknown action or area each give 400.
- **Answer:**
  ```json
  { "items": [
      { "id", "seq": 12, "at": "2026-11-28T07:15:08.420807Z",
        "actor": { "kind": "person", "id", "name": { en, ar, fr }, "external": false }   // [R10/14] external
               | { "kind": "trustline_staff", "name": "Staff" | null }
               | { "kind": "system" } | { "kind": "reporter" } | { "kind": "anonymous" },
        "action": "incident_reported", "area": "incidents",
        "entity": { "type": "incident", "id", "label": "INC-2026-00042" | { en, ar, fr } | null, "canOpen": true } | null,
        "details": { … } | null,
        "detailLines": ["Status: Open → Closed", …],   // [R10/14] worded, in ?locale
        "ip": "192.0.2.1" | null,
        "sealedLate": false } ],
    "more": true, "next": "<cursor>", "total": 1234, "totalCapped": false }
  ```
- **Showing an entry:**
  - Word the action with `audit.actions.<action>` (tables below), and the actor with `audit.actors.<kind>`. For `person`, show the name with `pick()`.
  - When `totalCapped` is true, show "more than 10,000".
  - `entity.label` is a reference or number (text), or a name to `pick()`. Link the record only when `canOpen` is true.
  - `ip` is given for sign-in entries only.
  - `sealedLate` gives "recorded before the trail was sealed".
  - `seq` is the entry's number in the chain ("#18,422").
- **Masking.** For someone not told an incident's reporter:
  - **[R10/14]** the report, and comments written as the reporter, show as `{ kind: 'reporter' }`. Nothing else the reporter did is masked;
  - `details.anonymous`, `details.byReporter` and **[R10/14]** `details.channel` are removed;
  - filtering by a person never lists what they reported.
- **Entries of a module the client does not have are never listed.**
- **[R10/14] Details:** show `detailLines`, which the API words in the request's language: the field first, a change as "{from} → {to}" (Arabic «من … إلى …», with no arrow), ids as names, references and numbers. `details` stays, raw, for anything else.

### `GET /audit/exports/entries`

- The same filters as the entries route, plus `locale`, which must be one of the client's languages (otherwise 400 `{ code: 'language_mismatch' }`).
- The answer is a CSV: worded, at most 50,000 rows, newest first. It is audited.

### `GET /audit/exports/chain`

- Query: `fromSeq` and `toSeq` (both optional; `fromSeq` must not be after `toSeq`).
- The answer is a JSON Lines file (`audit-chain-<slug>-<first>-<last>.jsonl`). It is audited.
- The format is in the spec ("The chain file format"). Entries the caller may not see in full have no `body`, and **[R10/14]** no `bodyHash`.
- **[R10/14]** Only one chain download per client runs at a time. A second gets 429 `{ code: 'export_in_progress' }`: say "A download is already running; try again in a moment".

### `GET /audit/checkpoints`

- Query: `from` and `to` (days).
- The answer is a JSON file of the signed checkpoints, with the public keys. It is audited.

### `GET /audit/keys`

- Needs no sign-in. It lists Trustline's public keys: `{ keys: [{ keyId, algorithm: 'Ed25519', publicKey, current }] }`.

### Buttons

- "Download CSV", "Download chain file" and "Download checkpoints".
- The viewer should encourage a monthly download of the checkpoints.
- The chain file can be checked with `apps/api/scripts/verify-audit-chain.mjs` (**[R10/14]** `node verify-audit-chain.mjs <file> <keys.json>`, with the keys from `/api/v1/audit/keys`; it fails when no signed checkpoint covers the file).

## External reviewers: Administration, Users, "External reviewer access"

### `GET /users/external`

- Needs `users.manage` for the whole organization.
- It answers `[{ id, name, email, status, organization, purpose, from, until, extendedAt, extensionReason, endedAt, revision, lastSignInAt, role: { id, code, name } }]`.

### `POST /users/external`

- Needs `users.manage` and `audit.view`, both for the whole organization. It stays open while the subscription is suspended.
- **Body:** `{ name: { en, ar?, fr? }, email, organization, purpose, from, until, roleId, preferredLocale? }`.
- **Answer:** 201 `{ reviewer, invite: { token, expiresAt, org } }`. Show the link, as for an invitation.
- **Refusals:**
  - 400 `{ code: 'access_in_past', field: 'from' }`;
  - 400 `{ code: 'access_out_of_order', field: 'until' }`;
  - 400 `{ code: 'access_too_long', field: 'until', days: 30 }` (30 days at most, first and last included);
  - 400 `{ code: 'not_read_only', permissions: [...] }` for a role that does anything but read, or that holds `incidents.see_reporter`;
  - 400 `{ code: 'language_mismatch' }`;
  - 403 `{ code: 'outside_scope', permission }`;
  - 404 `{ code: 'role_not_found' }`;
  - 409 `{ code: 'email_taken' }`.
- Suggest the built-in External reviewer role. Say that reviewers never see reporters' names and do not count as named users.

### `PATCH /users/external/:id`

- Needs the same permissions as granting.
- **Body:** either `{ until, reason, revision }` to extend, which is allowed once, for at most 30 more days; or `{ end: true, revision }` to end the access.
- **Answer:** the reviewer.
- **Refusals:**
  - 409 `stale_access` (the revision has changed: reload);
  - 409 `already_extended`;
  - 409 `access_ended`;
  - 400 `access_too_long` and `access_out_of_order`;
  - 404 for anyone who is not an external reviewer of this client.

### Roles a reviewer holds

**[R10/14]** `PATCH /roles/:id` answers 409 `{ code: 'held_by_external_reviewer' }` when the change would let a role an external reviewer holds do anything but read.

### Staff routes

- `PUT /users/:id/roles`, `PATCH /users/:id` and `POST /users/:id/invite` on a reviewer answer 409 `{ code: 'external_reviewer' }`. Manage reviewers on their own screen.

### Sign-in

- After the right password, `POST /auth/login` answers 200 `{ code: 'one_time_code_sent', challenge }` for an external reviewer, and sets no cookie.
- Then ask for the six-digit code from the email, and send `POST /auth/login/code` with `{ org, challenge, code }`.
  - The answer is as for a sign-in: a cookie, or `{ token }` on mobile.
  - 401 for a wrong, used or expired code: ten minutes, five tries. Offer to sign in again, which sends a new code.
  - **[R10/14]** Five wrong codes in all lock the account for 15 minutes, as wrong passwords do. At most five codes are sent in an hour; after that, sign-in answers 401.
  - **[R10/14]** Name the code field «رمز تسجيل الدخول» / « code de connexion » / "sign-in code", as in the email.
  - 503 `{ code: 'code_not_sent' }` when the email could not be sent.
- Outside their days, the sign-in answers 401, and a session already open ends.

## Notifications (in the app), new kinds

The list now gives `person: { id, name } | null` for a notification that names someone (`data.personId`). Show the name with `pick()`.

### `audit_chain_broken`

- Data: `{ kind, firstBadSeq?, serious: true }`, about nothing else.
- Sent to holders of `audit.view` or `settings.manage` for the whole organization.
- Wording (language review 9, N1). Use one variant per `kind`, and a variant without `{seq}` for `missing_seal`, which has no number:
  - en "The daily check found that the audit trail no longer matches its seals from entry {seq} ({kind}). Contact Trustline so the cause can be found."
  - ar «سجل التدقيق: تبيّن في الفحص اليومي أنه لم يعد مطابقًا لأختامه بدءًا من القيد رقم {seq}، إذ {kind}. تواصل مع Trustline لمعرفة السبب.»
  - fr « Journal d’audit : la vérification quotidienne a constaté qu’il ne correspond plus à ses sceaux à partir de l’entrée {seq} ({kind}). Contactez Trustline pour en déterminer la cause. »
- Kind phrases: the table in language review 9.

### `policies_import_granted`

- Data: `{ personId, serious: false }`, plus `person` in the list.
- Sent to the other Quality officers and Administrators.
- Wording N2:
  - en "{name} can now import existing documents. If you did not expect this, check their roles under “Users and roles”."
  - ar «أصبح بإمكان {name} استيراد الوثائق القائمة. إن لم يكن ذلك متوقعًا، فراجع أدوار هذا الشخص في «المستخدمون والأدوار».»
  - fr « {name} peut désormais importer des documents existants. Si ce n’était pas prévu, vérifiez les rôles de cette personne dans « Utilisateurs et rôles ». »

### `external_access_changed`

- Data: `{ change: 'granted' | 'extended' | 'ended', personId, serious: false }`, plus `person` in the list.
- Sent to holders of `users.manage` for the whole organization.
- Proposed wording, for the language review:
  - en "{name} was given external reviewer access." / "{name}'s external reviewer access was extended." / "{name}'s external reviewer access ended."
  - ar «مُنح {name} صلاحية مراجع خارجي.» / «مُدِّدت صلاحية المراجع الخارجي {name}.» / «انتهت صلاحية المراجع الخارجي {name}.»
  - fr « Un accès d’évaluateur externe a été ouvert pour {name}. » / « L’accès d’évaluateur externe de {name} a été prolongé. » / « L’accès d’évaluateur externe de {name} a pris fin. »

### `audit_chain_head`

- Data: `{ seq, hash, checkedOn, serious: false }`.
- Sent once a week to the Administrators. It is also emailed, and the email cannot be switched off.
- Proposed wording:
  - en "This week's seal of the audit trail: entry {seq}, seal {hash}. Keep it."
  - ar «ختم سجل التدقيق لهذا الأسبوع: القيد رقم {seq}، والختم {hash}. احتفظ به.»
  - fr « Sceau du journal d’audit cette semaine : entrée {seq}, sceau {hash}. Conservez-le. »

### Changed

`review_approval_turned_off` now carries `typeName: { en, ar, fr }` (N3).

## Emails (the API words them)

- **`audit_chain_head`:** subject "This week’s seal of your audit trail", with the number and the hash. Linked to `/admin/audit`.
- **The sign-in code:** "Your Trustline sign-in code". It holds the code only, and has no preferences or unsubscribe link.

## Labels

The keys the web dictionaries need are below, generated from `apps/api/src/audit/wording/*.ts`, which hold these words for the CSV.

The tables follow language review 9:
- English uses U+0027 apostrophes, as `en.json` does;
- the six `*_by_system` labels keep "by a Trustline update";
- Arabic `incident_reported` is «تقديم بلاغ»;
- the settled terms are ar «القيد / القيود» and «الختم / الأختام», fr « entrée » and « sceau / scellement ».

### Action labels (`audit.actions.<key>`)

| Key | Area | English | Arabic | French |
|---|---|---|---|---|
| `sign_in` | sign_in | Sign-in | تسجيل الدخول | Connexion |
| `sign_in_failed` | sign_in | Failed sign-in | محاولة تسجيل دخول فاشلة | Échec de connexion |
| `sign_out` | sign_in | Sign-out | تسجيل الخروج | Déconnexion |
| `password_set` | sign_in | Password set | تعيين كلمة المرور | Définition du mot de passe |
| `password_confirmation_failed` | sign_in | Password or PIN check failed | فشل التحقق من كلمة المرور أو رمز التوقيع | Échec de la vérification du mot de passe ou du code de signature |
| `signing_pin_set` | sign_in | Signing PIN set or changed | تعيين رمز التوقيع أو تغييره | Définition ou modification du code de signature |
| `signing_pin_reset` | sign_in | Signing PIN reset | إعادة تعيين رمز التوقيع | Réinitialisation du code de signature |
| `signing_pin_locked` | sign_in | Signing PIN locked | قفل رمز التوقيع | Blocage de la signature par code |
| `user_created` | accounts | User added | إضافة مستخدم | Ajout d’un utilisateur |
| `user_updated` | accounts | User's details changed | تعديل بيانات مستخدم | Modification des informations d’un utilisateur |
| `user_roles_changed` | accounts | User's roles changed | تغيير أدوار مستخدم | Modification des rôles d’un utilisateur |
| `sign_in_link_created` | accounts | Password link created | إنشاء رابط لتعيين كلمة المرور | Création d’un lien de définition du mot de passe |
| `role_created` | accounts | Role added | إضافة دور | Ajout d’un rôle |
| `role_updated` | accounts | Role changed | تعديل دور | Modification d’un rôle |
| `role_deleted` | accounts | Role deleted | حذف دور | Suppression d’un rôle |
| `administrator_created_by_platform` | accounts | Administrator added | إضافة مسؤول نظام | Ajout d’un administrateur |
| `built_in_roles_changed_by_system` | accounts | Built-in roles changed by a Trustline update | تعديل الأدوار الافتراضية بتحديث من Trustline | Modification des rôles par défaut par une mise à jour de Trustline |
| `external_access_granted` | accounts | External reviewer access granted | منح صلاحية وصول لمقيّم خارجي | Ouverture d’un accès d’évaluateur externe |
| `external_access_extended` | accounts | External reviewer access extended | تمديد صلاحية وصول مقيّم خارجي | Prolongation d’un accès d’évaluateur externe |
| `external_access_ended` | accounts | External reviewer access ended | إنهاء صلاحية وصول مقيّم خارجي | Fin d’un accès d’évaluateur externe |
| `org_unit_created` | organization | Facility, department or unit added | إضافة مرفق أو قسم أو وحدة | Ajout d’un site, d’un service ou d’une unité |
| `org_unit_updated` | organization | Facility, department or unit changed | تعديل مرفق أو قسم أو وحدة | Modification d’un site, d’un service ou d’une unité |
| `org_unit_moved` | organization | Department or unit moved | نقل قسم أو وحدة في الهيكل التنظيمي | Déplacement d’un service ou d’une unité |
| `public_reporting_changed` | organization | Reporting without sign-in switched on or off | تفعيل الإبلاغ دون تسجيل الدخول أو إلغاء تفعيله | Activation ou désactivation de la déclaration sans authentification |
| `response_rules_changed` | organization | Triage and closure deadlines changed | تعديل المواعيد النهائية للفرز والإغلاق | Modification des délais de tri et de clôture |
| `email_setting_changed` | organization | Email switched on or off for the organization | تفعيل البريد الإلكتروني للمنشأة أو إيقافه | Activation ou désactivation de l’e-⁠mail pour l’établissement |
| `notification_preferences_changed` | organization | Email preferences changed | تغيير تفضيلات البريد الإلكتروني | Modification des préférences d’e-⁠mail |
| `incident_reported` | incidents | Incident reported | تقديم بلاغ | Déclaration d’un incident |
| `incident_triaged` | incidents | Incident triaged | فرز حادث | Tri d’un incident |
| `incident_status_changed` | incidents | Incident status changed | تغيير حالة حادث | Changement de statut d’un incident |
| `incident_commented` | incidents | Comment added to an incident | إضافة تعليق على حادث | Ajout d’un commentaire à un incident |
| `incident_deadlines_filled` | incidents | Incident deadlines set | تحديد المواعيد النهائية لحادث | Fixation des échéances d’un incident |
| `public_reporting_limit_reached` | incidents | Reporting without sign-in paused (hourly limit reached) | إيقاف الإبلاغ دون تسجيل الدخول مؤقتًا (بلوغ الحد الأقصى في الساعة) | Suspension de la déclaration sans authentification (limite horaire atteinte) |
| `document_created` | documents | Document created | إنشاء وثيقة | Création d’un document |
| `document_updated` | documents | Document details changed | تعديل بيانات وثيقة | Modification des informations d’un document |
| `document_version_created` | documents | New version started | بدء إصدار جديد | Ouverture d’une nouvelle version |
| `document_version_edited` | documents | Draft edited | تعديل مسودة | Modification d’un brouillon |
| `document_submitted` | documents | Version sent for review | إرسال إصدار للمراجعة | Soumission d’une version à vérification |
| `document_step_approved` | documents | Approval step signed | توقيع خطوة في مسار الاعتماد | Signature d’une étape du circuit d’approbation |
| `document_returned` | documents | Version returned with comments | إعادة إصدار مع ملاحظات | Renvoi d’une version avec des remarques |
| `document_recalled` | documents | Version taken back to draft | استعادة إصدار للتعديل | Remise en brouillon d’une version |
| `document_version_withdrawn` | documents | Version withdrawn | سحب إصدار | Abandon d’une version |
| `document_publish_scheduled` | documents | Publication scheduled | جدولة النشر | Programmation de la publication |
| `document_published` | documents | Version published | نشر إصدار | Publication d’une version |
| `document_retired` | documents | Document retired | إيقاف العمل بوثيقة | Retrait d’un document |
| `document_reviewed` | documents | Periodic review recorded | تسجيل المراجعة الدورية | Enregistrement de la révision périodique |
| `document_review_requested` | documents | Periodic review sent for approval | إرسال المراجعة الدورية للاعتماد | Envoi de la révision périodique pour approbation |
| `document_review_approved` | documents | Periodic review approved | اعتماد المراجعة الدورية | Approbation de la révision périodique |
| `document_review_returned` | documents | Periodic review returned | إعادة المراجعة الدورية | Renvoi de la révision périodique |
| `document_acknowledged` | documents | Document acknowledged | الإقرار بالاطلاع على وثيقة | Prise de connaissance d’un document |
| `document_imported` | documents | Document imported | استيراد وثيقة | Importation d’un document |
| `document_import_signed` | documents | Import batch signed | توقيع دفعة استيراد | Signature d’un lot d’importation |
| `import_confirmed` | documents | Import confirmed by the owner | تأكيد المسؤول عن الوثيقة للاستيراد | Confirmation de l’importation par le responsable |
| `document_type_created` | documents | Document type added | إضافة نوع وثيقة | Ajout d’un type de document |
| `document_type_updated` | documents | Document type changed | تعديل نوع وثيقة | Modification d’un type de document |
| `document_category_created` | documents | Document category added | إضافة فئة | Ajout d’une catégorie de documents |
| `document_category_updated` | documents | Document category changed | تعديل فئة | Modification d’une catégorie de documents |
| `approval_route_created` | documents | Approval route added | إضافة مسار اعتماد | Ajout d’un circuit d’approbation |
| `approval_route_updated` | documents | Approval route changed | تعديل مسار اعتماد | Modification d’un circuit d’approbation |
| `document_settings_updated` | documents | Document settings changed | تعديل إعدادات الوثائق | Modification des paramètres des documents |
| `document_type_changed_by_system` | documents | Document type changed by a Trustline update | تعديل نوع وثيقة بتحديث من Trustline | Modification d’un type de document par une mise à jour de Trustline |
| `approval_routes_changed_by_system` | documents | Approval routes changed by a Trustline update | تعديل مسارات الاعتماد بتحديث من Trustline | Modification des circuits d’approbation par une mise à jour de Trustline |
| `policy_defaults_reworded_by_system` | documents | Default type and category names reworded by a Trustline update | تعديل صياغة أسماء الأنواع والفئات الافتراضية بتحديث من Trustline | Reformulation des noms des types et catégories par défaut par une mise à jour de Trustline |
| `import_confirmations_corrected_by_system` | documents | Import confirmations corrected by a Trustline update | تصحيح تأكيدات الاستيراد بتحديث من Trustline | Correction des confirmations d’importation par une mise à jour de Trustline |
| `import_confirmations_backfilled_by_system` | documents | Import confirmations recorded by a Trustline update | تسجيل تأكيدات الاستيراد بتحديث من Trustline | Enregistrement des confirmations d’importation par une mise à jour de Trustline |
| `documents_exported` | exports | Document list exported | تصدير قائمة الوثائق | Exportation de la liste des documents |
| `acknowledgements_exported` | exports | Version acknowledgements exported | تصدير إقرارات إصدار | Exportation des prises de connaissance d’une version |
| `imports_exported` | exports | Import register exported | تصدير سجل الاستيراد | Exportation du registre des importations |
| `overdue_acknowledgements_exported` | exports | Overdue acknowledgements exported | تصدير الإقرارات المتأخرة | Exportation des prises de connaissance en retard |
| `person_acknowledgements_exported` | exports | Acknowledgement record exported | تصدير سجل الإقرار بالاطلاع لشخص | Exportation du relevé des prises de connaissance d’une personne |
| `subscription_changed` | trustline | Subscription changed | تعديل الاشتراك | Modification de l’abonnement |
| `import_window_changed` | trustline | Import window changed | تغيير فترة الاستيراد | Modification de la période d’importation |
| `client_created_by_platform` | trustline | Organization created | إنشاء المنشأة | Création de l’établissement |
| `client_settings_changed_by_platform` | trustline | Organization's settings changed | تعديل إعدادات المنشأة | Modification des paramètres de l’établissement |
| `audit_chain_started` | audit | Audit trail sealing started | بدء ختم سجل التدقيق | Début du scellement du journal d’audit |
| `audit_entries_exported` | audit | Audit trail exported (CSV) | تصدير سجل التدقيق (CSV) | Exportation du journal d’audit (CSV) |
| `audit_chain_exported` | audit | Chain file downloaded | تنزيل ملف سلسلة الأختام | Téléchargement du fichier de la chaîne |
| `audit_checkpoints_exported` | audit | Checkpoints downloaded | تنزيل نقاط التحقق | Téléchargement des points de contrôle |
| `external_reviewer_viewed` | audit | Viewed by an external reviewer | اطلاع مقيّم خارجي | Consultation par un évaluateur externe |
| `audit_addresses_cleared` | audit | Old sign-in IP addresses cleared | مسح عناوين IP القديمة لتسجيل الدخول | Effacement des anciennes adresses IP de connexion |

### Areas (`audit.areas.<key>`)

| Key | English | Arabic | French |
|---|---|---|---|
| `sign_in` | Sign-in | تسجيل الدخول | Connexion |
| `accounts` | Accounts and roles | الحسابات والأدوار | Comptes et rôles |
| `organization` | Organization and settings | المنشأة والإعدادات | Établissement et paramètres |
| `incidents` | Incidents | الحوادث | Incidents |
| `documents` | Documents | الوثائق | Documents |
| `exports` | Exports | التصدير | Exportations |
| `trustline` | Trustline | Trustline | Trustline |
| `audit` | Audit trail | سجل التدقيق | Journal d’audit |

### Record types (`audit.entities.<key>`)

| Key | English | Arabic | French |
|---|---|---|---|
| `user` | Person | شخص | Personne |
| `role` | Role | دور | Rôle |
| `tenant` | Organization | المنشأة | Établissement |
| `org_unit` | Unit | وحدة | Unité |
| `incident` | Incident | حادث | Incident |
| `document` | Document | وثيقة | Document |
| `document_type` | Document type | نوع وثيقة | Type de document |
| `document_category` | Document category | فئة | Catégorie de documents |
| `approval_route` | Approval route | مسار اعتماد | Circuit d’approbation |
| `subscription` | Subscription | اشتراك | Abonnement |

### Actors (`audit.actors.<key>`)

| Key | English | Arabic | French |
|---|---|---|---|
| `system` | System | النظام | Système |
| `trustline_staff` | Trustline staff | فريق Trustline | Équipe Trustline |
| `reporter` | The reporter | المبلّغ | Le déclarant |
| `anonymous` | Anonymous | دون ذكر الاسم | Anonyme |
