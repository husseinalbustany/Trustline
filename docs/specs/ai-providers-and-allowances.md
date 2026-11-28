# AI providers, models and allowances

Status: decided by the business on 28 November 2026. Steps 1 and 2 of
"Order of build" are built in the API (see "Built: steps 1 and 2"); the
screens are not. This is the foundation every AI feature uses: policy drafting
(`ai-policy-drafting.md`), insights on incidents (`ai-insights.md`) and the
assistant (`ai-conversational-assistant.md`).

## What was decided

1. **Configurable per client, by Trustline staff.** No AI provider or model is
   fixed in the code. In the admin portal, Trustline staff choose for each
   client which provider and which model serve each AI feature, or switch AI
   off for that client. Some clients may use Claude through a global
   service; others may not, and use another provider or no AI at all.
2. **Several providers and models side by side.** Trustline can hold several
   provider connections at once, and different clients, or different
   features of one client, can use different ones.
3. **Data stays in Trustline's own database.** Documents, incidents and all
   records stay where they are. Only the text needed for one request is sent,
   and only to a provider whose terms say it keeps nothing afterwards.
4. **Names removed before sending.** Names of patients, staff and reporters,
   file numbers and phone numbers are replaced with placeholders before a
   request leaves Trustline, and put back only in what Trustline shows.
5. **Off by default.** Each client switches AI on itself, after Trustline
   staff have configured it. The client's screens say plainly which provider
   processes its requests and where.
6. **Order of features.** Policy drafting first, since it needs no patient
   data, then insights on incidents, then the assistant. Legal review is
   deferred until the features are built (see "Before the first client").
7. **Monthly allowances per plan** (starting figures, to be revised after the
   pilot):

   | Plan | Policy drafts | Suggestions on incidents | Assistant messages |
   |---|---|---|---|
   | Essentials | 10 | 50 | none |
   | Professional | 50 | 500 | 1,000 |
   | Enterprise | 200 | 2,000 | 5,000 |

   - A draft is one document's conversation: the questions, the draft and up
     to 5 revisions.
   - Usage is shown to administrators. At 80% they are warned; at 100% AI
     pauses until the next month and everything else keeps working.
   - Trustline staff can raise a client's allowance in the portal (audited).
     Extra packs can be sold; their price is a business decision.
   - Trustline records the cost of each request, so real prices can be set
     after the pilot.
8. **The medical option's agreement.** Trustline drafts a plain-language
   agreement in English, Arabic and French; a lawyer reviews it once the
   features are built. In the product, the option can only be switched on
   once an authorised person at the client has signed it with their
   password. The signed text is kept, and every change to the option is
   audited.

## What was checked (November 2026)

- Amazon Bedrock offers the current Claude models from the UAE region only
  through "Global" inference, which may process a request in any region;
  in-region and regional inference are not offered there.
- Google Cloud has regions in Doha and Dammam; no official source confirmed
  Claude in either, and published sources disagree.
- So at present Claude cannot be processed only inside the Gulf. This is why
  the provider is configurable per client: a client that must keep
  processing in the country can be given a provider that offers it, or no
  AI, without changing anything for the others. Check availability again
  before each client is configured: it changes.

## Providers

One interface in the API (`ai/` module), with one adapter per provider. The
features never call a provider directly.

| Provider kind | Notes |
|---|---|
| Anthropic API | Claude, processed by Anthropic. |
| Amazon Bedrock | Claude and others. The inference type (in-region, regional or global) is part of the configuration and shown to the client. |
| Google Cloud Vertex AI | Claude and others, where offered. |
| Compatible endpoint | A model hosted by the client or a local provider that speaks a supported API, for clients that need processing in the country. |

Each provider connection holds: a name, the kind, the region and inference
type, the models it offers, and a reference to its credentials. **Credentials
are never stored in the database or typed into a screen in plain view, and
never sent in chat:** they are secrets in the deployment's configuration,
referred to by name. The portal shows only whether a connection's
credentials are present and whether a test call works.

## Per-client configuration (admin portal)

For each client, Trustline staff set:

- AI on or off for the client (the client must also switch it on);
- for each feature (drafting, insights, assistant): the provider connection
  and model, or "not offered";
- the processing location shown to the client, taken from the connection;
- the allowance, if different from the plan's;
- whether the medical option may be offered (it still needs the client's
  signed agreement).

