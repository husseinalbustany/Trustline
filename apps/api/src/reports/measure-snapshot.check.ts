import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import { tenants } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { dayOf, startOfDay } from '../i18n/time-zones.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { EntitlementsService } from '../subscriptions/entitlements.service.js';
import { ORGANIZATION_KEY } from './measures.js';
import {
  MeasureSnapshots,
  monthLock,
  monthOf,
  monthsBetween,
  nextMonth,
  type SnapshotModule,
} from './snapshots.service.js';

/** Every fifteen minutes: each client's month ends at its own midnight. */
export const MEASURE_CHECK_EVERY_MS = 15 * 60_000;
/** How long any one statement may take, as for the other checks. */
export const MEASURE_CHECK_STATEMENT_TIMEOUT_MS = 30_000;
/** A month taken this long after it ended is worked out from history. */
export const ON_TIME_MS = 6 * 3_600_000;
/** The most months one run takes for a client and module. */
const MONTHS_PER_RUN = 120;
/**
 * How long one run spends on one client before going on to the next
 * (security review 16, L6): a long backfill is carried on next run, and
 * never holds the other clients' month end past the on-time window.
 */
export const CLIENT_BUDGET_MS = 2 * 60_000;


const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/;
/** The kind of a failure, never its message: see deadline-check.service.ts. */
const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'unknown error';
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const own = (error as { code?: unknown }).code;
  const code = databaseFailure(error)?.code ?? (typeof own === 'string' && ERROR_CODE.test(own) ? own : null);
  return code ? `${name} (${code})` : name;
};

type Client = { id: string; timeZone: string; createdAt: Date };

/**
 * The month-end check of the measures (docs/specs/reports-and-measures.md,
 * "The month-end check"), beside the other checks and built the same way:
 *
 * - **When:** at the first run on or after midnight on the first day of a
 *   month, on the client's calendar, it takes the month just ended, for
 *   each module the client has: every measure, for the organization and
 *   every unit of the month, in one transaction per module and month, so a
 *   month is there whole or not at all, and once (a lock, and the unique
 *   key), whatever the number of API processes.
 * - **On time or not:** taken within six hours of the month's end, the
 *   stock measures are read as the records stand (`snapshot`); later, they
 *   are worked out from the records' history (`reconstructed`).
 * - **Catching up and the backfill:** every month since the module started
 *   (`module_starts`) that has no figures is taken, reconstructed: the
 *   months before this release, and those missed while the check failed or
 *   the client was closed.
 * - **Provisional, then final:** the triage of a month is provisional while
 *   any of its reports is still within its first deadline; the run that
 *   finds it settled adds a final revision.
 * - Clients one at a time, in transactions of their own, no statement over
 *   30 seconds; a client that fails is named in the log with the kind of
 *   failure, and tried again next run. Suspended subscriptions go on: this
 *   reads, and changes nothing of the client's. Started by `main.ts` only;
 *   tests call `run()` with a moment and their own clients.
 */
@Injectable()
export class MeasureSnapshotCheck implements OnModuleDestroy {
  private readonly logger = new Logger(MeasureSnapshotCheck.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;
  statementTimeoutMs = MEASURE_CHECK_STATEMENT_TIMEOUT_MS;
  clientBudgetMs = CLIENT_BUDGET_MS;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly entitlements: EntitlementsService,
    private readonly provisioning: ProvisioningService,
    private readonly snapshots: MeasureSnapshots,
  ) {}

  start(everyMs = MEASURE_CHECK_EVERY_MS, only?: string[]) {
    if (!this.stopped) return;
    this.stopped = false;
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date(), only)
          .catch((error: unknown) => this.logger.error(`Measure check failed: ${kindOf(error)}`))
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

  private async limitStatements(tx: Transaction) {
    await tx.execute(sql`select set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`);
  }

  /** One pass over every active client, as of `now`. */
  async run(now = new Date(), only?: string[]) {
    const clients: Client[] = await this.db.transaction(async (tx) => {
      await this.limitStatements(tx);
      return tx
        .select({ id: tenants.id, timeZone: tenants.timeZone, createdAt: tenants.createdAt })
        .from(tenants)
        .where(only ? inArray(tenants.id, only) : eq(tenants.status, 'active'))
        .orderBy(asc(tenants.id));
    });
    const done = { clients: clients.length, months: 0, finals: 0, failed: 0 };
    for (const client of clients) {
      if (this.stopped && this.current !== undefined) break;
      try {
        const taken = await this.takeClient(client, now);
        done.months += taken.months;
        done.finals += taken.finals;
      } catch (error) {
        done.failed += 1;
        this.logger.error(`Measure check failed for client ${client.id}: ${kindOf(error)}`);
      }
    }
    if (done.months + done.finals + done.failed > 0) {
      const summary = `Measure check: ${done.months} months taken, ${done.finals} made final, ${done.failed} of ${done.clients} clients failed`;
      if (done.failed > 0) this.logger.warn(summary);
      else this.logger.log(summary);
    }
    return done;
  }

