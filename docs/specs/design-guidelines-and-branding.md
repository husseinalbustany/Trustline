# Design guidelines and client branding: preparation

Status: the guidelines describe how Trustline is designed today and how new
screens must be designed. Client branding (a client's own logo, colours and
font) is preparation only: it is not built.

Mock screens for the planned features, with a live demonstration of client
branding, are published as the "Trustline Design Preview" page.

## Part 1. Design guidelines

### Principles

1. **Clear before clever.** A member of staff under pressure must understand
   a screen at a glance. Plain words, one main action per screen, no jargon.
2. **The same thing looks the same everywhere.** One button style, one way
   to show a status, one place for the main action.
3. **State is visible without reading.** Serious, overdue and waiting items
   carry a colour and an icon and a word; never colour alone.
4. **Every language is first-class.** Layout mirrors for right-to-left;
   nothing is designed in English and "translated".
5. **Works on a phone.** Every screen is usable at 390 pixels wide, with
   touch targets of at least 44 pixels (48 on public pages).
6. **AI is always recognisable.** Anything the assistant wrote or suggested
   is marked as such, in one consistent way.

### Layout

- **App shell:** a sidebar with the modules, a top bar with the main action,
  notifications and the user. On a phone the sidebar becomes a menu.
- **Page:** a header (title, one line of description, the main action), then
  panels. Lists are rows, not tables, so they reflow on a phone.
- **Width:** content up to about 1100 pixels; running text up to about 65
  characters a line.
- **Spacing:** a 4-pixel scale (4, 8, 12, 16, 24, 32, 48). Gaps between
  panels 24; inside a panel 16.
- **Direction:** logical properties only (start and end, never left and
  right), so Arabic mirrors without special cases.

### Colour

Colours are tokens. Components use the token, never a literal colour.

| Token | Use | Default |
|---|---|---|
| `accent` | Main buttons, links, the selected item | Teal `#0F6B6B` |
| `accent-soft` | Selected backgrounds, quiet highlights | Derived from accent |
| `ink` | Text | Slate `#12202B` |
| `muted` | Secondary text | `#55636F` |
| `surface` | Panels | `#FDFEFE` |
| `canvas` | Page background | `#F7F9FA` |
| `line` | Borders | `#D5DEE3` |
| `good` / `warn` / `alert` | Status only: done, attention, serious or overdue | Green, amber, red |
| `ai` | The mark and panel edge of AI content | Violet `#5B4BC4` |

Rules:

- Text meets a contrast ratio of 4.5 to 1 against its background; large text
  and icons 3 to 1.
- **Status colours mean one thing each** and are never used for decoration
  or branding.
- **The AI colour is used only for AI content**, so it stays recognisable.
- Light and dark themes are both designed; a token has a value in each.

### Type

- **Interface:** Inter, with a system fallback. Arabic uses a face designed
  for Arabic (IBM Plex Sans Arabic), not a Latin font's fallback.
- **Scale:** 12, 14 (body), 16, 20, 24, 30. Body never below 14; public
  pages 16.
- Headings in sentence case. No all-capitals for sentences.
- Numbers in tables and counts use tabular figures.
- Western digits in every language.

### Components (one of each)

Button (primary, secondary, quiet, danger), link, field with label above and
help below, select, checkbox and radio as large rows, panel, list row, pill
(status), badge (count), banner (info, warning, error), dialog, tabs as
chips, pagination, empty state, loading state, toast.

Rules that apply to all:

- A field's label is always visible; placeholder text is an example, not the
  label.
- An error says what went wrong and what to do, next to the field.
- A destructive or consequential action asks once, with the facts.
- Every interactive element has a visible focus ring and works by keyboard.

### Words

- Sentence case. Short sentences. Active voice.
- Name things as the user does ("Report an incident"), not as the system
  does.
- A button says what happens ("Send report"), and the confirmation says it
  happened ("Report sent").
- No blame in wording about incidents.
- All wording lives in the dictionaries, one per language, with the same
  keys.

### AI content

- **The mark:** a small spark icon and the words "AI suggestion" or "AI
  draft", in the AI colour.
- **The panel:** suggestions sit in their own panel beside the record, never
  mixed into it.
- **The notice** (fixed wording) appears with every suggestion.
- **Evidence** is listed as links under each suggestion.
- **Actions:** Use, Dismiss; never "Accept all".
- A draft keeps its "AI draft" mark until a person takes ownership.

#### The fixed notices (language review 11)

The single source of the wording: the web dictionaries
(`policies.drafting.notice` and the suggestion notice) and the API's
exported documents (`apps/api/src/exports/wording/<lang>.ts`, `html.aiNotice`)
copy these texts word for word. They cannot be switched off or styled away.

