import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import {
  emailOutbox,
  emailPreferences,
  emailQueue,
  emailSettings,
  notifications,
  tenants,
  type NotificationData,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { pickText, type Localized, type Locale } from '../i18n/locales.js';
import { momentIn } from '../i18n/time-zones.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import {
  NOTIFICATION_MODULE,
  type NotificationKind,
} from '../incidents/notifier.js';
import {
  allows,
  EntitlementsService,
} from '../subscriptions/entitlements.service.js';
import { BackgroundContext } from './background-context.js';
import { describeMail, type MailConfig } from './config.js';
import { DigestService } from './digest.service.js';
import { EmailPreferencesService } from './email-preferences.service.js';
import {
  COMPULSORY_FOR_ASSIGNEES,
  COMPULSORY_FOR_EVERYONE,
  COMPULSORY_FOR_TRIAGERS,
  IMMEDIATE,
  SAFETY_WHILE_SUSPENDED,
  switchOf,
  type EmailCategory,
  type ImmediateKind,
} from './kinds.js';
import { renderMail, type MailContent } from './render.js';
import {
  classifySmtpError,
  MAIL_CONFIG,
  MAIL_SENDER,
  type MailSender,
  type OutgoingMail,
} from './sender.js';
import { signUnsubscribe } from './unsubscribe-token.js';
import { localeFor } from './wording/index.js';

/** How often the worker looks for email to send. */
export const EMAIL_EVERY_MS = 30_000;
/** Emails claimed at once. */
const BATCH = 25;
/**
 * How long a claim holds. Far longer than a send can take (the SMTP
 * timeouts in sender.ts bound one to well under two minutes), so that a
 * claim lapses only when the process that held it has gone.
 */
export const CLAIM_MS = 15 * 60_000;
/**
 * The database's clock, for claims (security review 8): every process
 * reads the same one, so that no process's own clock running fast or slow
 * makes it take over a claim that has not lapsed. `clock_timestamp()`, not
 * `now()`, which stays at the start of a transaction.
 */
const DB_NOW = sql`clock_timestamp()`;
/** When a claim made now lapses, by the database's clock. */
const CLAIM_UNTIL = sql`clock_timestamp() + ${sql.raw(`interval '${CLAIM_MS} milliseconds'`)}`;
/** The waits before each attempt after the first, in minutes. */
export const BACKOFF_MINUTES = [1, 5, 30, 120];
/**
 * How long sending waits, in every client, after the mail server refused
 * the login or to relay (security review 9, finding 2): long enough not to
 * send a wrong password every 30 seconds, which can lock the account at the
 * mail service, and short enough for a corrected configuration to be found
 * soon.
 */
export const PAUSE_AFTER_REFUSAL_MS = 5 * 60_000;
/** Attempts before an email is given up. */
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** An email not sent within this long of being queued is dropped. */
export const EXPIRES_AFTER_MS = 24 * 3_600_000;
/** How long finished queue rows and outbox copies are kept. */
export const RETENTION_DAYS = 30;
/** The hour of the day, on the organization's clock, of the daily digest. */
export const DIGEST_HOUR = 7;
/** How long one statement may take: see CHECK_STATEMENT_TIMEOUT_MS. */
const STATEMENT_TIMEOUT_MS = 30_000;

const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
// RFC 2606 and 6761: names that are never anyone's mailbox.
const RESERVED_DOMAIN = /\.(?:invalid|test|example|localhost)$/i;

/**
 * The kind of a failure and its code, never its message (which can hold
 * data): the database's SQLSTATE, a system or library code (`ECONNRESET`,
 * `EAUTH`), found on the error or what caused it, and the table and
 * constraint for a database error. `no code` when there is none, so that a
 * log line always says which it was.
 */
