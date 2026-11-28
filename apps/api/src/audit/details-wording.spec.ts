import { detailLines } from './details.js';
import { AUDIT_WORDING } from './wording/index.js';
import type { Locale } from '../i18n/locales.js';

/** Words, not codes or raw dates, in every language (language review 11). */
const lines = (locale: Locale, action: Parameters<typeof detailLines>[0], details: Record<string, unknown>) =>
  detailLines(action, details, { words: AUDIT_WORDING[locale], locale, defaultLocale: 'en', names: new Map() });

describe('worded audit details (language review 11)', () => {
  it('names each changed target’s measure, in its unit', () => {
    const details = { targets: { 'incidents.triaged_on_time': { from: 95, to: 85 }, 'incidents.time_to_report': { from: null, to: 90 } } };
    expect(lines('en', 'report_settings_changed', details)).toEqual(['Triaged on time: 95% → 85%', 'Time to submit a report (median seconds): the default target → 90 s']);
    expect(lines('ar', 'report_settings_changed', details)[0]).toBe('الفرز في الموعد: من 95% إلى 85%');
    expect(lines('fr', 'report_settings_changed', details)[0]).toBe('Tri dans les délais : 95 % → 85 %');
  });

  it('words a module, a method, a month and a language', () => {
    const taken = { month: '2026-10-01', module: 'policies', method: 'snapshot', rows: 4 };
    expect(lines('en', 'measures_snapshot_taken', taken)).toEqual(['Month: October 2026', 'Module: Documents', 'How it was taken: Taken at month end', 'Rows: 4']);
    expect(lines('ar', 'measures_snapshot_taken', taken).join(' · ')).not.toMatch(/policies|snapshot|2026-10/);
    expect(lines('ar', 'measures_snapshot_taken', taken)[1]).toMatch(/^جزء النظام/);
    expect(lines('fr', 'measures_exported', { locale: 'ar', rows: 2, filters: {} })).toContain('Langue : arabe');
  });

  it('writes the access days of an external reviewer as the web does', () => {
    const granted = { organization: 'Survey body', purpose: 'Survey', from: '2026-11-28', until: '2026-12-03', roleId: null };
    const [en] = lines('en', 'external_access_granted', granted);
    expect(en).toContain('Nov 28, 2026');
    expect(en).toContain('Dec 3, 2026');
    expect(en).not.toContain('2026-11-28');
    expect(lines('fr', 'external_access_granted', granted)[0]).toContain('28 nov. 2026');
    expect(lines('ar', 'external_access_granted', granted)[0]).not.toContain('2026-11-28');
  });
});
