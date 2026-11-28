import { escapeHtml, sectionHtml } from '../../exports/html.js';
import { wordDay } from '../../i18n/dates.js';
import { pickText, type Locale, type Localized } from '../../i18n/locales.js';
import type { SectionLanguageState } from '../languages.js';
import { qrSvg } from './qr.js';
import { PDF_WORDING } from './wording/index.js';

export type Standing = 'retired' | 'superseded' | 'withdrawn' | 'unpublished';

/** What the page of one version is made from: as the version route gives it, and the client's day. */
export type PdfPage = {
  /** The page's language: its direction and its labels. */
  locale: Locale;
  defaultLocale: string;
  /** The client's day, which the page is printed on. */
  today: string;
  /** One or two languages, the language that applies first if shown. */
  languages: Locale[];
  authoritative: string;
  /** The document's page, which shows the version in force. */
  link: string;
  number: string;
  title: Localized;
  version: number;
  originalRevision: string | null;
  owner: string | null;
  ownerUnit: Localized | null;
  effectiveOn: string | null;
  nextReviewOn: string | null;
  approvals: { kind: string; signedBy: string | null; signedOn: string | null }[];
  imported: {
    revisionLabel: string | null;
    approvedOn: string | null;
    approvedBy: string | null;
    originalKeptAt: Localized | null;
    differences: string | null;
  } | null;
  contentHash: string;
  sections: { key: string; name: Localized }[];
  content: Partial<Record<string, Record<string, string>>>;
  /** Where each section stands in each language (`languageStatus`). */
  states: Record<string, Record<string, SectionLanguageState>>;
  standing: Standing | null;
  aiDraft: boolean;
  /** The `@font-face` rules of the embedded faces. */
  fontFaces: string;
};

const FONT = `"Trustline Document", "DejaVu Sans", "Noto Sans", "Noto Naskh Arabic", sans-serif`;
const dirOf = (locale: string) => (locale === 'ar' ? 'rtl' : 'ltr');

/** A CSS string: quotes, backslashes and line breaks escaped. */
const cssString = (text: string) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r\f]/g, ' ')}"`;

/** "Page {page} of {pages}" as CSS content, with the page counters. */
function pageCounter(template: string) {
  return template
    .split(/(\{page\}|\{pages\})/)
    .filter((part) => part !== '')
    .map((part) => (part === '{page}' ? 'counter(page)' : part === '{pages}' ? 'counter(pages)' : cssString(part)))
    .join(' ');
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{([A-Za-z]+)\}/g, (all, k: string) => values[k] ?? all);

/**
 * The page of one version, in one language or side by side in two
 * (docs/specs/document-pdf.md, "What the PDF holds"), for the shared
 * renderer: complete in itself, its text all escaped, nothing loaded from
 * anywhere. Every page's margins carry what the web's print view prints:
 * the number, version and title with the QR code at the head; "printed on,
 * valid that day only" and "page x of y" at the foot; and across every page
 * the standing of a version not in force.
 */
