# AI-assisted policy and procedure drafting: preparation

Trustline's clients are not only hospitals. This feature is written for any
organization: a hospital, a factory, a logistics company, a school. Examples
below are deliberately general.

Status: built in the API (step 3 of the order of build in
`ai-providers-and-allowances.md`): the client profile, the document design
and drafting with the assistant. The screens are not built. What was built,
and what was decided where this document left a choice open, is in
"Built". Below it, this document says what the feature is.

## What was asked

When someone creates a new policy or procedure, they tell an assistant what
they need. The assistant asks the questions it needs answered, then writes a
draft. Two things make the draft belong to the client and not read as
generic text:

1. **A profile for each client**: what kind of organization it is, so the
   draft fits it.
2. **A document design for each client**: one layout and one set of writing
   rules, so every policy and procedure of that client looks and reads the
   same.

## How it works for the user

1. **Start.** On "New policy" or "New procedure" the user chooses to write it
   themselves or to draft it with the assistant.
2. **Say what is needed**, in their own words and their own language: "a
   procedure for the monthly inspection of fire extinguishers at every site".
3. **Answer questions.** The assistant asks only what it cannot work out from
   the profile and the request, a few at a time, each with a reason. Typical
   ones: who it applies to, who is responsible for each step, how often, what
   is recorded and where, what happens when a step cannot be done, which
   existing policies it must agree with. The user can answer "not decided":
   the draft then carries a marked gap instead of an invention.
4. **Read the draft.** It arrives in the client's own template, section by
   section, with every statement the assistant assumed marked as an
   assumption, and a list of the existing documents it drew on.
5. **Revise.** The user edits directly, or asks for a change ("shorter",
   "add the pharmacy's role", "translate to Arabic"). Each request produces a
   new version of the draft; nothing is overwritten.
6. **Hand over.** The draft becomes an ordinary document in the policy
   module and goes through the same review, approval and signature as one
   written by hand.

The assistant never approves, publishes or changes a controlled document. It
writes drafts. A person owns every decision.

## The client profile

One per client, filled in by the client's administrator with Trustline's help
at onboarding, and editable afterwards. It is the standing context for every
draft, so that the user is not asked the same things each time.

| Part | What it holds | Why the assistant needs it |
|---|---|---|
| Identity | Legal and trading name in each language, sector and type (for example a hospital, a factory, a logistics company, a school), ownership, size (staff, sites, and what the sector counts: beds, production lines, vehicles) | Tone, scale, what "department" means here |
| Services | What the organization does and does not do | Not writing a step for a unit or activity the client does not have |
| Structure | Taken from the organization tree already in Trustline; committees and what each approves | Who is responsible, who approves |
| Roles and titles | The job titles the client actually uses, and which Trustline role each maps to | The client's own titles, not generic ones |
| Standards | Standards followed and their edition (ISO 9001, ISO 45001, JCI, CBAHI, sector rules), national regulations, licensing body | Which requirements a document must meet and cite |
| Languages | Document languages, which one is authoritative when they differ | Language of the draft, bilingual layout |
| Terms | A glossary of preferred and forbidden terms, abbreviations allowed | Consistent wording across documents |
| House rules | Review period, who may own a document, numbering scheme, retention | Filling the document's control block correctly |
| Related systems | Names of the systems staff use (the ERP, the maintenance system, the hospital information system) | "Record it in <their system>" and not "in the system" |

The profile holds facts about the organization, never about individual
people: no customers, patients or named staff.

## The document design

One design per client (a second for a client that keeps policies and
procedures visibly different). It has three parts.

**The template.** The page a reader sees and the PDF that is exported:
logo and name, header and footer, fonts and colours, the control block
(number, title, version, owner, effective and review dates, approvals), and
right-to-left and bilingual layout where the client's languages need it.

**The structure.** The sections every document has, in order, and which are
required. A common starting set, which each client adjusts:

- Policy: purpose, scope, definitions, policy statements, responsibilities,
  references, related documents, revision history.
- Procedure: purpose, scope, definitions, responsibilities, equipment and
  forms, the steps (numbered, one action each, with who does it), what to
  record, exceptions and escalation, references, revision history.

**The writing rules.** What the assistant must follow and a human author is
reminded of: voice and tense ("the supervisor checks", not "should be checked"),
sentence length, how steps are written, how a requirement is distinguished
from guidance (must, should, may), how standards are cited, which terms from
the glossary apply, and what never appears (names of customers, patients or staff,
brand names unless necessary).

The design is what makes the fiftieth document look like the first. It is
applied to documents written by hand as well, so it is part of the policy
module, not of the assistant.

## What the assistant may read

