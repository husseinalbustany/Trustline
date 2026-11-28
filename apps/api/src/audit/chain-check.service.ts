import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { asc, desc, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import {
  auditChainCheckpoints,
  auditChainHeads,
  auditChainVerifications,
  notifications,
  tenants,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { dayOf, momentIn } from '../i18n/time-zones.js';
import { AccessService } from '../identity/access.service.js';
import { AuditKeys } from './audit-keys.js';
import {
  bodyOf,
  GENESIS_HASH,
  ipCommitmentOf,
  linkHash,
  sha256,
} from './chain.js';

/** Every fifteen minutes; each client is checked once a day. */
export const AUDIT_CHECK_EVERY_MS = 15 * 60_000;
/** The hour of the day, on the client's clock, from which it is checked. */
export const AUDIT_CHECK_HOUR = 2;
/** Entries checked per statement. */
const BATCH = 10_000;
/** How long any one statement may take, as for the other checks. */
export const AUDIT_CHECK_STATEMENT_TIMEOUT_MS = 30_000;
/** The slack for an entry's time against a checkpoint, and for sealing. */
const SLACK_MS = 10 * 60_000;
/** A full check at least this often. */
const FULL_EVERY_MS = 7 * 24 * 3_600_000 - 12 * 3_600_000;

export type ChainBreak =
  (typeof auditChainVerifications.kind.enumValues)[number];

export type ChainCheck = {
  tenantId: string;
  result: 'passed' | 'failed';
  full: boolean;
  fromSeq: number;
  toSeq: number;
  kind: ChainBreak | null;
  firstBadSeq: number | null;
  firstBadEntryId: string | null;
  /** Whether the checkpoint made on success is signed. */
  signed: boolean;
};

const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/;
/** The kind of a failure, never its message: see deadline-check.service.ts. */
const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'unknown error';
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const own = (error as { code?: unknown }).code;
  const code =
    databaseFailure(error)?.code ??
    (typeof own === 'string' && ERROR_CODE.test(own) ? own : null);
  return code ? `${name} (${code})` : name;
};

type Row = {
  seq: string;
  entry_id: string;
  prev_hash: string;
  body_hash: string;
  hash: string;
  ip_commitment: string | null;
  id: string | null;
  tenant_id: string | null;
  occurred_at: string | null;
  occurred_ms: string | null;
  actor_id: string | null;
  action: string | null;
  entity_type: string | null;
  entity_id: string | null;
  changes: string | null;
  ip_address: string | null;
  ip_salt: string | null;
};

class Broken extends Error {
  constructor(
    readonly kind: ChainBreak,
    readonly seq: number | null,
    readonly entryId: string | null = null,
  ) {
    super(kind);
  }
}

/**
 * The daily verification of each client's audit chain
 * (docs/specs/audit-trail.md, "The daily verification"), beside the other
 * checks and built the same way:
 *
 * - **When:** at the first run after 02:00 on the client's calendar, once a
 *   day; from the last signed checkpoint, and from entry 1 at least once a
 *   week. Every client, suspended or not: what was recorded is checked
 *   whatever the subscription.
 * - **What:** every seal from there to the head, rebuilt here from the
 *   entries (`chain.ts`), not by the database's functions; the links; the
 *   numbers; that every seal has its entry and every entry older than ten
 *   minutes its seal; that the head reaches, and matches, every signed
 *   checkpoint; and that no entry is dated more than ten minutes before the
 *   checkpoint before it.
 * - **On success:** a checkpoint of the head, signed with Trustline's key
 *   (`AuditKeys`), or unsigned without one.
 * - **On failure:** the result says the kind and the first entry found
 *   wrong; the server log names the client and the kind, nothing of any
 *   entry; Trustline's own log says it (`audit_chain_broken`); and the
 *   client's holders of `audit.view` and `settings.manage` are told at once
 *   in the app, the first time it is found.
 *
 * Each client in one transaction, under a lock of its own, so that two API
 * processes never check it at once; no statement over 30 seconds. Started
 * by `main.ts` only; tests call `verify()`.
 */
@Injectable()
export class AuditChainCheck implements OnModuleDestroy {
  private readonly logger = new Logger(AuditChainCheck.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;
  statementTimeoutMs = AUDIT_CHECK_STATEMENT_TIMEOUT_MS;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly keys: AuditKeys,
    private readonly access: AccessService,
  ) {}

  start(everyMs = AUDIT_CHECK_EVERY_MS, only?: string[]) {
    if (!this.stopped) return;
    this.stopped = false;
    // Said once: the name of what is missing, never a value.
    if (this.keys.problem) this.logger.warn(this.keys.problem);
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date(), only)
          .catch((error: unknown) => {
            this.logger.error(`Audit chain check failed: ${kindOf(error)}`);
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

  /** One pass: every client due for its daily check, as of `now`. */
  async run(now = new Date(), only?: string[]) {
    const clients = await this.db.transaction(async (tx) => {
      await this.limitStatements(tx);
      return tx
        .select({ id: tenants.id, timeZone: tenants.timeZone })
        .from(tenants)
        .where(only ? inArray(tenants.id, only) : undefined)
        .orderBy(asc(tenants.id));
    });
    const done = { checked: 0, broken: 0, failed: 0 };
    for (const client of clients) {
      if (this.stopped && this.current !== undefined) break;
      if (Number(momentIn(now, client.timeZone).slice(11, 13)) < AUDIT_CHECK_HOUR) continue;
      try {
        const result = await this.verify(client.id, { now, scheduled: client.timeZone });
        if (!result) continue;
        done.checked += 1;
        if (result.result === 'failed') done.broken += 1;
      } catch (error) {
        done.failed += 1;
        this.logger.error(`Audit chain check failed for client ${client.id}: ${kindOf(error)}`);
      }
    }
    if (done.checked + done.failed > 0) {
      const summary = `Audit chain check: ${done.checked} clients checked, ${done.broken} broken, ${done.failed} failed${this.keys.signer ? '' : ', checkpoints unsigned'}`;
      if (done.broken + done.failed > 0) this.logger.warn(summary);
      else this.logger.log(summary);
    }
    return done;
  }

  private async limitStatements(tx: Transaction) {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`,
    );
  }

  /**
   * Checks one client's chain and records the result. `full` checks from
   * entry 1. `scheduled` (the client's time zone) makes it the daily run:
   * nothing is done if the client was checked today on its calendar, and
   * it is full if no full check was made in the last week. Answers null
   * when nothing was done (checked already, or being checked elsewhere).
   */
  verify(
    tenantId: string,
    options: { full?: boolean; now?: Date; scheduled?: string } = {},
  ): Promise<ChainCheck | null> {
    const now = options.now ?? new Date();
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      await this.limitStatements(tx);
      const { rows: lock } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`trustline.audit-chain.${tenantId}`}, 0)) as locked`,
      );
      if (!lock[0].locked) return null;
      const runs = await tx
        .select({ runAt: auditChainVerifications.runAt, full: auditChainVerifications.full, result: auditChainVerifications.result })
        .from(auditChainVerifications)
        .orderBy(desc(auditChainVerifications.runAt))
        .limit(50);
      let full = options.full ?? false;
      if (options.scheduled) {
        const zone = options.scheduled;
        if (runs.some((r) => dayOf(r.runAt, zone) === dayOf(now, zone))) return null;
        full ||= !runs.some((r) => r.full && now.getTime() - r.runAt.getTime() < FULL_EVERY_MS);
      }
      const check = await this.check(tx, tenantId, full, now);
      await this.record(tx, tenantId, check, now, runs[0]?.result ?? null);
      return check;
    });
  }

  /** The check itself, in the client's transaction. Records nothing. */
  private async check(tx: Transaction, tenantId: string, full: boolean, now: Date) {
    const [head] = await tx
      .select({ seq: auditChainHeads.seq, hash: auditChainHeads.hash })
      .from(auditChainHeads);
    const headSeq = head?.seq ?? 0;
    const headHash = head?.hash ?? GENESIS_HASH;
    const checkpoints = await tx
      .select()
      .from(auditChainCheckpoints)
      .orderBy(asc(auditChainCheckpoints.seq), asc(auditChainCheckpoints.at));
    const base = { tenantId, full, toSeq: headSeq, signed: false };
    let fromSeq = 1;
    try {
      // The checkpoints this API can trust: signed under a key it knows.
      const trusted: { seq: number; hash: string; at: Date }[] = [];
      for (const cp of checkpoints) {
        const state = this.keys.check({ ...cp, tenantId });
        if (state === 'invalid') throw new Broken('bad_checkpoint', cp.seq);
        if (state === 'valid') trusted.push({ seq: cp.seq, hash: cp.hash, at: cp.at });
      }
      const last = trusted.at(-1);
      if (last && headSeq < last.seq) throw new Broken('head_rewound', headSeq + 1);
      fromSeq = full || !last ? 1 : last.seq;
      // The trusted checkpoints by number, and the latest one before each
      // entry, for the time check.
      const bySeq = new Map(trusted.map((cp) => [cp.seq, cp]));
      let before = 0;
      const latestBefore = (seq: number) => {
        while (before + 1 < trusted.length && trusted[before + 1].seq < seq) before++;
        return trusted[before] && trusted[before].seq < seq ? trusted[before] : undefined;
      };

      let expected = fromSeq;
      let prev: string | null = fromSeq === 1 ? GENESIS_HASH : null;
      for (let from = fromSeq; from <= headSeq; from += BATCH) {
        const { rows } = await tx.execute<Row>(sql`
          select c.seq::text as seq, c.entry_id, c.prev_hash, c.body_hash, c.hash, c.ip_commitment,
                 e.id, e.tenant_id::text as tenant_id,
                 to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
                 (extract(epoch from e.occurred_at) * 1000)::bigint::text as occurred_ms,
                 e.actor_id::text as actor_id, e.action, e.entity_type, e.entity_id::text as entity_id,
                 e.changes::text as changes, e.ip_address, e.ip_salt
          from audit_chain c
          left join audit_log e on e.id = c.entry_id and e.tenant_id = c.tenant_id
          where c.seq between ${from} and ${Math.min(from + BATCH - 1, headSeq)}
          order by c.seq`);
        for (const row of rows) {
          const seq = Number(row.seq);
          if (seq !== expected) throw new Broken('gap', expected);
          if (row.id === null) throw new Broken('missing_entry', seq, row.entry_id);
          // Its address, while kept, is the one committed to.
          if (row.ip_address !== null && ipCommitmentOf(row.ip_salt, row.ip_address) !== row.ip_commitment) {
            throw new Broken('content_changed', seq, row.id);
          }
          const body = bodyOf(
            {
              id: row.id,
              tenantId: row.tenant_id!,
              occurredAt: row.occurred_at!,
              actorId: row.actor_id,
              action: row.action!,
              entityType: row.entity_type,
              entityId: row.entity_id,
              changes: row.changes,
            },
            seq,
            row.ip_commitment,
          );
          if (sha256(body) !== row.body_hash) throw new Broken('content_changed', seq, row.id);
          if (prev !== null && row.prev_hash !== prev) throw new Broken('content_changed', seq, row.id);
          if (linkHash(seq, row.prev_hash, row.body_hash) !== row.hash) {
            throw new Broken('content_changed', seq, row.id);
          }
          const signed = bySeq.get(seq);
          if (signed && signed.hash !== row.hash) throw new Broken('head_rewound', seq, row.id);
          const cp = latestBefore(seq);
          if (cp && Number(row.occurred_ms) < cp.at.getTime() - SLACK_MS) {
            throw new Broken('backdated', seq, row.id);
          }
          prev = row.hash;
          expected = seq + 1;
        }
        if (rows.length === 0) break;
      }
      if (expected !== headSeq + 1) throw new Broken('gap', expected);
      if (headSeq > 0 && prev !== headHash) throw new Broken('content_changed', headSeq);
      // Seals past the head: written round the sealing function.
      const { rows: past } = await tx.execute<{ seq: string }>(
        sql`select min(seq)::text as seq from audit_chain where seq > ${headSeq}`,
      );
      if (past[0].seq !== null) throw new Broken('content_changed', Number(past[0].seq));
      // Entries with no seal, older than the slack: written round the
      // trigger. Since the last signed checkpoint daily, all of them weekly.
      const since = !full && last ? new Date(last.at.getTime() - SLACK_MS) : null;
      const { rows: unsealed } = await tx.execute<{ id: string }>(sql`
        select e.id from audit_log e
        where not exists (select from audit_chain c where c.tenant_id = e.tenant_id and c.entry_id = e.id)
          and e.occurred_at < ${new Date(now.getTime() - SLACK_MS)}
          ${since ? sql`and e.occurred_at >= ${since}` : sql``}
        order by e.occurred_at, e.id
        limit 1`);
      if (unsealed.length > 0) throw new Broken('missing_seal', null, unsealed[0].id);
    } catch (error) {
      if (!(error instanceof Broken)) throw error;
      return {
        ...base,
        fromSeq,
        result: 'failed' as const,
        kind: error.kind,
        firstBadSeq: error.seq,
        firstBadEntryId: error.entryId,
      };
    }
    return {
      ...base,
      fromSeq: Math.min(fromSeq, headSeq),
      result: 'passed' as const,
      kind: null,
      firstBadSeq: null,
      firstBadEntryId: null,
      head: { seq: headSeq, hash: headHash },
    };
  }

  /** The result, a checkpoint on success, and the notices of a break. */
  private async record(
    tx: Transaction,
    tenantId: string,
    check: Awaited<ReturnType<AuditChainCheck['check']>>,
    now: Date,
    previous: 'passed' | 'failed' | null,
  ) {
    let checkpointId: string | null = null;
    if (check.result === 'passed' && 'head' in check && check.head.seq > 0) {
      // To the millisecond: what is signed is what is stored.
      const at = new Date(now.getTime());
      const signed = this.keys.sign({ tenantId, seq: check.head.seq, hash: check.head.hash, at });
      const [cp] = await tx
        .insert(auditChainCheckpoints)
        .values({ tenantId, seq: check.head.seq, hash: check.head.hash, at, ...signed })
        .returning({ id: auditChainCheckpoints.id });
      checkpointId = cp.id;
      check.signed = signed.signature !== null;
    }
    await tx.insert(auditChainVerifications).values({
      tenantId,
      runAt: now,
      fromSeq: check.fromSeq,
      toSeq: check.toSeq,
      full: check.full,
      result: check.result,
      kind: check.kind,
      firstBadSeq: check.firstBadSeq,
      firstBadEntryId: check.firstBadEntryId,
      checkpointId,
    });
    if (check.result === 'passed') return;
    // The client and the kind, nothing of any entry.
    this.logger.error(`Audit chain of client ${tenantId} is broken: ${check.kind}`);
    await tx.execute(
      sql`select audit_chain_report_break(${tenantId}::uuid, ${check.kind}::audit_chain_break, ${check.firstBadSeq}::bigint, ${check.firstBadEntryId}::uuid)`,
    );
    // Told once, when it is first found, not on every day it stays broken.
    if (previous === 'failed') return;
    const holders = await this.access.holders(tx, ['audit.view', 'settings.manage'], []);
    const to = new Set([...holders.everywhere('audit.view'), ...holders.everywhere('settings.manage')]);
    if (to.size === 0) return;
    await tx.insert(notifications).values(
      [...to].map((userId) => ({
        tenantId,
        userId,
        kind: 'audit_chain_broken' as const,
        data: {
          kind: check.kind!,
          ...(check.firstBadSeq !== null && { firstBadSeq: check.firstBadSeq }),
          serious: true,
        },
      })),
    );
  }
}
