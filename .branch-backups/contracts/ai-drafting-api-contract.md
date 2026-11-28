# AI drafting of policies and procedures: the API's contract for the web app

Step 3 of `docs/specs/ai-providers-and-allowances.md`, following
`docs/specs/ai-policy-drafting.md` ("Built"). Branch
`worktree-agent-a401760666624b587`. Every route answers JSON.

- Text a client writes is per language (`{ en, ar, fr }`, the client's
  languages only); show it with `pick()`.
- A screen may show a form that was read, then saved. Changes carry the
  `revision` (or `version`) that was read, and an out-of-date save is
  refused with 409.
- The AI refusals (`ai_not_offered`, `ai_switched_off`,
  `ai_allowance_reached`, `ai_spending_limit`, `ai_request_too_large`,
  `ai_unavailable`, `subscription_suspended`) come as in
  `ai-foundation-api-contract.md`, section 2. On a conversation that
  exists they also carry `draftId`. A refused **start** carries none: it
  leaves no conversation, and the person starts again.

---

## 1. The client profile: Settings, "Organization profile"

Core. `settings.manage` for the whole organization (403 `missing_permission` otherwise).

### `GET /settings/profile`

```json
{
  "revision": 0,
  "identity": {
    "legalName": { "en": "…" }, "tradingName": null,
    "sector": "healthcare", "organizationType": { "en": "A general hospital" },
    "ownership": "private", "staffCount": 850, "siteCount": 2,
    "measures": [{ "label": { "en": "Beds" }, "value": 240 }]
  },
  "services": { "provided": [{ "en": "…" }], "notProvided": [{ "en": "…" }] },
  "committees": [{ "name": { "en": "…" }, "approves": { "en": "…" } }],
  "titles": [{ "title": { "en": "Charge nurse" }, "roleId": "uuid | null" }],
  "standards": [{ "kind": "standard | regulation | licensing_body", "name": { "en": "JCI" }, "edition": "8th" }],
  "glossary": [{ "preferred": { "en": "…" }, "avoid": { "en": "…" }, "note": null }],
  "abbreviations": [{ "short": "FE", "meaning": { "en": "…" } }],
  "houseRules": { "documentOwners": { "en": "…" }, "retention": null, "other": null },
  "relatedSystems": [{ "name": "MaintainIt", "purpose": { "en": "…" } }],
  "fromSettings": {
    "languages": ["en", "ar"], "defaultLocale": "en", "authoritativeLocale": null,
    "documentTypes": [{ "id": "…", "name": { "en": "Procedure" }, "numberPrefix": "SOP", "defaultReviewMonths": 24 }]
  }
}
```

- With no profile yet: `revision: 0`, the client's name as `legalName`, `sector: "other"`, everything else empty.
- `fromSettings` is read-only, shown as "taken from your settings". The structure is the organization tree, edited where it already is.
- `sector` is one of `healthcare`, `manufacturing`, `logistics`, `education`, `public_sector`, `services`, `retail`, `energy`, `construction`, `other`.
- `ownership` is `public`, `private`, `non_profit`, `mixed` or null.
- Limits:

  | Field | Most |
  |---|---|
  | `measures` | 10 |
  | `provided`, `notProvided` | 100 each |
  | `committees` | 50 |
  | `titles` | 200 |
  | `standards` | 50 |
  | `glossary` | 300 |
  | `abbreviations` | 200 |
  | `relatedSystems` | 50 |

### `PUT /settings/profile`

The whole profile (everything above except `fromSettings`) plus the `revision` read. It answers the profile as GET does.

| Status | Body | When |
|---|---|---|
| 400 | — | malformed |
| 400 | `language_mismatch` | text in a language the client does not use, or no legal name in its main language |
| 400 | `unknown_role` | a title mapped to a role the client does not have |
| 409 | `profile_changed` | saved by someone else since it was read |

---

## 2. The document design: Settings, Policies, "Document design"

Policies module. `settings.manage` for the whole organization.

### `GET /policies/design?documentTypeId=<uuid>`

Leave `documentTypeId` out for the organization's design. The answer:

