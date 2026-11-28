# AI insights on incidents: the API's contract for the web app

Spec: `docs/specs/ai-insights.md`, "Built: the first release". Every route is under `/api/v1`, of the AI module (`ai_assistant`), signed in. Errors are `{ code, … }`. Every text a suggestion holds is untrusted and must be shown as plain text.

Insights are offered to no client until Trustline's staff clear them. Until then every request is refused 409 `ai_not_offered` with `reason: "not_cleared"`, and `GET /ai/settings` shows insights `offered: false` (`reason: "not_cleared"` for administrators).

## 1. Settings: Settings, AI, "Suggestions on incidents"

`GET /ai/insights/settings` and `PUT /ai/insights/settings`: `settings.manage` for the whole organization (403 otherwise).

```json
{
  "offered": true, "reason": null, "active": true,
  "kinds": { "triage": false, "duplicates": false, "closureSummary": false, "causeHypotheses": false },
  "runs": "on_request | on_arrival | daily",
  "revision": 0,
  "categories": [{ "id": "…", "code": "medication", "name": { "en": "…" }, "active": true, "clinical": true }],
  "medicalOption": null | {
    "switchedOn": false, "effective": false,
    "agreement": {
      "version": "2026-11-draft-1", "draft": true,
      "signed": null | { "id": "…", "version": "…", "current": true, "signedBy": { "id": "…", "name": {…} }, "signedAt": "…", "method": "password | pin", "confirmedByTrustline": false, "confirmedAt": null }
    }
  },
  "outcomes": { "month": "2026-11", "byKind": { "triage": { "shown": 3, "used": 1, "dismissed": 1, "empty": 0 }, "…": {} } }
}
```

- `medicalOption: null`: Trustline does not offer the option to the client. **Do not show the switch at all.**
- `effective: false` while switched on: say what is missing. If `signed` is null, it must be signed. If `confirmedByTrustline` is false, Trustline must confirm the addendum. If `current` is false, the new version must be signed.
- PUT body, all fields required: `{ kinds: { triage, duplicates, closureSummary, causeHypotheses }, runs, clinicalCategoryIds: uuid[], medicalOption: boolean, revision }`. `clinicalCategoryIds` is exactly the categories that need a medical decision. Answers the same shape.
- Errors: 400 (malformed); 400 `unknown_category`; 409 `revision_mismatch` (+ `revision`); 409 `medical_option_not_offered`.

## 2. The medical option's agreement

Both need `ai.medical_agreement` for the whole organization. **Nobody holds it until an administrator gives it** to the person who may commit the organization.

- `GET /ai/insights/medical-agreement?locale=en|ar|fr` returns `{ version, draft: true, locale, text, textSha256, signed: null | { id, version, current, signedAt, confirmedByTrustline } }`.
  - Show `text` exactly, as plain text with its line breaks. Its first line says it is a draft for legal review; also show a "Draft for legal review" badge while `draft` is true.
- `POST /ai/insights/medical-agreement` with `{ version, locale, textSha256, password }` returns 201 `{ id, version, signedAt, confirmedByTrustline: false }`.
  - Send back the `version` and `textSha256` you were given.
  - The password is the person's password, or their signing PIN if they sign with one (as for approvals).
  - Errors: 400; 400 `language_mismatch`; 401 `wrong_password` and `password_locked`; 403 `signing_pin_required` and `signing_pin_locked`; 409 `medical_option_not_offered`; 409 `agreement_version_changed` (+ `version`: reload the text); 409 `agreement_already_signed`.

## 3. The panel on an incident

For whoever may triage the incident (`incidents.triage`). 404 if they cannot see it; 403 `outside_scope` if they see it only as its reporter; 403 `missing_permission` without the right.

`GET /ai/insights/incidents/:id/suggestions?causes=hidden|shown`

```json
{
  "used": true,
  "reason": null | "not_offered" | "switched_off" | "medical_decision",
  "kinds": { "triage": true, "duplicates": true, "closure_summary": true, "cause_hypotheses": true },
  "medical": false,
  "notice": "This is a suggestion from the AI assistant, …",
  "medicalNotice": null | "This incident needs a medical decision. …",
  "suggestions": [Suggestion],
  "hiddenCauses": 1
}
```

- **`reason: "medical_decision"`: show "The AI assistant is not used on this incident: it needs a medical decision"** (`insights.notUsed.medical_decision`). Do not show an empty panel.
- `notice` must always be shown, in every place a suggestion appears, and cannot be hidden or styled away. `medicalNotice` goes beside it when present.
- Possible causes are hidden until the investigator asks. Show "Show possible causes (n)" when `hiddenCauses > 0`, then reload with `?causes=shown`. Before the first request for causes, ask the team for its own first view.

A `Suggestion` has these fields:

```json
{
  "id": "…", "kind": "triage | duplicates | closure_summary | cause_hypotheses",
  "status": "open | empty | used | dismissed",
  "trigger": "request | arrival | daily",
  "createdAt": "…", "locale": "en", "medical": false,
  "confidence": "several_cases | some_signal | weak_signal",
  "content": …,
  "evidence": [{ "kind": "passage", "text": "…" } | { "kind": "incident", "incidentId": "…", "reference": "INC-…" }],
  "ownView": null | "…",
  "requestedBy": null | { "id", "name" }, "decidedBy": null | { "id", "name" }, "decidedAt": null, "dismissReason": null,
  "specialist": null | { "id", "name" },
  "notice": "…", "medicalNotice": null | "…"
}
```