Every change is audited in the platform log and in the client's own log.
A change of provider for a client tells its administrators in the app.

## What the client sees

- In Settings: whether AI is available, for which features, the provider and
  where requests are processed, and the switch to turn it on or off.
- The monthly usage against the allowance.
- Every AI output marked as such (`design-guidelines-and-branding.md`).

## Safeguards common to every provider

- Names and identifiers removed before sending, and put back after.
- No client's data is used in another client's request.
- Every request is recorded: who, which feature, which provider and model,
  the size, the cost and the outcome; the text itself is not kept beyond
  what the feature needs (a draft, a suggestion).
- A provider that fails or times out never blocks the user's work: the
  feature says the assistant is unavailable and everything else continues.
- A per-client and a platform-wide spending limit, beyond which requests
  stop and Trustline staff are told.

## Data to add (outline, not a schema)

- `ai_provider_connections` (platform): kind, region, inference type,
  models, credential reference, active.
- `ai_client_settings` (per client): on or off, per-feature connection and
  model, allowance override, medical option allowed.
- `ai_requests` (per client): feature, connection, model, size, cost,
  outcome, person, time.
- `ai_agreements` (per client): the signed medical-option agreement and its
  signature.

## Order of build

1. The provider interface, the first adapters (Anthropic API and Amazon
   Bedrock), connection settings and the per-client configuration in the
   portal; request records, allowances and spending limits.
2. Name removal and restoration, with tests.
3. Policy drafting (`ai-policy-drafting.md`). Built in the API: see its
   "Built" section.
4. Insights on incidents.
5. The assistant.

Steps 4 and 5 may be built, but not offered to any client, until a
recogniser of named entities is added or the legal review accepts the
remaining risk of name removal in writing (security review 13, H2; see
"Limits of name removal" under "Built: steps 1 and 2").

## Before the first client uses AI

The business will consult a lawyer once the features are built, before any
client switches AI on. Open for that review:

- sending incident text, even with names removed, to a provider outside the
  country (the UAE restricts health data most);
- the final text of the medical option's agreement;
- the data processing terms shown to clients.

## Still to decide

- The price of extra packs.
- Which provider serves clients that need in-country processing, once one
  offers suitable models there.

## Built: steps 1 and 2

What the API does now, and what was chosen where this document was silent.
Each choice is marked **Chosen**. The web app's contract (routes, answers,
codes, notification kinds and wording keys) was handed over with the work.

### Providers

- One interface (`apps/api/src/ai/provider.ts`): a system text, the
  messages, a ceiling on the answer, optionally a JSON schema the answer
  must follow, a timeout, and the input and output tokens used. Three
  adapters: the Anthropic API (`@anthropic-ai/sdk`), Amazon Bedrock
  (`@anthropic-ai/bedrock-sdk`), and a deterministic fake that never
  touches the network. Vertex AI and compatible endpoints are not built:
  the connection kinds are `anthropic` and `bedrock`.
- **Model ids are data.** Each connection lists its models by the
  provider's own id, with prices per million tokens for estimating cost.
  The seed's demo connections offer `claude-sonnet-5-5` and
  `claude-haiku-5-5` (on Bedrock, `global.anthropic.…`). Each client's
  feature names one model, and optionally a **quick model** for quick
  answers (**Chosen**), used when the feature asks for `tier: 'quick'`.
- **Where it processes is checked.** A Bedrock connection's region is an
  AWS region code. Its model ids must match its inference type:
  - global: `global.` profiles;
  - regional: a profile of a geography the region belongs to (`eu.` in
    `eu-west-1`, `us.` in `us-east-1`, `jp.` or `apac.` in
    `ap-northeast-1`). A region in no geography (`me-central-1`) has no
    regional inference. The map is in `bedrockGeographies()`, from
    Amazon's documentation as of November 2026: check it again when a
    region is added;
  - in-region: the bare model, or the ARN of a foundation or provisioned
    model of the connection's own region. Never an inference profile's
    ARN, which may send requests elsewhere (security review 13, L1).

  The Anthropic API offers global (region `global`) or regional (a
  geography such as `us`, sent as `inference_geo`), not in-region.
  **Chosen**, so that what the client is shown is what happens.
