# AI providers, models and allowances

Status: decided by the business on 28 November 2026. Not built yet. This is
the foundation every AI feature uses: policy drafting
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
3. Policy drafting (`ai-policy-drafting.md`).
4. Insights on incidents.
5. The assistant.

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
