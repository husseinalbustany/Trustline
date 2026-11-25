import { z } from 'zod';
import {
  fitsLanguages,
  localizedText,
  optionalLocalizedText,
} from './locales.js';
import {
  hasControlCharacter,
  hasControlOrLineBreak,
  identifier,
  line,
  optionalLine,
  optionalText,
  text,
} from './text.js';

// Written as escapes throughout: a control character or an invisible mark in
// a source file is one nobody can see or review.
const C0 = Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code));
const DEL = '\u007f';
const C1 = Array.from({ length: 0x20 }, (_, code) =>
  String.fromCharCode(0x80 + code),
);
const TAB = '\t';
const LINE_BREAKS = ['\n', '\r'];

/** What Arabic and French are written with, none of it a control character. */
const NEEDED = {
  'zero-width non-joiner': 'می\u200cخواهم',
  'zero-width joiner': 'ه\u200d',
  'right-to-left mark': 'قسم الطوارئ (ER)\u200f',
  'left-to-right mark': 'ICU\u200e 3',
  'Arabic letter mark': '\u061c12-3',
  'non-breaking space': 'Service\u00a0: urgences',
  'narrow non-breaking space': 'Qui\u202f? Les soins\u202f!',
  'accents and ligatures': 'Hôpital Sacré-Cœur, unité de réanimation',
  'Arabic with diacritics': 'مُسْتَشْفَى الأَمَل',
  tatweel: 'جـــودة',
  apostrophes: 'Salle d’attente de l’hôpital',
  guillemets: '«\u00a0Bloc B\u00a0»',
  'Arabic comma and digits': 'الطابق ٣، جناح ب',
};

const accepts = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value).success;