| Source | Used for | Limit |
|---|---|---|
| The client profile and design | Every draft | That client's only |
| The client's own approved documents | Agreeing with what exists, citing related documents, flagging conflicts | That client's only; only documents the user may read |
| A library of standards requirements | Citing the requirement a section meets | Only texts Trustline has the right to use; see open questions |
| What the user types in the conversation | The draft | Screened for personal identifiers first |

It reads nothing from another client. It reads no incident record and no record about a person.

## Safeguards

These come from the business document's AI section and from how the rest of
Trustline is built.

- **A person decides.** Output is a draft with a visible "AI-drafted" mark
  until a named person takes ownership of it. The mark, the model used and
  the questions and answers behind the draft are kept with the document's
  history.
- **No invented facts.** Where the assistant lacks an answer it leaves a
  marked gap. A citation of a standard must point at a requirement in the
  library; one it cannot find is not written.
- **Personal details stay out.** Text is screened for identifiers before it
  leaves Trustline. The profile and design hold none.
- **Each client chooses.** The feature is off until the client switches it
  on. A client that may not send text to an external service can use a model
  hosted in its own region or not use the feature at all.
- **Data residency.** Where the model runs is a per-client setting that
  follows the client's data region; this is a condition of sale in Saudi
  Arabia.
- **Separation between clients.** Profile, design, documents and
  conversations are tenant data under the same row-level security as
  everything else. Nothing a client writes is used to train a model.
- **Permission.** Drafting with the assistant needs the right to create
  documents; it grants nothing new. Every conversation and draft is audited.
- **Cost under control.** Usage is metered per client against its plan.

## What has to exist first

The assistant drafts into the policy module, and that module is not built.
In order:

1. **Policy module, without AI.** Documents, versions, the control block,
   numbering, owners, review dates, an approval cycle with signature, a
   library people can search and read, export to PDF. This is already in the
   first-release scope of the business document.
2. **Client profile.** New screens in the client's settings and in the
   admin portal.
3. **Document design.** Template, structure and writing rules per client,
   used by the editor and the PDF export.
4. **The assistant.** Conversation, questions, draft, revision, hand-over.
5. **Later:** conflict check against existing documents, gap analysis
   against a standard, translation between the client's languages, summaries
   and quiz questions for training.

Steps 2 and 3 are useful without step 4: a consistent template and a filled
profile improve hand-written documents too.

## Data to add (outline, not a schema)

- `tenant_profiles`: one row per client; the parts above as structured
  fields, client-written text stored per language.
- `tenant_glossary_terms`: term, preferred form per language, forbidden
  forms, note.
- `document_designs`: per client and document type; template settings,
  section list, writing rules; versioned, so an old document keeps the
  design it was approved in.
- `documents`, `document_versions`, `document_approvals`: the policy module
  itself (already in the data design).
- `drafting_sessions`, `drafting_messages`: the conversation behind a draft,
  who ran it, which model and which sources were used.
- `ai_usage`: metering per client.
- `standards_requirements`: the requirement library, if licensed.

All are tenant tables under row-level security except the standards library,
which is shared and read-only.

## Decisions needed before building

1. **Which AI service, and where it runs.** A hosted model in a region that
   satisfies each client's data rules, a model the client hosts, or both. This
   decides cost, quality in Arabic, and whether a client in Saudi Arabia can use it.
2. **Standards texts.** ISO, JCI and CBAHI standards are copyrighted. Either
   Trustline licenses them, or each client loads the edition it has bought,
   or drafts cite a requirement by number only, without its text.
3. **Languages of a draft.** One language then translate, or both at once;
   and which is authoritative. Arabic quality needs a native reviewer at each
   client either way.
4. **Who fills the profile.** The client alone, or Trustline staff with the
   client during onboarding (recommended: it is a good onboarding session and
   decides the quality of every later draft).
5. **Who may use the assistant.** Every document author, or the quality
   office only at first.
6. **How drafts are marked after approval.** Whether an approved document
   still shows that it began as an AI draft (recommended: in its history,
   not on its face).
7. **Pricing.** Included in a plan up to a quota, then metered (the business
   document lists "AI usage above plan quota" as extra revenue).
8. **Order of work.** Whether the policy module moves ahead of the remaining
   incident work, since this feature depends on it.

## Built

What the API does now, and what was decided where this document left a
choice open. Each decision is marked **Decided**, with the recommendation
it follows where there was one. The web app's contract (routes, answers,
codes and wording keys) was handed over with the work.

### The client profile

