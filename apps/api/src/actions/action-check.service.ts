import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import { actionReminders, actions, tenants } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { dayOf, shiftDay } from '../i18n/time-zones.js';
import { EntitlementsService } from '../subscriptions/entitlements.service.js';
import { ActionNotifier, type ActionNotice } from './action-notifier.js';
import { ActionsService } from './actions.service.js';

/** Every fifteen minutes, as the other checks: a day starts at a different moment for each client. */
export const ACTION_CHECK_EVERY_MS = 15 * 60_000;
/** Actions handled in one transaction. */
const BATCH = 100;
export const ACTION_CHECK_STATEMENT_TIMEOUT_MS = 30_000;
/** Days before the due day for "due soon", and days overdue to escalate. */
export const DUE_SOON_DAYS = 7;
export const ESCALATE_AFTER_DAYS = 14;

const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/;
/** The kind of a failure, never its message. */
const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'unknown error';
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const own = (error as { code?: unknown }).code;
  const code = databaseFailure(error)?.code ?? (typeof own === 'string' && ERROR_CODE.test(own) ? own : null);
  return code ? `${name} (${code})` : name;
};

export type ActionCheckResult = { listed: boolean; clients: number; failed: number; notified: number };

type Reminder = 'due_soon' | 'overdue' | 'escalated';

/**
 * The reminders of the shared actions engine (docs/specs/actions.md), so
 * that every source's actions get them with no check of its own:
 *
 * - `action_due_soon`: 7 days before the due day, to the action's owner;
 * - `action_overdue`: the day after it, to the action's owner and the
 *   source's owner;
 * - `action_escalated`: 14 days overdue, to the managers of the source.
 *
 * Each is claimed once per action and due day in `action_reminders`, in the
 * transaction that writes its notifications, with the action's row locked
 * (rows another process holds are passed over and found claimed later):
 * once with any number of API processes, and again for a new due day.
 * Every client one at a time, in short transactions under
 * `TenantDb.withTenant`, no statement over 30 seconds; a source whose
 * module the client does not have is left alone, and so is a client
 * suspended by Trustline or cancelled. A subscription suspended by the
 * client's billing goes on being reminded. Started by `main.ts`; tests call
 * `run()`.
 */
@Injectable()
export class ActionCheck implements OnModuleDestroy {
  private readonly logger = new Logger(ActionCheck.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;
  statementTimeoutMs = ACTION_CHECK_STATEMENT_TIMEOUT_MS;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly entitlements: EntitlementsService,
    private readonly engine: ActionsService,
    private readonly notifier: ActionNotifier,
  ) {}

  start(everyMs = ACTION_CHECK_EVERY_MS) {
    if (!this.stopped) return;
    this.stopped = false;
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date())
          .catch((error: unknown) => this.logger.error(`Action check failed: ${kindOf(error)}`))
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
  async run(now = new Date(), only?: string[]): Promise<ActionCheckResult> {
    const result: ActionCheckResult = { listed: false, clients: 0, failed: 0, notified: 0 };
    let clients: { id: string; timeZone: string }[];
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
      this.logger.error(`Action check failed before any client was checked: ${kindOf(error)}`);
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
        this.logger.error(`Action check failed for client ${client.id}: ${kindOf(error)}`);
      }
    }
    if (result.notified + result.failed > 0) {
      const summary = `Action check: ${result.notified} notifications written, ${result.failed} of ${result.clients} clients failed`;
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

  async checkClient(client: { id: string; timeZone: string }, now: Date) {
    const today = dayOf(now, client.timeZone);
    let notified = 0;
    for (const [type, rules] of this.engine.registered()) {
      const inUse = await this.inClient(client.id, (tx) => this.entitlements.mayUse(tx, client.id, rules.module));
      if (!inUse) continue;
      for (const reminder of ['overdue', 'escalated', 'due_soon'] as const) {
        for (let claimed = BATCH; claimed >= BATCH; ) {
          if (this.stopping) return notified;
          const done = await this.remind(client.id, type, reminder, today);
          claimed = done.claimed;
          notified += done.notified;
        }
      }
    }
    return notified;
  }

  /** Claims up to BATCH actions of a source for one reminder, and tells their people. */
  private remind(tenantId: string, type: 'risk', reminder: Reminder, today: string) {
    const due =
      reminder === 'due_soon'
        ? sql`${actions.dueOn} between ${today}::date and ${shiftDay(today, DUE_SOON_DAYS)}::date`
        : reminder === 'overdue'
          ? sql`${actions.dueOn} < ${today}::date`
          : sql`${actions.dueOn} < ${shiftDay(today, -ESCALATE_AFTER_DAYS)}::date`;
    const rules = this.engine.rulesOf(type);
    return this.inClient(tenantId, async (tx) => {
      const claimed = await tx
        .select({ id: actions.id, reference: actions.reference, ownerId: actions.ownerId, dueOn: actions.dueOn, riskId: actions.riskId })
        .from(actions)
        .where(
          and(
            eq(actions.sourceType, type),
            inArray(actions.status, ['open', 'in_progress']),
            due,
            sql`not exists (select from ${actionReminders} r
              where r.action_id = ${actions.id} and r.kind = ${reminder} and r.period = ${actions.dueOn}::text)`,
          ),
        )
        .orderBy(asc(actions.dueOn), asc(actions.id))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      let notified = 0;
      for (const action of claimed) {
        const [added] = await tx
          .insert(actionReminders)
          .values({ tenantId, kind: reminder, actionId: action.id, period: action.dueOn })
          .onConflictDoNothing()
          .returning({ actionId: actionReminders.actionId });
        if (!added) continue;
        const record = await rules.record(tx, action.riskId!);
        if (!record) continue;
        const notice: ActionNotice =
          reminder === 'due_soon'
            ? { kind: 'action_due_soon', to: [action.ownerId], data: { dueOn: action.dueOn } }
            : reminder === 'overdue'
              ? { kind: 'action_overdue', to: [action.ownerId, record.ownerId], data: { dueOn: action.dueOn } }
              : { kind: 'action_escalated', to: await rules.managersOf(tx, record), data: { dueOn: action.dueOn } };
        notified += await this.notifier.send(tx, tenantId, action, record, null, [notice]);
      }
      return { claimed: claimed.length, notified };
    });
  }
}
