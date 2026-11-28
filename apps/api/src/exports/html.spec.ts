import { EXPORT_WORDING } from './wording/index.js';
import { sectionHtml, versionHtml, type VersionPage } from './html.js';

describe('document HTML', () => {
  it('turns the stored Markdown into its few elements, and nothing else', () => {
    expect(sectionHtml('# Purpose\nTo make a spill **safe**.\n\n1. Mark the area.\n2. Call:\n   - porters\n   - cleaners\n\nDone.')).toBe(
      '<h3>Purpose</h3><p>To make a spill <strong>safe</strong>.</p><ol><li>Mark the area.</li><li>Call:<ul><li>porters</li><li>cleaners</li></ul></li></ol><p>Done.</p>',
    );
  });

  it('escapes everything, so that no text becomes markup', () => {
    const html = sectionHtml('<script>alert(1)</script> [a](javascript:x) ![i](x) "q" & \'s\'');
    expect(html).not.toMatch(/<script|<a |<img/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('makes a page complete in itself, in the language’s direction, with its notes', () => {
    const page: VersionPage = {
      locale: 'ar',
      defaultLocale: 'en',
      organization: { en: 'Demo hospital', ar: 'مستشفى تجريبي' },
      number: 'POL-1',
      title: { en: 'Hand hygiene <b>', ar: 'نظافة اليدين' },
      version: 2,
      status: 'منشورة',
      owner: 'Owner',
      ownerUnit: 'Quality',
      effectiveOn: '2026-11-01',
      authoritative: 'en',
      sections: [
        { key: 'purpose', name: { en: 'Purpose', ar: 'الغرض' }, state: 'fallback' },
        { key: 'steps', name: { en: 'Steps', ar: 'الخطوات' }, state: 'written' },
      ],
      content: { en: { purpose: 'Clean hands.', steps: 'Wash.' }, ar: { steps: 'اغسل.' } },
      changeSummary: null,
      approvals: [{ step: 'Approval', by: 'Authority', at: '2026-10-30 10:00' }],
      imported: null,
      signatures: [{ meaning: 'Approval', by: 'Authority', at: '2026-10-30 10:00', contentHash: 'a'.repeat(64) }],
      languageName: (l) => (l === 'en' ? 'الإنجليزية' : l),
    };
    const html = versionHtml(page, EXPORT_WORDING.ar);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script|<link|<img|src=|href=/);
    expect(html).toContain('<div lang="en"><p>Clean hands.</p></div>');
    expect(html).toContain('بـالإنجليزية');
    expect(html).toContain('<p>اغسل.</p>');
    expect(html).toContain('a'.repeat(64));
  });
});