- **Storage.** One per client (`organization_profiles`), as one document of
  facts. Every text the client writes is per language. It holds:
  - identity: legal and trading name, sector, type in the organization's
    own words, ownership, staff, sites, and what the sector counts;
  - services provided and not provided;
  - committees and what each approves;
  - the job titles used, each mapped to one of the client's roles or to
    none;
  - standards, regulations and licensing bodies, with editions;
  - a glossary of preferred terms and forms to avoid;
  - allowed abbreviations;
  - house rules: who may own a document, retention, anything else;
  - the systems staff use.
- **What it does not hold twice.** Structure is the organization tree
  already in Trustline. Languages are the client's settings. Numbering and
  review periods come from the document types. `GET /settings/profile`
  shows these beside the profile (`fromSettings`), read-only.
- **Decided:** the glossary is part of the profile, not a table of its own
  (`tenant_glossary_terms` in the outline). It is bounded (300 terms), and
  read and written with the rest.
- **Who.**
  - The client's administrators read and write it (`settings.manage` for
    the whole organization). Core, whatever modules the client has, since
    steps 2 and 3 are useful without AI.
  - **Decided** (decision 4, as recommended): the client fills it, with
    Trustline's staff during onboarding; Trustline does not write it from
    the portal.
- **Rules.**
  - Text only in the client's languages; the legal name in its main one.
  - A title's role must be the client's own.
  - A change on an out-of-date screen is refused (409 `profile_changed`).
  - Every change is audited (`organization_profile_updated`, with the
    parts that changed, never their text).
- **No people.** It holds facts about the organization, never about a
  person. Nothing can check that a word is not someone's name. Any name
  that does slip in is removed before anything is sent, like every client
  user's name (`ai-providers-and-allowances.md`, "Name removal").

### The document design

- **Storage.** `document_designs` holds:
  - the template rules: header, footer, logo, font, accent colour, the
    fields of the control block, and the layout of bilingual documents.
    Right-to-left follows from the language;
  - the writing rules: the organization's own rules, sentence length, how
    steps are written, the words for requirement, recommendation and
    permission, how standards are cited, whether the glossary applies, and
    what never appears;
  - guidance per section.
- **Decided:** the structure (the sections, their order, which are
  required) stays the document type's. It is edited where it always was,
  not held twice.
