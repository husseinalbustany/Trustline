import { DIGEST_ITEMS, renderMail, type MailEnvelope } from './render.js';

const BASE = 'https://trustline.example';

const envelope = (locale: 'en' | 'ar' | 'fr' = 'en'): MailEnvelope => ({
  locale,
  organization: 'Example Organization',
  unsubscribe: { href: `${BASE}/api/v1/email/unsubscribe/v1.abc.def`, switch: 'immediate' },
  preferencesHref: `${BASE}/${locale}/notifications/preferences`,
});

const assigned = {
  category: 'immediate' as const,
  kind: 'incident_assigned' as const,
  reference: 'INC-2026-00042',
  href: `${BASE}/en/incidents/00000000-0000-4000-8000-000000000001`,
};

/** Every address an HTML body links to or loads. */
const urls = (html: string) =>
  [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);

describe('rendering an email', () => {
  it('says what happened with the reference and links to it, in text and in HTML', () => {
    const mail = renderMail(assigned, envelope());
    expect(mail.subject).toBe('Incident INC-2026-00042 is assigned to you');
    expect(mail.text).toContain('Incident INC-2026-00042 has been assigned to you.');
    expect(mail.text).toContain(`Open in Trustline: ${assigned.href}`);
    expect(mail.text).toContain(`Stop these immediate emails: ${BASE}/api/v1/email/unsubscribe/v1.abc.def`);
    expect(mail.text).toContain('Example Organization');
    expect(mail.html).toContain(`href="${assigned.href}"`);
    expect(mail.html).toContain('<html lang="en" dir="ltr">');
  });

  it('loads nothing, runs nothing, tracks nothing, and links only to Trustline', () => {
    for (const locale of ['en', 'ar', 'fr'] as const) {
      const { html } = renderMail(assigned, envelope(locale));
      expect(html).not.toMatch(/<img|<script|<iframe|<link|<object|<embed|url\(|src=/i);
      for (const url of urls(html)) expect(url.startsWith(`${BASE}/`)).toBe(true);
    }
  });

  it('writes Arabic right to left, with references kept in their order', () => {
    const mail = renderMail(assigned, envelope('ar'));
    expect(mail.html).toContain('<html lang="ar" dir="rtl">');
    expect(mail.html).toContain('<body dir="rtl"');
    expect(mail.subject).toContain('\u2066INC-2026-00042\u2069');
    // The app's own words (language review 7, E4).
    expect(mail.text).toContain('تم تكليفك بمعالجة الحادث');
  });

  it('escapes what it is given, and keeps the subject on one line', () => {
    const mail = renderMail(
      { ...assigned, reference: 'INC-1\r\nBcc: someone@example.com' },
      { ...envelope(), organization: '<script>alert(1)</script> & Co' },
    );
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
  });

  it('asks for a review or an approval of a document by its number and version', () => {
    const base = {
      category: 'immediate' as const,
      kind: 'document_step_assigned' as const,
      number: 'PRC-SAF-014',
      version: 3,
      href: `${BASE}/fr/policies/x`,
    };
    expect(renderMail({ ...base, step: 'review' }, envelope('fr')).subject).toBe(
      'Le document PRC-SAF-014 attend votre vérification',
    );
    const approve = renderMail({ ...base, step: 'approve' }, envelope());
    expect(approve.subject).toBe('Document PRC-SAF-014 awaits your approval');
    expect(approve.text).toContain('Document PRC-SAF-014, version 3, awaits your approval.');
  });

  it('lists at most ten references a section, and counts the rest', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      label: `INC-2026-${String(i + 1).padStart(5, '0')}`,
      href: `${BASE}/en/incidents/${i}`,
      overdue: i === 0,
    }));
    const mail = renderMail(
      {
        category: 'daily_digest',
        day: '2026-11-28',
        href: `${BASE}/en/dashboard`,
        sections: [{ key: 'incidents', count: 12, overdueCount: 1, items }],
      },
      { ...envelope(), unsubscribe: { href: `${BASE}/u`, switch: 'digest' } },
    );
    // The day as the app shows it in each language (language review 7, E16).
    expect(mail.subject).toBe('What waits for you in Trustline: Nov 28, 2026');
    const day = (locale: 'ar' | 'fr') =>
      renderMail(
        { category: 'daily_digest', day: '2026-11-28', href: `${BASE}/${locale}/dashboard`, sections: [] },
        { ...envelope(locale), unsubscribe: { href: `${BASE}/u`, switch: 'digest' } },
      ).subject;
    expect(day('fr')).toBe('Ce qui vous attend dans Trustline\u00a0: 28 nov. 2026');
    expect(day('ar')).toBe('ما ينتظرك في Trustline: \u206828\u200f/11\u200f/2026\u2069');
    expect(mail.text).toContain('Incidents assigned to you: 12');
    expect(mail.text).toContain('Of these, overdue: 1');
    expect(mail.text).toContain('- INC-2026-00001 (overdue):');
    expect(mail.text).toContain('INC-2026-00010');
    expect(mail.text).not.toContain('INC-2026-00011');
    expect(mail.text).toContain('And 2 more in Trustline.');
    expect(mail.text).toContain('Stop these summary emails');
    expect((mail.html.match(/<li>/g) ?? []).length).toBe(DIGEST_ITEMS);
  });

  it('gives the weekly digest as counts only', () => {
    const mail = renderMail(
      { category: 'weekly_digest', overdue: 7, people: 3, stepsOverdue: 0, href: `${BASE}/en/policies/overdue` },
      envelope(),
    );
    expect(mail.text).toContain('Acknowledgements overdue: 7');
    expect(mail.text).toContain('People concerned: 3');
  });

  it('puts U+00A0 before every colon of a French plain text, on link and reference lines too (regression 2, D5)', () => {
    const items = [
      { label: 'WI-OPS-051', href: `${BASE}/fr/policies/1`, overdue: true },
      { label: 'INC-2026-00007', href: `${BASE}/fr/incidents/2` },
    ];
    const mails = [
      renderMail({ ...assigned, href: `${BASE}/fr/incidents/3` }, envelope('fr')),
      renderMail(
        {
          category: 'daily_digest',
          day: '2026-11-28',
          href: `${BASE}/fr/dashboard`,
          sections: [{ key: 'acknowledge', count: 2, items }],
        },
        { ...envelope('fr'), unsubscribe: { href: `${BASE}/u`, switch: 'digest' } },
      ),
      renderMail({ category: 'weekly_digest', overdue: 3, people: 2, stepsOverdue: 0, href: `${BASE}/fr/policies/overdue` }, envelope('fr')),
    ];
    for (const { text } of mails) {
      // Every colon but those of an address (`https://`).
      const bare = [...text.replaceAll('://', '').matchAll(/(.):/gu)].map((m) => m[1]);
      expect(bare.length).toBeGreaterThan(2);
      expect(new Set(bare)).toEqual(new Set(['\u00a0']));
    }
    expect(mails[1].text).toContain(`- WI-OPS-051 (en retard)\u00a0: ${BASE}/fr/policies/1`);
    expect(mails[0].text).toContain(`Ouvrir dans Trustline\u00a0: ${BASE}/fr/incidents/3`);
    // English keeps its plain colon.
    expect(renderMail(assigned, envelope()).text).toContain(`Open in Trustline: ${assigned.href}`);
  });

  it('gives the overdue approval steps in the weekly email, alone or after the acknowledgements (quality review 3, S2)', () => {
    const alone = renderMail(
      { category: 'weekly_digest', overdue: 0, people: 0, stepsOverdue: 2, href: `${BASE}/en/policies/steps/overdue` },
      envelope(),
    );
    expect(alone.subject).toBe('Approval steps overdue this week');
    // To the list of overdue steps (language review 8, M6).
    expect(alone.text).toContain(`See the overdue steps in Trustline: ${BASE}/en/policies/steps/overdue`);
    expect(alone.text).toContain('Approval steps overdue: 2');
    expect(alone.text).not.toContain('Acknowledgements overdue');
    const both = renderMail(
      { category: 'weekly_digest', overdue: 4, people: 3, stepsOverdue: 1, href: `${BASE}/en/policies/overdue` },
      envelope(),
    );
    // Both named in the subject (language review 8, A3); the link to the
    // late acknowledgements.
    expect(both.subject).toBe('Overdue acknowledgements and approval steps this week');
    expect(both.text).toContain(`See who in Trustline: ${BASE}/en/policies/overdue`);
    expect(both.text).toContain('Acknowledgements overdue: 4');
    expect(both.text).toContain('Approval steps overdue: 1');
    // In French, with its spaces.
    expect(
      renderMail({ category: 'weekly_digest', overdue: 0, people: 0, stepsOverdue: 2, href: `${BASE}/fr/dashboard` }, envelope('fr')).text,
    ).toContain('Étapes d’approbation en retard\u00a0: 2');
  });
});
