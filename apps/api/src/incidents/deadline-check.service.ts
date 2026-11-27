import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import { incidents, tenants } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { Notifier, type Announcement } from './notifier.js';
import { closeDueAt, triageDueAt } from './response-rules.js';
import { ResponseRulesService } from './response-rules.service.js';
import { DEADLINE_LIVE_IN, DUE_SOON_SHARE, type Deadline } from './status.js';

export const CHECK_EVERY_MS = 5 * 60_000;
/** Incidents announced in one transaction. */
const BATCH = 100;
/**
 * How long any one statement of the check may take, waiting for a lock
 * included, before the database gives it up. The next run starts only when
 * this one has ended, so without a limit one statement that never returns
 * would end the check for every hospital, silently.
 */
export const CHECK_STATEMENT_TIMEOUT_MS = 30_000;

// An error class of the database (57014) or of the system (ECONNREFUSED).
const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/;

/**
 * What may be logged of a failure: the kind of error and, where it has one,
 * its error class: the database's for a query it refused (57014 is a
 * statement that ran out of time), the system's for a connection that could
 * not be had. Never the error's message, which can hold a statement's values.
 */
const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'unknown error';
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const own = (error as { code?: unknown }).code;
  const code =
    databaseFailure(error)?.code ??
    (typeof own === 'string' && ERROR_CODE.test(own) ? own : null);
  return code ? `${name} (${code})` : name;
};

/** What one run of the check did. */
export type CheckResult = {
  /** Whether the list of hospitals could be read at all. */
  listed: boolean;
  /** Active hospitals found. */
  hospitals: number;
  /** Hospitals whose check failed; the next run tries them again. */
  failed: number;
  /** Notifications written. */
  notified: number;
  /** Incidents given the deadlines an older release stored them without. */
  filled: number;
};

type Mark = {
  /** When it was announced. */
  at:
    'triageDueSoonAt' | 'triageOverdueAt' | 'closeDueSoonAt' | 'closeOverdueAt';
  /**
   * For a deadline that can move (closing): which deadline it was announced
   * for. A deadline is announced only if it is later than that one.
   */
  for?: 'closeDueSoonFor' | 'closeOverdueFor';
};

type Stage = {
  deadline: Deadline;
  kind: 'due_soon' | 'overdue';
  /** The deadline itself. */
  dueAt: 'triageDueAt' | 'closeDueAt';
  /** When the time allowed for it started to run, if not at the report. */
  from?: 'closeDueFrom';
  /** Where it is recorded that this was announced. */
  announced: Mark;
  /** For "overdue": where "due soon" is recorded, which it makes pointless. */
  supersedes?: Mark;
};

// "Overdue" before "due soon" for each deadline. An incident found already
// past its deadline is announced as overdue and its "due soon" is recorded as
// sent with it, so nobody is told the lesser thing after the greater.
const TRIAGE_SOON: Mark = { at: 'triageDueSoonAt' };
const CLOSE_SOON: Mark = { at: 'closeDueSoonAt', for: 'closeDueSoonFor' };
const STAGES: Stage[] = [
  {
    deadline: 'triage',
    kind: 'overdue',
    dueAt: 'triageDueAt',
    announced: { at: 'triageOverdueAt' },
    supersedes: TRIAGE_SOON,
  },
  {
    deadline: 'triage',
    kind: 'due_soon',
    dueAt: 'triageDueAt',
    announced: TRIAGE_SOON,
  },
  {
    deadline: 'closure',
    kind: 'overdue',
    dueAt: 'closeDueAt',
    from: 'closeDueFrom',
    announced: { at: 'closeOverdueAt', for: 'closeOverdueFor' },
    supersedes: CLOSE_SOON,
  },
  {
    deadline: 'closure',
    kind: 'due_soon',
    dueAt: 'closeDueAt',
    from: 'closeDueFrom',
    announced: CLOSE_SOON,
  },
];

/**
 * Whether the incident's deadline, where it now is, is still to be
 * announced at this mark: nothing was, or what was was for an earlier
 * deadline. The triage deadline never moves, so once is once. A time set
 * without the deadline it was for (by a release that did not record it)
 * counts as set for the deadline the incident has.
 */