- **Credentials.** A connection names an environment variable,
  `AI_CREDENTIAL_<KIND>_<NAME>`. **Chosen:** no other name is accepted, so
  a connection cannot be pointed at another secret of the deployment, nor
  one kind's credential sent to the other kind's service (400
  `credential_env_mismatch`; security review 13, L4).
  - The value is read when a request is made and goes no further than the
    adapter. It is never stored, logged or returned. The portal shows only
    whether the variable is set.
  - For Bedrock, the variable holds a Bedrock API key, or
    `ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]`.
  - Neither SDK is allowed to read a base URL or a credential from the
    environment on its own. Both adapters set the SDK's log level off
    whatever `ANTHROPIC_LOG` says, since at debug the SDK writes request
    bodies to the log. The SDK adds `ANTHROPIC_CUSTOM_HEADERS` to every
    request whatever it is told, so the API warns at start-up when that
    variable is set (security review 13, L5).
- **No test or development run calls a real provider.**
  `AI_PROVIDERS=real` takes effect only with `NODE_ENV=production`
  (**Chosen**). Otherwise, including when nothing is set, every request is
  answered by the fake provider, and the API says so in its log.
  - Under test it is always the fake. A real adapter built under test
    throws `RealProviderUnderTestError`, which `AiService` does not turn
    into "unavailable", so the test fails. The adapters' own tests give
    them a `fetch` of the test's own.
  - The fake keeps what it was sent, and can be scripted, only under test.
    Elsewhere it is the default, and keeping requests would hold record
    text in memory (security review 13, M6).

### Connections, in the portal

