import {
  BACKOFF_MINUTES,
  CLAIM_MS,
  digestDay,
  EXPIRES_AFTER_MS,
  MAX_ATTEMPTS,
} from './email-worker.service.js';
import { categoryOf, IMMEDIATE_KINDS, SAFETY_WHILE_SUSPENDED } from './kinds.js';

describe('the email worker', () => {
  it('queues the daily digest from 07:00 on the organization’s own clock', () => {
    expect(digestDay(new Date('2026-11-28T06:59:00Z'), 'UTC')).toBeNull();
    expect(digestDay(new Date('2026-11-28T07:00:00Z'), 'UTC')).toBe('2026-11-28');
    expect(digestDay(new Date('2026-11-28T23:59:00Z'), 'UTC')).toBe('2026-11-28');
    // Riyadh is three hours ahead: 07:00 there is 04:00 in UTC.
    expect(digestDay(new Date('2026-11-28T03:59:00Z'), 'Asia/Riyadh')).toBeNull();
    expect(digestDay(new Date('2026-11-28T04:00:00Z'), 'Asia/Riyadh')).toBe('2026-11-28');
    // Its day, not UTC's: past midnight there, it is not yet 07:00...
    expect(digestDay(new Date('2026-11-28T22:00:00Z'), 'Asia/Riyadh')).toBeNull();
    // ...and 14 hours ahead, 18:00 in UTC is 08:00 the next day.
    expect(digestDay(new Date('2026-11-28T18:00:00Z'), 'Pacific/Kiritimati')).toBe('2026-11-29');
  });

  it('gives up after five attempts, well within the day an email is worth sending in', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    const waited = BACKOFF_MINUTES.reduce((a, b) => a + b, 0) * 60_000;
    expect(waited + MAX_ATTEMPTS * CLAIM_MS).toBeLessThan(EXPIRES_AFTER_MS);
  });
});

describe('what is emailed at once', () => {
  it('a new report or a handover only when serious, the others always', () => {
    expect(categoryOf('incident_reported', { serious: true })).toBe('immediate');
    expect(categoryOf('incident_reported', { serious: false })).toBeNull();
    expect(categoryOf('incident_handed_over', { serious: false })).toBeNull();
    expect(categoryOf('incident_handed_over', { serious: true })).toBe('immediate');
    for (const kind of [
      'sentinel_flagged',
      'incident_assigned',
      'sign_off_requested',
      'document_step_assigned',
      'review_approval_requested',
    ] as const) {
      expect(categoryOf(kind, { serious: false })).toBe('immediate');
    }
    expect(categoryOf('acknowledgements_overdue_digest', { serious: false })).toBe(
      'weekly_digest',
    );
    for (const kind of [
      'comment_added',
      'status_changed',
      'sign_off_decided',
      'due_soon',
      'overdue',
      'public_form_paused',
      'document_returned',
      'document_published',
      'acknowledgement_assigned',
      'review_due',
    ] as const) {
      expect(categoryOf(kind, { serious: true })).toBeNull();
    }
  });

  it('still sends what is about incidents while the subscription is suspended, and not approvals', () => {
    // Approvals wait: a step, and a "no change" review (business decision 6).
    const approvals = ['document_step_assigned', 'review_approval_requested', 'risk_step_assigned'];
    for (const kind of IMMEDIATE_KINDS.filter((k) => !approvals.includes(k))) {
      expect(SAFETY_WHILE_SUSPENDED).toContain(kind);
    }
    for (const kind of approvals) expect(SAFETY_WHILE_SUSPENDED).not.toContain(kind);
    expect(SAFETY_WHILE_SUSPENDED).toContain('acknowledgements_overdue_digest');
  });
});
