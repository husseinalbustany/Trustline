import { SUPPORTED_LOCALES } from '../../../i18n/locales.js';
import { PDF_WORDING } from './index.js';

function texts(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'string') return { [path]: value };
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) Object.assign(out, texts(inner, path ? `${path}.${key}` : key));
  return out;
}
const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).sort();

describe('document PDF wording', () => {
  const english = texts(PDF_WORDING.en);
  it.each(SUPPORTED_LOCALES)('has exactly the keys and placeholders of the English, each said: %s', (locale) => {
    const own = texts(PDF_WORDING[locale]);
    expect(Object.keys(own).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(own)) {
      expect(`${key}: ${text.trim().length > 0}`).toBe(`${key}: true`);
      expect(`${key}: ${placeholders(text).join(',')}`).toBe(`${key}: ${placeholders(english[key]).join(',')}`);
    }
  });
});
