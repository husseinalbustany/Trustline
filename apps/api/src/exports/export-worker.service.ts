import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import { dataExports, tenants } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { Locale } from '../i18n/locales.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { ArchiveBuilder } from './archive.js';
import { authorityOf, DOWNLOAD_DAYS, MAX_DOWNLOADS, tellOfExport } from './exports.service.js';
import { ExportStorage } from './storage.js';

/** How often the worker looks for exports to make, lapse or expire. */
export const EXPORT_WORKER_EVERY_MS = 30_000;
/** Tries of one export: the first, and two more (spec). */
export const MAX_ATTEMPTS = 3;
/** A claim not heard of for this long is taken to be a process that stopped. */
export const STALE_CLAIM_MS = 30 * 60_000;
/** No export is begun past this much of a run (security review 19, L7). */
export const RUN_BUDGET_MS = 10 * 60_000;
/** How often a run says it is still making its export (security review 19, M2). */
export const HEARTBEAT_MS = 60_000;
/** The last download is given this long to finish before the file is deleted. */
const LAST_DOWNLOAD_GRACE_MS = 60 * 60_000;

const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/;
/** The kind of a failure, never its message (as the other checks). */
export const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'unknown error';
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const own = (error as { code?: unknown }).code;
  const code = databaseFailure(error)?.code ?? (typeof own === 'string' && ERROR_CODE.test(own) ? own : null);
  return code ? `${name} (${code})` : name;
};

/**
 * The export worker (docs/specs/data-export.md, "How it is made"), beside
 * the other checks and built the same way: started by `main.ts` only,
 * every 30 seconds, client by client, safe in any number of API processes
 * (`for update skip locked` on the export claimed). For each client:
 *
 * - requests not approved within 7 days lapse;
 * - archives past their last day, or downloaded the most times, are deleted
 *   and the export expires (its record stays);
 * - one approved export is made: claimed, then built outside any
 *   transaction (`ArchiveBuilder`), stored encrypted, and made ready. A
 *   failure records its kind, is tried twice more, then tells the person
 *   who asked and the approver.
 *
 * Every change is audited in its transaction and told as the routes tell.
 */
@Injectable()
export class ExportWorker implements OnModuleDestroy {
  private readonly logger = new Logger(ExportWorker.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;
  /** How long one run goes on beginning exports. */
  runBudgetMs = RUN_BUDGET_MS;
  /** How often a run that is making an export says it still is. */
  heartbeatMs = HEARTBEAT_MS;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly builder: ArchiveBuilder,
    private readonly storage: ExportStorage,
  ) {}

  start(everyMs = EXPORT_WORKER_EVERY_MS) {
    if (!this.stopped) return;
    this.stopped = false;
    this.storage.warn();
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date())
          .catch((error: unknown) => this.logger.error(`Export worker failed: ${kindOf(error)}`))
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

  /** One pass over every client, or these. */
  async run(now = new Date(), only?: string[]) {
    const clients = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(only ? inArray(tenants.id, only) : undefined)
      .orderBy(asc(tenants.id));
    const done = { lapsed: 0, expired: 0, made: 0, failed: 0 };
    // First what is quick, for every client: one long export never holds
    // back another client's lapse or expiry (security review 19, L7).
    for (const client of clients) {
      if (this.stopped && this.current !== undefined) break;
      try {
        done.lapsed += await this.lapse(client.id, now);
        done.expired += await this.expire(client.id, now);
      } catch (error) {
        this.logger.error(`Export worker failed for client ${client.id}: ${kindOf(error)}`);
      }
    }
    // Then the exports, one per client, and none begun past the run's time:
    // what is left is begun next run.
    const until = Date.now() + this.runBudgetMs;
    for (const client of clients) {
      if ((this.stopped && this.current !== undefined) || Date.now() > until) break;
      try {
        const made = await this.make(client.id, now);
        if (made === 'made') done.made += 1;
        if (made === 'failed') done.failed += 1;
      } catch (error) {
        this.logger.error(`Export worker failed for client ${client.id}: ${kindOf(error)}`);
      }
    }
    if (done.lapsed + done.expired + done.made + done.failed > 0) {
      this.logger.log(`Export worker: ${done.made} made, ${done.failed} failed, ${done.lapsed} lapsed, ${done.expired} expired`);
    }
    return done;
  }

