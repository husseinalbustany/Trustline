import { SUPPORTED_LOCALES } from '../../i18n/locales.js';
import { REPORTS_WORDING } from './index.js';

function texts(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'string') return { [path]: value };
  const out: Record<string, string> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, texts(inner, path ? `${path}.${key}` : key));
  }
  return out;
}

describe('reports wording', () => {
  const english = Object.keys(texts(REPORTS_WORDING.en)).sort();
  it.each(SUPPORTED_LOCALES)('has exactly the keys of the English, each said: %s', (locale) => {
    const own = texts(REPORTS_WORDING[locale]);
    expect(Object.keys(own).sort()).toEqual(english);
    for (const [key, text] of Object.entries(own)) expect(`${key}: ${text.trim().length > 0}`).toBe(`${key}: true`);
  });
});
