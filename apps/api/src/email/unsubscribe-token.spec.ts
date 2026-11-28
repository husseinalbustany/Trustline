import { createHmac } from 'node:crypto';
import {
  signUnsubscribe,
  UNSUBSCRIBE_DAYS,
  verifyUnsubscribe,
} from './unsubscribe-token.js';

const SECRET = 'a-secret-of-at-least-thirty-two-characters!';
const claim = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  switch: 'digest' as const,
  locale: 'ar' as const,
};
const now = new Date('2026-11-28T08:00:00Z');

describe('unsubscribe tokens', () => {
  it('names the organization, the person, the switch and the language, when it was issued, until it expires', () => {
    const token = signUnsubscribe(SECRET, claim, now);
    expect(verifyUnsubscribe(SECRET, token, now)).toEqual({
      ...claim,
      expiresAt: now.getTime() / 1000 + UNSUBSCRIBE_DAYS * 86_400,
      issuedAt: now.getTime(),
    });
    const later = new Date(now.getTime() + (UNSUBSCRIBE_DAYS - 1) * 86_400_000);
    expect(verifyUnsubscribe(SECRET, token, later)).not.toBeNull();
    const expired = new Date(now.getTime() + UNSUBSCRIBE_DAYS * 86_400_000);
    expect(verifyUnsubscribe(SECRET, token, expired)).toBeNull();
  });

  it('holds nothing else', () => {
    const token = signUnsubscribe(SECRET, claim, now);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['e', 'i', 'l', 's', 't', 'u']);
  });

  it('takes a link sent before the issue time was added as issued when it was made', () => {
    // As signed then: the same key and purpose, without `i`.
    const e = now.getTime() / 1000 + UNSUBSCRIBE_DAYS * 86_400;
    const payload = Buffer.from(
      JSON.stringify({ t: claim.tenantId, u: claim.userId, s: claim.switch, l: claim.locale, e }),
    ).toString('base64url');
    const token = signUnsubscribe(SECRET, claim, now);
    const signature = createHmac('sha256', SECRET)
      .update(`trustline.email.unsubscribe.v1.${payload}`)
      .digest('base64url');
    expect(token.startsWith('v1.')).toBe(true);
    expect(verifyUnsubscribe(SECRET, `v1.${payload}.${signature}`, now)).toMatchObject({
      issuedAt: now.getTime(),
    });
  });

  it('is refused when altered, signed with another key, or not one at all', () => {
    const token = signUnsubscribe(SECRET, claim, now);
    const [version, payload, signature] = token.split('.');
    // Another person, with the signature of the first.
    const other = Buffer.from(
      JSON.stringify({
        t: claim.tenantId,
        u: '00000000-0000-4000-8000-000000000003',
        s: 'digest',
        l: 'ar',
        e: 4_000_000_000,
      }),
    ).toString('base64url');
    for (const forged of [
      `${version}.${other}.${signature}`,
      `${version}.${payload}.${signature.slice(0, -2)}AA`,
      `v2.${payload}.${signature}`,
      `${version}.${payload}`,
      '',
      'not-a-token',
      `${token}.extra`,
      'x'.repeat(500),
    ]) {
      expect(verifyUnsubscribe(SECRET, forged, now)).toBeNull();
    }
    expect(
      verifyUnsubscribe('another-secret-of-at-least-32-characters', token, now),
    ).toBeNull();
  });
});
