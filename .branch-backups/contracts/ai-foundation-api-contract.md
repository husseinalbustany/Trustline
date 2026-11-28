# AI foundation: the API's contract for the web app

Steps 1 and 2 of `docs/specs/ai-providers-and-allowances.md`. Branch
`worktree-agent-a401760666624b587` (based on 8cbffe4). Every route answers
JSON. Amounts of money are US dollars as numbers (`12.5`). Months are
`YYYY-MM`, days `YYYY-MM-DD`. A feature is one of `drafting`, `insights`,
`assistant`.

Nothing here needs a new permission. The client's screens use
`settings.manage` held for the whole organization (as every setting does).

---

## 1. The client's screens

The routes belong to the AI module (`ai_assistant`). A client without it
gets Nest's own 404 (`Cannot GET /ai/settings`), as for any module that is
off: show nothing about AI. `/auth/me` `tenant.modules` says whether it is
on.

### `GET /ai/settings`

Anyone signed in. 401 without a session.

**Short answer** (anyone without `settings.manage` for the whole
organization):

```json
{
  "available": true,
  "enabled": false,
  "features": [
    {
      "feature": "drafting",
      "offered": true,
      "active": false,
      "provider": { "kind": "anthropic", "region": "global", "inferenceType": "global" }
    },
    { "feature": "insights", "offered": false, "active": false, "provider": null },
    { "feature": "assistant", "offered": true, "active": false, "provider": { "kind": "bedrock", "region": "me-central-1", "inferenceType": "global" } }
  ]
}
```

- `available`: Trustline offers at least one feature.
- `enabled`: the organization's own switch.
- `offered`: Trustline offers this feature now.
- `active`: offered and switched on. A feature's screens show their AI part only when this is true.
- `provider`: who processes the requests, and where. Null when not offered.

**Full answer** (holders of `settings.manage` for the whole organization):
everything above, and:

```json
{
  "available": true,
  "enabled": true,
  "features": [
    {
      "feature": "drafting",
      "offered": true,
      "active": true,
      "provider": { "kind": "anthropic", "region": "global", "inferenceType": "global" },
      "reason": null,
      "model": "claude-sonnet-5-5",
      "quickModel": "claude-haiku-5-5",
      "allowance": 50,
      "used": 41,
      "warning": true,
      "reached": false
    }
  ],
  "month": "2026-11",
  "resetsOn": "2026-12-01",
  "medicalOptionAllowed": false,
  "switchedBy": { "id": "uuid", "name": { "en": "…", "ar": "…" } },
  "switchedAt": "2026-11-28T10:00:00.000Z"
}
```

- `reason`, when `offered` is false: `module` (the subscription lacks the AI module or the module the feature assists: policies for drafting; incidents, investigations, actions or risks for insights), `not_offered` (Trustline does not offer AI to the client), `not_configured` (no provider chosen for this feature), `connection_inactive`, `plan` (the plan includes none of it). Null when offered.
- `allowance`: the month's allowance (drafts, suggestions, assistant messages). `null` means no limit. Show it as "no limit".
- `used`: units counted this month. `warning`: 80% or more is used. `reached`: all is used, so the feature is paused until `resetsOn`.
- `month` and `resetsOn` follow the organization's time zone.
- `switchedBy.name` is per-language: show it with `pick()`.

### `PUT /ai/settings`

Body: `{ "enabled": true | false }` (strict: any other field gives 400).
Returns the full answer above.

| Status | Body | When |
|---|---|---|
| 200 | full answer | switched, or already so (nothing audited then) |
| 400 | — | malformed body |
| 401 | — | no session |
| 403 | `{ code: "missing_permission", permission: "settings.manage" }` | not held for the whole organization |
| 403 | `{ code: "subscription_suspended" }` | switching **on** while the subscription is suspended (switching off still works) |
| 409 | `{ code: "ai_not_offered" }` | switching on before Trustline offers any feature |

Audited in the client's log as `ai_use_changed`, `{ from, to }`.

---

## 2. Refusals features will return (for later screens)

`AiService.run()` returns these. A feature's route turns them into HTTP
with `aiRefusalException()`: 503 for `ai_unavailable`, 400 for
`ai_request_too_large`, 403 for `subscription_suspended`, 409 for the others.
The body is the refusal without `ok`:

