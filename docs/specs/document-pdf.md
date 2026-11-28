# The controlled document as a PDF

Status: steps 1 to 3 built (see "Built"). Read `reports-and-measures.md`,
"The server-made PDF", first: this is the spec it asked for, and it builds
the renderer that committee packs and the full export will share.

A version of a controlled document, made into a PDF by the server, in one of
its languages or side by side in two. The business document calls the
"bilingual PDF export" a key capability of the policies module. Browser
print stays as it is: it is the reader's own copy of what is on screen.

## The renderer (decided)

**A headless browser in a separate, isolated process.** The API makes the
page as HTML, and a headless Chromium prints it to PDF.

- **Why a browser:**
  - Arabic shaping, joining and mixed-direction text are where PDF
    libraries fail; a browser engine gets them right;
  - the print layout already exists as HTML and CSS (`@page` margin boxes,
    which the web's print view uses);
  - one renderer serves the controlled document, committee packs and the
    full export.
- **The binary:** Chromium or Chrome for Testing, installed with the
  deployment (`PDF_BROWSER`, else the first of `/usr/bin/chromium`,
  `/usr/bin/chromium-browser`, `/usr/bin/google-chrome`). Nothing is
  downloaded at run time, and the API starts without one: the PDF route
  then answers 503 `pdf_unavailable`.
- **The process, for each PDF:**
  - a new browser process, with its own empty profile in a private
    temporary directory, removed afterwards;
  - given one file: the page, written into that directory. It gets no
    session, no token, and no address of Trustline's API;
  - **no network:** every request goes to a proxy that is not there
    (`--proxy-server=socks5://127.0.0.1:9`), and every name resolves to
    nothing (`--host-resolver-rules`). Background networking, component
    updates, sync and extensions are off. The page's own content security
    policy is `default-src 'none'`, allowing only its inline style, and
    fonts and images as `data:`;
  - **no script:** the page holds none. Every text is escaped, and the
    policy refuses script.
  - **limits:** 30 seconds per PDF, after which the process is killed;
    renderer processes limited to one; at most two PDFs made at once per
    API process. The rest wait their turn, up to 20.
  - **the sandbox:** the browser's own sandbox is on, except when the API
    runs as root (as in development containers), where Chromium refuses
    it. Production runs the API as an unprivileged user.
- **Fonts, embedded:** a Latin and an Arabic face under a free licence,
  read from the deployment (`PDF_FONT_DIR`) and embedded in the page as
  `data:`, never fetched.
  - Today: DejaVu Sans (regular and bold), which covers Latin, French and
    Arabic, under the Bitstream Vera and public-domain licence.
  - **Recommended later:** Noto Sans and Noto Naskh Arabic (SIL Open Font
    Licence), vendored with the deployment, for a better Arabic face.
  - Without the font files, the page names the faces and the browser uses
    what the system has. The API says so once at start.
- **The alternative** (Typst, or a PDF library) was not taken: see
  decision 10 of `reports-and-measures.md`.

## What the PDF holds

- **One version, in one language or two:**
  - one language: one column, for any client;
  - two languages: two columns, section by section, each section's two
    texts starting level. A client working in three chooses which two
    (decision 11).
  - The language that applies is the first column, at the inline start of
    the page.
- **The page's direction, and the labels of the control block,** follow the
  language asked for (`locale`, one of the client's; by default the
  client's own). In two languages, each column's text has its own
  language and direction.
- **The control block,** in the page's language:
  - number and version, with "(Rev. 4 on the original)" for an imported
    version;
  - title (in each language shown), owner, responsible area, effective day,
    next review;
  - the approvals with the signer's name, the meaning and the day; or
    "Approved before Trustline" with who approved it, when, where the
    signed original is kept, and the differences from it;
  - the language that applies, and the fingerprint of what was signed
    (`contentHash`).
- **Notes per section** (`languageStatus`), in the page's language:
  - "Not written in this language: shown in {language}, the language that
    applies" (fallback);
  - "Translation not updated" (lagging).
- **Every page carries** what the web's print view prints:
  - at the head, the number, the version and the title, with a QR code to
    the document's page (`<site>/policies/<id>`, which always shows the
    version in force);
  - at the foot, "Printed on <day>, valid on that day only" and "Page x of
    y";
  - at the start and the end of the text, "Printed copies are not
    controlled";
  - for a version not in force, its standing across every page as a
    watermark ("Superseded, not in force", "Withdrawn, never in force",
    "Not published, not in force", "Retired, not in force");
  - for an AI draft nobody has taken ownership of, the "AI draft" mark and
    its notice (`design-guidelines-and-branding.md`).
- **The day printed** is the client's day.

## Who may have it

`GET /policies/documents/:id/versions/:versionId/pdf?languages=en,ar&locale=ar`

- **Who:** anyone who may read the document, for the version in force; any
  other version only with full sight of the document (`policies.manage` or
  `policies.view_all` over it). Anything else answers 404, as the version
  route does.
- **`languages`:** one or two of the version's languages, the language that
  applies first. Anything else is 400 `language_mismatch`.
- **`locale`:** one of the client's languages (400 `language_mismatch`).
- **The answer:** `application/pdf`, `Content-Disposition: attachment`,
  `Cache-Control: no-store`, and its SHA-256 in `X-Content-SHA256`.
- **Audit:** `document_pdf_made`, with the version, the languages, the
  page's language, the number of pages and the fingerprint. Reading on
  screen and browser print are not audited, as before.
- **Module:** policies. While suspended, it stays open: it reads.

## Tests

- The QR encoder, module for module against the generator the web uses.
- A PDF of a two-language procedure:
  - the text extracted from it holds the Arabic and the French as written;
  - every page carries the header and the footer, with "Page x of y";
  - a version not in force carries its watermark on every page.
- The route's refusals: no session, a reader without full sight asking for
  a version not in force, another client's version, bad languages.

## Order of build

1. This spec, the renderer, the QR code and the template.
2. The route, its audit, and its tests.
3. The full export's PDFs (`data-export.md`, step 4, and decision 12): every
   version ever published, in each language and side by side, from the same
   template. Not built yet: an archive of a thousand documents is about
   half an hour of rendering, and needs the export worker's time box first.
4. The committee pack's PDF (`reports-and-measures.md`, step 8), from the
   same renderer.

The reviews: `security-reviewer` (the renderer's isolation) and
`bilingual-reviewer` (the page in each direction).
