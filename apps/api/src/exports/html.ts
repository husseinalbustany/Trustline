import { pickText, type Locale, type Localized } from '../i18n/locales.js';
import type { SectionLanguageState } from '../policies/languages.js';
import type { ExportWording } from './wording/types.js';

/** Text for HTML, escaped for an element or an attribute. */
export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Bold (`**…**`) in escaped text: the only inline markup a section may hold. */
const inline = (text: string) => escapeHtml(text).replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>');

const LIST_ITEM = /^( {0,6})([-*]|\d{1,3}[.)]) +(.*)$/;
const HEADING = /^ {0,3}(#{1,3})(?: +(.*?))?\s*#*\s*$/;

/**
 * One section's text as HTML (docs/specs/data-export.md, "Documents"):
 * what the editor writes and the API stores (policies/content.ts), which
 * is all a section may hold: paragraphs, headings of level 1 to 3, bulleted
 * and numbered lists nested by indenting, and bold. Everything is escaped
 * first; nothing else is ever turned into markup, so no stored text becomes
 * a link, an image or a script.
 */
export function sectionHtml(text: string): string {
  const out: string[] = [];
  const lists: { indent: number; tag: 'ul' | 'ol' }[] = [];
  let paragraph: string[] = [];
  const closeParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join(' ')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    const list = lists.pop()!;
    out.push(`</li></${list.tag}>`);
  };
  const closeLists = (above = -1) => {
    while (lists.length > 0 && lists[lists.length - 1].indent > above) closeList();
  };
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    if (line.trim() === '') {
      closeParagraph();
      closeLists();
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      closeParagraph();
      const indent = item[1].length;
      const tag = /\d/.test(item[2]) ? 'ol' : 'ul';
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (top && top.indent === indent && top.tag !== tag) closeList();
      const same = lists[lists.length - 1];
      if (same && same.indent === indent) out.push(`</li><li>${inline(item[3])}`);
      else {
        lists.push({ indent, tag });
        out.push(`<${tag}><li>${inline(item[3])}`);
      }
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading && lists.length === 0) {
      closeParagraph();
      const level = heading[1].length + 2;
      out.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }
    if (lists.length > 0) {
      // A line carried on under a list item.
      out.push(` ${inline(line.trim())}`);
      continue;
    }
    paragraph.push(line.trim());
  }
  closeParagraph();
  closeLists();
  return out.join('');
}

export type VersionPage = {
  locale: Locale;
  defaultLocale: string;
  organization: Localized;
  number: string;
  title: Localized;
  version: number;
  /** Worded already, in the page's language. */
  status: string;
  owner: string | null;
  ownerUnit: string | null;
  effectiveOn: string | null;
  authoritative: string;
  sections: { key: string; name: Localized; state: SectionLanguageState }[];
  content: Partial<Record<string, Record<string, string>>>;
  changeSummary: Localized | null;
  approvals: { step: string; by: string | null; at: string | null }[];
  imported: {
    approvedOn: string | null;
    approvedBy: string | null;
    originalKeptAt: Localized | null;
    differences: unknown;
  } | null;
  signatures: { meaning: string; by: string | null; at: string; contentHash: string }[];
  /** An AI draft nobody has taken ownership of yet: marked as such. */
  aiDraft: boolean;
  /** The language names, in the page's language, for the fallback note. */
  languageName: (locale: string) => string;
};

const STYLE = `
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-inline-size: 48rem; padding-inline: 1rem; line-height: 1.5; color: #111; }
table { border-collapse: collapse; margin-block: 1rem; }
th, td { text-align: start; padding-block: 0.25rem; padding-inline: 0 1rem; vertical-align: top; }
.control { border: 1px solid #999; padding: 0.75rem 1rem; }
.note { font-style: italic; color: #555; }
:lang(ar) .note { font-style: normal; }
.ai { border-inline-start: 4px solid #5B4BC4; padding-inline-start: 0.75rem; color: #5B4BC4; }
.hash { font-family: ui-monospace, monospace; word-break: break-all; direction: ltr; unicode-bidi: isolate; }
section { margin-block: 1.5rem; }
`;

