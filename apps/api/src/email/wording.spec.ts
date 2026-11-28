import { SUPPORTED_LOCALES } from '../i18n/locales.js';
import { fill, localeFor, WORDING } from './wording/index.js';

/** Every text of a wording, by its path of keys. */
function texts(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'string') return { [path]: value };
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, texts(inner, path ? `${path}.${key}` : key));
  }
  return out;
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).sort();

const ALLOWED = ['count', 'day', 'number', 'organization', 'overdue', 'people', 'reference', 'version'];

describe('email wording', () => {
  const english = texts(WORDING.en);

  it('has a wording for every language the product has', () => {
    expect(Object.keys(WORDING).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))(
    'has exactly the keys of the English, with the same placeholders: %s',
    (locale) => {
      const own = texts(WORDING[locale]);
      expect(Object.keys(own).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(own)) {
        expect(`${key}: ${placeholders(text).join(',')}`).toBe(
          `${key}: ${placeholders(english[key]).join(',')}`,
        );
      }
    },
  );

  it.each(SUPPORTED_LOCALES)('says something everywhere, with known placeholders only: %s', (locale) => {
    for (const [key, text] of Object.entries(texts(WORDING[locale]))) {
      expect(`${key}: ${text.trim().length > 0}`).toBe(`${key}: true`);
      for (const name of placeholders(text)) {
        expect(`${key}: ${name}`).toBe(`${key}: ${ALLOWED.includes(name) ? name : '(not allowed)'}`);
      }
    }
  });

  it('writes Arabic right to left, and the others left to right', () => {
    expect(WORDING.ar.dir).toBe('rtl');
    expect(WORDING.en.dir).toBe('ltr');
    expect(WORDING.fr.dir).toBe('ltr');
  });

  it.each(SUPPORTED_LOCALES)('is neutral for any organization: never a hospital or a patient: %s', (locale) => {
    const all = Object.values(texts(WORDING[locale])).join('\n').toLowerCase();
    for (const word of ['hospital', 'hôpital', 'مستشفى', 'patient', 'مريض']) {
      expect(all).not.toContain(word);
    }
  });

  it('fills placeholders, and leaves unknown ones as they are', () => {
    expect(fill('Incident {reference} ({count})', { reference: 'INC-1', count: 2 })).toBe(
      'Incident INC-1 (2)',
    );
    expect(fill('{nothing}', {})).toBe('{nothing}');
  });

  it('writes to a person in their language if the organization works in it', () => {
    const org = { locales: ['en', 'ar'], defaultLocale: 'en' };
    expect(localeFor('ar', org)).toBe('ar');
    expect(localeFor('fr', org)).toBe('en');
    expect(localeFor(null, org)).toBe('en');
    expect(localeFor(null, { locales: ['fr'], defaultLocale: 'fr' })).toBe('fr');
    expect(localeFor('xx', { locales: ['xx'], defaultLocale: 'xx' })).toBe('en');
  });
});