| | English | العربية | Français |
|---|---|---|---|
| **Mark** | AI draft · AI suggestion | مسودة ذكاء اصطناعي · اقتراح من المساعد الذكي | Brouillon IA · Suggestion de l’IA |
| **Drafting notice** (on every AI draft, and in every export of one, until a person takes ownership) | Written by an AI assistant. It can be wrong or incomplete: check every part against how your organization works before you rely on it. Only a person can approve or publish what it writes. | كتبه المساعد الذكي، وقد يحتوي أخطاء أو نقصًا: راجِع كل جزء منه في ضوء طريقة العمل في منشأتك قبل الأخذ به. ولا يُعتمد شيء مما يكتبه ولا يُنشر إلا بقرار من شخص. | Ce texte a été rédigé par un assistant d’IA. Il peut contenir des erreurs ou des oublis : vérifiez chaque partie au regard du fonctionnement de votre établissement avant de vous y fier. Seule une personne peut approuver ou publier ce qu’il rédige. |
| **Suggestion notice** (with every suggestion, and in anything exported or printed that holds one; `ai-insights.md`, rule 7) | This is a suggestion from the AI assistant, based on the records listed below. It can be wrong or incomplete. Check it and investigate further before you decide. | هذا اقتراح من المساعد الذكي، مبني على السجلات المذكورة أدناه، وقد يكون خاطئًا أو ناقصًا. تحقّق منه وواصل التقصّي قبل أن تقرّر. | Ceci est une suggestion de l’assistant d’IA, fondée sur les dossiers listés ci-dessous. Elle peut être erronée ou incomplète. Vérifiez-la et poursuivez l’analyse avant de décider. |

In French, the colon takes a no-break space (U+00A0) before it.

### Accessibility

WCAG 2.2 level AA as the target: contrast as above, keyboard access, visible
focus, labels for screen readers, no information by colour alone, motion
reduced when the user asks for it, text resizable to 200%.

## Part 2. Client branding

### What was asked

Each client can change its colours, logo and font, so Trustline looks like
the client's own system.

### What a client can change

| Item | What the client sets | Where it shows |
|---|---|---|
| **Logo** | A full logo and a square mark, each for light and for dark backgrounds | Sidebar, sign-in page, public report page, documents, PDFs, emails |
| **Name shown** | The name beside or instead of "Trustline" | Same places |
| **Accent colour** | One colour | Buttons, links, selection, the sidebar's active item |
| **Sidebar style** | Light, dark, or tinted with the accent | The app shell |
| **Font** | One from an approved list (below) | The interface; documents follow the document design |
| **Corner style** | Sharp, soft or round | Buttons, panels, fields |
| **Sign-in page** | A welcome line per language and an optional background image | Sign-in |
| **Public pages** | The same branding, plus a line of text per language | Public report and follow-up pages, QR posters |
| **Emails** | Logo, accent, sender name and footer | Notifications, when email is built |

Document appearance (templates for policies and procedures) is the separate
"document design" in `ai-policy-drafting.md`; it takes its logo and colours
from the branding by default.

### What a client cannot change

- **Status colours** (green, amber, red) and what they mean.
- **The AI mark and colour**, and the AI notice.
- **Layout, component shapes and spacing**, beyond the corner style.
- **Wording of safety and privacy notices.**
- **"Powered by Trustline"** in the footer of sign-in and public pages
  (removable on an enterprise plan; a decision).

### Guardrails, applied automatically

A client's choice must never make the product harder to use.

- **Contrast is checked when the colour is chosen.** If the accent does not
  give 4.5 to 1 against white for button text (or against the page for
  links), Trustline uses a darker or lighter shade of it where needed and
  shows the client what it did. A colour that cannot be made to work (a pale
  yellow as a text colour) is refused with the reason.
- **Too close to a status colour:** an accent near the alert red or the warn
  amber is allowed for the logo area but replaced by a neutral for buttons,
  with an explanation, so "red" keeps meaning "serious".
- **Dark theme:** a matching accent for dark backgrounds is derived and
  shown for the client to adjust.
- **Fonts come from an approved list**, each chosen because it covers the
  client's languages well and is licensed for this use: Inter (default), IBM
  Plex Sans, Noto Sans, Source Sans 3, Nunito Sans; for Arabic, IBM Plex
  Sans Arabic, Noto Sans Arabic or Noto Kufi Arabic. A client's own
  corporate font can be uploaded on an enterprise plan, after a check that
  it covers the languages in use and that the client holds a web licence.
- **Logo files:** SVG or PNG, size and proportion limits, checked for
  embedded scripts; shown on a light and a dark background before saving.
- **Preview before publish.** Changes are tried in a live preview of real
  screens (list, form, sign-in, public page, a document) in each of the
  client's languages, then published in one step. The previous branding can
  be restored.

### How it works

- Branding is a small set of values per client, stored with the client's
  settings and audited when changed.
- The app loads them at sign-in and sets the design tokens; every component
  already reads tokens, so no screen needs to know about branding.
- Sign-in and public pages are branded by the client's address (its
  identifier in the link), before anyone has signed in. Only the logo, name,
  colours and font are exposed there.
- Fonts are served by Trustline, not by a third party, so no visitor's
  address is sent elsewhere.
- Who may change it: a user holding `settings.manage` for the whole
  organization. Trustline staff can set it at onboarding from the admin
  portal.

### Plans

Branding can differ by plan (see `modules-and-subscriptions.md`): logo and
accent on every plan; font, sidebar style and sign-in page on higher plans;
own font upload and removal of "Powered by Trustline" on enterprise. These
are for the business to set.

### Data to add (outline)

- `tenant_branding`: logo files, name shown, accent, derived shades, sidebar
  style, font choices per script, corner style, sign-in and public text per
  language, email settings; a draft and a published version.
- Stored logo and font files, per client, in file storage (not yet built).

### Decisions needed

1. **How much freedom.** One accent colour (proposed), or a second colour as
   well. More freedom means more ways to make a screen hard to read.
2. **"Powered by Trustline".** Always shown, or removable on some plans.
3. **Own font upload.** Offered at all, and on which plan.
4. **Branding by plan.** Which items belong to which plan.
5. **A custom web address** (the client's own domain for sign-in and public
   pages). Often asked for with branding; it is a separate piece of work.