```json
{
  "id": "uuid | null",
  "source": "type | organization | defaults",
  "version": 1,
  "template": {
    "header": { "en": "…" }, "footer": null, "showLogo": true,
    "font": "sans | serif", "accentColor": "#1F4E79",
    "controlBlock": ["number", "title", "version", "owner", "effectiveOn", "reviewOn", "approvals"],
    "bilingualLayout": "one_language_per_document | side_by_side | one_after_another"
  },
  "writing": {
    "rules": [{ "en": "Write in the active voice…" }], "maxSentenceWords": 25,
    "steps": "numbered_one_action | numbered",
    "requirements": "must_should_may | shall_should_may",
    "citations": "by_number | by_number_and_title",
    "useGlossary": true, "never": [{ "en": "…" }]
  },
  "sectionGuidance": { "steps": { "en": "…" } },
  "type": { "id": "…", "name": { "en": "Procedure" }, "sections": [{ "key": "purpose", "name": { "en": "Purpose" }, "required": true }] }
}
```

- `source` says where the design comes from:
  - `type`: the type's own;
  - `organization`: the organization's, used for a type without its own;
  - `defaults`: nothing saved yet, made from the profile.
- The sections are the type's, edited under document types. Show them read-only here, with a guidance field for each.
- 404 for an unknown type.

### `PUT /policies/design`

The body is `{ documentTypeId: uuid | null, template, writing, sectionGuidance, version }`, where `version` is the one read (0 when `source` was not this design's own). It answers the design.

| Status | Body | When |
|---|---|---|
| 400 | — | malformed (a colour must be `#RRGGBB`; the control block needs 1 to 7 different fields) |
| 400 | `unknown_type` | |
| 400 | `unknown_section` (+ `section`) | guidance for a section the type (or, for the organization, any type) does not have |
| 400 | `language_mismatch` | |
| 409 | `design_changed` | |

---

## 3. Drafting with the assistant: "New policy/procedure with the assistant"

These routes are of the AI module. Offer them only when `tenant.modules`
includes both `ai_assistant` and `policies`, and `GET /ai/settings` says
drafting is `active`. Without either module the routes answer 404. They need
`policies.manage` (403 `missing_permission`).

A conversation is its author's own. Another person, or another client, gets
404.

### The conversation object

```json
{
  "id": "uuid", "status": "asking | ready | drafted | handed_over",
  "documentTypeId": "uuid", "locale": "en", "request": "…",
  "rounds": 1, "maxRounds": 3, "revision": 4,
  "designId": "uuid | null", "documentId": null, "handedOverVersion": null,
  "createdAt": "…", "lastActivityAt": "…",
  "openQuestions": [{ "id": "q1-1", "text": "…", "reason": "…" }],
  "turns": [
    { "seq": 1, "kind": "questions", "body": { "round": 1, "questions": [{ "id": "q1-1", "text": "…", "reason": "…" }] } },
    { "seq": 2, "kind": "answers", "body": { "round": 1, "answers": [{ "questionId": "q1-1", "answer": "… | null" }] } },
    { "seq": 3, "kind": "revision_request", "body": { "instruction": "…", "locale": "en" } }
  ],
  "versions": [{
    "number": 1, "author": "assistant | person", "title": { "en": "…" },
    "content": { "en": { "purpose": "…", "steps": "…" } },
    "gaps": [{ "section": "responsibilities", "text": "who stands in" }],
    "assumptions": [{ "section": "scope", "text": "…" }],
    "sources": [{ "documentId": "uuid", "number": "SOP-SAF-003", "title": { "en": "…" } }],
    "model": "claude-sonnet-5-5 | null", "createdAt": "…"
  }]
}
```

- Text is Markdown limited as a document's is: paragraphs, lists, bold, and headings `##` and `###`. Render it like a document version, never as HTML.
- Questions, their reasons, and titles are **plain text**: never render them as Markdown or HTML.
- Gaps and assumptions are marked in the text:

  | Language | Gap | Assumption |
  |---|---|---|
  | en | `[To be decided: …]` | `[Assumed: …]` |
  | fr | `[À décider : …]` | `[Hypothèse : …]` |
  | ar | `[لم يُحدَّد بعد: …]` | `[افتراض: …]` |

  Highlight them, and list them beside the text from `gaps` and `assumptions`.
- Mark every version by the assistant as AI-written, per the design guidelines.
- `sources` are the existing documents it drew on. Link them to the documents.

### Routes

| Route | Body | Answer |
|---|---|---|
| `GET /ai/drafts` | — | `{ items: [{ id, status, documentTypeId, locale, request, versions, createdAt, lastActivityAt }] }`: the caller's open conversations, newest first |
| `POST /ai/drafts` | `{ documentTypeId, request (1–4000), locale? }` | 201, the conversation, with the first questions |
| `GET /ai/drafts/:id` | — | the conversation |
| `POST /ai/drafts/:id/questions` | — | asks a round again, after a refusal or an outage in a later round. 409 `not_asking`, `questions_open` |
| `POST /ai/drafts/:id/answers` | `{ answers: [{ questionId, answer: string (1–2000) \| null }], revision }` | the conversation after the next round. Every open question must be answered: 400 `answers_mismatch` (+ `questions`). `null` is "Not decided" |
| `POST /ai/drafts/:id/draft` | — | the conversation with version 1. Allowed while `asking` or `ready`; open questions count as not decided. 409 `not_ready` |
| `POST /ai/drafts/:id/revisions` | `{ instruction (1–2000), locale?, revision }` | a new version. Use another `locale` to translate. 409 `not_drafted`, `draft_too_long_for_assistant` (+ `max`: offer editing by hand) |
| `POST /ai/drafts/:id/edits` | `{ content: { <locale>: { <section>: text \| null } }, revision }` | a new version by the person. Checked as a document version (400 `unsupported_markup`, `unknown_section`, `section_too_long`, `language_mismatch`) |
| `POST /ai/drafts/:id/hand-over` | as `POST /policies/documents` without `typeId` (`categoryId`, `title`, `ownerId`, `ownerUnitId`, `audience?`, `confidentiality?`, `keywords?`, `references?`, `reviewMonths?`, `acknowledgementRequired?`, `acknowledgeWithinDays?`), plus `version?` (the latest unless named) and `revision` | 201, **the document**, as `GET /policies/documents/:id`. Its errors are that route's (403 outside the person's scope, 400 `unknown_category` …), plus 404 `unknown_version` and 409 `not_drafted` |
| `POST /ai/drafts/:id/discard` | — | 204. 409 `handed_over` |