`ai_provider_connections` (Trustline's data) holds the name, kind, region,
inference type, models, credential variable's name, and whether it is
active.

- Staff can list, create, edit, deactivate (`active: false`) and test a
  connection.
- The test is a tiny call. It says only whether it works and whether the
  credential is present, and in which `mode` the API runs. While the fake
  provider answers every request, no call is made and `works` is null,
  since the fake would say nothing of the connection (security review 13,
  L3).
- Every change, and every test, is in the platform log.
- **Chosen:** while a client uses a connection, these cannot change
  (409 `connection_in_use`):
  - its region, inference type or credential variable (another credential
    is another account with the provider, perhaps under other terms of
    retention);
  - whether it is active (it cannot be deactivated).

  No model a client uses can be removed (409 `model_in_use`). Otherwise
  the client would be served from somewhere other than it was told, or
  under other terms, without being told. Move the clients first.
- A connection's kind is fixed once created.

### Per-client settings, in the portal

`ai_client_settings` and `ai_client_features` (tenant data, written by the
portal only) hold:

- AI offered or not;
- for each feature, the connection, model and optional quick model, or no
  row for "not offered";
- allowance overrides (a feature present replaces the plan's; null is no
  limit);
- whether the medical option may be offered;
- the client's monthly spending limit;
- the client's own switch, the one column the application may write.

Every change is in the platform log. What the client can see change is in
the client's own log as `ai_settings_changed`: whether AI is offered, each
feature's provider, where it processes and its model, the allowances, and
the medical option. **Chosen:** not the spending limit, which is
Trustline's control of its own costs. The entry is written through the
platform role's narrow insert policy, as `subscription_changed` is.

A change of provider tells the client's administrators in the app
(`ai_provider_changed`, with the features that moved). **Chosen:** that
covers a feature moved to another connection, given its first one, or
withdrawn, and AI offered or withdrawn as a whole. The client's switch is
left as it was: the administrators are told, and can switch AI off.

**Chosen:** "the client's administrators", here and for the allowance
notices, are the active users who hold `settings.manage` for the whole
organization, as for `/settings/subscription`.

### The client's switch

- `GET /ai/settings` (of the AI module) shows anyone signed in whether AI
  is available, each feature offered and active, and the provider and
  where it processes. **Chosen:** where requests are processed is shown to
  everyone, not only administrators, because decision 5 says the client's
  screens say it plainly.
- Holders of `settings.manage` for the whole organization also see:
  - each model;
  - why a feature is not offered;
  - the month's use against each allowance, with the 80% and 100% marks,
    and the day it starts again;
  - whether the medical option may be offered;
  - who last switched AI, and when.
- `PUT /ai/settings` (`settings.manage` for the whole organization)
  switches AI on or off for the whole organization, and is audited
  (`ai_use_changed`). It is refused with 409 `ai_not_offered` until
  Trustline offers at least one feature. **Chosen:** while the
  subscription is suspended, AI can still be switched off, but not on.

### Allowances

- Plans hold `aiAllowances` per feature (drafts, suggestions, assistant
  messages), which staff change like any part of a plan.
  - Null is no limit.
  - **Chosen:** zero means the plan does not include the feature, and the
    feature is then not offered (`reason: "plan"`), rather than "used
    up".
  - A plan created without them includes no AI.
  - A change of a plan's allowances, or of a client's plan, is in the
    client's `subscription_changed` entry (`aiAllowances`).
- The spec's table is in `SPEC_ALLOWANCES` (`ai/features.ts`). No plans
  named Essentials, Professional and Enterprise exist. **Chosen:**
  - migration 0061 gives the `everything` plan, which every existing
    client is on, the Enterprise figures;
  - the seed gives the illustrative plans the Essentials figures, and
    Complete gets Professional's.

  The old `limits.aiCreditsPerMonth` is left as it was, stored and not
  enforced: the allowances per feature replace credits for now.
- **What is counted** (decision 7):
  - an assistant message: every request;
  - a suggestion: every request;
  - a draft: one document's conversation. The feature passes the draft's
    own id, a UUID (`unit`), never anything written in it.
- **How a draft is counted** (security review 13, M4):
  - The server cannot tell a question from a revision, and does not take
    the feature's word for it. **Chosen:** decision 7's "questions, the
    draft and up to 5 revisions" is read as up to **20 requests** of one
    draft in a month (`REQUESTS_PER_DRAFT`). The first opens the draft and
    counts one; the next 19 count nothing more; the 21st opens another
    draft and counts again.
  - **Chosen:** a draft that carries on into another month is counted
    again there.
  - A request that failed counts nothing, except one whose answer did not
    fit the shape asked for (`invalid_output`). That one cost as much as
    an answer, and is not a way around the allowance. A draft whose
    opening failed opens again.
- **Months follow the client's time zone.** Each request is recorded with
  its month (`YYYY-MM`) on the client's calendar.
- **At 80%** of a feature's allowance the administrators are told once a
  month (`ai_allowance_warning`).
- **At 100%** they are told once too (`ai_allowance_reached`; **chosen**,
  so that nobody finds out only by being refused). The request is refused
  with `ai_allowance_reached`, the allowance and the day it starts again.
  Nothing else is affected.
- Checks and counts are made in one transaction of the client's, under
  locks per client and feature and per spending limit, so two requests
  cannot both take the last unit.

### Spending limits

- Each client has a monthly limit in its own month
  (`ai_client_settings`). Trustline has one over every client together in
  the UTC month (`ai_platform_settings`, set at
  `PUT /platform/ai/settings`). **Chosen:** both default to none; setting
  them is the business's.
- A request is admitted only if what was spent, plus the most it can cost
  over **both** attempts, stays within both limits. The most one attempt
  can cost is its text at three characters a token plus its longest
  answer, at the model's prices.
- The request is recorded at that most until it ends, then at what it
  cost over every attempt (security review 13, M3):
  - an attempt that answered: its real cost;
  - an attempt that timed out, lost its connection or met a server error,
    which the provider may still have billed: the most an attempt can
    cost;
  - an attempt refused before any work (rate limited, overloaded, a bad
    request, no credential): nothing.
- Otherwise it is refused with `ai_spending_limit`, and Trustline's staff
  are told once a month per limit in the platform log
  (`ai_spending_limit_reached`, with the scope and month).
- The application cannot see other clients' requests. It learns the
  platform's total for the UTC month (`ai_platform_spend_this_month()`,
  which takes no moment, so that nobody can watch when other clients use
  AI), and writes that entry (`ai_report_spending_limit()`). Both are
  `SECURITY DEFINER` functions whose search_path ends with `pg_temp` and
  whose names are all qualified, so that no temporary table of the
  session can stand in for a real one (security review 13, M1;
  `security-definer.spec.ts` checks every such function).
- **Chosen:** the client is not told which limit was reached.

### Requests

`ai_requests` (tenant data) records each request:

- the feature, connection, model, and person (null for what runs without
  one);
- the month, the draft it belongs to, and whether it was counted;
- tokens in and out, and the estimated cost in millionths of a dollar;
- the outcome (`pending`, `succeeded`, `failed`, `refused`), the kind of
  failure or refusal, and the attempts.