| `code` | Extra fields | Message to show |
|---|---|---|
| `ai_not_offered` | `feature`, `reason` (as above) | AI is not available for this. |
| `ai_switched_off` | `feature` | Your organization has not switched AI on. |
| `ai_allowance_reached` | `feature`, `allowance`, `resetsOn` | This month's allowance is used up; it starts again on `resetsOn`. Writing by hand still works. |
| `ai_spending_limit` | `feature` | The assistant is paused; Trustline has been told. |
| `ai_unavailable` | `feature` | The assistant is unavailable just now; everything else works. |
| `ai_request_too_large` (HTTP 400) | `feature`, `maxMessageChars` (20,000), `maxRequestChars` (60,000) | This is too long for the assistant; shorten it. A feature should stop the person before this. |
| `subscription_suspended` (HTTP 403) | `feature` | As for any write while the subscription is suspended. |

---

## 3. Notifications (new kinds)

In `GET /notifications` as usual, about the organization (`incident: null`,
`document: null`). Of the AI module: not shown when the module is off. In
the app only, never emailed. Sent to holders of `settings.manage` for the
whole organization.

| `kind` | `data` | Meaning |
|---|---|---|
| `ai_provider_changed` | `{ features: "drafting,insights", serious: false }` | Trustline changed the provider of these features (comma-separated), or offered or withdrew AI. Link to the AI settings. |
| `ai_allowance_warning` | `{ feature, used, allowance, month, resetsOn, serious: false }` | 80% of this feature's allowance is used. Sent once a month per feature. |
| `ai_allowance_reached` | `{ feature, used, allowance, month, resetsOn, serious: false }` | All of it is used; the feature pauses until `resetsOn`. Sent once a month per feature. |

---

## 4. The admin portal (Trustline staff)

Every route needs the platform session (401 otherwise) and is audited in the
platform log. An id that is not a UUID, or that is unknown, gives 404.

### Connections

A connection object:

```json
{
  "id": "uuid",
  "name": "Bedrock UAE, global",
  "kind": "anthropic | bedrock",
  "region": "me-central-1",
  "inferenceType": "in_region | regional | global",
  "models": [
    { "id": "global.anthropic.claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "inputUsdPerMTok": 3, "outputUsdPerMTok": 15 }
  ],
  "credentialEnv": "AI_CREDENTIAL_BEDROCK_UAE",
  "credentialsPresent": true,
  "active": true,
  "clients": 2,
  "createdAt": "…",
  "updatedAt": "…"
}
```

The credential itself is never accepted, stored or returned: only the name
of the environment variable that holds it, and whether that variable is set.
The field is a variable name, not a secret field: never offer to type a key.

| Route | Body | Answer |
|---|---|---|
| `GET /platform/ai/connections` | — | list, sorted by name |
| `GET /platform/ai/connections/:id` | — | one |
| `POST /platform/ai/connections` | `name`, `kind`, `region`, `inferenceType`, `models` (1 to 30, ids unique), `credentialEnv`, `active?` | 201, the connection |
| `PATCH /platform/ai/connections/:id` | any of `name`, `region`, `inferenceType`, `models`, `credentialEnv`, `active` (not `kind`) | 200, the connection. Deactivate with `{ "active": false }`. |
| `POST /platform/ai/connections/:id/test` | `{}` or `{ "model": "…" }` | 200 `{ works: boolean \| null, credentialsPresent: boolean, mode: "fake" \| "real", fakeAnswers? }`. In fake mode no call is made, `works` is `null` and `fakeAnswers` is given (see below): show "not tested: the fake provider answers every request". |

- `credentialEnv` must be `AI_CREDENTIAL_ANTHROPIC_…` for an Anthropic connection and `AI_CREDENTIAL_BEDROCK_…` for a Bedrock one, followed by capitals, digits or `_`.
- `region`: for Bedrock, an AWS region code (`me-central-1`). For the Anthropic API, `global` with global inference, or a geography (`us`, `eu`) with regional inference.

Error codes:

