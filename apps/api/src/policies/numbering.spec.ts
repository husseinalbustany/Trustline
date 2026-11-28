import { lettersOutside, mixesScripts, normalizeNumber, seriesOf } from './numbering.js';

describe('document numbers', () => {
  it('are normalised: NFKC, any script’s digits as ASCII, spaces made one', () => {
    expect(normalizeNumber('ＰＯＬ-ＧＯＶ-００７')).toBe('POL-GOV-007');
    expect(normalizeNumber('POL-GOV-٠٠٧')).toBe('POL-GOV-007');
    expect(normalizeNumber(' POL  GOV ७ ')).toBe('POL GOV 7');
    expect(seriesOf(normalizeNumber('PRC-SAF-۰۱۴'))).toEqual({ series: 'PRC-SAF', n: 14 });
  });

  it('may have letters only of the scripts of the client’s languages (security review 9, finding 3)', () => {
    const enAr = ['en', 'ar'];
    for (const number of ['POL-GOV-007', 'سياسة-12', 'NUM 7/2']) {
      expect(`${number}: ${lettersOutside(number, enAr)}`).toBe(`${number}: false`);
    }
    // Wholly in a script that looks like Latin, or one letter of another.
    for (const number of ['ЅОР-001', 'ꓑꓳꓡ-ꓖꓳꓦ-007', 'ᏢᎾᏞ-ᎶᎾᏙ-007', 'РОL-GOV-007', 'POLα-1', 'ΑΒΓ-1']) {
      expect(`${number}: ${lettersOutside(number, enAr)}`).toBe(`${number}: true`);
    }
    // Arabic letters only where the client works in Arabic.
    expect(lettersOutside('سياسة-1', ['en', 'fr'])).toBe(true);
    expect(lettersOutside('سياسة-1', ['ar'])).toBe(false);
    // Latin always: Trustline's own numbers are.
    expect(lettersOutside('POL-1', ['ar'])).toBe(false);
  });

  it('may not mix scripts', () => {
    expect(mixesScripts('POL-سياسة-1')).toBe(true);
    expect(mixesScripts('POL-GOV-007')).toBe(false);
    expect(mixesScripts('سياسة-1')).toBe(false);
  });
});