/**
 * One version of a document in one language, as a page complete in itself
 * (spec, "Documents"): no script, no font, no image, nothing loaded from
 * anywhere (a content security policy says so too), and its direction the
 * language's. The control block first: number, version, status, owner,
 * effective day, approvals or "Approved before Trustline"; then each
 * section, with its note where it is shown in the language that applies,
 * or its translation was not updated; then the signatures, with the
 * fingerprint each was made over.
 */
export function versionHtml(page: VersionPage, words: ExportWording): string {
  const w = words.html;
  const pick = (v: Localized | null | undefined) => (v ? pickText(v, page.locale, page.defaultLocale) : '');
  const row = (label: string, value: string | null) =>
    value ? `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>` : '';
  const control = [
    row(w.number, page.number),
    row(w.version, String(page.version)),
    row(w.status, page.status),
    row(w.owner, page.owner),
    row(w.ownerUnit, page.ownerUnit),
    row(w.effective, page.effectiveOn),
  ].join('');
  const approvals = page.imported
    ? `<h2>${escapeHtml(w.approvedBeforeTrustline)}</h2><table>${[
        row(w.approvedOn, page.imported.approvedOn),
        row(w.approvedBy, page.imported.approvedBy),
        row(w.originalKeptAt, pick(page.imported.originalKeptAt)),
        row(
          w.differences,
          page.imported.differences ? (typeof page.imported.differences === 'string' ? page.imported.differences : JSON.stringify(page.imported.differences)) : null,
        ),
      ].join('')}</table>`
    : page.approvals.length > 0
      ? `<h2>${escapeHtml(w.approvals)}</h2><table>${page.approvals
          .map((a) => `<tr><td>${escapeHtml(a.step)}</td><td>${escapeHtml(a.by ?? '')}</td><td>${escapeHtml(a.at ?? '')}</td></tr>`)
          .join('')}</table>`
      : '';
  const sections = page.sections
    .map((s) => {
      const here = page.content[page.locale]?.[s.key]?.trim() ?? '';
      const main = page.content[page.authoritative]?.[s.key]?.trim() ?? '';
      const note =
        s.state === 'fallback'
          ? `<p class="note">${escapeHtml(w.fallback.replace('{language}', page.languageName(page.authoritative)))}</p>`
          : s.state === 'lagging'
            ? `<p class="note">${escapeHtml(w.lagging)}</p>`
            : s.state === 'empty'
              ? `<p class="note">${escapeHtml(w.empty)}</p>`
              : '';
      const text = s.state === 'fallback' ? main : here;
      // Shown in the language that applies: its own language and direction.
      const lang =
        s.state === 'fallback'
          ? ` lang="${escapeHtml(page.authoritative)}" dir="${page.authoritative === 'ar' ? 'rtl' : 'ltr'}"`
          : '';
      return `<section><h2>${escapeHtml(pick(s.name))}</h2>${note}<div${lang}>${text ? sectionHtml(text) : ''}</div></section>`;
    })
    .join('');
  const summary = page.changeSummary && pick(page.changeSummary)
    ? `<section><h2>${escapeHtml(w.changeSummary)}</h2><p>${escapeHtml(pick(page.changeSummary))}</p></section>`
    : '';
  const signatures = page.signatures.length > 0
    ? `<h2>${escapeHtml(w.signed)}</h2><table>${page.signatures
        .map(
          (s) =>
            `<tr><td>${escapeHtml(s.meaning)}</td><td>${escapeHtml(s.by ?? '')}</td><td>${escapeHtml(s.at)}</td><td><span class="hash" title="${escapeHtml(w.contentHash)}">${escapeHtml(s.contentHash)}</span></td></tr>`,
        )
        .join('')}</table>`
    : '';
  const dir = words.dir;
  const title = `${page.number} · ${pick(page.title)}`;
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(page.locale)}" dir="${dir}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    `<p>${escapeHtml(pick(page.organization))}</p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    page.aiDraft ? `<div class="ai"><strong>${escapeHtml(w.aiDraft)}</strong><p>${escapeHtml(w.aiNotice)}</p></div>` : '',
    `<div class="control"><table>${control}</table>${approvals}</div>`,
    sections,
    summary,
    signatures,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
