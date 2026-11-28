import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { emailQueue, signInCodes, type tenants, type users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { MailConfig } from '../email/config.js';
import { renderMail } from '../email/render.js';
import { MAIL_CONFIG, MAIL_SENDER, MailFailure, type MailSender } from '../email/sender.js';
import { localeFor } from '../email/wording/index.js';
import { pickText } from '../i18n/locales.js';
import { hashToken } from './provisioning.service.js';

/** How long a code may be used, and how many tries it has. */
export const SIGN_IN_CODE_MINUTES = 10;
export const SIGN_IN_CODE_TRIES = 5;
/** Codes sent to one person in an hour, at most (security review 14, M3). */
export const SIGN_IN_CODES_PER_HOUR = 5;

const codeHashOf = (challenge: string, code: string) =>
  createHash('sha256').update(`trustline.sign-in-code.${challenge}.${code}`).digest('hex');

/**
 * The one-time code an external reviewer is sent at each sign-in
 * (docs/specs/audit-trail.md, decision 2): after the right password, six
 * digits by email, with a challenge the client keeps; both stored hashed.
 * Ten minutes, five tries, once.
 *
 * Sent by the request itself, not the queue's worker, which never takes a
 * sign-in code: the reviewer is waiting. In outbox mode it is kept in the
 * outbox as every other email is.
 */
@Injectable()
export class SignInCodes {
  private readonly logger = new Logger(SignInCodes.name);

  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
    @Inject(MAIL_CONFIG) private readonly config: MailConfig,
  ) {}

  /**
   * Records a code for this person, in the caller's transaction; null when
   * they have been sent as many as an hour allows.
   */
  async issue(tx: Transaction, tenantId: string, userId: string, client: string) {
    // In production a code is never kept readable in the outbox, which is
    // also where mail goes when SMTP is not set up right (review 14, L5).
    if (process.env.NODE_ENV === 'production' && this.sender.mode === 'outbox') {
      throw new ServiceUnavailableException({ code: 'code_not_sent' });
    }
    const [{ sent }] = await tx
      .select({ sent: count() })
      .from(signInCodes)
      .where(and(eq(signInCodes.userId, userId), gt(signInCodes.createdAt, new Date(Date.now() - 3_600_000))));
    if (sent >= SIGN_IN_CODES_PER_HOUR) return null;
    const challenge = randomBytes(32).toString('base64url');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // One live code per person: a new sign-in voids the one before.
    await tx
      .update(signInCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(signInCodes.userId, userId), isNull(signInCodes.usedAt)));
    await tx.insert(signInCodes).values({
      tenantId,
      userId,
      challengeHash: hashToken(challenge),
      codeHash: codeHashOf(challenge, code),
      client,
      expiresAt: new Date(Date.now() + SIGN_IN_CODE_MINUTES * 60_000),
    });
    const [queued] = await tx
      .insert(emailQueue)
      .values({
        tenantId,
        userId,
        category: 'sign_in_code',
        status: 'sending',
        attempts: 1,
        claimedUntil: sql`now() + interval '5 minutes'`,
      })
      .returning({ id: emailQueue.id });
    return { challenge, code, queueId: queued.id };
  }

  /**
   * Sends the code, after the transaction that recorded it has committed.
   * 503 `code_not_sent` when the mail could not be handed over.
   */
  async send(
    tenant: typeof tenants.$inferSelect,
    user: typeof users.$inferSelect,
    issued: { code: string; queueId: string },
  ) {
    const locale = localeFor(user.preferredLocale, tenant);
    const rendered = renderMail(
      { category: 'sign_in_code', code: issued.code, minutes: SIGN_IN_CODE_MINUTES },
      {
        locale,
        organization: pickText(tenant.name, locale, tenant.defaultLocale),
        unsubscribe: null,
        preferencesHref: null,
      },
    );
    const domain = this.config.from.address.split('@')[1] ?? 'localhost';
    let outcome: { status: 'sent' | 'failed'; reason: string | null; lastError: string | null };
    try {
      await this.sender.send({
        tenantId: tenant.id,
        queueId: issued.queueId,
        to: user.email,
        ...rendered,
        messageId: `<${issued.queueId}@${domain}>`,
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
          'Content-Language': locale,
        },
      });
      outcome = { status: 'sent', reason: null, lastError: null };
    } catch (error) {
      const code = error instanceof MailFailure ? error.code : 'unknown';
      this.logger.error(`Sign-in code not sent for client ${tenant.id} (${code})`);
      outcome = { status: 'failed', reason: 'not_sent', lastError: code };
    }
    await this.tenantDb.withTenant(tenant.id, (tx) =>
      tx
        .update(emailQueue)
        .set({ ...outcome, sentAt: outcome.status === 'sent' ? new Date() : null, claimedUntil: null, updatedAt: new Date() })
        .where(eq(emailQueue.id, issued.queueId)),
    );
    if (outcome.status === 'failed') {
      throw new ServiceUnavailableException({ code: 'code_not_sent' });
    }
  }

  /**
   * Takes a code, in the caller's transaction, under a lock: the person it
   * was for, or why not. A wrong one counts a try; the fifth wrong one, or
   * the right one, uses the code up.
   */
  async take(tx: Transaction, challenge: string, code: string) {
    const [row] = await tx
      .select()
      .from(signInCodes)
      .where(
        and(
          eq(signInCodes.challengeHash, hashToken(challenge)),
          isNull(signInCodes.usedAt),
          gt(signInCodes.expiresAt, new Date()),
        ),
      )
      .for('update');
    if (!row) return { ok: false as const, userId: null };
    const given = Buffer.from(codeHashOf(challenge, code), 'hex');
    const right = given.length === 32 && timingSafeEqual(given, Buffer.from(row.codeHash, 'hex'));
    const attempts = row.attempts + 1;
    await tx
      .update(signInCodes)
      .set({ attempts, usedAt: right || attempts >= SIGN_IN_CODE_TRIES ? new Date() : null })
      .where(eq(signInCodes.id, row.id));
    return right
      ? { ok: true as const, userId: row.userId, client: row.client }
      : { ok: false as const, userId: row.userId };
  }
}
