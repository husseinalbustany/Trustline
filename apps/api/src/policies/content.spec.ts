import { addMonths, daysBetween } from '../i18n/time-zones.js';
import {
  compareVersions,
  contentSize,
  diffLines,
  languagesOf,
  markupProblem,
  missingSections,
  normalizeSection,
} from './content.js';

describe("a version's text", () => {
  it('takes paragraphs, headings to level 3, lists and bold, in any script', () => {
    for (const text of [
      'One paragraph.',
      '# Title\n\n## Part\n\n### Detail',
      '- one\n- two\n  - nested\n* star',
      '1. first\n2) second\n   continued',
      'Some **bold** words.',
      'الغرض من هذا الإجراء **واضح**.',
      'L’objet : éviter une chute.',
      'Less than < 5, more than > 3 in a sentence.',
      'A list:\n\n- item\n\n    continued under the item',
      'Brackets [like this] alone.',
    ]) {
      expect({ text, problem: markupProblem(text) }).toEqual({ text, problem: null });
    }
  });

  it('refuses what could only be read as something else', () => {
    const cases: [string, string][] = [
      ['<p>x</p>', 'html'],
      ['</div>', 'html'],
      ['<!-- x -->', 'html'],
      ['<?xml?>', 'html'],
      ['<mailto:a@b>', 'html'],
      ['[a](javascript:alert(1))', 'link'],
      ['[a][ref]', 'link'],
      ['[ref]: https://example.invalid', 'link'],
      ['![a](b.png)', 'image'],
      ['`code`', 'code'],
      ['```\ncode\n```', 'code'],
      ['~~~\ncode', 'code'],
      ['> quote', 'quote'],
      ['| a |', 'table'],
      ['#### four', 'heading_level'],
      ['Para.\n\n    code block', 'indented'],
      ['Para.\n\n\tcode block', 'indented'],
      ['nul \u0000 here', 'control_character'],
      ['escape \u001b[31m', 'control_character'],
    ];
    for (const [text, problem] of cases) {
      expect({ text, problem: markupProblem(text) }).toEqual({ text, problem });
    }
  });

  it('is kept with one kind of line end and no space around it', () => {
    expect(normalizeSection('  a\r\nb\rc  ')).toBe('a\nb\nc');
  });

  it('is measured in characters over every language', () => {
    expect(contentSize({ en: { a: 'abc', b: 'de' }, ar: { a: 'وثيقة' } })).toBe(10);
  });

  it('says which required sections the default language lacks, and which languages it has', () => {
    const sections = [
      { key: 'purpose', name: { en: 'Purpose' }, required: true },
      { key: 'steps', name: { en: 'Steps' }, required: true },
      { key: 'notes', name: { en: 'Notes' }, required: false },
    ];
    expect(missingSections(sections, { en: { purpose: 'x', steps: '  ' } }, 'en')).toEqual(['steps']);
    expect(missingSections(sections, { ar: { purpose: 'x', steps: 'y' } }, 'en')).toEqual(['purpose', 'steps']);
    expect(languagesOf({ fr: { a: 'x' }, en: { a: '' }, ar: { a: 'y' } }, ['en', 'ar', 'fr'])).toEqual(['ar', 'fr']);
  });

  it('is compared line by line, section by section', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'removed', text: 'b' },
      { op: 'same', text: 'c' },
      { op: 'added', text: 'd' },
    ]);
    expect(diffLines('', 'new')).toEqual([{ op: 'added', text: 'new' }]);
    expect(diffLines('old', '')).toEqual([{ op: 'removed', text: 'old' }]);
    const sections = [
      { key: 'purpose', name: { en: 'Purpose' }, required: true },
      { key: 'steps', name: { en: 'Steps' }, required: true },
    ];
    const compared = compareVersions(
      { sections, content: { en: { purpose: 'Same', steps: 'New' }, ar: { purpose: 'جديد' } } },
      { content: { en: { purpose: 'Same', steps: 'Old' } } },
      ['en', 'ar'],
    );
    expect(compared.map((s) => [s.key, s.changed, Object.keys(s.locales)])).toEqual([
      ['purpose', true, ['en', 'ar']],
      ['steps', true, ['en']],
    ]);
    expect(compared[0].locales.en.changed).toBe(false);
    expect(compared[0].locales.ar.changed).toBe(true);
    // A first version is compared with nothing: all of it is new.
    expect(compareVersions({ sections, content: { en: { purpose: 'x' } } }, null, ['en'])[0].changed).toBe(true);
  });
});

describe('review dates', () => {
  it('add calendar months, a missing day becoming the last of the month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
    expect(addMonths('2026-11-27', 36)).toBe('2029-11-27');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(daysBetween('2026-11-27', '2026-12-27')).toBe(30);
    expect(daysBetween('2026-12-27', '2026-11-27')).toBe(-30);
  });
});