- **Decided** (as the outline says): one design for the whole
  organization, and optionally one per document type ("a second for a
  client that keeps policies and procedures visibly different").
- **Versioned.** Every change is a new row, and none is changed. A draft
  records the design it was written in. The control block and the export
  to PDF do not read the design yet; they will.
- **Defaults.** Until a client saves one, its design is made from:
  - the profile (its name in the header);
  - every field of the control block;
  - the starting writing rules in its languages: active voice and present
    tense, one action per step with who does it, roles and units and never
    people, sentences of 25 words at most;
  - never naming patients, customers or staff, or brands unless necessary.
- **Who and how.** As the profile: `settings.manage` for the whole
  organization. A change on an out-of-date version is refused (409
  `design_changed`). Every change is audited (`document_design_updated`,
  with the type, the version and the parts changed). Of the policies
  module.
- **Decided** (decision 2): standards are cited by requirement number only,
  by default, since no library of their texts is licensed. A client may
  choose number and title. The text of a standard is never quoted.

### Drafting with the assistant

"New policy/procedure with the assistant" opens a conversation
(`drafting_sessions`). It belongs to the AI module, and exists only where
the policies module is on too.

- **Who.** Those who may create documents (`policies.manage`). Each
  conversation is its author's own: anyone else, in the same client or
  another, gets 404.
  - **Decided** (decision 5): every document author, not the quality
    office only. The coordinator's instruction says `policies.manage`.
  - The owning unit chosen at handover must be within the author's scope,
    as for any document.
- **Steps.**
  1. **Request**, in the person's own words, for a document type. The
     draft's language is one of the client's: the person's own if the
     client works in it, else the client's main one.
  2. **Questions.** At most 5 a round, each with its reason, and at most 3
     rounds (**Decided**). The assistant asks only what the profile and the
     request do not say, and says when it knows enough. Every open question
     must be answered at once.
     - "Not decided" (`null`) is a valid answer.
     - A question left open when the draft is asked for counts as "not
       decided".
  3. **Draft**, section by section, in the client's design:
     - each statement the assistant assumed is marked "[Assumed: …]";
     - each gap is marked "[To be decided: …]". These are the words in
       English; in Arabic "[افتراض: …]" and "[لم يُحدَّد بعد: …]", in
       French "[Hypothèse : …]" and "[À décider : …]";
     - every "not decided" answer is a marked gap, even if the assistant
       left fewer gaps than there were such answers;
     - a required section it did not write is a gap;
     - what a document's text cannot hold (links, addresses, HTML, code)
       is written plainly;
     - the existing documents it drew on are listed.
  4. **Revisions.** A change asked for ("shorter", "add the pharmacy's
     role", "translate to Arabic") makes a new version, and none is
     overwritten. An edit by hand makes a new version too, checked as any
     document's text is. Gaps and assumptions are listed again from the
     marks in the text.
  5. **Handover.** A version, the latest unless named, becomes an
     ordinary draft document of the policies module, in the same
     transaction as `POST /policies/documents` would make it. The document
     and its first version are marked `ai_drafted`.
- **Languages.** **Decided** (decision 3): a draft is written in one
  language, and translated into another by asking for it. Each language is
  its own text, and a translation leaves the other languages as they
  were. Which language stands is the client's existing setting (business
  decision 5 of the policies module).
- **The AI draft mark.**
  - A handed-over document is marked as an AI draft until a person takes
    ownership of it: its owner, or anyone who manages it. Who and when is
    recorded and audited.
  - It cannot be sent for review before that (409 `ai_draft_not_owned`),
    nor while a gap the assistant left is still in its text, in any
    language (409 `ai_draft_gaps`, with each section).
  - From then on it goes through the same review, approval and signature
    as any document. **Decided:** assumptions do not block review; the
    owner answers for them.
  - **Decided** (decision 6, as recommended): once owned, the document no
    longer carries the mark on its face. Its history still says it began
    as an AI draft: its `source`, the audit trail, and the conversation
    behind it.
- **Never approves or publishes.** Nothing in drafting approves, publishes
  or changes a controlled document. It writes drafts, and handing over
  makes a draft.

### What the assistant reads

As "What the assistant may read" says:

- **Read:**
  - the profile;
  - the design and the type's sections;
  - the organization's units by name;
  - the person's request and answers;
  - the title and published text of at most 3 existing documents. These
    must be in force and readable by the person, as the library would
    show them to them, and the most like the request (by the words of
    their title and keywords, the same type preferred).
- **Not read:** no other client's data, no incident and no record about a
  person, no draft or restricted document the person may not read, and no
  standards text.
- **How it reaches the foundation.**
  - Every call goes through `AiService.run(…, 'drafting', …)`: the
    client's switch, allowances, spending limits and name removal hold.
  - The conversation's id is the request's `unit`, so a conversation is
    one draft of the allowance (20 requests a month, as built).
  - Questions use the feature's quick model; the draft and revisions use
    its main one.
  - Every answer is checked against a Zod schema: questions, or a title,
    sections and sources. A malformed answer is "the assistant is
    unavailable", and is still counted and costed.
  - `people` is passed with the names of the owners of the documents read.
    These are the person fields of those records; every user's name is
    removed in any case.
- **Prompt injection.**
  - The instructions are ours, in the system text, with the rules for
    data (`DATA_RULES`).
  - Everything a client or a person wrote goes in through `asData()`: the
    profile, the structure, the request, each answer, each existing
    document, the draft being revised and the change asked for.
  - The model has no tools, and its answer is data checked against a
    schema: an instruction hidden in a source document can change at most
    the text of a draft, which a person reads, owns and sends for
    approval.

### What is kept, and for how long

- **Kept** (`drafting_sessions`, `drafting_messages`, `drafting_versions`):
  - the request;
  - every question with its reason, and every answer;
  - every change asked for;
  - every version, with its gaps, assumptions, sources, the model and the
    AI request it came from.
- **Decided: how long.**
  - **Handed over:** with the document, as part of its history, for as
    long as the document is kept. Documents are never deleted, and the
    database refuses to remove such a conversation. Those who see the
    document in full read it at `GET /policies/documents/:id/ai-draft`.
  - **Discarded** by its author: removed by the next daily check.
  - **Neither, untouched for 90 days:** removed by the daily check.

  Its turns and versions go with it. The audit trail keeps that it existed
  and what was done (`ai_draft_*`, `ai_drafts_removed_by_system`), never
  what it said.
- Nothing a client writes is used to train a model (the providers' terms,
  `ai-providers-and-allowances.md`).

### Audited

These actions, worded in English, Arabic and French:

- `organization_profile_updated`;
- `document_design_updated`;
- `ai_draft_started`;
- `ai_draft_questions_asked`;
- `ai_draft_answered`;
- `ai_draft_version_created`;
- `ai_draft_discarded`;
- `ai_draft_handed_over`;
- `ai_draft_ownership_taken`;
- `ai_drafts_removed_by_system`.

`document_created` says `source: ai_drafted` and the conversation's id for
a handed-over draft.

### Not built yet

- The screens.
- Standards requirements as a library (decision 2).
- Applying the design to the control block and the PDF export.
- Conflict checks against existing documents, gap analysis against a
  standard, and summaries for training (step 5 of "What has to exist
  first").