- **Session codes:** 400 `language_mismatch` and `unknown_type` on starting; 409 `draft_changed` when the conversation changed since it was read (reload it).
- **Allowance:** one conversation is one draft of the month's allowance, for up to 20 requests. The 21st request, or the first in a new month, counts again.
- **How long it is kept:** the screens should say this. A conversation handed over is kept with its document. Discarded, it is removed the next day. Untouched for 90 days, it is removed.
- **Choose a version:** show each version, and offer "hand over this version".

---

## 4. An AI-drafted document in the policies module

`GET /policies/documents/:id` gains:

```json
"source": "written | imported | ai_drafted",
"aiDraft": { "sessionId": "uuid | null", "ownedBy": { "id": "…", "name": { "en": "…" } } | null, "ownedAt": "… | null" } | null
```

- While `ownedBy` is null, show the "AI draft" mark, and offer "Take ownership" to the document's owner and to those who manage it.
- `sessionId` is shown only to those who see the document in full.

| Route | Answer |
|---|---|
| `POST /policies/documents/:id/ai-draft/ownership` | 200, the document. 404 if not the caller's to own; 409 `not_ai_draft`, `already_owned` |
| `GET /policies/documents/:id/ai-draft` | the conversation behind it (the object above, plus `limited`), for those who see the document in full; 404 otherwise. Put it in the document's history: "Drafted with the assistant", its questions and answers, the versions, and the model |

Submitting its version for review (`POST …/versions/:versionId/submit`) adds two codes:

- 409 `ai_draft_not_owned`: take ownership first;
- 409 `ai_draft_gaps` (+ `gaps: [{ locale, section }]`): a "To be decided" mark is still in the text. Show which sections.

---

## 5. Wording keys the web needs (en, ar, fr in each dictionary)

