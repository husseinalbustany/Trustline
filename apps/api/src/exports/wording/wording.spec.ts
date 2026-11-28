import { SUPPORTED_LOCALES } from '../../i18n/locales.js';
import { CSV_FILES } from '../coverage.js';
import { EXPORT_WORDING } from './index.js';

function texts(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'string') return { [path]: value };
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, texts(inner, path ? `${path}.${key}` : key));
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).sort();

describe('export wording', () => {
  const english = texts(EXPORT_WORDING.en);
  it.each(SUPPORTED_LOCALES)('has exactly the keys and placeholders of the English, each said: %s', (locale) => {
    const own = texts(EXPORT_WORDING[locale]);
    expect(Object.keys(own).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(own)) {
      expect(`${key}: ${text.trim().length > 0}`).toBe(`${key}: true`);
      expect(`${key}: ${placeholders(text).join(',')}`).toBe(`${key}: ${placeholders(english[key]).join(',')}`);
    }
  });

  it('heads every column of every CSV file', () => {
    for (const [table, spec] of Object.entries(CSV_FILES)) {
      expect(Object.keys(EXPORT_WORDING.en.csv[table] ?? {}).sort()).toEqual(spec.columns.map((c) => c.column).sort());
    }
    expect(Object.keys(EXPORT_WORDING.en.csv).sort()).toEqual(Object.keys(CSV_FILES).sort());
  });
});