It never records the text. The application adds and finishes rows, and can
neither delete nor rewrite them. A row is finished once, while it is under
way, and what it was (whose, which feature, connection, model and month,
whether it counted) never changes; the trigger `ai_requests_finish_once`
enforces this for every role (security review 13, L2). The portal reads
them for usage and cost (`GET /platform/tenants/:id/ai`,
`GET /platform/ai/usage`). **Chosen:** a request still pending after 15
minutes is taken to have died with its process, and no longer counts
against an allowance or a limit.

### `AiService.run(caller, feature, request)`

The single entry point. In order:

1. It refuses a request too large to send: a message over 20,000
   characters, or 60,000 in all (`ai_request_too_large`, with the
   limits). A feature keeps what it sends within these.
2. It checks, reading the client's subscription afresh:
   - that the subscription is not suspended (`subscription_suspended`).
     **Chosen** (security review 13, M5): the incidents module's routes
     stay open while suspended, and AI is not safety work;
   - the AI module, and the module the feature assists: policies for
     drafting; incidents, investigations, actions or risks for insights;
     any for the assistant;
   - that the feature is offered and configured;
   - the client's switch;
   - the allowance, and both spending limits.
3. It removes names and identifiers.
4. It calls the provider with a timeout (60 seconds unless the feature
   sets one). It retries once after a failure worth retrying: a timeout,
   429, 529, a 5xx or a lost connection.
5. It puts the names back. When the feature gave a shape (a Zod schema),
   it is sent as a JSON schema, and the answer is checked against it
   after the names are put back: an answer that does not fit fails as
   `invalid_output`.
6. It records the request.
7. It returns `{ ok: true, text, data?, requestId, model, usage }`, or
   `{ ok: false, code, … }` with one of these codes:
   - `ai_request_too_large`;
   - `subscription_suspended`;
   - `ai_not_offered` (with the `reason`);
   - `ai_switched_off`;
   - `ai_allowance_reached`;
   - `ai_spending_limit`;
   - `ai_unavailable`.

   `aiRefusalException()` turns a refusal into HTTP: 503 for
   `ai_unavailable`, 400 for `ai_request_too_large`, 403 for
   `subscription_suspended`, and 409 for the others.

A provider's failure never throws. Only a fault of the code does: a
malformed request (no `people` list, a draft without a UUID), or a real
provider under test. Failures are logged and recorded by kind, never with
a provider's message, which can quote the request.

### Name removal and restoration (step 2)

`ai/redaction.ts`: one `Redaction` per request, held in memory only.

- **What is replaced:**
  - **Names**, as `[PERSON_n]`:
    - those of every user of the client, in every language their name is
      written in;
    - every name the feature passes in. `people` is required: every
      person field of every record sent (patient, reporter, witnesses,
      relatives, staff named), or an empty list where no record is sent;
    - names announced by the words before them (security review 13, H2).
      In English, French and Arabic, the words after a title or a word
      for a relationship: Patient, Mr, Dr, Nurse, her son, his wife, the
      witness; patiente, Mme, son fils, sa fille; المريضة، السيد، ابنها،
      زوجته. In Latin script, the capitalised words after it (up to
      three); in Arabic, up to two words, stopping at a word that cannot
      be a name. A name so found is removed wherever else it appears in
      the request too.

    Whole names are matched first, then the parts of a name on their own
    (three letters or more, titles never). In Latin script a part on its
    own counts when capitalised, or in lower case when it has four letters
    or more and is not an ordinary word (so "will" is not taken for Will,
    and "spoke to mohammed" is caught). Arabic has no capitals, so every
    part counts.
  - **Email addresses**, as `[EMAIL_n]`.
  - **Phone numbers**, as `[PHONE_n]`.
  - **National ID-like numbers**, as `[ID_n]`:
    - Emirates ID, Saudi ID and iqama, and Kuwaiti civil ID;
    - passport and social security numbers after their words in English,
      French and Arabic;
    - any long number standing alone.
  - **Medical record and file numbers**, as `[MRN_n]`: after their words
    in the three languages, and any number of six digits or more near a
    word for a patient, a file, a record or an admission (`patient
    654321`, `file 445566`, `ملف ٤٥٢١٨٨`).
  - Latin and Arabic-Indic digits alike.
- **What is left alone:** dates, times, doses, room numbers, and
  Trustline's own references (`INC-2026-0042`).