export function documentPdfHtml(page: PdfPage): string {
  const w = PDF_WORDING[page.locale];
  const dir = w.dir;
  const start = dir === 'rtl' ? 'right' : 'left';
  const end = dir === 'rtl' ? 'left' : 'right';
  const pick = (v: Localized | null | undefined, locale: string = page.locale) =>
    v ? pickText(v, locale, page.defaultLocale) : '';
  const day = (d: string | null) => (d ? wordDay(d, page.locale) : w.notSet);
  const language = (l: string) => w.languages[l as Locale] ?? l;
  const title = pick(page.title);
  const head = fill(page.originalRevision ? w.printHeaderOriginal : w.printHeader, {
    number: page.number,
    version: String(page.version),
    revision: page.originalRevision ?? '',
    title: title.length > 140 ? `${title.slice(0, 140)}…` : title,
  });
  const qr = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg(page.link, 80))}")`;
  const box = `font-family: ${FONT}; font-size: 8pt; line-height: 1.35; color: #000; direction: ${dir};`;
  const mark = page.standing ? w.notInForce[page.standing] : null;

  const row = (label: string, value: string) =>
    `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
  const control = [
    row(w.number, page.number),
    row(w.version, page.originalRevision ? `${page.version} (${w.imported.revisionLabel} ${page.originalRevision})` : String(page.version)),
    ...page.languages.map((l) =>
      `<tr><th scope="row">${escapeHtml(w.title)}${page.languages.length > 1 ? ` (${escapeHtml(language(l))})` : ''}</th><td lang="${l}" dir="${dirOf(l)}">${escapeHtml(pick(page.title, l))}</td></tr>`,
    ),
    row(w.owner, page.owner ?? w.unknownPerson),
    row(w.ownerUnit, pick(page.ownerUnit)),
    row(w.effectiveOn, day(page.effectiveOn)),
    row(w.nextReviewOn, day(page.nextReviewOn)),
    row(w.authoritative, language(page.authoritative)),
  ].join('');
  const approvals = page.imported
    ? `<h2>${escapeHtml(w.imported.title)}</h2><p>${escapeHtml(w.imported.notThroughRoute)}</p><table>${[
        row(w.imported.approvedOn, day(page.imported.approvedOn)),
        row(w.imported.approvedBy, page.imported.approvedBy ?? w.notSet),
        row(w.imported.originalKeptAt, pick(page.imported.originalKeptAt) || w.notSet),
        ...(page.imported.differences ? [row(w.imported.differences, page.imported.differences)] : []),
      ].join('')}</table>`
    : `<h2>${escapeHtml(w.approvals)}</h2>${
        page.approvals.length === 0
          ? `<p>${escapeHtml(w.noApprovals)}</p>`
          : `<ul>${page.approvals
              .map((a) => {
                const said = a.kind === 'review' ? w.reviewedBy : a.kind === 'prepare' ? w.preparedBy : w.approvedBy;
                return `<li>${escapeHtml(fill(said, { name: a.signedBy ?? w.unknownPerson, date: day(a.signedOn) }))}</li>`;
              })
              .join('')}</ul>`
      }`;

  // Each section, in each language shown, its two texts starting level.
  const cell = (key: string, locale: string) => {
    const state = page.states[key]?.[locale] ?? 'written';
    const here = page.content[locale]?.[key]?.trim() ?? '';
    const main = page.content[page.authoritative]?.[key]?.trim() ?? '';
    const shownIn = state === 'fallback' ? page.authoritative : locale;
    const text = state === 'fallback' ? main : here;
    const note =
      state === 'fallback'
        ? `<p class="note">${escapeHtml(fill(w.sectionInOther, { language: language(locale), other: language(page.authoritative) }))}</p>`
        : state === 'lagging'
          ? `<p class="note">${escapeHtml(fill(w.sectionLagging, { language: language(locale), authoritative: language(page.authoritative) }))}</p>`
          : '';
    const name = page.sections.find((s) => s.key === key)?.name;
    return `<div class="cell" lang="${locale}" dir="${dirOf(locale)}"><h3 lang="${locale}">${escapeHtml(pick(name, locale))}</h3>${note}<div lang="${shownIn}" dir="${dirOf(shownIn)}">${text ? sectionHtml(text) : ''}</div></div>`;
  };
  const columns = page.languages.length;
  const sections = page.sections
    .map((s) => `<section class="row">${page.languages.map((l) => cell(s.key, l)).join('')}</section>`)
    .join('');

  return [
    '<!doctype html>',
    `<html lang="${page.locale}" dir="${dir}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">`,
    `<title>${escapeHtml(head)}</title>`,
    '<style>',
    page.fontFaces,
    `@page {
  size: A4;
  margin: 26mm 14mm 20mm;
  @top-${start} { content: ${cssString(head)}; ${box} text-align: start; vertical-align: middle; }
  @top-${end} { content: ${qr}; vertical-align: middle; text-align: ${end}; width: 22mm; }
  @bottom-${start} { content: ${cssString(fill(w.printedOn, { date: wordDay(page.today, page.locale) }))}; ${box} text-align: start; vertical-align: top; }
  @bottom-${end} { content: ${pageCounter(w.pageOf)}; ${box} text-align: ${end}; vertical-align: top; white-space: nowrap; }
}`,
    `body { font-family: ${FONT}; font-size: 10pt; line-height: 1.45; color: #000; margin: 0; }
h1 { font-size: 15pt; margin: 0 0 4mm; }
h2 { font-size: 11pt; margin: 4mm 0 2mm; }
h3 { font-size: 10.5pt; margin: 0 0 1.5mm; }
table { border-collapse: collapse; }
th, td { text-align: start; vertical-align: top; padding-block: 0.6mm; padding-inline: 0 4mm; }
th { font-weight: 700; white-space: nowrap; }
.control { border: 0.4mm solid #000; padding: 3mm 4mm; margin-block-end: 5mm; }
.uncontrolled { font-size: 8.5pt; font-weight: 700; margin-block: 0 4mm; }
.uncontrolled.end { margin-block: 5mm 0; }
.row { display: grid; grid-template-columns: repeat(${columns}, minmax(0, 1fr)); column-gap: 7mm; margin-block-end: 4mm; }
.cell { min-width: 0; overflow-wrap: anywhere; }
.note { font-size: 8.5pt; font-style: italic; margin: 0 0 1.5mm; }
:lang(ar) .note, .note:lang(ar) { font-style: normal; }
.hash { font-family: "DejaVu Sans Mono", monospace; font-size: 8pt; direction: ltr; unicode-bidi: isolate; overflow-wrap: anywhere; }
.ai { border-inline-start: 1.2mm solid #5B4BC4; padding-inline-start: 3mm; margin-block-end: 5mm; }
.ai strong { color: #5B4BC4; }
.mark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.mark p { transform: rotate(-30deg); border: 2mm solid rgba(180, 0, 0, 0.3); color: rgba(180, 0, 0, 0.3); font-size: 34pt; font-weight: 700; padding: 4mm 8mm; text-align: center; }`,
    '</style>',
    '</head>',
    '<body>',
    mark ? `<div class="mark" aria-hidden="true"><p>${escapeHtml(mark)}</p></div>` : '',
    `<p class="uncontrolled">${escapeHtml(w.notControlled)}</p>`,
    `<h1>${escapeHtml(`${page.number} · ${title}`)}</h1>`,
    page.aiDraft ? `<div class="ai"><strong>${escapeHtml(w.aiDraft)}</strong><p>${escapeHtml(w.aiNotice)}</p></div>` : '',
    `<div class="control"><h2>${escapeHtml(w.controlBlock)}</h2><table>${control}</table>${approvals}<p>${escapeHtml(w.contentHash)}: <span class="hash">${escapeHtml(page.contentHash)}</span></p></div>`,
    sections,
    `<p class="uncontrolled end">${escapeHtml(w.notControlled)}</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