const unannounced = (mark: Mark, dueAt: SQLWrapper) =>
  mark.for
    ? sql`(${incidents[mark.at]} is null or ${dueAt} > coalesce(${incidents[mark.for]}, ${dueAt}))`
    : isNull(incidents[mark.at]);

/** Records a mark as announced now, for the deadline the incident has. */
const marked = (mark: Mark, dueAt: SQLWrapper, now: Date) => ({
  [mark.at]: now,
  ...(mark.for && { [mark.for]: dueAt }),
});

/**
 * The background check behind the `due_soon` and `overdue` notifications.
 *
 * Every five minutes it goes through the active hospitals one at a time,
 * each in transactions of its own inside `TenantDb.withTenant`, and
 * announces every deadline that has entered its last quarter or has passed.
 *
 * **Once per incident per deadline, with any number of API processes.** An
 * incident is announced by whoever claims it: the claim is its row, locked
 * and marked as announced, in the same transaction that writes the
 * notifications. A second process looking at the same moment skips the
 * locked rows; one looking a moment later finds them marked. If the
 * transaction fails, the mark goes with the notifications and the next run
 * tries again. No process needs to know of any other.
 *
 * **Not started by the application itself.** `main.ts` starts it, so a test
 * that builds the application gets no timer; tests call `run()` or
 * `checkHospital()` directly, with the moment to check as of.
 */