  /** Requests past their 7 days, lapsed. */
  private lapse(tenantId: string, now: Date) {
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      const lapsed = await tx
        .update(dataExports)
        .set({ status: 'lapsed', revision: sql`${dataExports.revision} + 1`, updatedAt: sql`now()` })
        .where(and(eq(dataExports.status, 'requested'), lt(dataExports.lapsesAt, now)))
        .returning({ id: dataExports.id, requestedBy: dataExports.requestedBy });
      for (const e of lapsed) {
        await this.provisioning.audit(tx, tenantId, null, 'data_export_lapsed', 'tenant', tenantId, { exportId: e.id });
        await tellOfExport(tx, tenantId, e.id, 'lapsed', [...(await authorityOf(tx)), e.requestedBy]);
      }
      return lapsed.length;
    });
  }

  /** Archives past their last day or their last download: deleted, and the export expired. */
  private async expire(tenantId: string, now: Date) {
    const due = await this.tenantDb.withTenant(tenantId, (tx) =>
      tx
        .select({ id: dataExports.id, storageKey: dataExports.storageKey, expiresAt: dataExports.expiresAt })
        .from(dataExports)
        .where(
          and(
            eq(dataExports.status, 'ready'),
            or(
              lt(dataExports.expiresAt, now),
              and(
                sql`${dataExports.downloads} >= ${MAX_DOWNLOADS}`,
                lt(dataExports.lastDownloadedAt, new Date(now.getTime() - LAST_DOWNLOAD_GRACE_MS)),
              ),
            ),
          ),
        ),
    );
    for (const e of due) {
      // The file first: an export said to be expired never has one left.
      await this.storage.removeFile(e.storageKey);
      await this.storage.removeExport(tenantId, e.id);
      await this.tenantDb.withTenant(tenantId, async (tx) => {
        const [gone] = await tx
          .update(dataExports)
          .set({ status: 'expired', expiredAt: sql`now()`, storageKey: null, wrappedKey: null, revision: sql`${dataExports.revision} + 1`, updatedAt: sql`now()` })
          .where(and(eq(dataExports.id, e.id), eq(dataExports.status, 'ready')))
          .returning({ id: dataExports.id });
        if (!gone) return;
        await this.provisioning.audit(tx, tenantId, null, 'data_export_expired', 'tenant', tenantId, {
          exportId: e.id,
          by: e.expiresAt && e.expiresAt < now ? 'expiry' : 'downloads',
        });
      });
    }
    return due.length;
  }

  /**
   * Claims and makes one approved export of a client: or takes over a claim
   * silent for 30 minutes, within the tries (security review 19, M1); a
   * claim silent at its last try is failed, `stopped`.
   */
  private async make(tenantId: string, now: Date): Promise<'made' | 'failed' | 'retry' | null> {
    const claimed = await this.tenantDb.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(dataExports)
        .where(
          or(
            eq(dataExports.status, 'approved'),
            and(eq(dataExports.status, 'making'), lt(dataExports.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS))),
          ),
        )
        .orderBy(asc(dataExports.approvedAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!row) return null;
      if (row.status === 'making' && row.attempts >= MAX_ATTEMPTS) {
        // Stopped at its last try (a process that ended while making it):
        // not tried again.
        await tx
          .update(dataExports)
          .set({ status: 'failed', phase: null, errorKind: 'stopped', revision: sql`${dataExports.revision} + 1`, updatedAt: sql`now()` })
          .where(eq(dataExports.id, row.id));
        await this.provisioning.audit(tx, tenantId, null, 'data_export_failed', 'tenant', tenantId, {
          exportId: row.id,
          kind: 'stopped',
          attempt: row.attempts,
          final: true,
        });
        await tellOfExport(tx, tenantId, row.id, 'failed', [row.requestedBy, ...(row.approvedBy ? [row.approvedBy] : [])]);
        return { stopped: true as const, id: row.id };
      }
      await tx
        .update(dataExports)
        .set({ status: 'making', claimedAt: sql`now()`, phase: 'data', attempts: row.attempts + 1, errorKind: null, updatedAt: sql`now()` })
        .where(eq(dataExports.id, row.id));
      return { stopped: false as const, job: { ...row, attempts: row.attempts + 1 } };
    });
    if (!claimed) return null;
    if (claimed.stopped) {
      await this.storage.removeExport(tenantId, claimed.id).catch(() => undefined);
      return 'failed';
    }
    const job = claimed.job;
    // Still this run's claim: the export making, at this run's try. Else
    // another run took it over, and this one stops (security review 19, M2).
    const ours = and(eq(dataExports.id, job.id), eq(dataExports.status, 'making'), eq(dataExports.attempts, job.attempts));
    const lost = new AbortController();
    const beat = async (phase?: string) => {
      const [still] = await this.tenantDb.withTenant(tenantId, (tx) =>
        tx
          .update(dataExports)
          .set({ claimedAt: sql`now()`, updatedAt: sql`now()`, ...(phase && { phase }) })
          .where(ours)
          .returning({ id: dataExports.id }),
      );
      if (!still) lost.abort(new Error('claim lost'));
    };
    const heartbeat = setInterval(() => {
      beat().catch(() => undefined);
    }, this.heartbeatMs);
    try {
      const work = await this.storage.workDir(tenantId, job.id, job.attempts);
      const built = await this.builder.build(
        {
          id: job.id,
          tenantId,
          locale: job.locale as Locale,
          reason: job.reason,
          includePdfs: job.includePdfs,
          requestedBy: job.requestedBy,
          approvedBy: job.approvedBy,
          trustline: job.trustlineApprovedAt && job.writtenRequest ? { at: job.trustlineApprovedAt, writtenRequest: job.writtenRequest } : null,
          signal: lost.signal,
        },
        work,
        async (phase) => {
          await beat(phase);
          lost.signal.throwIfAborted();
        },
      );
      lost.signal.throwIfAborted();
      const stored = await this.storage.put(tenantId, job.id, job.attempts, built.zipPath);
      await this.storage.removeAttempt(tenantId, job.id, job.attempts);
      const outcome = await this.tenantDb.withTenant(tenantId, async (tx) => {
        const [made] = await tx
          .update(dataExports)
          .set({
            status: 'ready',
            phase: null,
            snapshotAt: built.snapshotAt,
            counts: built.counts,
            sizeBytes: built.sizeBytes,
            archiveSha256: built.archiveSha256,
            manifestSha256: built.manifestSha256,
            storageKey: stored.storageKey,
            wrappedKey: stored.wrappedKey,
            readyAt: sql`now()`,
            expiresAt: sql`now() + make_interval(days => ${DOWNLOAD_DAYS})`,
            revision: sql`${dataExports.revision} + 1`,
            updatedAt: sql`now()`,
          })
          // Still this run's: cancelled or taken over meanwhile, it is not.
          .where(ours)
          .returning({ id: dataExports.id });
        if (!made) return null;
        await this.provisioning.audit(tx, tenantId, null, 'data_export_ready', 'tenant', tenantId, {
          exportId: job.id,
          archiveSha256: built.archiveSha256,
          sizeBytes: built.sizeBytes,
          counts: built.counts,
        });
        await tellOfExport(tx, tenantId, job.id, 'ready', [...(await authorityOf(tx)), job.requestedBy, ...(job.approvedBy ? [job.approvedBy] : [])]);
        // One archive ready per client (security review 19, L7): one made
        // before this is expired, its file deleted.
        const replaced = await tx
          .update(dataExports)
          .set({ status: 'expired', expiredAt: sql`now()`, storageKey: null, wrappedKey: null, revision: sql`${dataExports.revision} + 1`, updatedAt: sql`now()` })
          .where(and(eq(dataExports.status, 'ready'), ne(dataExports.id, job.id)))
          .returning({ id: dataExports.id });
        for (const r of replaced) {
          await this.provisioning.audit(tx, tenantId, null, 'data_export_expired', 'tenant', tenantId, { exportId: r.id, by: 'replaced' });
        }
        return replaced.map((r) => r.id);
      });
      if (!outcome) {
        await this.storage.removeFile(stored.storageKey);
        return null;
      }
      for (const id of outcome) await this.storage.removeExport(tenantId, id);
      return 'made';
    } catch (error) {
      await this.storage.removeAttempt(tenantId, job.id, job.attempts).catch(() => undefined);
      if (lost.signal.aborted) {
        // Taken over: the run that has it now goes on.
        this.logger.warn(`Export ${job.id} of client ${tenantId}: claim lost at attempt ${job.attempts}`);
        return null;
      }
      const kind = kindOf(error);
      this.logger.error(`Export ${job.id} of client ${tenantId} failed (attempt ${job.attempts}): ${kind}`);
      const final = job.attempts >= MAX_ATTEMPTS;
      await this.tenantDb.withTenant(tenantId, async (tx) => {
        const [still] = await tx
          .update(dataExports)
          .set({
            status: final ? 'failed' : 'approved',
            phase: null,
            errorKind: kind,
            ...(final && { revision: sql`${dataExports.revision} + 1` }),
            updatedAt: sql`now()`,
          })
          .where(ours)
          .returning({ id: dataExports.id });
        if (!still) return;
        await this.provisioning.audit(tx, tenantId, null, 'data_export_failed', 'tenant', tenantId, {
          exportId: job.id,
          kind,
          attempt: job.attempts,
          final,
        });
        if (final) await tellOfExport(tx, tenantId, job.id, 'failed', [job.requestedBy, ...(job.approvedBy ? [job.approvedBy] : [])]);
      });
      return final ? 'failed' : 'retry';
    } finally {
      clearInterval(heartbeat);
    }
  }
}
