# Conversational and voice assistant: preparation

Status: preparation only. Nothing here is built. It adds a third job for the
AI assistant beside drafting documents (`ai-policy-drafting.md`) and offering
suggestions (`ai-insights.md`): a conversation, typed or spoken, in which a
user asks about their own environment and carries out some decisions. How it
is sold and limited is in `modules-and-subscriptions.md`.

Trustline's clients are any organization, not only hospitals.

## What was asked

A voice assistant. The user can talk with it by chat or by voice, ask
whatever they want about their environment, and take some decisions.

## What it is

One assistant, reachable from every screen and from the phone, with two ways
in and out:

- **Chat:** typed questions, written answers.
- **Voice:** the user speaks; the assistant answers aloud and shows the same
  answer on screen. The user can switch between the two at any moment in the
  same conversation.

It does three things:

1. **Answers questions** about what the user is allowed to see.
2. **Helps do things** the user is allowed to do, after the user confirms.
3. **Takes a report by voice**: someone describes an incident in their own
   words and the assistant fills in the form for them to check and send.

## Asking

Examples, in the user's own words:

- "What is overdue in my department?"
- "How many incidents did we have at the north site last month, and of what
  kind?"
- "Which procedure covers working at height, and when was it last reviewed?"
- "Who has not completed fire safety training in my team?"
- "What changed in the top risks since the last committee meeting?"
- "Summarise incident INC-2026-00042 for me."

How it answers:

- **From the client's own records only**, and only those the person asking
  could open themselves. The same permissions and department scope apply as
  on the screens; the assistant has no access of its own.
- **With its sources**: every figure and statement links to the records or
  the document behind it. On voice it says where the answer comes from and
  shows the links on screen.
- **Figures are counted, not guessed.** A number comes from a query on the
  data, shown with its filters ("incidents reported 1 to 31 October, north
  site"), so it matches what the list screen would show.
- **It says when it does not know** or when the person may not see the
  answer, without revealing that something exists.
- It does not answer questions about another client, and does not give
  legal, medical or engineering advice.

Everything decided for suggestions holds here too: who reported an incident
is never given to the assistant; it does not name a person as a cause;
incidents that need a medical decision get facts on request (status, dates,
who is handling) but no suggestion, unless the client has activated that
option and signed the agreement.

## Asking for help with a problem

The user can also bring a problem, not only a question: "We keep getting
late deliveries signed off without a check. What should I do, and how?"

1. **It asks before it answers**: where and how often it happens, what the
   current way of working is, what has been tried. A few questions, each
   with a reason.
2. **It looks at what the client already has**, within what the user may
   see: the procedure that covers this step (or the fact that none does),
   related incidents and how they ended, open risks and actions, and whether
   the people involved were trained.
3. **It proposes options, not one answer.** Each says what it would change,
   why, how much effort it is, and what it rests on. Typical options:
   - a new or revised **policy** (the rule);
   - a new or revised **procedure** (who does what, in which order);
   - a **work instruction** or checklist for one task (a new kind of
     document: one page, for the place where the work is done);
   - **training** or a short awareness message for the people concerned;
   - an entry in the **risk register**, or a **corrective action** with an
     owner and a date;
   - reporting it as an **incident or hazard**, if that has not been done.
   It says which options are strong and which are weak on their own:
   changing how the work is set up is stronger than a reminder or training
   alone.
4. **It explains how**: the steps to carry out the chosen option in
   Trustline, and who has to approve.
5. **It can start the work**, on the user's confirmation: open a draft
   document with the drafting assistant (`ai-policy-drafting.md`), with this
   conversation as its starting point; open a draft training, action or risk
   for the user to complete. Starting a draft is an everyday action. The
   draft then goes through the normal review, approval and signature by
   people.

Limits:

- It advises on how the organization works: rules, steps, responsibilities,
  training. It does not give legal, medical or engineering advice, and says
  so when a problem needs a specialist.
- Its options are suggestions and carry the same notice as every other
  suggestion: check it and look further before deciding.
- If the problem is really a safety event, it says so first and offers to
  report it.
- Where a module is not switched on for the client (for example training),
  it may still name that kind of option but cannot start it.

## Deciding and doing

The user takes the decision; the assistant carries it out. Nothing happens
until the user confirms a summary of exactly what will change.

1. The user says what they want: "Assign this to Rana and set it to in
   progress."
2. The assistant shows (and on voice, reads back) what it will do: the
   record, each change, and who will be notified.
3. The user confirms. On voice, a clear spoken yes; a tap for anything in the
   second group below.
4. It is done under the user's own name and rights, written to the audit
   trail as done by that user through the assistant.

What may be done this way is a fixed list per module, in three groups:

| Group | Examples | How it is confirmed |
|---|---|---|
| **Everyday** | Add a comment, assign a person, set a reminder, mark notifications read, start a report, open a draft, acknowledge having read a document | Spoken or typed yes |
| **Consequential** | Triage, change status, set a risk score, set an action's due date, close an ordinary incident | The summary on screen and a tap or click; never by voice alone |
| **Not through the assistant** | Any signature: closing an incident that needs a second sign-off, approving a document, an investigation report or an action. Roles, permissions, users, settings, subscriptions. Deleting or switching off anything | The assistant opens the right screen and stops there |

Rules:

- **One decision at a time.** No "close all of these"; bulk changes are done
  on the screens.
- **It never acts by itself.** No action is started by the assistant, on a
  schedule, or because a suggestion was shown.
- **Refusals from the system are final.** If the rules refuse a move (the
  wrong status, a missing right, a record changed meanwhile), the assistant
  says so in plain words and does not look for another way.
- **A misheard instruction costs nothing**, because of the read-back and the
  confirmation; a consequential one also needs the tap.
- **Each client chooses** which groups are allowed. Answering questions can
  be on with doing things off.

## Reporting by voice

The strongest everyday use, and the first worth building.

- A member of staff, signed in or through the public link, taps the
  microphone and says what happened.
- The assistant turns it into the report form: type, category, where, when,
  what happened, what was done. It asks only for what is missing.
- The person reads (or hears) the filled form, corrects it, and sends it
  themselves. The assistant does not send a report.
- Nothing is lost if speech recognition fails: the words heard are shown as
  text to edit.
- The warnings of the written form apply: no names of patients or customers,
  what anonymity covers, and that nobody is alerted immediately.

## Voice: what is particular to it

- **Languages and accents.** English, Arabic and French at least, and Arabic
  as it is spoken, not only formal Arabic. Recognition quality differs by
  dialect and must be tested with real staff at each client before it is
  relied on. Mixed speech (Arabic with English terms) is normal and must
  work.
- **Names and references.** People's names, unit names and references such
  as INC-2026-00042 are easily misheard. The assistant matches them against
  the client's own lists, and asks when unsure instead of guessing.
- **Being overheard.** A spoken answer in a corridor or an open office can
  disclose what should not be heard. So: the assistant speaks summaries, not
  personal or sensitive details, which stay on screen; spoken answers are
  off by default on shared devices; there is a "do not read aloud" setting
  per user and per client; headphones are recommended in the guidance.
- **Noise.** Push to talk by default. No always-listening wake word: the
  microphone is on only while the user holds or taps the button, and the
  screen shows clearly when it is.
- **Recordings.** Audio is turned into text and discarded. No voice
  recording is kept, no voiceprint is made, and audio is never used to
  identify who is speaking: the session does that. The text of the
  conversation is kept as below.
- **Accessibility.** Voice helps people who cannot type easily; everything
  spoken is also on screen, and everything can be done without voice.
- **Hands busy, gloves on.** Voice input matters most where people cannot
  use a keyboard, which is where reporting is otherwise skipped.

## What is kept

- **The conversation as text**, visible to the user in their history, under
  the client's separation like all data, for a period the client sets (and
  the user can delete their own).