@Injectable()
export class DeadlineCheck implements OnModuleDestroy {
  private readonly logger = new Logger(DeadlineCheck.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;
  /** See CHECK_STATEMENT_TIMEOUT_MS. A field so that a test can shorten it. */
  statementTimeoutMs = CHECK_STATEMENT_TIMEOUT_MS;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly rules: ResponseRulesService,
    private readonly notifier: Notifier,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * Starts checking: once shortly after start, then every `everyMs` counted
   * from the end of the run before, so two runs of one process never overlap.
   * Every active hospital, as `main.ts` starts it; `only` is for tests, as
   * in `run()`.
   */
  start(everyMs = CHECK_EVERY_MS, only?: string[]) {
    if (!this.stopped) return;
    this.stopped = false;
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date(), only)
          // run() does not throw; this is for the unforeseen, which is
          // said too: a check that fails must not fail in silence.
          .catch((error: unknown) => {
            this.logger.error(`Deadline check failed: ${kindOf(error)}`);
          })
          .finally(() => {
            this.current = undefined;
            if (!this.stopped) next(everyMs);
          });
      }, delay);
    };
    next(Math.min(everyMs, 1_000));
  }

  /**
   * Stops checking and waits for a run in progress to finish the hospital it
   * is on. Nothing is lost by stopping: what was not announced is found by
   * the next run, here or in another process.
   */
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  /** On shutdown, before the database connections are closed. */
  async onModuleDestroy() {
    await this.stop();
  }

  /** Whether the timer is set or a run is in progress. */
  get active() {
    return this.timer !== undefined || this.current !== undefined;
  }

  /**
   * One pass over every active hospital. A suspended hospital is left
   * alone: nobody there can sign in to read a notification. Its deadlines
   * are announced, once, when it is active again.
   *
   * One hospital failing does not stop the others, and no failure passes
   * unsaid. What is logged is the hospital's id and the kind of failure,
   * never anything from a record. A run that did something says so in one
   * line; one that found nothing to do says nothing.
   *
   * `only` narrows the pass to the hospitals with these ids. The API never
   * passes it: it is there so that a test, which shares its database with
   * hospitals it did not make and may check as of a moment that is not now,
   * announces nothing to anyone else's.
   */
  async run(now = new Date(), only?: string[]): Promise<CheckResult> {
    const result: CheckResult = {
      listed: false,
      hospitals: 0,
      failed: 0,
      notified: 0,
      filled: 0,
    };
    let hospitals: { id: string; timeZone: string }[];
    try {
      // The list of clients is not hospital data: the application role reads
      // it outside any hospital, as sign-in does.
      hospitals = await this.db.transaction(async (tx) => {
        await this.limitStatements(tx);
        return tx
          .select({ id: tenants.id, timeZone: tenants.timeZone })
          .from(tenants)
          .where(
            and(
              eq(tenants.status, 'active'),
              only ? inArray(tenants.id, only) : undefined,
            ),
          )
          .orderBy(asc(tenants.id));
      });
    } catch (error) {
      this.logger.error(
        `Deadline check failed before any hospital was checked: ${kindOf(error)}`,
      );
      return result;
    }
    result.listed = true;
    result.hospitals = hospitals.length;
    for (const hospital of hospitals) {
      if (this.stopping) break;
      try {
        const done = await this.check(hospital, now);
        result.notified += done.notified;
        result.filled += done.filled;
      } catch (error) {
        result.failed += 1;
        if (this.stopping) break;
        this.logger.error(
          `Deadline check failed for hospital ${hospital.id}: ${kindOf(error)}`,
        );
      }
    }
    if (result.notified > 0 || result.filled > 0 || result.failed > 0) {
      const summary = `Deadline check: ${result.notified} notifications written, ${result.filled} incidents given their deadlines, ${result.failed} of ${result.hospitals} hospitals failed`;
      if (result.failed > 0) this.logger.warn(summary);
      else this.logger.log(summary);
    }
    return result;
  }

  /** Asked to stop while a run is in progress. */
  private get stopping() {
    return this.stopped && this.current !== undefined;
  }

  /**
   * A transaction for one hospital in which no statement may take longer
   * than the check allows.
   */
  private inHospital<T>(tenantId: string, fn: (tx: Transaction) => Promise<T>) {
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      await this.limitStatements(tx);
      return fn(tx);
    });
  }

  /** For the rest of this transaction only. */
  private async limitStatements(tx: Transaction) {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`,
    );
  }

  /**
   * Announces what is due in one hospital as of `now`, and returns how many
   * notifications that made. Several short transactions, never one long one.
   */
  async checkHospital(hospital: { id: string; timeZone: string }, now: Date) {
    return (await this.check(hospital, now)).notified;
  }

  private async check(hospital: { id: string; timeZone: string }, now: Date) {
    const filled = await this.fillMissingDeadlines(hospital);
    let notified = 0;
    for (const stage of STAGES) {
      // Until a batch comes back short: nothing more is due at this stage.
      for (let claimed = BATCH; claimed === BATCH;) {
        if (this.stopping) return { notified, filled };
        const done = await this.announce(hospital.id, stage, now);
        claimed = done.claimed;
        notified += done.notified;
      }
    }
    return { notified, filled };
  }

  /**
   * One batch of one stage: claims up to BATCH incidents whose moment has
   * come and that nobody has announced, and writes their notifications, all
   * in one transaction.
   */
  private announce(tenantId: string, stage: Stage, now: Date) {
    const dueAt = incidents[stage.dueAt];
    // When to announce: at the deadline, or a quarter of the allowed time
    // (from the report, or the reopening, to the deadline) before it.
    const from = stage.from
      ? sql`coalesce(${incidents[stage.from]}, ${incidents.reportedAt})`
      : sql`${incidents.reportedAt}`;
    const moment: SQL =
      stage.kind === 'overdue'
        ? sql`${dueAt}`
        : sql`${dueAt} - (${dueAt} - ${from}) * ${DUE_SOON_SHARE}::float8`;
    const toAnnounce = unannounced(stage.announced, dueAt);
    const due = and(
      // Only while the deadline is live: an incident already triaged has no
      // triage deadline to miss, a closed one no closure deadline.
      inArray(incidents.status, DEADLINE_LIVE_IN[stage.deadline]),
      toAnnounce,
      lte(moment, now),
    );
    return this.inHospital(tenantId, async (tx) => {
      // The claim. Rows another process holds are passed over, not waited
      // for; a row it released a moment ago is read again as it now is, and
      // no longer matches. Whoever holds the row is the one to announce it.
      const mine = await tx
        .select({ id: incidents.id })
        .from(incidents)
        .where(due)
        .orderBy(asc(dueAt), asc(incidents.id))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      if (mine.length === 0) return { claimed: 0, notified: 0 };
      // Announced now, for the deadline it has; and an overdue deadline is
      // no longer due soon, which is recorded as said with it unless it was
      // said already for this deadline.
      const soon = stage.supersedes;
      const claimed = await tx
        .update(incidents)
        .set({
          ...marked(stage.announced, sql`${dueAt}`, now),
          ...(soon && {
            [soon.at]: sql`case when ${unannounced(soon, dueAt)} then ${now.toISOString()}::timestamptz else ${incidents[soon.at]} end`,
            ...(soon.for && {
              [soon.for]: sql`greatest(${incidents[soon.for]}, ${dueAt})`,
            }),
          }),
        })
        .where(
          and(
            inArray(
              incidents.id,
              mine.map((i) => i.id),
            ),
            toAnnounce,
          ),
        )
        .returning({
          id: incidents.id,
          reference: incidents.reference,
          orgUnitId: incidents.orgUnitId,
          ownerUnitId: incidents.ownerUnitId,
          assignedTo: incidents.assignedTo,
          reportedBy: incidents.reportedBy,
          harmLevel: incidents.harmLevel,
          isSentinel: incidents.isSentinel,
          status: incidents.status,
          closureRequestedBy: incidents.closureRequestedBy,
        });

      const notified = await this.notifier.sendAll(
        tx,
        tenantId,
        claimed.map(({ status, closureRequestedBy, ...incident }): Announcement => ({
          incident,
          actorId: null,
          drafts: (who) => {
            const triagers = who.mayTriage([
              incident.orgUnitId,
              incident.ownerUnitId,
            ]);
            // For triage: those who may triage it. For closure: the
            // person it is assigned to, or those who may triage it when
            // nobody is, or that person has left.
            const responsible =
              stage.deadline === 'closure'
                ? { to: [incident.assignedTo], orElse: triagers }
                : { to: triagers };
            return [
              {
                kind: stage.kind,
                data: { deadline: stage.deadline },
                internal: true,
                ...responsible,
              },
              // A missed deadline also goes to everyone who may triage
              // for the whole organization. Someone already told is not
              // told twice.
              ...(stage.kind === 'overdue'
                ? [
                    {
                      kind: stage.kind,
                      data: { deadline: stage.deadline },
                      internal: true,
                      to: who.mayTriageEverywhere(),
                    },
                  ]
                : []),
              // A closure that passes its deadline while it waits for the
              // second signature waits on those who may give it: they are
              // told too, but for the one who asked, who cannot.
              ...(stage.kind === 'overdue' && status === 'awaiting_sign_off'
                ? [
                    {
                      kind: stage.kind,
                      data: { deadline: stage.deadline },
                      internal: true,
                      to: [...who.maySignOff()].filter(
                        (id) => id !== closureRequestedBy,
                      ),
                    },
                  ]
                : []),
            ];
          },
        })),
      );
      return { claimed: mine.length, notified };
    });
  }

  /**
   * Gives its deadlines to any incident stored without them. Every report
   * gets them when it is made; this is for one stored by a release that did
   * not know of deadlines yet, still running while a new one is deployed.
   * Counted from when it was reported, under the rules as they are now.
   * Returns how many it filled in.
   */
  private async fillMissingDeadlines(hospital: {
    id: string;
    timeZone: string;
  }) {
    return this.inHospital(hospital.id, async (tx) => {
      const missing = await tx
        .select({
          id: incidents.id,
          reportedAt: incidents.reportedAt,
          harmLevel: incidents.harmLevel,
          isSentinel: incidents.isSentinel,
          triageDueAt: incidents.triageDueAt,
          closeDueAt: incidents.closeDueAt,
          closeDueFrom: incidents.closeDueFrom,
        })
        .from(incidents)
        .where(or(isNull(incidents.triageDueAt), isNull(incidents.closeDueAt)))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      if (missing.length === 0) return 0;
      const rules = await this.rules.inForce(tx);
      for (const incident of missing) {
        const set = {
          ...(incident.triageDueAt === null && {
            triageDueAt: triageDueAt(incident.reportedAt, incident, rules),
          }),
          ...(incident.closeDueAt === null && {
            closeDueAt: closeDueAt(
              incident.closeDueFrom ?? incident.reportedAt,
              incident,
              rules,
              hospital.timeZone,
            ),
          }),
        };
        await tx
          .update(incidents)
          .set(set)
          .where(eq(incidents.id, incident.id));
        // A change to the record like any other, so it is audited, in the
        // same transaction. Nobody made it: the check did. The deadlines
        // given, and nothing else.
        await this.provisioning.audit(
          tx,
          hospital.id,
          null,
          'incident_deadlines_filled',
          'incident',
          incident.id,
          Object.fromEntries(
            Object.entries(set).map(([field, at]) => [
              field,
              { from: null, to: at.toISOString() },
            ]),
          ),
        );
      }
      return missing.length;
    });
  }
}