export const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'unknown error (no code)';
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const database = databaseFailure(error);
  let own: string | null = null;
  for (let e: unknown = error, depth = 0; e && depth < 5 && !own; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) own = code;
    e = (e as { cause?: unknown }).cause;
  }
  const code = database?.code ?? own;
  const where = [database?.table, database?.constraint].filter(Boolean).join(', ');
  return `${name} (${code ?? 'no code'}${where ? `; ${where}` : ''})`;
};

/** Whether the daily digest is due: from DIGEST_HOUR on, on the client's clock. */
export function digestDay(now: Date, timeZone: string, hour = DIGEST_HOUR) {
  const wall = momentIn(now, timeZone);
  return Number(wall.slice(11, 13)) >= hour ? wall.slice(0, 10) : null;
}

export type EmailRunResult = {
  listed: boolean;
  clients: number;
  failed: number;
  /** Handed to the SMTP server. */
  sent: number;
  /** Kept in the outbox instead. */
  kept: number;
  skipped: number;
  retried: number;
  givenUp: number;
  /** Daily digests queued. */
  queued: number;
  /**
   * The mail server refused the login (security review 8, M1): nothing
   * more was sent this run, and what was claimed went back to the queue.
   */
  loginRefused: boolean;
};

type Client = {
  id: string;
  status: 'active' | 'suspended';
  timeZone: string;
  name: Localized;
  locales: string[];
  defaultLocale: string;
};

type Claimed = {
  id: string;
  userId: string;
  category: EmailCategory;
  notificationId: string | null;
  period: string | null;
  attempts: number;
  createdAt: Date;
};

type Prepared = { skip: string } | { mail: OutgoingMail };

/**
 * Sends the email queue (docs/specs/email.md, section 5), and queues each
 * day's digests. Started by `main.ts` only, beside the deadline and policy
 * checks and built the same way: one client at a time, in short
 * transactions of its own under `TenantDb.withTenant`; one client failing
 * does not stop the others, and none fails in silence.
 *
 * **Once, with any number of processes.** An email is claimed by setting it
 * to `sending` with one more attempt, for rows locked with SKIP LOCKED; it is
 * sent outside any transaction; and its outcome is recorded only where the
 * row is still `sending` at that attempt. A claim lapses after CLAIM_MS, so
 * that an email whose process died is sent by another.
 *
 * **Never breaks anything else:** email is queued in a savepoint
 * (MailQueue), sent here, outside any request.
 */
@Injectable()
export class EmailWorker implements OnModuleDestroy {
  private readonly logger = new Logger(EmailWorker.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;
  statementTimeoutMs = STATEMENT_TIMEOUT_MS;
  /**
   * The hour of the daily digest (DIGEST_HOUR). A field so that a test,
   * which runs at whatever hour it is, can say when the digest is due.
   */
  digestHour = DIGEST_HOUR;
  /**
   * Until when nothing is sent, after the mail server refused the login or
   * to relay. For this process; another finds out the same way, once.
   */
  sendingPausedUntil = 0;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    /** Where email goes. A test may put another in its place. */
    @Inject(MAIL_SENDER) public sender: MailSender,
    @Inject(MAIL_CONFIG) private readonly config: MailConfig,
    private readonly preferences: EmailPreferencesService,
    private readonly provisioning: ProvisioningService,
    private readonly entitlements: EntitlementsService,
    private readonly background: BackgroundContext,
    private readonly digest: DigestService,
  ) {}

