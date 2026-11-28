import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import {
  actions,
  approvalRuns,
  approvalRunSteps,
  orgUnits,
  riskAcceptances,
  riskBands,
  riskMatrices,
  riskReminders,
  risks,
  roleAssignments,
  roles,
  tenants,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { buildScope, type Grant } from '../identity/scope.js';
import { dayOf, isoWeekOf, shiftDay } from '../i18n/time-zones.js';
import { lapse } from './acceptance.js';
import { EntitlementsService } from '../subscriptions/entitlements.service.js';
import type { BandCode } from './defaults.js';
import { RiskNotifier } from './risk-notifier.js';
import { within } from './visibility.js';
import { REVIEW_DUE_DAYS } from './work.service.js';

/** Every fifteen minutes: a day starts at a different moment for each client. */
export const RISK_CHECK_EVERY_MS = 15 * 60_000;
/** Risks handled in one transaction. */
const BATCH = 100;
export const RISK_CHECK_STATEMENT_TIMEOUT_MS = 30_000;

const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/;
/** The kind of a failure, never its message. */
const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'unknown error';
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const own = (error as { code?: unknown }).code;
  const code = databaseFailure(error)?.code ?? (typeof own === 'string' && ERROR_CODE.test(own) ? own : null);
  return code ? `${name} (${code})` : name;
};

export type RiskCheckResult = { listed: boolean; clients: number; failed: number; notified: number };

type Client = { id: string; timeZone: string };

/**
 * The risk check (docs/specs/risk-management.md, "The risk check"), built
 * as `PolicyCheck` is:
 *
 * - **Review reminders:** the owner of a risk on the register is told 14
 *   days before its next review, or a quarter of its band's interval if
 *   that is shorter (`risk_review_due`); the owner and the managers of its
 *   unit the day after it has passed (`risk_review_overdue`). Each once per
 *   review day, claimed in `risk_reminders`: a new review day gives new
 *   reminders.
 * - **Acceptances** (step 6): the owner is told 30 days before an
 *   acceptance's last day (`risk_acceptance_ending`), once; on its last day
 *   it lapses, written by the system, and the owner and the managers of the
 *   unit are told (`risk_acceptance_lapsed`).
 * - **Steps overdue:** an acceptance or closure step past its due time is
 *   told once to those who manage risks for the whole organization
 *   (`risk_step_overdue`).
 * - **The weekly email to managers:** from the first run of each ISO week
 *   on the client's calendar, each person who manages risks anywhere is
 *   told how many reviews and actions are overdue in their reach, and, for
 *   the whole organization, how many steps (`risks_overdue_digest`), once
 *   a week, and only when there are some.
 *
 * Escalation is not the check's: it happens in the transaction of the
 * rating that causes it. Actions' reminders are the engine's `ActionCheck`.
 *
 * Once with any number of API processes: each thing is claimed by a row
 * lock (rows another process holds are passed over) and recorded in
 * `risk_reminders` in the transaction that writes its notifications. Every
 * client one at a time, in short transactions under `TenantDb.withTenant`,
 * no statement over 30 seconds; a client without the module, suspended by
 * Trustline or cancelled is skipped, and what came due meanwhile is done
 * once when it is back. A subscription suspended for billing goes on being
 * reminded. Started by `main.ts`; tests call `run()`.
 */
@Injectable()
export class RiskCheck implements OnModuleDestroy {
  private readonly logger = new Logger(RiskCheck.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;
  statementTimeoutMs = RISK_CHECK_STATEMENT_TIMEOUT_MS;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly entitlements: EntitlementsService,
    private readonly notifier: RiskNotifier,
    private readonly provisioning: ProvisioningService,
  ) {}

  start(everyMs = RISK_CHECK_EVERY_MS) {
    if (!this.stopped) return;
    this.stopped = false;
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date())
          .catch((error: unknown) => this.logger.error(`Risk check failed: ${kindOf(error)}`))
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

  private get stopping() {
    return this.stopped && this.current !== undefined;
  }

