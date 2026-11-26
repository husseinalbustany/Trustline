# AI-assisted policy and procedure drafting: preparation

Trustline's clients are not only hospitals. This feature is written for any
organization: a hospital, a factory, a logistics company, a school. Examples
below are deliberately general.

Status: preparation only. Nothing here is built. This document says what the
feature is, what has to exist before it, and what must be decided first.

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