  /** Says how mail is sent, once, then works every `everyMs`. */
  start(everyMs = EMAIL_EVERY_MS, only?: string[]) {
    if (!this.stopped) return;
    this.stopped = false;
    for (const { level, message } of describeMail(this.config)) {
      this.logger[level](message);
    }
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date(), only)
          .catch((error: unknown) => {
            this.logger.error(`Email worker failed: ${kindOf(error)}`);
          })
          .finally(() => {
            this.current = undefined;
            if (!this.stopped) next(everyMs);
          });
      }, delay);
    };
    next(Math.min(everyMs, 1_000));
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  async onModuleDestroy() {
    await this.stop();
  }

  get active() {
    return this.timer !== undefined || this.current !== undefined;
  }

  private get stopping() {
    return this.stopped && this.current !== undefined;
  }

  /**
   * One pass over every client, as of `now`. `only` narrows it to these
   * clients: for tests, which share the database with clients they did not
   * make. A client Trustline has suspended is sent nothing and has no
   * digest made: its emails expire a day after they were queued, and what is
   * finished is deleted after RETENTION_DAYS like anyone's, so that no
   * address or copy is kept longer while it is suspended.
   */
  async run(now = new Date(), only?: string[]): Promise<EmailRunResult> {
    const result: EmailRunResult = {
      listed: false,
      clients: 0,
      failed: 0,
      sent: 0,
      kept: 0,
      skipped: 0,
      retried: 0,
      givenUp: 0,
      queued: 0,
      loginRefused: false,
    };
    let clients: Client[];
    try {
      clients = await this.db.transaction(async (tx) => {
        await this.limitStatements(tx);
        return tx
          .select({
            id: tenants.id,
            status: tenants.status,
            timeZone: tenants.timeZone,
            name: tenants.name,
            locales: tenants.locales,
            defaultLocale: tenants.defaultLocale,
          })
          .from(tenants)
          .where(only ? inArray(tenants.id, only) : undefined)
          .orderBy(asc(tenants.id));
      });
    } catch (error) {
      this.logger.error(
        `Email worker failed before any client was looked at: ${kindOf(error)}`,
      );
      return result;
    }
    result.listed = true;
    result.clients = clients.length;
    for (const client of clients) {
      if (this.stopping) break;
      try {
        if (client.status === 'active') {
          await this.workClient(client, now, result);
        } else {
          result.skipped += await this.expire(client.id, now);
          await this.purge(client.id, now);
        }
      } catch (error) {
        result.failed += 1;
        if (this.stopping) break;
        this.logger.error(
          `Email worker failed for client ${client.id}: ${kindOf(error)}`,
        );
      }
    }
    const handled =
      result.sent + result.kept + result.skipped + result.retried + result.givenUp;
    if (handled + result.failed > 0) {
      const outbox =
        this.sender.mode === 'outbox'
          ? ` (mail is not configured: kept in the outbox, not sent)`
          : '';
      const summary = `Email: ${result.sent} sent, ${result.kept} kept in the outbox${outbox}, ${result.skipped} skipped, ${result.retried} to retry, ${result.givenUp} given up, ${result.failed} of ${result.clients} clients failed`;
      if (result.failed > 0 || result.givenUp > 0) this.logger.warn(summary);
      else this.logger.log(summary);
    }
    return result;
  }

  private inClient<T>(tenantId: string, fn: (tx: Transaction) => Promise<T>) {
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      await this.limitStatements(tx);
      return fn(tx);
    });
  }

  private async limitStatements(tx: Transaction) {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`,
    );
  }

  /**
   * One client: its digests, then its queue, then its purge, each a step of
   * its own (security review 8, L4), so that a digest that cannot be queued
   * neither holds back what cannot wait nor the deletion of what is past
   * keeping. A failure of any step is named in the log with the client.
   */
  private async workClient(client: Client, now: Date, result: EmailRunResult) {
    let failed = false;
    try {
      result.queued += await this.queueDigests(client, now);
    } catch (error) {
      failed = true;
      this.logger.error(
        `Email digests could not be queued for client ${client.id}: ${kindOf(error)}`,
      );
    }
    try {
      await this.sendQueue(client, now, result);
    } finally {
      try {
        await this.purge(client.id, now);
      } catch (error) {
        failed = true;
        this.logger.error(
          `Email retention could not be applied for client ${client.id}: ${kindOf(error)}`,
        );
      }
    }
    if (failed) result.failed += 1;
  }

  /**
   * Sends what is due, a batch at a time. Once the mail server has refused
   * the login, nothing more is sent this run, for this client or any
   * other: every message would be refused the same way. What was claimed
   * and not tried goes back to the queue as it was.
   */
  private async sendQueue(client: Client, now: Date, result: EmailRunResult) {
    if (now.getTime() < this.sendingPausedUntil) {
      result.loginRefused = true;
      return;
    }
    for (;;) {
      if (this.stopping || result.loginRefused) return;
      const claimed = await this.claim(client.id, now);
      for (const [i, row] of claimed.entries()) {
        if (result.loginRefused) {
          await this.release(client.id, claimed.slice(i));
          return;
        }
        const outcome = await this.deliver(client, row, now, result);
        result[outcome] += 1;
      }
      if (claimed.length < BATCH) break;
    }
  }

  /**
   * Puts claimed rows that were not tried back as they were: pending, with
   * the attempt they were claimed for not counted. Only rows still held by
   * this claim.
   */
  private async release(tenantId: string, rows: Claimed[], lastError?: string) {
    await this.inClient(tenantId, async (tx) => {
      for (const row of rows) {
        await tx
          .update(emailQueue)
          .set({
            status: 'pending',
            attempts: sql`${emailQueue.attempts} - 1`,
            claimedUntil: null,
            ...(lastError !== undefined && { lastError }),
          })
          .where(
            and(
              eq(emailQueue.id, row.id),
              eq(emailQueue.status, 'sending'),
              eq(emailQueue.attempts, row.attempts),
            ),
          );
      }
    });
  }

  /**
   * Queues today's digest for every active person who has not switched it
   * off, once a day from DIGEST_HOUR on the client's clock. The day is
   * claimed on the client's settings row, so it is queued once whoever
   * runs. Returns how many were queued.
   */
  private queueDigests(client: Client, now: Date) {
    const day = digestDay(now, client.timeZone, this.digestHour);
    if (!day) return Promise.resolve(0);
    return this.inClient(client.id, async (tx) => {
      // Switched off for the organization: no digest is made.
      if (!(await this.preferences.organizationEnabled(tx))) return 0;
      const claimed = await tx
        .insert(emailSettings)
        .values({ tenantId: client.id, digestsQueuedOn: day })
        .onConflictDoUpdate({
          target: emailSettings.tenantId,
          set: { digestsQueuedOn: day },
          setWhere: sql`${emailSettings.digestsQueuedOn} is null or ${emailSettings.digestsQueuedOn} < ${day}::date`,
        })
        .returning({ tenantId: emailSettings.tenantId });
      if (claimed.length === 0) return 0;
      const off = new Set(
        (
          await tx
            .select({ userId: emailPreferences.userId })
            .from(emailPreferences)
            .where(eq(emailPreferences.digest, false))
        ).map((r) => r.userId),
      );
      const people = (await this.provisioning.activeUserIds(tx)).filter(
        (id) => !off.has(id),
      );
      for (let i = 0; i < people.length; i += 1000) {
        await tx
          .insert(emailQueue)
          .values(
            people.slice(i, i + 1000).map((userId) => ({
              tenantId: client.id,
              userId,
              category: 'daily_digest' as const,
              period: day,
              nextAttemptAt: now,
            })),
          )
          .onConflictDoNothing();
      }
      return people.length;
    });
  }

  /**
   * Claims up to BATCH emails that are due, or whose claim has lapsed. Rows
   * another process holds are passed over, not waited for.
   */
  private claim(tenantId: string, now: Date): Promise<Claimed[]> {
    return this.inClient(tenantId, async (tx) => {
      const due = await tx
        .select({ id: emailQueue.id })
        .from(emailQueue)
        .where(
          and(
            or(
              and(eq(emailQueue.status, 'pending'), lte(emailQueue.nextAttemptAt, now)),
              and(eq(emailQueue.status, 'sending'), lt(emailQueue.claimedUntil, DB_NOW)),
            ),
            // A sign-in code is sent by the request that asks for it, at
            // once, and never again: one left unsent is not the worker's.
            ne(emailQueue.category, 'sign_in_code'),
          ),
        )
        .orderBy(asc(emailQueue.nextAttemptAt), asc(emailQueue.id))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      return tx
        .update(emailQueue)
        .set({
          status: 'sending',
          attempts: sql`${emailQueue.attempts} + 1`,
          // By the database's clock, which every process shares, as is the
          // test of a lapsed claim: no process's own clock moves either.
          claimedUntil: CLAIM_UNTIL,
          updatedAt: now,
        })
        .where(
          inArray(
            emailQueue.id,
            due.map((d) => d.id),
          ),
        )
        .returning({
          id: emailQueue.id,
          userId: emailQueue.userId,
          category: emailQueue.category,
          notificationId: emailQueue.notificationId,
          period: emailQueue.period,
          attempts: emailQueue.attempts,
          createdAt: emailQueue.createdAt,
        }) as Promise<Claimed[]>;
    });
  }

  /** Prepares and sends one claimed email, and records how it ended. */
  private async deliver(
    client: Client,
    row: Claimed,
    now: Date,
    result: EmailRunResult,
  ): Promise<'sent' | 'kept' | 'skipped' | 'retried' | 'givenUp'> {
    try {
      const prepared = await this.prepare(client, row, now);
      if ('skip' in prepared) {
        await this.finish(client.id, row, now, { status: 'skipped', reason: prepared.skip });
        return 'skipped';
      }
      // Still ours, for a whole claim from now: a batch sent one by one to a
      // slow server must not outlast its claim and be taken over midway.
      if (!(await this.renew(client.id, row))) return 'skipped';
      await this.sender.send(prepared.mail);
    } catch (error) {
      const failure = classifySmtpError(error);
      if (failure.stopsSending) {
        // The configuration's, not this email's: it goes back as it was,
        // with no attempt counted (security review 9, finding 2), so that
        // an outage of the login gives up nobody's email. The day-old
        // expiry is the only limit. Nothing is sent for a while.
        if (!result.loginRefused) {
          result.loginRefused = true;
          this.sendingPausedUntil = now.getTime() + PAUSE_AFTER_REFUSAL_MS;
          this.logger.error(
            `Email: the mail server refused the login or to relay (${failure.code}): nothing is sent for ${PAUSE_AFTER_REFUSAL_MS / 60_000} minutes; check SMTP_USER, SMTP_PASSWORD and the relay's settings`,
          );
        }
        await this.release(client.id, [row], failure.code);
        return 'retried';
      }
      return this.failed(client, row, now, failure.code, failure.outcome === 'permanent');
    }
    // Handed over. Should this fail to be recorded, the error goes up and
    // the client is named in the log; the claim lapses and the email is
    // tried again with the same Message-ID, never at once.
    await this.finish(client.id, row, now, { status: 'sent' });
    return this.sender.mode === 'outbox' ? 'kept' : 'sent';
  }

  /** An attempt that failed: tried again later, or given up. */
  private async failed(
    client: Client,
    row: Claimed,
    now: Date,
    code: string,
    permanent: boolean,
  ): Promise<'retried' | 'givenUp'> {
    if (permanent || row.attempts >= MAX_ATTEMPTS) {
      this.logger.warn(
        `Email ${row.id} of client ${client.id} not sent: ${permanent ? 'refused' : `given up after ${row.attempts} attempts`} (${code})`,
      );
      await this.finish(client.id, row, now, {
        status: 'failed',
        reason: permanent ? 'refused' : 'gave_up',
        lastError: code,
      });
      return 'givenUp';
    }
    const wait = BACKOFF_MINUTES[Math.min(row.attempts, BACKOFF_MINUTES.length) - 1];
    await this.finish(client.id, row, now, {
      status: 'pending',
      lastError: code,
      nextAttemptAt: new Date(now.getTime() + wait * 60_000),
    });
    return 'retried';
  }

  /**
   * Extends the claim on a row just before it is sent, if it is still this
   * attempt's. False if another process has taken it over: then it is not
   * sent here.
   */
  private async renew(tenantId: string, row: Claimed) {
    const renewed = await this.inClient(tenantId, (tx) =>
      tx
        .update(emailQueue)
        .set({ claimedUntil: CLAIM_UNTIL })
        .where(
          and(
            eq(emailQueue.id, row.id),
            eq(emailQueue.status, 'sending'),
            eq(emailQueue.attempts, row.attempts),
          ),
        )
        .returning({ id: emailQueue.id }),
    );
    return renewed.length > 0;
  }

  /**
   * Records how an attempt ended, only if the row is still this attempt's:
   * a process whose claim lapsed and was taken over records nothing.
   */
  private finish(
    tenantId: string,
    row: Claimed,
    now: Date,
    outcome: {
      status: 'sent' | 'skipped' | 'failed' | 'pending';
      reason?: string;
      lastError?: string;
      nextAttemptAt?: Date;
    },
  ) {
    return this.inClient(tenantId, (tx) =>
      tx
        .update(emailQueue)
        .set({
          status: outcome.status,
          reason: outcome.reason ?? null,
          ...(outcome.lastError !== undefined && { lastError: outcome.lastError }),
          ...(outcome.nextAttemptAt && { nextAttemptAt: outcome.nextAttemptAt }),
          ...(outcome.status === 'sent' && { sentAt: now }),
          claimedUntil: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(emailQueue.id, row.id),
            eq(emailQueue.status, 'sending'),
            eq(emailQueue.attempts, row.attempts),
          ),
        ),
    );
  }

  /**
   * Whether the email is still to be sent, and if so the email itself.
   * Everything is decided now, not when it was queued: the organization's
   * switch, the person (active, with an address, their switch and their
   * language), the module and the subscription.
   */
  private async prepare(
    client: Client,
    row: Claimed,
    now: Date,
  ): Promise<Prepared> {
    if (row.createdAt.getTime() < now.getTime() - EXPIRES_AFTER_MS) {
      return { skip: 'expired' };
    }
    // The organization's switch and what its subscription gives, read for
    // each email as it is prepared (security review 8, L1): switching email
    // off, a module off or a suspension counts from the next email, not the
    // next run.
    const found = await this.inClient(client.id, async (tx) => {
      const enabled = await this.preferences.organizationEnabled(tx);
      const entitlements = await this.entitlements.of(tx, client.id);
      if (!enabled) return { enabled, entitlements };
      const [mailbox] = await this.provisioning.mailboxesOf(tx, [row.userId]);
      const switches = await this.preferences.switchesOf(tx, row.userId);
      const [notification] = row.notificationId
        ? await tx
            .select({
              kind: notifications.kind,
              data: notifications.data,
              incidentId: notifications.incidentId,
              documentId: notifications.documentId,
            })
            .from(notifications)
            .where(eq(notifications.id, row.notificationId))
        : [];
      // Whether the person triages incidents: some emails are always on
      // for them (business decision 4).
      const { rows: triage } = await tx.execute<{ yes: boolean }>(sql`
        select exists (select from role_assignments ra join roles r on r.id = ra.role_id
          where ra.user_id = ${row.userId} and 'incidents.triage' = any(r.permissions)) as yes`);
      return { enabled, entitlements, mailbox, switches, notification, triages: !!triage[0]?.yes };
    });
    if (!found.enabled) return { skip: 'organization_off' };
    const { entitlements, mailbox, switches, notification } = found;
    if (!mailbox || mailbox.status !== 'active') return { skip: 'inactive' };
    if (!this.deliverable(mailbox.email)) return { skip: 'no_address' };
    const which = switchOf(row.category);
    // Business decision 4: the emails others rely on are sent whatever the
    // person's own switch says.
    const kindOf_ = notification?.kind as NotificationKind | undefined;
    const compulsory =
      row.category === 'immediate' &&
      !!kindOf_ &&
      (COMPULSORY_FOR_ASSIGNEES.includes(kindOf_) ||
        COMPULSORY_FOR_EVERYONE.includes(kindOf_) ||
        (COMPULSORY_FOR_TRIAGERS.includes(kindOf_) && found.triages));
    if (!switches[which] && !compulsory) return { skip: 'opted_out' };

    const locale = localeFor(mailbox.preferredLocale, client);
    const link = (path: string) => `${this.config.webBaseUrl}/${locale}${path}`;
    const suspended = entitlements?.status === 'suspended';

    let content: MailContent;
    if (row.category === 'daily_digest') {
      // Only on its own day, on the client's clock: a digest still unsent
      // (tried again past midnight) is not sent the next day, which has
      // its own.
      if (row.period !== momentIn(now, client.timeZone).slice(0, 10)) {
        return { skip: 'expired' };
      }
      if (!entitlements || entitlements.status === 'cancelled') {
        return { skip: 'module_off' };
      }
      const auth = await this.background.of(client.id, row.userId);
      if (!auth) return { skip: 'inactive' };
      const sections = await this.digest.sectionsFor(auth, link, suspended);
      if (sections.length === 0) return { skip: 'nothing_waiting' };
      content = {
        category: 'daily_digest',
        day: row.period ?? '',
        sections,
        href: link('/dashboard'),
      };
    } else {
      if (!notification) return { skip: 'gone' };
      const kind = notification.kind as NotificationKind;
      if (!allows(entitlements, NOTIFICATION_MODULE[kind])) {
        return { skip: 'module_off' };
      }
      if (suspended && !SAFETY_WHILE_SUSPENDED.includes(kind)) {
        return { skip: 'suspended' };
      }
      const built = this.contentOf(kind, notification, link);
      if (!built) return { skip: 'gone' };
      // While suspended, approval steps wait (they cannot be decided): the
      // weekly email says nothing of them, and goes only for what it has
      // left (quality review 3, S2).
      if (built.category === 'weekly_digest' && suspended) {
        if (built.overdue === 0) return { skip: 'suspended' };
        built.stepsOverdue = 0;
      }
      content = built;
    }

    const token = signUnsubscribe(
      this.config.linkSecret,
      { tenantId: client.id, userId: row.userId, switch: which, locale },
      now,
    );
    const unsubscribe = `${this.config.webBaseUrl}/api/v1/email/unsubscribe/${token}`;
    const rendered = renderMail(content, {
      locale,
      organization: pickText(client.name, locale, client.defaultLocale),
      unsubscribe: { href: unsubscribe, switch: which },
      // The web app's email preferences screen (language review 7, M6).
      preferencesHref: link('/notifications/preferences'),
    });
    const domain = this.config.from.address.split('@')[1] ?? 'localhost';
    return {
      mail: {
        tenantId: client.id,
        queueId: row.id,
        to: mailbox.email,
        ...rendered,
        messageId: `<${row.id}@${domain}>`,
        headers: {
          'List-Unsubscribe': `<${unsubscribe}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          // Not to be answered by an out-of-office reply.
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
          'Content-Language': locale satisfies Locale,
        },
      },
    };
  }

  /**
   * What an email says of its notification: the values the notification
   * carries that an email may say, and the link to what it is about.
   * Nothing else of the notification is read.
   */
  private contentOf(
    kind: NotificationKind,
    notification: {
      data: NotificationData;
      incidentId: string | null;
      documentId: string | null;
    },
    link: (path: string) => string,
  ): MailContent | null {
    const { data } = notification;
    const short = (v: unknown) =>
      typeof v === 'string' && v.length > 0 && v.length <= 80 ? v : null;
    if (kind === 'acknowledgements_overdue_digest') {
      const overdue = Number(data.overdue) || 0;
      return {
        category: 'weekly_digest',
        overdue,
        people: Number(data.people) || 0,
        stepsOverdue: Number(data.stepsOverdue) || 0,
        // Where the late acknowledgements are listed; with none, the list of
        // the overdue approval steps (language review 8, M6).
        href: link(overdue > 0 ? '/policies/overdue' : '/policies/steps/overdue'),
      };
    }
    if (!IMMEDIATE[kind]) return null;
    if (kind === 'signing_pin_changed' || kind === 'signing_pin_locked') {
      const action =
        data.action === 'set' || data.action === 'changed' || data.action === 'reset'
          ? data.action
          : undefined;
      return {
        category: 'immediate',
        kind,
        action,
        href: link('/notifications'),
      };
    }
    if (kind === 'audit_chain_head') {
      const seq = Number(data.seq);
      const hash = typeof data.hash === 'string' && /^[0-9a-f]{64}$/.test(data.hash) ? data.hash : null;
      if (!Number.isSafeInteger(seq) || seq < 1 || !hash) return null;
      return { category: 'immediate', kind, count: seq, hash, href: link('/admin/audit') };
    }
    if (kind === 'review_approval_requested') {
      const number = short(data.number);
      if (!number || !notification.documentId) return null;
      return {
        category: 'immediate',
        kind,
        number,
        href: link(`/policies/${notification.documentId}`),
      };
    }
    if (kind === 'document_step_assigned') {
      const number = short(data.number);
      if (!number || !notification.documentId) return null;
      const versionId = typeof data.versionId === 'string' && UUID.test(data.versionId)
        ? data.versionId
        : null;
      return {
        category: 'immediate',
        kind,
        number,
        version: Number(data.version) || undefined,
        step: data.step === 'approve' ? 'approve' : 'review',
        href: link(
          versionId
            ? `/policies/${notification.documentId}/versions/${versionId}`
            : `/policies/${notification.documentId}`,
        ),
      };
    }
    const reference = short(data.reference);
    if (!reference || !notification.incidentId) return null;
    return {
      category: 'immediate',
      kind: kind as ImmediateKind,
      reference,
      href: link(`/incidents/${notification.incidentId}`),
    };
  }

  /**
   * An address that can be written to. In SMTP mode, not one of a domain
   * that is never anyone's (the demo and test data use them, and a server
   * would only bounce them); the outbox keeps those, since it sends nothing.
   */
  private deliverable(email: string) {
    if (!email || !ADDRESS.test(email)) return false;
    return this.sender.mode === 'outbox' || !RESERVED_DOMAIN.test(email);
  }

  /**
   * For a client Trustline has suspended, which is sent nothing: drops as
   * `expired` what was queued more than EXPIRES_AFTER_MS ago and is not
   * being sent by another process, as sending would. Until then, the
   * client made active again sends it. Returns how many were dropped.
   */
  private expire(tenantId: string, now: Date) {
    return this.inClient(tenantId, async (tx) => {
      const dropped = await tx
        .update(emailQueue)
        .set({ status: 'skipped', reason: 'expired', claimedUntil: null, updatedAt: now })
        .where(
          and(
            lt(emailQueue.createdAt, new Date(now.getTime() - EXPIRES_AFTER_MS)),
            or(
              eq(emailQueue.status, 'pending'),
              and(eq(emailQueue.status, 'sending'), lt(emailQueue.claimedUntil, DB_NOW)),
            ),
          ),
        )
        .returning({ id: emailQueue.id });
      return dropped.length;
    });
  }

  /**
   * Deletes what is finished and older than RETENTION_DAYS, and the copies
   * the outbox kept for as long. A thousand of each at a time.
   */
  private purge(tenantId: string, now: Date) {
    const before = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
    return this.inClient(tenantId, async (tx) => {
      const old = tx
        .select({ id: emailQueue.id })
        .from(emailQueue)
        .where(
          and(
            inArray(emailQueue.status, ['sent', 'skipped', 'failed']),
            lt(emailQueue.updatedAt, before),
          ),
        )
        .limit(1000);
      await tx.delete(emailQueue).where(inArray(emailQueue.id, old));
      const kept = tx
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(lt(emailOutbox.createdAt, before))
        .limit(1000);
      await tx.delete(emailOutbox).where(inArray(emailOutbox.id, kept));
    });
  }
}
