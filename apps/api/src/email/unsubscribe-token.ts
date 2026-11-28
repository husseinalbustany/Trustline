import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { localeSchema, type Locale } from '../i18n/locales.js';

/** What an unsubscribe link switches off. */
export type EmailSwitch = 'immediate' | 'digest';

export type UnsubscribeClaim = {
  tenantId: string;
  userId: string;
  switch: EmailSwitch;
  /** The language of the email it came in, for the page it opens. */
  locale: Locale;
  /** Seconds since the epoch. */
  expiresAt: number;
};

/** How long a link in an email keeps working. */
export const UNSUBSCRIBE_DAYS = 90;

const VERSION = 'v1';
// Bound to its use, so that no other signature made with the same key can
// pass for one of these.
const PURPOSE = 'trustline.email.unsubscribe';

const claimSchema = z.strictObject({
  t: z.uuid(),
  u: z.uuid(),
  s: z.enum(['immediate', 'digest']),
  l: localeSchema,
  e: z.number().int().positive(),
});

const mac = (secret: string, payload: string) =>
  createHmac('sha256', secret)
    .update(`${PURPOSE}.${VERSION}.${payload}`)
    .digest('base64url');

/**
 * A signed, expiring token for one person's unsubscribe link: their
 * organization, their id, which switch, the language of the email, and until
 * when. Nothing else is in it, and it opens nothing else.
 */
export function signUnsubscribe(
  secret: string,
  claim: Omit<UnsubscribeClaim, 'expiresAt'>,
  now = new Date(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      t: claim.tenantId,
      u: claim.userId,
      s: claim.switch,
      l: claim.locale,
      e: Math.floor(now.getTime() / 1000) + UNSUBSCRIBE_DAYS * 86_400,
    }),
  ).toString('base64url');
  return `${VERSION}.${payload}.${mac(secret, payload)}`;
}

/** The claim of a token, or null if it is not one, was altered or expired. */
export function verifyUnsubscribe(
  secret: string,
  token: string,
  now = new Date(),
): UnsubscribeClaim | null {
  if (token.length > 400) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return null;
  }
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const claim = claimSchema.safeParse(parsed);
  if (!claim.success) return null;
  if (claim.data.e * 1000 <= now.getTime()) return null;
  return {
    tenantId: claim.data.t,
    userId: claim.data.u,
    switch: claim.data.s,
    locale: claim.data.l,
    expiresAt: claim.data.e,
  };
}
