import { categoryOf, SAFETY_WHILE_SUSPENDED } from './kinds.js';
import { renderMail, type MailEnvelope } from './render.js';

const BASE = 'https://trustline.example';
const envelope = (locale: 'en' | 'ar' | 'fr' = 'en'): MailEnvelope => ({
  locale,
  organization: 'Example Organization',
  unsubscribe: { href: `${BASE}/api/v1/email/unsubscribe/v1.abc.def`, switch: 'immediate' },
  preferencesHref: `${BASE}/${locale}/notifications/preferences`,
});

/** The emails of the risks module (docs/specs/risk-management.md, "Notifications and email"). */
describe('the risks module’s emails', () => {
  it('sends an escalation at once only when the band is Extreme, and still while suspended', () => {
    expect(categoryOf('risk_escalated', { reference: 'RSK-2026-00001', serious: true, band: 'extreme' })).toBe('immediate');
    expect(categoryOf('risk_escalated', { reference: 'RSK-2026-00001', serious: true, band: 'high' })).toBeNull();
    expect(categoryOf('risks_overdue_digest', { serious: false })).toBe('weekly_digest');
    expect(categoryOf('action_overdue', { serious: false })).toBeNull();
    expect(SAFETY_WHILE_SUSPENDED).toContain('risk_escalated');
  });

  it('says the reference of an extreme risk escalated, and links to it, in each language', () => {
    for (const locale of ['en', 'ar', 'fr'] as const) {
      const mail = renderMail(
        { category: 'immediate', kind: 'risk_escalated', reference: 'RSK-2026-00012', href: `${BASE}/${locale}/risks/x` },
        envelope(locale),
      );
      expect(mail.subject).toContain('RSK-2026-00012');
      expect(mail.html).toContain(`href="${BASE}/${locale}/risks/x"`);
    }
  });

  it('gives managers the counts of overdue reviews and actions, nothing else', () => {
    const mail = renderMail(
      { category: 'weekly_digest', topic: 'risks', reviewsOverdue: 3, actionsOverdue: 0, stepsOverdue: 0, href: `${BASE}/en/risks/reviews` },
      envelope(),
    );
    expect(mail.subject).toBe('Risk reviews and actions overdue this week');
    expect(mail.text).toContain('Risk reviews overdue: 3');
    expect(mail.text).not.toContain('Actions overdue');
    expect(mail.text).not.toContain('steps overdue');
    expect(mail.text).toContain(`See the reviews due in Trustline: ${BASE}/en/risks/reviews`);
  });

  it('counts the acceptance and closure steps overdue for whole-organization managers', () => {
    const mail = renderMail(
      { category: 'weekly_digest', topic: 'risks', reviewsOverdue: 0, actionsOverdue: 0, stepsOverdue: 2, href: `${BASE}/en/risks/reviews` },
      envelope(),
    );
    expect(mail.text).toContain('Acceptance and closure steps overdue: 2');
  });

  it('tells an assignee of a risk step by its reference only, in each language', () => {
    for (const locale of ['en', 'ar', 'fr'] as const) {
      const mail = renderMail(
        { category: 'immediate', kind: 'risk_step_assigned', reference: 'RSK-2026-00013', href: `${BASE}/${locale}/risks/y` },
        envelope(locale),
      );
      expect(mail.subject).toContain('RSK-2026-00013');
      expect(mail.html).toContain(`href="${BASE}/${locale}/risks/y"`);
    }
  });

  it('lists the risk steps to decide in the morning digest', () => {
    const mail = renderMail(
      {
        category: 'daily_digest',
        day: '2026-11-28',
        sections: [{ key: 'riskSteps', count: 1, items: [{ label: 'RSK-2026-00002', href: `${BASE}/en/risks/b` }] }],
        href: `${BASE}/en/dashboard`,
      },
      envelope(),
    );
    expect(mail.text).toContain('Risk steps to decide: 1');
    expect(mail.text).toContain('RSK-2026-00002');
  });

  it('lists risks to review and actions due in the morning digest', () => {
    const mail = renderMail(
      {
        category: 'daily_digest',
        day: '2026-11-28',
        sections: [
          { key: 'riskReviews', count: 1, items: [{ label: 'RSK-2026-00001', href: `${BASE}/en/risks/a`, overdue: true }] },
          { key: 'actionsDue', count: 2, overdueCount: 1, items: [{ label: 'ACT-2026-00001', href: `${BASE}/en/risks/a` }] },
        ],
        href: `${BASE}/en/dashboard`,
      },
      envelope(),
    );
    expect(mail.text).toContain('Risks to review: 1');
    expect(mail.text).toContain('Actions due: 2');
    expect(mail.text).toContain('Of these, overdue: 1');
  });
});