  /** One pass over every active client as of `now`; `only` narrows it, for tests. */
  async run(now = new Date(), only?: string[]): Promise<RiskCheckResult> {
    const result: RiskCheckResult = { listed: false, clients: 0, failed: 0, notified: 0 };
    let clients: Client[];
    try {
      clients = await this.db.transaction(async (tx) => {
        await this.limitStatements(tx);
        return tx
          .select({ id: tenants.id, timeZone: tenants.timeZone })
          .from(tenants)
          .where(and(eq(tenants.status, 'active'), only ? inArray(tenants.id, only) : undefined))
          .orderBy(asc(tenants.id));
      });
    } catch (error) {
      this.logger.error(`Risk check failed before any client was checked: ${kindOf(error)}`);
      return result;
    }
    result.listed = true;
    result.clients = clients.length;
    for (const client of clients) {
      if (this.stopping) break;
      try {
        result.notified += await this.checkClient(client, now);
      } catch (error) {
        result.failed += 1;
        if (this.stopping) break;
        this.logger.error(`Risk check failed for client ${client.id}: ${kindOf(error)}`);
      }
    }
    if (result.notified + result.failed > 0) {
      const summary = `Risk check: ${result.notified} notifications written, ${result.failed} of ${result.clients} clients failed`;
      if (result.failed > 0) this.logger.warn(summary);
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
    await tx.execute(sql`select set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`);
  }

  async checkClient(client: Client, now: Date) {
    const inUse = await this.inClient(client.id, (tx) => this.entitlements.mayUse(tx, client.id, 'risks'));
    if (!inUse) return 0;
    const today = dayOf(now, client.timeZone);
    let notified = 0;
    for (const overdue of [true, false]) {
      for (let claimed = BATCH; claimed >= BATCH; ) {
        if (this.stopping) return notified;
        const done = await this.remindReviews(client.id, today, overdue);
        claimed = done.claimed;
        notified += done.notified;
      }
    }
    for (const job of [() => this.lapseAcceptances(client.id, today), () => this.remindEnding(client.id, today), () => this.stepsOverdue(client.id, now)]) {
      for (let claimed = BATCH; claimed >= BATCH; ) {
        if (this.stopping) return notified;
        const done = await job();
        claimed = done.claimed;
        notified += done.notified;
      }
    }
    if (this.stopping) return notified;
    notified += await this.sendDigests(client.id, today, now);
    return notified;
  }

  /** Claims up to BATCH acceptances in force whose last day has come, and ends them. */
  private lapseAcceptances(tenantId: string, today: string) {
    return this.inClient(tenantId, async (tx) => {
      const claimed = await tx
        .select({
          id: riskAcceptances.id,
          riskId: riskAcceptances.riskId,
          score: riskAcceptances.score,
          reference: risks.reference,
          orgUnitId: risks.orgUnitId,
          ownerId: risks.ownerId,
          currentBand: risks.currentBand,
        })
        .from(riskAcceptances)
        .innerJoin(risks, eq(risks.id, riskAcceptances.riskId))
        .where(and(eq(riskAcceptances.status, 'accepted'), sql`${riskAcceptances.untilOn} <= ${today}::date`))
        .orderBy(asc(riskAcceptances.untilOn), asc(riskAcceptances.id))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      let notified = 0;
      for (const a of claimed) {
        notified += await lapse(
          tx,
          { provisioning: this.provisioning, notifier: this.notifier },
          tenantId,
          a,
          { id: a.riskId, reference: a.reference, orgUnitId: a.orgUnitId, ownerId: a.ownerId, currentBand: a.currentBand as BandCode | null },
          'last_day',
        );
      }
      return { claimed: claimed.length, notified };
    });
  }

  /** The owner is told 30 days before an acceptance's last day, once. */
  private remindEnding(tenantId: string, today: string) {
    return this.inClient(tenantId, async (tx) => {
      const claimed = await tx
        .select({
          id: riskAcceptances.id,
          untilOn: riskAcceptances.untilOn,
          riskId: risks.id,
          reference: risks.reference,
          ownerId: risks.ownerId,
          currentBand: risks.currentBand,
        })
        .from(riskAcceptances)
        .innerJoin(risks, eq(risks.id, riskAcceptances.riskId))
        .where(
          and(
            eq(riskAcceptances.status, 'accepted'),
            sql`${riskAcceptances.untilOn} <= ${shiftDay(today, 30)}::date`,
            sql`not exists (select from ${riskReminders} r
              where r.subject_id = ${riskAcceptances.id} and r.kind = 'acceptance_ending' and r.period = ${riskAcceptances.untilOn}::text)`,
          ),
        )
        .orderBy(asc(riskAcceptances.untilOn), asc(riskAcceptances.id))
        .limit(BATCH)
        .for('update', { of: riskAcceptances, skipLocked: true });
      let notified = 0;
      for (const a of claimed) {
        const [added] = await tx
          .insert(riskReminders)
          .values({ tenantId, kind: 'acceptance_ending', subjectId: a.id, period: a.untilOn })
          .onConflictDoNothing()
          .returning({ subjectId: riskReminders.subjectId });
        if (!added) continue;
        notified += await this.notifier.send(
          tx,
          tenantId,
          { id: a.riskId, reference: a.reference, currentBand: a.currentBand as BandCode | null },
          null,
          [{ kind: 'risk_acceptance_ending', to: [a.ownerId], data: { until: a.untilOn } }],
        );
      }
      return { claimed: claimed.length, notified };
    });
  }

  /** The steps of acceptances and closures past their due time: told once. */
  private stepsOverdue(tenantId: string, now: Date) {
    return this.inClient(tenantId, async (tx) => {
      const claimed = await tx
        .select({
          id: approvalRunSteps.id,
          position: approvalRunSteps.position,
          subjectType: approvalRuns.subjectType,
          riskId: risks.id,
          reference: risks.reference,
          currentBand: risks.currentBand,
        })
        .from(approvalRunSteps)
        .innerJoin(approvalRuns, eq(approvalRuns.id, approvalRunSteps.runId))
        .leftJoin(
          riskAcceptances,
          and(eq(approvalRuns.subjectType, 'risk_acceptance'), eq(riskAcceptances.id, approvalRuns.subjectId)),
        )
        .innerJoin(
          risks,
          sql`${risks.id} = case when ${approvalRuns.subjectType} = 'risk' then ${approvalRuns.subjectId} else ${riskAcceptances.riskId} end`,
        )
        .where(
          and(
            eq(approvalRuns.status, 'in_progress'),
            eq(approvalRunSteps.status, 'pending'),
            inArray(approvalRuns.subjectType, ['risk_acceptance', 'risk']),
            sql`${approvalRunSteps.dueAt} < ${now.toISOString()}::timestamptz`,
            sql`not exists (select from ${riskReminders} r where r.subject_id = ${approvalRunSteps.id} and r.kind = 'step_overdue')`,
          ),
        )
        .orderBy(asc(approvalRunSteps.dueAt), asc(approvalRunSteps.id))
        .limit(BATCH)
        .for('update', { of: approvalRunSteps, skipLocked: true });
      if (claimed.length === 0) return { claimed: 0, notified: 0 };
      const managers = await this.notifier.managersOf(tx, null);
      let notified = 0;
      for (const step of claimed) {
        const [added] = await tx
          .insert(riskReminders)
          .values({ tenantId, kind: 'step_overdue', subjectId: step.id })
          .onConflictDoNothing()
          .returning({ subjectId: riskReminders.subjectId });
        if (!added) continue;
        notified += await this.notifier.send(
          tx,
          tenantId,
          { id: step.riskId, reference: step.reference, currentBand: step.currentBand as BandCode | null },
          null,
          [
            {
              kind: 'risk_step_overdue',
              to: managers,
              data: { subject: step.subjectType === 'risk' ? 'closure' : 'acceptance', position: step.position },
            },
          ],
        );
      }
      return { claimed: claimed.length, notified };
    });
  }

  /**
   * Claims up to BATCH open risks whose review reminder has come and was
   * not sent for this review day, and tells their people.
   */
  private remindReviews(tenantId: string, today: string, overdue: boolean) {
    const kind = overdue ? 'review_overdue' : 'review_due';
    // The lead: 14 days, or a quarter of the band's interval if shorter.
    const lead = sql`least(${REVIEW_DUE_DAYS}, (select b.review_interval_days / 4 from ${riskBands} b
      join ${riskMatrices} m on m.id = b.matrix_id and m.status = 'in_use'
      where b.code = ${risks.currentBand}))`;
    const due = overdue
      ? sql`${risks.nextReviewOn} < ${today}::date`
      : sql`${risks.nextReviewOn} >= ${today}::date and ${risks.nextReviewOn} - coalesce(${lead}, ${REVIEW_DUE_DAYS}) <= ${today}::date`;
    return this.inClient(tenantId, async (tx) => {
      const claimed = await tx
        .select({
          id: risks.id,
          reference: risks.reference,
          orgUnitId: risks.orgUnitId,
          ownerId: risks.ownerId,
          currentBand: risks.currentBand,
          nextReviewOn: risks.nextReviewOn,
        })
        .from(risks)
        .where(
          and(
            eq(risks.status, 'open'),
            due,
            sql`not exists (select from ${riskReminders} r
              where r.subject_id = ${risks.id} and r.kind = ${kind} and r.period = ${risks.nextReviewOn}::text)`,
          ),
        )
        .orderBy(asc(risks.nextReviewOn), asc(risks.id))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      let notified = 0;
      for (const risk of claimed) {
        const [added] = await tx
          .insert(riskReminders)
          .values({ tenantId, kind, subjectId: risk.id, period: risk.nextReviewOn! })
          .onConflictDoNothing()
          .returning({ subjectId: riskReminders.subjectId });
        if (!added) continue;
        const managers = overdue ? await this.notifier.managersOf(tx, risk.orgUnitId) : [];
        notified += await this.notifier.send(tx, tenantId, { ...risk, currentBand: risk.currentBand as BandCode | null }, null, [
          {
            kind: overdue ? 'risk_review_overdue' : 'risk_review_due',
            to: [risk.ownerId, ...managers],
            data: { dueOn: risk.nextReviewOn! },
          },
        ]);
      }
      return { claimed: claimed.length, notified };
    });
  }

  /**
   * The weekly email, from the first run of each ISO week: to each active
   * person who manages risks, the counts of reviews and actions overdue in
   * their reach, worked out from their grants as their screens would.
   */
  private sendDigests(tenantId: string, today: string, now: Date) {
    const week = isoWeekOf(today);
    return this.inClient(tenantId, async (tx) => {
      const grants = await tx
        .select({ userId: roleAssignments.userId, permissions: roles.permissions, orgUnitId: roleAssignments.orgUnitId })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .innerJoin(users, eq(users.id, roleAssignments.userId))
        .where(and(eq(users.status, 'active'), sql`'risks.manage' = any(${roles.permissions})`));
      if (grants.length === 0) return 0;
      const units = await tx.select({ id: orgUnits.id, parentId: orgUnits.parentId }).from(orgUnits);
      const byUser = new Map<string, Grant[]>();
      for (const g of grants) {
        const list = byUser.get(g.userId) ?? [];
        list.push({ permissions: g.permissions, orgUnitId: g.orgUnitId });
        byUser.set(g.userId, list);
      }
      const due: { userId: string; data: Record<string, string | number> }[] = [];
      for (const [userId, own] of byUser) {
        const reach = buildScope(own, units)['risks.manage'];
        if (!reach) continue;
        const managed = within(reach, risks.orgUnitId);
        const [reviews] = await tx
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(risks)
          .where(and(eq(risks.status, 'open'), managed, sql`${risks.nextReviewOn} < ${today}::date`));
        const [late] = await tx
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(actions)
          .innerJoin(risks, eq(risks.id, actions.riskId))
          .where(and(inArray(actions.status, ['open', 'in_progress']), managed, sql`${actions.dueOn} < ${today}::date`));
        // Steps are the whole organization's: counted for its managers only.
        let steps = 0;
        if (reach === 'all') {
          const { rows } = await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from ${approvalRunSteps} s join ${approvalRuns} r on r.id = s.run_id
            where r.status = 'in_progress' and s.status = 'pending'
              and r.subject_type in ('risk_acceptance', 'risk') and s.due_at < ${now.toISOString()}::timestamptz`);
          steps = Number(rows[0]?.n ?? 0);
        }
        if (reviews.n + late.n + steps === 0) continue;
        const [claimed] = await tx
          .insert(riskReminders)
          .values({ tenantId, kind: 'weekly_digest', subjectId: userId, period: week })
          .onConflictDoNothing()
          .returning({ subjectId: riskReminders.subjectId });
        if (!claimed) continue;
        due.push({ userId, data: { reviewsOverdue: reviews.n, actionsOverdue: late.n, stepsOverdue: steps, week } });
      }
      return this.notifier.sendDigest(tx, tenantId, due);
    });
  }
}