| Status | `code` | When |
|---|---|---|
| 400 | — | malformed |
| 400 | `invalid_region` | the region does not fit the kind or inference type |
| 400 | `inference_type_not_offered` | in-region with the Anthropic API |
| 400 | `model_inference_mismatch` (+ `model`) | a Bedrock model id that does not match the inference type: global needs `global.…`; regional needs the profile of the region's own geography (`eu.…` in `eu-west-1`; none exists in `me-central-1`); in-region needs the bare model, or the ARN of a foundation or provisioned model in the connection's region |
| 400 | `credential_env_mismatch` | the credential variable is not named for the connection's kind |
| 400 | `unknown_model` | test: a model the connection does not offer |
| 409 | `name_taken` | |
| 409 | `connection_in_use` (+ `tenantIds`) | changing region, inference type or credential variable, or deactivating, while a client uses it |
| 409 | `model_in_use` (+ `model`, `tenantIds`) | removing a model a client uses |

### Trustline's own AI settings

`GET /platform/ai/settings` and `PUT /platform/ai/settings` (body
`{ "monthlySpendingLimitUsd": number | null }`, to the cent):

```json
{ "monthlySpendingLimitUsd": 500, "month": "2026-11", "spentUsd": 12.34, "mode": "fake | real", "fakeAnswers": "sample | echo | scripted | null", "updatedAt": "…" }
```

This is the spending limit over every client together, for the UTC month.
`mode: "fake"` means every request is answered by the fake provider. Show
that prominently.

`fakeAnswers` says what the fake answers with. It is null in real mode.

- `sample`: built-in sample answers for development, outside tests and
  production only. Drafting gets valid questions, drafts and revisions,
  and every text says it is sample text from the fake provider. Show
  "Sample answers from the fake provider, not a real model" beside the
  mode (wording key `portal.ai.fakeAnswers.sample`).
- `echo`: the fake says the request back (`portal.ai.fakeAnswers.echo`).
- `scripted`: a test's own answers. It is never seen outside tests
  (`portal.ai.fakeAnswers.scripted`).

### A client's AI settings

`GET /platform/tenants/:id/ai` and `PATCH /platform/tenants/:id/ai`. The
PATCH body takes any of these:

```json
{
  "offered": true,
  "features": {
    "drafting": { "connectionId": "uuid", "model": "claude-sonnet-5-5", "quickModel": "claude-haiku-5-5" },
    "insights": null
  },
  "allowanceOverrides": { "drafting": 100 },
  "medicalOptionAllowed": false,
  "monthlySpendingLimitUsd": 50
}
```

- A feature left out is unchanged. A feature set to `null` is no longer offered.
- `quickModel` is optional; null means `model`.
- `allowanceOverrides` replaces the overrides as a whole. A feature left out follows the plan, and `null` means no limit.

The answer:

```json
{
  "tenantId": "uuid",
  "offered": true,
  "features": {
    "drafting": { "connection": { "id": "uuid", "name": "…", "kind": "anthropic", "region": "global", "inferenceType": "global", "active": true }, "model": "…", "quickModel": null },
    "insights": null,
    "assistant": null
  },
  "planAllowances": { "drafting": 50, "insights": 500, "assistant": 1000 },
  "allowanceOverrides": { "drafting": 100 },
  "allowances": { "drafting": 100, "insights": 500, "assistant": 1000 },
  "medicalOptionAllowed": false,
  "monthlySpendingLimitUsd": 50,
  "clientEnabled": false,
  "clientSwitchedAt": null,
  "month": "2026-11",
  "usage": { "drafting": { "used": 3, "requests": 9, "costUsd": 0.41 }, "insights": { "…": "…" }, "assistant": { "…": "…" } },
  "costUsd": 0.41
}
```

Errors: 400 malformed or empty; 400 `unknown_connection`, `connection_inactive` or `unknown_model` (each with `feature`, and `unknown_model` also with `model`); 404 for an unknown client.

The client's log gets `ai_settings_changed` with what the client can see:
`offered`, `features` (`{ feature: { from, to } }`, each being
`{ kind, region, inferenceType, model }` or null), `allowances`,
`medicalOptionAllowed`, and `platformAdminEmail`. The spending limit is
never in the client's log. A change of provider sends
`ai_provider_changed`.

