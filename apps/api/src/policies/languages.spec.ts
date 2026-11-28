import type { DocumentSection } from '../database/schema.js';
import { authoritativeLocale, languageStatus } from './languages.js';

const section = (key: string): DocumentSection => ({ key, name: { en: key }, required: false });
const sections = ['purpose', 'scope', 'steps', 'records'].map(section);

describe('where each section stands in each language', () => {
  it('takes the language the client chose as authoritative, else its main language', () => {
    const tenant = { defaultLocale: 'ar', locales: ['ar', 'en'] };
    expect(authoritativeLocale(tenant)).toBe('ar');
    expect(authoritativeLocale(tenant, { authoritativeLocale: null })).toBe('ar');
    expect(authoritativeLocale(tenant, { authoritativeLocale: 'en' })).toBe('en');
    // A language the client no longer works in does not stand.
    expect(authoritativeLocale(tenant, { authoritativeLocale: 'fr' })).toBe('ar');
  });

  it('says what is written, what falls back to the authoritative text, and what is empty', () => {
    const status = languageStatus(
      {
        sections,
        content: {
          en: { purpose: 'Why.', scope: 'Who.', steps: '1. Go.' },
          ar: { purpose: 'لماذا.' },
        },
      },
      null,
      ['en', 'ar'],
      'en',
    );
    expect(status.comparedWith).toBeNull();
    expect(status.sections).toEqual([
      { key: 'purpose', locales: { en: 'written', ar: 'written' } },
      { key: 'scope', locales: { en: 'written', ar: 'fallback' } },
      { key: 'steps', locales: { en: 'written', ar: 'fallback' } },
      { key: 'records', locales: { en: 'empty', ar: 'empty' } },
    ]);
    expect(status.byLocale.ar).toEqual({ written: 1, fallback: 2, lagging: 0, empty: 1 });
    expect(status.lagging).toBe(false);
  });

  it('flags a section changed in the authoritative language and not in another', () => {
    const previous = {
      id: 'v1',
      version: 1,
      content: {
        en: { purpose: 'Why.', scope: 'Who.', steps: '1. Go.' },
        ar: { purpose: 'لماذا.', scope: 'من.', steps: '1. اذهب.' },
      },
    };
    const status = languageStatus(
      {
        sections,
        content: {
          // Steps changed in English only; scope in both.
          en: { purpose: 'Why.', scope: 'Who, all.', steps: '1. Go.\n2. Count.' },
          ar: { purpose: 'لماذا.', scope: 'من، الجميع.', steps: '1. اذهب.' },
        },
      },
      previous,
      ['en', 'ar'],
      'en',
    );
    expect(status.comparedWith).toEqual({ id: 'v1', version: 1 });
    expect(status.sections.map((s) => [s.key, s.locales.ar])).toEqual([
      ['purpose', 'written'],
      ['scope', 'written'],
      ['steps', 'lagging'],
      ['records', 'empty'],
    ]);
    expect(status.lagging).toBe(true);
    // The authoritative language never lags behind itself.
    expect(status.sections.every((s) => s.locales.en !== 'lagging')).toBe(true);
  });
});
