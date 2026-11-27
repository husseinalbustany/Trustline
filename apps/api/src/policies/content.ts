import type { DocumentContent, DocumentSection } from '../database/schema.js';
import { hasControlCharacter } from '../i18n/text.js';

/**
 * What a version's text may be. Each section is Markdown limited to
 * paragraphs, numbered and bulleted lists, bold and headings, which is what
 * the editor's toolbar writes. The API stores the text as written and never
 * turns it into HTML: screens render it with a sanitizing renderer that
 * drops anything else. What could only be read as something else (HTML,
 * links, images, code) is refused here, so that no stored text depends on
 * the renderer to be harmless.
 */

/** Characters in one section, in one language. */
export const SECTION_MAX_CHARS = 20_000;
/** Characters in all sections of a version, in every language together. */
export const VERSION_MAX_CHARS = 200_000;

/** Why a section's text is refused, or null if it is fine. */
export type MarkupProblem =
  | 'control_character'
  | 'html'
  | 'link'
  | 'image'
  | 'code'
  | 'quote'
  | 'table'
  | 'heading_level'
  | 'indented';

const LIST_ITEM = /^( {0,6})([-*]|\d{1,3}[.)]) +\S/;
const HEADING = /^ {0,3}(#{1,6})(?: +|$)/;

/**
 * Checks one section's text. Allowed: paragraphs; headings of level 1 to 3
 * (`#`, `##`, `###`); bulleted (`-`, `*`) and numbered (`1.`, `1)`) lists,
 * nested by indenting; bold (`**…**`). Refused: HTML tags and comments,
 * links of any form, images, code spans and blocks, block quotes and
 * tables. Text is otherwise taken as typed, Arabic and French included.
 */
export function markupProblem(text: string): MarkupProblem | null {
  if (hasControlCharacter(text)) return 'control_character';
  // A tag, a comment or a declaration: `<b>`, `</p>`, `<!--`, `<?`, and an
  // autolink such as `<https://…>`. A "<" before a space or a digit
  // ("less than 5", "< 5") is text.
  if (/<[A-Za-z/!?]/.test(text)) return 'html';
  if (/!\[/.test(text)) return 'image';
  // `[text](address)`, `[text][label]`, and a label's definition.
  if (/\]\(|\]\[|^\s*\[[^\]]*\]:/m.test(text)) return 'link';
  if (/`|^\s*~~~/m.test(text)) return 'code';
  let inList = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    if (/^\s*>/.test(line)) return 'quote';
    if (/^\s*\|/.test(line)) return 'table';
    const heading = HEADING.exec(line);
    if (heading) {
      if (heading[1].length > 3) return 'heading_level';
      inList = false;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      inList = true;
      continue;
    }
    // Indented by four or more, or by a tab, outside a list: a code block.
    if (/^( {4,}|\t)/.test(line) && !inList) return 'indented';
    if (!/^\s/.test(line)) inList = false;
  }
  return null;
}

/** Line ends as one character, and no space at either end. */
export const normalizeSection = (text: string) =>
  text.replace(/\r\n?/g, '\n').trim();

/** All characters of a version's text, every language together. */
export function contentSize(content: DocumentContent) {
  let size = 0;
  for (const sections of Object.values(content)) {
    for (const text of Object.values(sections ?? {})) size += text.length;
  }
  return size;
}

/** The sections required in `locale` that have no text there. */
export function missingSections(
  sections: DocumentSection[],
  content: DocumentContent,
  locale: string,
) {
  return sections
    .filter((s) => s.required && !content[locale]?.[s.key]?.trim())
    .map((s) => s.key);
}

/** The languages a version has text in, in the client's order. */
export const languagesOf = (content: DocumentContent, order: string[]) =>
  order.filter((locale) =>
    Object.values(content[locale] ?? {}).some((text) => !!text?.trim()),
  );

export type DiffLine = { op: 'same' | 'added' | 'removed'; text: string };

/** Beyond this many lines on either side a section is compared whole. */
const DIFF_MAX_LINES = 2_000;

/**
 * What changed in one section's text, line by line: the lines both have,
 * the lines only the new text has, and those only the old text had, in the
 * order of reading. By the longest common run of lines, so that a line
 * added in the middle shows as one line added.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [
      ...a.map((text) => ({ op: 'removed' as const, text })),
      ...b.map((text) => ({ op: 'added' as const, text })),
    ];
  }
  // lengths[i][j]: the longest common run of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Uint16Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] =
        a[i] === b[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      out.push({ op: 'removed', text: a[i++] });
    } else {
      out.push({ op: 'added', text: b[j++] });
    }
  }
  while (i < a.length) out.push({ op: 'removed', text: a[i++] });
  while (j < b.length) out.push({ op: 'added', text: b[j++] });
  return out;
}

/**
 * A version compared with another (the published one), section by section
 * and language by language: for each section of the version, and each
 * language either has text in, whether it changed and how.
 */
export function compareVersions(
  version: { sections: DocumentSection[]; content: DocumentContent },
  base: { content: DocumentContent } | null,
  locales: string[],
) {
  return version.sections.map((section) => {
    const byLocale: Record<
      string,
      { changed: boolean; lines: DiffLine[] }
    > = {};
    for (const locale of locales) {
      const now = version.content[locale]?.[section.key] ?? '';
      const before = base?.content[locale]?.[section.key] ?? '';
      if (!now && !before) continue;
      byLocale[locale] = {
        changed: now !== before,
        lines: diffLines(before, now),
      };
    }
    return {
      key: section.key,
      name: section.name,
      required: section.required,
      changed: Object.values(byLocale).some((l) => l.changed),
      locales: byLocale,
    };
  });
}