describe('text a client writes', () => {
  describe('a control character', () => {
    it('is any of the C0 range and DEL, except the tab and line breaks in free text', () => {
      for (const character of [...C0, DEL]) {
        const allowed = character === TAB || LINE_BREAKS.includes(character);
        expect([
          character.charCodeAt(0),
          hasControlCharacter(`a${character}b`),
        ]).toEqual([character.charCodeAt(0), !allowed]);
      }
    });

    it('is any of C0, DEL and C1, and every line break, in one line of text', () => {
      for (const character of [...C0, DEL, ...C1, '\u2028', '\u2029']) {
        expect([
          character.charCodeAt(0),
          hasControlOrLineBreak(`a${character}b`),
        ]).toEqual([character.charCodeAt(0), true]);
      }
    });

    it('is none of what Arabic and French are written with', () => {
      for (const [what, words] of Object.entries(NEEDED)) {
        expect([what, hasControlCharacter(words)]).toEqual([what, false]);
        expect([what, hasControlOrLineBreak(words)]).toEqual([what, false]);
      }
    });
  });

  describe('free text', () => {
    it('keeps its line breaks and what its language needs, and is refused with a control character', () => {
      const words = 'First line.\nSecond line.\r\n\tIndented.';
      expect(text(1, 100).parse(`  ${words}  `)).toBe(words);
      for (const [what, value] of Object.entries(NEEDED)) {
        expect([what, text(1, 100).parse(value)]).toEqual([what, value]);
      }
      for (const character of ['\u0000', '\u0007', '\u001b', DEL]) {
        expect(accepts(text(1, 100), `a${character}b`)).toBe(false);
        expect(accepts(optionalText(100), `a${character}b`)).toBe(false);
      }
      expect(optionalText(100).parse('   ')).toBeNull();
      expect(optionalText(100).parse(undefined)).toBeNull();
    });
  });

  describe('one line of text', () => {
    it('is trimmed, kept as written, and refused with any control character or line break', () => {
      expect(line(1, 100).parse('  Head nurse \n')).toBe('Head nurse');
      for (const [what, value] of Object.entries(NEEDED)) {
        expect([what, line(1, 100).parse(value)]).toEqual([what, value]);
      }
      for (const character of [...C0, DEL, ...C1, '\u2028', '\u2029']) {
        const value = `a${character}b`;
        expect([character.charCodeAt(0), accepts(line(1, 100), value)]).toEqual(
          [character.charCodeAt(0), false],
        );
        expect(accepts(optionalLine(100), value)).toBe(false);
      }
      expect(accepts(line(1, 5), 'x'.repeat(6))).toBe(false);
      expect(accepts(line(1, 5), '   ')).toBe(false);
      expect(optionalLine(100).parse(null)).toBeNull();
      expect(optionalLine(100).parse('  ')).toBeNull();
      expect(optionalLine(100).parse(' +961\u00a01\u00a0234 ')).toBe('+961\u00a01\u00a0234');
    });
  });

  describe('what someone types to say who they are', () => {
    it('is refused with a control character inside it, and not for a line end pasted with it', () => {
      const email = identifier(320);
      expect(email.parse('nadia@example.test')).toBe('nadia@example.test');
      // Kept as typed: where it is looked up it is trimmed, as before.
      expect(email.parse(' nadia@example.test\r\n')).toBe(
        ' nadia@example.test\r\n',
      );
      for (const character of [...C0, DEL, ...C1]) {
        const value = `nadia${character}@example.test`;
        expect([character.charCodeAt(0), accepts(email, value)]).toEqual([
          character.charCodeAt(0),
          false,
        ]);
      }
      expect(accepts(email, '')).toBe(false);
      expect(accepts(email, 'x'.repeat(321))).toBe(false);
      expect(accepts(email, 42)).toBe(false);
    });
  });

  describe('a name in each language', () => {
    it('takes what Arabic and French need, exactly as written', () => {
      for (const [what, value] of Object.entries(NEEDED)) {
        const name = { ar: value, fr: value };
        expect([what, localizedText(200).parse(name)]).toEqual([what, name]);
        expect([what, optionalLocalizedText(500).parse(name)]).toEqual([
          what,
          name,
        ]);
      }
    });

    it('is refused with a control character or a line break in any language', () => {
      for (const character of [...C0, DEL, ...C1, '\u2028', '\u2029']) {
        for (const name of [
          { en: `Phar${character}macy` },
          { en: 'Pharmacy', ar: `صيد${character}لية` },
          { en: 'Pharmacy', fr: `Phar${character}macie` },
        ]) {
          expect([
            character.charCodeAt(0),
            accepts(localizedText(200), name),
          ]).toEqual([character.charCodeAt(0), false]);
        }
      }
      // At either end it is white space, and trimmed like any other.
      expect(localizedText(200).parse({ en: '\tPharmacy\n' })).toEqual({
        en: 'Pharmacy',
      });
    });

    it('still drops blanks, refuses an empty name and an unknown language', () => {
      expect(localizedText(200).parse({ en: 'Pharmacy', fr: '  ' })).toEqual({
        en: 'Pharmacy',
      });
      expect(accepts(localizedText(200), { en: ' ' })).toBe(false);
      expect(accepts(localizedText(200), {})).toBe(false);
      expect(accepts(localizedText(200), { de: 'Apotheke' })).toBe(false);
      expect(accepts(localizedText(5), { en: 'Pharmacy' })).toBe(false);
      expect(
        fitsLanguages(localizedText(200).parse({ fr: 'Pharmacie' }), {
          locales: ['fr'],
          defaultLocale: 'fr',
        }),
      ).toBe(true);
    });
  });

  describe('a description in each language', () => {
    it('may run over several lines, and is refused with any other control character', () => {
      const lines = { en: 'Reads incidents.\nCloses none.\tSo far.' };
      expect(optionalLocalizedText(500).parse(lines)).toEqual(lines);
      for (const character of ['\u0000', '\u0008', '\u001b', DEL]) {
        expect(
          accepts(optionalLocalizedText(500), { en: `a${character}b` }),
        ).toBe(false);
      }
      expect(optionalLocalizedText(500).parse(undefined)).toBeNull();
      expect(optionalLocalizedText(500).parse({ en: '  ' })).toBeNull();
    });
  });
});