`content` depends on the kind:

| Kind | `content` |
|---|---|
| `triage` | `{ categoryId, categoryCode, categoryName: Localized, harmLevel, reason }` (either suggested value may be null) |
| `duplicates` | `{ matches: [{ incidentId, reference, reason, passages: string[] }] }` |
| `closure_summary` | `{ summary }`: paragraphs, with line breaks |
| `cause_hypotheses` | `{ hypotheses: [{ cause, factor, confirmIf, ruleOutIf, passages }] }`, two at least. Factor is one of `task`, `equipment`, `environment`, `process`, `organization`, `communication`. |

- `status: "empty"` has `content: null`: show "Too little to go on: no suggestion" (`insights.empty`).
- Show evidence passages as quotes. Show incidents as links to the incident.
- Show confidence in plain words (`insights.confidence.*`).
- `trigger: "arrival"` or `"daily"` means it was made on its own: show "Suggested automatically" (`insights.trigger.*`).

### Asking

`POST /ai/insights/incidents/:id/suggestions` with `{ kind, ownView? }`

- 201 returns `{ …panel fields, suggestion: Suggestion | null }`.
  - `null`: nothing could be shown (withheld). Show "No suggestion this time" (`insights.nothing`).
- `ownView` (1 to 4,000 characters) is required for `cause_hypotheses` (400 `own_view_required`) and refused for the others (400 `own_view_not_asked`).
- Errors:
  - 409 `ai_kind_off` (+ `kind`);
  - 409 `ai_medical_decision`;
  - the foundation's codes: 409 `ai_not_offered` (+ `reason`), 409 `ai_switched_off`, 409 `ai_allowance_reached` (+ `allowance`, `resetsOn`), 409 `ai_spending_limit`, 403 `subscription_suspended`, 400 `ai_request_too_large`, 503 `ai_unavailable`.

### Use and dismiss

- `POST /ai/insights/suggestions/:id/use` with `{ specialistId? }` returns 200 `{ suggestion, draft }`.
  - `draft` is the suggestion's `content`. Fill the form with it (triage: category and harm level; closure: the summary). The person edits it and saves through the incident's own routes, under their own name. Nothing is saved by `use`.
  - With `medical: true`, ask "Which specialist reviewed this suggestion?" (a user of the organization) and send `specialistId`. Errors: 400 `specialist_required`, `unknown_specialist`, `specialist_not_asked`.
- `POST /ai/insights/suggestions/:id/dismiss` with `{ reason? }` (1 to 500 characters) returns 200 `{ suggestion, draft: null }`.
- Both: 404 for a suggestion not found or not visible; 409 `suggestion_decided` (+ `status`); 409 `ai_medical_decision`.
- There is no "accept all", and leaving a suggestion alone changes nothing.

## 4. On the incident: "Needs a medical decision"

`POST /incidents/:id/medical-decision` with `{ needed: boolean }` returns 200 `{ needsMedicalDecision, clinicalCategory }`. Whoever may triage the incident. 404, 403 (`outside_scope`, `missing_permission`), 400.

- `clinicalCategory: true` means its category already needs one, whatever this mark says. Say so beside the switch.

## 5. The admin portal

- `GET /platform/ai/settings` adds `insights: { cleared, basis, reference, clearedBy, clearedAt }`.
- `PUT /platform/ai/insights-clearance` takes `{ cleared: true, basis: "legal_review", reference }` or `{ cleared: false }`, and answers like `GET /platform/ai/settings`.
  - Errors: 400; 400 `entity_recognition_not_built`.
  - Show prominently: "Insights on incidents are offered to no client until cleared." The reference is that of the written legal acceptance (1 to 500 characters, one line).
- `GET /platform/tenants/:id/ai` adds:
  - `insightsCleared`;
  - `medicalAgreement: null | { id, version, locale, textSha256, signedAt, method, confirmedAt, confirmationReference, current, versionInForce }`;
  - `insightOutcomes: { kind: { shown, used, dismissed, empty } }`.
- `POST /platform/tenants/:id/ai/medical-agreement/confirm` takes `{ agreementId, confirmationReference }` (1 to 300 characters) and returns 200 with the client's view.
  - Errors: 400; 404; 409 `agreement_already_confirmed`; 409 `agreement_version_changed`.

## 6. Wording keys (en, ar, fr in each dictionary)

- `admin.permissions["ai.medical_agreement"]` and `admin.permissionHints["ai.medical_agreement"]`: added.
- `insights.*`: the panel title "AI suggestions", the notices (from the API's `notice` and `medicalNotice`, not the dictionaries), `notUsed.not_offered|switched_off|medical_decision`, `empty`, `nothing`, `kinds.*`, `confidence.*`, `trigger.*`, `use`, `dismiss`, `dismissReason`, `specialistQuestion`, `ownViewQuestion`, `showCauses`, and the error codes above.
- `settings.insights.*`: the kinds, `runs.*`, the clinical categories, and the medical option with its agreement states.
- The audit actions:
  - `ai_insight_settings_changed`, `ai_medical_agreement_signed` and `ai_medical_agreement_confirmed`;
  - `incident_medical_decision_marked`;
  - `ai_suggestion_made`, `ai_suggestion_used` and `ai_suggestion_dismissed`;
  - `incident_categories_marked_clinical_by_system`.

  Their wording is in the API's `audit/wording/*.ts`.