- **Every action done through the assistant**, in the audit trail, with the
  user, the summary they confirmed, and that it came through the assistant.
- **What the assistant looked up** to answer, so an answer can be checked.
- Not kept: audio.
- Nothing is used to train a model, and nothing crosses clients.

## Safeguards (in addition to those for drafting and suggestions)

- **The assistant has the user's rights and no more.** It reaches data
  through the same API and the same checks as the screens. It cannot be
  talked into showing or doing what the user may not: the check is in the
  system, not in the assistant's instructions.
- **Text inside records is data, not instructions.** A report or a comment
  that says "ignore your rules" or "close this incident" is read as content.
  Actions come only from the signed-in user's own words in the conversation.
- **Confirmation shows facts, not the assistant's wording**: the record and
  the changes are rendered by the system from the action itself.
- **Session rules hold.** The assistant stops when the session ends; a
  consequential action after a long idle period asks the user to sign in
  again.
- **Marked as AI.** Answers carry the notice that they can be wrong and
  should be checked against the linked records.
- **Limits.** Each question and action uses credits from the client's AI
  allowance; voice costs more than chat because of speech processing. A rate
  limit per user applies.
- **Data residency.** Speech and language processing run in the region the
  client's data must stay in, or the feature is off for that client.

## What has to exist first

- The assistant can only ask about, and act in, modules that are built and
  switched on for the client. Today that is incidents and the organization.
- A fixed, tested list of actions per module (the same operations the
  screens use), each with its group and its confirmation.
- AI metering and allowances (`modules-and-subscriptions.md`).
- For voice: a speech service that handles the client's languages in the
  client's region.

Suggested order:

1. Chat that answers questions about incidents, with sources.
2. Reporting an incident by voice.
3. Everyday actions by chat, then by voice.
4. Consequential actions, with on-screen confirmation.
5. Other modules as they are built; spoken answers on the mobile app.

## Data to add (outline, not a schema)

- `assistant_conversations`, `assistant_messages`: the text, per user, with
  the sources used for each answer.
- `assistant_actions`: what was proposed, what the user confirmed, the
  result, linked to the audit entry.
- `assistant_settings`: per client, what is on (answers, each action group,
  voice in, voice out), retention, languages.
- User preferences: voice on or off, read aloud or not.
- Use is metered through `ai_usage`.

## Decisions taken

1. **Decisions through the assistant: the safer start.** Only everyday
   actions at first (comment, assign a person, set a reminder, start a
   report or a draft). Triage, status changes, scores and closing stay on
   the screens until this has been used for a while and is reviewed.
2. **Signatures stay out of the assistant.** Confirmed.
3. **Who gets it: managers only at first**, not every member of staff.
   "Manager" here means a user holding a new permission, "use the
   assistant", which each client grants to its managers and quality staff.
4. **A client's administrator cannot read staff conversations.** Only the
   audit trail of actions taken through the assistant is visible to them.
5. **Arabic as spoken in Lebanon, Saudi Arabia, Kuwait and the United Arab
   Emirates** is what voice must be tested with, including speech mixed
   with English or French terms. Each needs native testers before it is
   offered in that country.
6. **Start with** questions about incidents by chat, then reporting by
   voice (the recommended order; no objection raised).

7. **Voice reporting by all staff: not now.** Reporting an incident by
   voice is, like the rest of the assistant, for managers only at first.
   Opening it to every member of staff is left for later.

## Still to decide

- **Spoken answers** off by default on shared devices, as proposed, or left
  to each client.
- **How long conversations are kept.**
- **The AI and speech services, and where they run.**