### Usage of every client

`GET /platform/ai/usage` lists every client with AI settings, or with
requests in the last 32 days. Clients over a limit come first, then those
near one:

```json
[{ "tenantId": "…", "slug": "…", "name": { "en": "…" }, "month": "2026-11", "offered": true, "enabled": true,
   "features": { "drafting": { "configured": true, "allowance": 50, "used": 41, "costUsd": 3.2 } },
   "costUsd": 3.2, "monthlySpendingLimitUsd": null, "near": true, "over": false }]
```

### Plans

Plans gain `aiAllowances: { drafting, insights, assistant }`, each a whole
number or `null` (no limit). Zero means not included. It is required on
PATCH when sent, optional on POST (all zero by default), and returned by
`GET /platform/plans` and `GET /platform/plans/:id`. The subscription view
(`GET /platform/tenants/:id/subscription`) has `effective.aiAllowances`. A
change shows in the client's `subscription_changed` entry as
`aiAllowances: { feature: { from, to } }`.

---

## 5. Wording keys the web needs (en, ar, fr in each dictionary)

The audit trail, under `audit.actions` (the API's own wording, to match):

| Key | en | ar | fr |
|---|---|---|---|
| `audit.actions.ai_use_changed` | AI switched on or off | تفعيل الذكاء الاصطناعي أو إيقافه | Activation ou désactivation de l’IA |
| `audit.actions.ai_settings_changed` | AI settings changed by Trustline | تعديل إعدادات الذكاء الاصطناعي من قِبل Trustline | Modification des réglages d’IA par Trustline |

Detail keys for the audit viewer: `ai_use_changed` has `from` and `to`.
`ai_settings_changed` has `offered`, `features`, `allowances`,
`medicalOptionAllowed` and `platformAdminEmail`. `subscription_changed`
gains `aiAllowances`.

Notifications: `notifications.kinds.ai_provider_changed`, `ai_allowance_warning`, `ai_allowance_reached`. They need the feature names and the `used`, `allowance` and `resetsOn` values.

The settings screen (suggested keys):
- `ai.title`, `ai.intro`, `ai.available`, `ai.notAvailable`
- `ai.switch.on`, `ai.switch.off`, `ai.switch.confirmOn`, `ai.switch.lastChanged` (who and when)
- `ai.features.drafting`, `ai.features.insights`, `ai.features.assistant`
- `ai.units.drafting` (drafts), `ai.units.insights` (suggestions), `ai.units.assistant` (messages)
- `ai.providers.anthropic` (Anthropic API), `ai.providers.bedrock` (Amazon Bedrock)
- `ai.inference.in_region` (only in {region}), `ai.inference.regional` (within {region}'s geography), `ai.inference.global` (in any region the provider has)
- `ai.regions.<code>`, a readable name for each region code you choose to show (`me-central-1`: UAE, `global`, `us`, `eu`); show the code itself otherwise
- `ai.reasons.module`, `ai.reasons.not_offered`, `ai.reasons.not_configured`, `ai.reasons.connection_inactive`, `ai.reasons.plan`
- `ai.usage.of` ({used} of {allowance}), `ai.usage.noLimit`, `ai.usage.warning`, `ai.usage.reached` (paused until {resetsOn}), `ai.usage.month`
- `ai.medicalOption.allowed`, `ai.medicalOption.notAllowed`
- `ai.model` (shown to administrators)
- `errors.ai_not_offered`, `errors.ai_switched_off`, `errors.ai_allowance_reached`, `errors.ai_spending_limit`, `errors.ai_unavailable`

Portal screens (if the portal shares the dictionaries): connection fields, the codes in section 4, the `mode` fake/real notice, and the test result (works or not, credential present or not).

---

## 6. Changes after security review 13

- New refusal codes `ai_request_too_large` and `subscription_suspended` (section 2).
- Test connection returns `mode`, and `works: null` in fake mode (section 4).
- Credential variables are named per kind, and `credential_env_mismatch` is a new code (section 4).
- AI answers are untrusted text. Show `text` as plain text, never rendered as HTML or Markdown.
