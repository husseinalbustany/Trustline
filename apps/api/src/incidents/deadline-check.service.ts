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
} from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { DATABASE } from '../database/database.constants.js';
import { incidents, tenants } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { Notifier, type Announcement } from './notifier.js';
import { closeDueAt, triageDueAt } from './response-rules.js';
import { ResponseRulesService } from './response-rules.service.js';
import { DEADLINE_LIVE_IN, DUE_SOON_SHARE, type Deadline } from './status.js';

export const CHECK_EVERY_MS = 5 * 60_000;
/** Incidents announced in one transaction. */
const BATCH = 100;

type Stage = {
  deadline: Deadline;
  kind: 'due_soon' | 'overdue';
  /** The deadline itself. */
  dueAt: 'triageDueAt' | 'closeDueAt';
  /** Where it is recorded that this was announced. */
  announced:
    'triageDueSoonAt' | 'triageOverdueAt' | 'closeDueSoonAt' | 'closeOverdueAt';
  /** For "overdue": where "due soon" is recorded, which it makes pointless. */
  supersedes?: 'triageDueSoonAt' | 'closeDueSoonAt';
};

// "Overdue" before "due soon" for each deadline. An incident found already
// past its deadline is announced as overdue and its "due soon" is recorded as
// sent with it, so nobody is told the lesser thing after the greater.
const STAGES: Stage[] = [
  {
    deadline: 'triage',
    kind: 'overdue',
    dueAt: 'triageDueAt',
    announced: 'triageOverdueAt',
    supersedes: 'triageDueSoonAt',
  },
  {
    deadline: 'triage',
    kind: 'due_soon',
    dueAt: 'triageDueAt',
    announced: 'triageDueSoonAt',
  },
  {
    deadline: 'closure',
    kind: 'overdue',
    dueAt: 'closeDueAt',
    announced: 'closeOverdueAt',
    supersedes: 'closeDueSoonAt',
  },
  {
    deadline: 'closure',
    kind: 'due_soon',
    dueAt: 'closeDueAt',
    announced: 'closeDueSoonAt',
  },
];

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

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly rules: ResponseRulesService,
    private readonly notifier: Notifier,
  ) {}

  /**
   * Starts checking: once shortly after start, then every `everyMs` counted
   * from the end of the run before, so two runs of one process never overlap.
   */
  start(everyMs = CHECK_EVERY_MS) {
    if (!this.stopped) return;
    this.stopped = false;
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run()
          // run() does not throw; this is for the unforeseen.
          .catch(() => undefined)
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
   * One hospital failing does not stop the others. What is logged is the
   * hospital's id and the kind of failure, never anything from a record.
   */
  async run(now = new Date()) {
    // The list of clients is not hospital data: the application role reads
    // it outside any hospital, as sign-in does.
    const hospitals = await this.db
      .select({ id: tenants.id, timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.status, 'active'))
      .orderBy(asc(tenants.id));
    let notified = 0;
    let failed = 0;
    for (const hospital of hospitals) {
      if (this.stopping) break;
      try {
        notified += await this.checkHospital(hospital, now);
      } catch (error) {
        failed += 1;
        if (this.stopping) break;
        this.logger.error(
          `Deadline check failed for hospital ${hospital.id}: ${
            error instanceof Error ? error.name : 'unknown error'
          }`,
        );
      }
    }
    return { hospitals: hospitals.length, failed, notified };
  }

  /** Asked to stop while a run is in progress. */
  private get stopping() {
    return this.stopped && this.current !== undefined;
  }

  /**
   * Announces what is due in one hospital as of `now`, and returns how many
   * notifications that made. Several short transactions, never one long one.
   */
  async checkHospital(hospital: { id: string; timeZone: string }, now: Date) {
    await this.fillMissingDeadlines(hospital);
    let notified = 0;
    for (const stage of STAGES) {
      // Until a batch comes back short: nothing more is due at this stage.
      for (let claimed = BATCH; claimed === BATCH;) {
        if (this.stopping) return notified;
        const done = await this.announce(hospital.id, stage, now);
        claimed = done.claimed;
        notified += done.notified;
      }
    }
    return notified;
  }

  /**
   * One batch of one stage: claims up to BATCH incidents whose moment has
   * come and that nobody has announced, and writes their notifications, all
   * in one transaction.
   */
  private announce(tenantId: string, stage: Stage, now: Date) {
    const announced = incidents[stage.announced];
    const dueAt = incidents[stage.dueAt];
    // When to announce: at the deadline, or a quarter of the allowed time
    // (from the report to the deadline) before it.
    const moment: SQL =
      stage.kind === 'overdue'
        ? sql`${dueAt}`
        : sql`${dueAt} - (${dueAt} - ${incidents.reportedAt}) * ${DUE_SOON_SHARE}::float8`;
    const due = and(
      // Only while the deadline is live: an incident already triaged has no
      // triage deadline to miss, a closed one no closure deadline.
      inArray(incidents.status, DEADLINE_LIVE_IN[stage.deadline]),
      isNull(announced),
      lte(moment, now),
    );
    return this.tenantDb.withTenant(tenantId, async (tx) => {
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
      const claimed = await tx
        .update(incidents)
        .set({
          [stage.announced]: now,
          ...(stage.supersedes && {
            [stage.supersedes]: sql`coalesce(${incidents[stage.supersedes]}, ${now})`,
          }),
        })
        .where(
          and(
            inArray(
              incidents.id,
              mine.map((i) => i.id),
            ),
            isNull(announced),
          ),
        )
        .returning({
          id: incidents.id,
          reference: incidents.reference,
          orgUnitId: incidents.orgUnitId,
          ownerUnitId: incidents.ownerUnitId,
          assignedTo: incidents.assignedTo,
          reportedBy: incidents.reportedBy,
        });

      const notified = await this.notifier.sendAll(
        tx,
        tenantId,
        claimed.map((incident): Announcement => ({
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
   */
  private async fillMissingDeadlines(hospital: {
    id: string;
    timeZone: string;
  }) {
    await this.tenantDb.withTenant(hospital.id, async (tx) => {
      const missing = await tx
        .select({
          id: incidents.id,
          reportedAt: incidents.reportedAt,
          harmLevel: incidents.harmLevel,
          isSentinel: incidents.isSentinel,
          triageDueAt: incidents.triageDueAt,
          closeDueAt: incidents.closeDueAt,
        })
        .from(incidents)
        .where(or(isNull(incidents.triageDueAt), isNull(incidents.closeDueAt)))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      if (missing.length === 0) return;
      const rules = await this.rules.inForce(tx);
      for (const incident of missing) {
        await tx
          .update(incidents)
          .set({
            triageDueAt:
              incident.triageDueAt ??
              triageDueAt(incident.reportedAt, incident, rules),
            closeDueAt:
              incident.closeDueAt ??
              closeDueAt(
                incident.reportedAt,
                incident,
                rules,
                hospital.timeZone,
              ),
          })
          .where(eq(incidents.id, incident.id));
      }
    });
  }
}