The audit trail, under `audit.actions` (the API's own wording, to match):

| Key | en | ar | fr |
|---|---|---|---|
| `organization_profile_updated` | Organization profile changed | تعديل الملف التعريفي للمؤسسة | Modification du profil de l’organisation |
| `document_design_updated` | Document design changed | تعديل تصميم الوثائق | Modification de la présentation des documents |
| `ai_draft_started` | Drafting with the assistant started | بدء الصياغة بمساعدة المساعد الذكي | Début d’une rédaction avec l’assistant |
| `ai_draft_questions_asked` | Questions asked by the assistant | طرح المساعد الذكي أسئلة | Questions posées par l’assistant |
| `ai_draft_answered` | Assistant’s questions answered | الإجابة عن أسئلة المساعد الذكي | Réponses aux questions de l’assistant |
| `ai_draft_version_created` | Draft version written | كتابة نسخة من المسودة | Rédaction d’une version du brouillon |
| `ai_draft_discarded` | Assistant draft discarded | التخلي عن مسودة المساعد الذكي | Abandon d’un brouillon de l’assistant |
| `ai_draft_handed_over` | Assistant draft turned into a document | تحويل مسودة المساعد الذكي إلى وثيقة | Transformation d’un brouillon de l’assistant en document |
| `ai_draft_ownership_taken` | Ownership of an AI draft taken | تولّي مسؤولية مسودة أعدّها الذكاء الاصطناعي | Prise en charge d’un brouillon rédigé par l’IA |
| `ai_drafts_removed_by_system` | Old assistant drafts removed | حذف مسودات قديمة للمساعد الذكي | Suppression d’anciens brouillons de l’assistant |

The detail keys of each action:

| Action | Details |
|---|---|
| `organization_profile_updated` | `changed` |
| `document_design_updated` | `documentTypeId`, `version`, `changed` |
| `ai_draft_started` | `typeId`, `locale` |
| `ai_draft_questions_asked` | `round`, `questions`, `aiRequestId` |
| `ai_draft_answered` | `round`, `answered`, `notDecided` |
| `ai_draft_version_created` | `version`, `author`, `gaps`, `assumptions`, `sources`, `model`, `aiRequestId` |
| `ai_draft_discarded` | `versions` |
| `ai_draft_handed_over` | `sessionId`, `version`, `number` |
| `ai_draft_ownership_taken` | `sessionId` |
| `ai_drafts_removed_by_system` | `discarded`, `abandoned` |

`document_created` gains `source` and `aiDraftSessionId`. A new entity type, `ai_draft`, links to the conversation.

Suggested keys for the screens:
- `profile.*`: one label per field. The `profile.sectors.<sector>`, `profile.ownership.<value>` and `profile.standardKinds.<kind>` values. `profile.fromSettings` ("Taken from your settings").
- `design.*`: one label per field. The `design.controlFields.<field>`, `design.fonts.<font>`, `design.bilingualLayout.<value>`, `design.steps.<value>`, `design.requirements.<value>` and `design.citations.<value>` values. `design.source.<type|organization|defaults>`.
- `drafting.*`:
  - `start`, `requestLabel`, `languageLabel`;
  - `questions.title`, `questions.reason`, `questions.notDecided`, `questions.submit`;
  - `draftNow`, `versions`, `version.byAssistant`, `version.byPerson`;
  - `gaps`, `assumptions`, `sources`;
  - `revise`, `revisePlaceholder`, `translateTo`, `editByHand`;
  - `handOver`, `handOverVersion`, `discard`, `keptFor` (how long a conversation is kept), `aiMark`;
  - `takeOwnership`, `ownedBy`, `history`.
- `errors.profile_changed`, `errors.design_changed`, `errors.unknown_role`, `errors.answers_mismatch`, `errors.draft_changed`, `errors.not_asking`, `errors.questions_open`, `errors.not_ready`, `errors.not_drafted`, `errors.draft_too_long_for_assistant`, `errors.unknown_version`, `errors.handed_over`, `errors.not_ai_draft`, `errors.already_owned`, `errors.ai_draft_not_owned`, `errors.ai_draft_gaps`.

---

## 6. Changes after security review 18

- A refused start leaves no conversation, and its refusal carries no `draftId`.
- `GET /policies/documents/:id/ai-draft` filters by what the viewer may read:
  - each version's `sources` are only those the viewer may read now;
  - when the viewer is not the author and cannot read every source, `limited` is true. `turns` and `openQuestions` are then empty, and `versions` holds only the version handed over;
  - show "Part of this conversation drew on documents you cannot read".
- Gaps are kept across the assistant's revisions. Only an edit by hand removes one.
- Questions, reasons and titles are plain text.
- New wording key: `drafting.limited`.

## 7. Trying it in development

With the fake provider outside tests and production, drafting gets valid
sample answers in the conversation's language:

- one round of three questions, then "ready";
- a draft of the type's sections, with one assumption, citing one of the
  documents it was given;
- a revision that keeps the text and its gaps.

Every title, question, reason and section says it is sample text from the
fake provider. The portal shows `fakeAnswers: "sample"` in
`GET /platform/ai/settings` (see the foundation contract). The drafting
screens need no special handling.