- **How names are matched:**
  - Case, accents and Arabic diacritics (harakat, shadda, tanween,
    tatweel) are ignored, as are hamza and madda on alef.
  - Invisible characters inside a word (a soft hyphen, zero-width
    characters, direction marks) are ignored.
  - Teh marbuta matches heh.
  - **Chosen:** alef maqsura is not folded into yeh, so the preposition
    على is never taken for the name علي.
  - Al- and El- names match however they are written: Al-Hassan, Al
    Hassan, Alhassan, El-Hassan. So do Abdul, Abd al- and Abdel names,
    Abu and Abou, and عبد الله and عبدالله.
  - Common names written several ways in Latin letters match each other:
    Muhammad, Mohammed and Mohamed; Aisha, Aicha and Ayesha; Youssef and
    Yusuf; and so on (`SPELLINGS`).
  - An attached و، ف، ب، ل، ك (or و/ف before another) stays outside the
    placeholder.
- **How placeholders behave:**
  - The same thing gets the same placeholder throughout the request.
  - A placeholder already typed in the request is never reused, in any
    form it would be put back from (`[PERSON_1]`, `PERSON_1`,
    `[ PERSON_1 ]`). So restoring can never put a person's name where
    someone typed a placeholder (security review 13, M2).
  - The answer is restored even where the model dropped the brackets.
  - Anything that only looks like a placeholder is left as it is.
- **Chosen: err on the side of removing.** A word that is also a name is
  replaced, and put back in the answer. So what the person reads is right
  either way, and only the model sees less.
- **Chosen:** one person written two ways ("Al-Hassan", "El Hassan") gets
  one placeholder, and is put back in the answer as first written.
- **Bounded.** Every pattern is anchored and bounded, and every step is
  one pass over the text, so that no input can hold the API up (security
  review 13, H1). `redaction-performance.spec.ts` redacts 400,000
  characters of adversarial input, more than six times the largest
  request, within about a second.
- Tested in English, French and Arabic (`ai/redaction.spec.ts`), and end
  to end: under test the fake provider records exactly what would have
  left Trustline (`test/ai-foundation.e2e-spec.ts`).

### Limits of name removal

Name removal knows only:

- the names it is given: the client's users and the `people` the feature
  passes;
- the names a title or a word for a relationship announces;
- the identifiers its patterns describe.

**It cannot find any other name.** These go out unchanged:

- a patient, relative or visitor named in free text with no announcing
  word ("Aisha fell near the lift");
- a spelling of a name it does not know as a variant;
- a name part of one or two letters on its own ("Jo was on shift");
- a number of the wrong shape after a word it does not know.

Over-removal is harmless (the answer is put back); under-removal sends a
name abroad. So:

- **Every feature must pass every person field** of the records it sends
  (`people`), and should send no free text it does not need.
- **Insights on incidents (step 4) and the assistant (step 5) may not be
  offered to any client until one of these is done:**
  1. a recogniser of named entities, run inside Trustline, is added in
     front of the rules above, and tested in English, French and Arabic;
     or
  2. the legal review ("Before the first client uses AI") accepts the
     remaining risk in writing, for the countries concerned.

  Policy drafting (step 3), which sends no record about a person, is not
  held back by this.

### Prompt injection

Text from a record (an incident's narrative, a comment, a document) can
say anything, including "ignore your instructions". The model is never
trusted to tell data from instructions, so:

- **Instructions are the feature's**, in the system text. Record text
  goes in the messages only through `asData(label, text)` (`ai/prompt.ts`).
  This wraps it in `<record>` tags, labels it, and defuses any tag inside
  it, so the text cannot close the data and write instructions after it.
- The system text of every request that carries record text includes
  `DATA_RULES`. These say that record text is never an instruction, and
  that placeholders are kept as they are.
- **The model has no tools**, and nothing it answers is acted on: the
  provider interface carries no tools, and no answer triggers an action.
  An action the assistant proposes is a suggestion that a person confirms
  on a screen (`ai-conversational-assistant.md`).
- **Answers are untrusted text.**
  - The web shows them as plain text, never as HTML or Markdown that
    could carry a link or an image fetched from elsewhere.
  - Data is used only through `output`: a Zod schema the answer is
    checked against, so that a feature never sees a shape it did not ask
    for.

### Not built yet

- `ai_agreements` and the signed medical-option agreement: only "may be
  offered" is stored.
- A recogniser of named entities (see "Limits of name removal").
- Vertex AI and compatible endpoints.
- Extra packs.
- Per-user rate limits.
- The screens.