  /**
   * Every month due of one client, then the provisional months now settled.
   * A month that fails is named in the log and tried again next run; the
   * client's other months go on (security review 16, L6). Within the
   * client's budget: what is left is carried on next run.
   */
  private async takeClient(client: Client, now: Date) {
    const done = { months: 0, finals: 0 };
    const thisMonth = monthOf(dayOf(now, client.timeZone));
    const until = Date.now() + this.clientBudgetMs;
    let failed: unknown = null;
    for (const module of ['incidents', 'policies'] as SnapshotModule[]) {
      const plan = await this.tenantDb.withTenant(client.id, async (tx) => {
        await this.limitStatements(tx);
        if (!(await this.entitlements.mayUse(tx, client.id, module))) return [];
        const { rows } = await tx.execute<{ started_on: string }>(
          sql`select started_on::text from module_starts where module = ${module}`,
        );
        const start = rows[0]?.started_on ?? dayOf(client.createdAt, client.timeZone);
        const taken = await this.snapshots.takenMonths(tx, module);
        return monthsBetween(start, thisMonth)
          .filter((m) => m < thisMonth && !taken.has(m))
          .slice(-MONTHS_PER_RUN);
      });
      for (const month of plan) {
        if (Date.now() > until) break;
        try {
          if (await this.takeMonth(client, module, month, now)) done.months += 1;
        } catch (error) {
          failed ??= error;
          this.logger.error(`Measure check failed for client ${client.id}, ${module} ${month}: ${kindOf(error)}`);
        }
      }
    }
    done.finals += await this.settle(client, now, until);
    // Counted once for the client, after its other months were taken.
    if (failed) throw failed;
    return done;
  }

  /** One module's month, whole, once. Answers whether it was taken by this run. */
  private takeMonth(client: Client, module: SnapshotModule, month: string, now: Date) {
    return this.tenantDb.withTenant(client.id, async (tx) => {
      await this.limitStatements(tx);
      const { rows: lock } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`trustline.measures.${client.id}.${module}.${month}`}, 0)) as locked`,
      );
      if (!lock[0].locked) return false;
      if ((await this.snapshots.takenMonths(tx, module)).has(month)) return false;
      const asAt = startOfDay(nextMonth(month), client.timeZone);
      const onTime = now.getTime() - asAt.getTime() <= ON_TIME_MS;
      const method = onTime ? ('snapshot' as const) : ('reconstructed' as const);
      const rows = await this.snapshots.compute(tx, { module, month, zone: client.timeZone, history: !onTime, now });
      const stored = await this.snapshots.store(tx, client.id, month, rows, { method });
      await this.provisioning.audit(tx, client.id, null, 'measures_snapshot_taken', 'tenant', client.id, {
        month,
        module,
        method,
        rows: stored.length,
      });
      return true;
    });
  }

  /**
   * The months whose triage was provisional, now settled: every report of
   * the month decided or past its first deadline. A final revision for each
   * row that is now settled.
   */
  private async settle(client: Client, now: Date, until = Infinity) {
    const months = await this.tenantDb.withTenant(client.id, (tx) => this.snapshots.provisionalMonths(tx));
    let finals = 0;
    for (const month of months) {
      if (Date.now() > until) break;
      finals += await this.tenantDb.withTenant(client.id, async (tx) => {
        await this.limitStatements(tx);
        const { rows: lock } = await tx.execute<{ locked: boolean }>(
          sql`select pg_try_advisory_xact_lock(${monthLock(client.id, month)}) as locked`,
        );
        if (!lock[0].locked) return 0;
        const latest = await this.snapshots.latest(tx, month, ['incidents.triaged_on_time']);
        const open = [...latest.values()].filter((r) => r.status === 'provisional');
        if (open.length === 0) return 0;
        // On what the month was taken on: its target, boundaries and
        // structure, never today's (security review 16, M1).
        const takenOn = await this.snapshots.takenOn(tx, month);
        if (!takenOn) return 0;
        const rows = await this.snapshots.compute(tx, {
          module: 'incidents',
          month,
          zone: client.timeZone,
          history: false,
          now,
          onlyUnits: open.map((r) => r.orgUnitId),
          takenOn,
        });
        const settled = rows.filter(
          (r) => r.measure === 'incidents.triaged_on_time' && !r.figure.provisional,
        );
        if (settled.length === 0) return 0;
        const methods = new Map(open.map((r) => [r.orgUnitId ?? ORGANIZATION_KEY, r.method]));
        let stored = 0;
        for (const method of ['snapshot', 'reconstructed', 'corrected'] as const) {
          const mine = settled.filter((r) => methods.get(r.orgUnitId ?? ORGANIZATION_KEY) === method);
          if (mine.length === 0) continue;
          // A correction made final is recomputed as any other month: the
          // correction it settles keeps its own revision and reason.
          stored += (await this.snapshots.store(tx, client.id, month, mine, {
            method: method === 'corrected' ? 'reconstructed' : method,
            status: 'final',
          })).length;
        }
        return stored;
      });
    }
    return finals;
  }
}

