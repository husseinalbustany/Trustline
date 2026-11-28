import { BadRequestException } from '@nestjs/common';
import {
  markupProblem,
  normalizeSection,
  SECTION_MAX_CHARS,
} from './content.js';

/**
 * One section's text as a client sends it, checked as every version's text
 * is, whether written in the editor or imported: a section the version has
 * (400 `unknown_section`), the small markup only (400 `unsupported_markup`,
 * with the `locale`, `section` and `problem`), and within the size of a
 * section (400 `section_too_long`, with the `max`). Returns the text with
 * its line ends made one and no space at either end; empty for none.
 */
export function checkedSection(
  locale: string,
  key: string,
  raw: string | null,
  keys: Set<string>,
): string {
  if (!keys.has(key)) {
    throw new BadRequestException({ code: 'unknown_section', section: key });
  }
  const value = raw === null ? '' : normalizeSection(raw);
  const problem = value ? markupProblem(value) : null;
  if (problem) {
    throw new BadRequestException({
      code: 'unsupported_markup',
      locale,
      section: key,
      problem,
    });
  }
  if (value.length > SECTION_MAX_CHARS) {
    throw new BadRequestException({
      code: 'section_too_long',
      locale,
      section: key,
      max: SECTION_MAX_CHARS,
    });
  }
  return value;
}
