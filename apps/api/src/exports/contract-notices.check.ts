import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { DATABASE } from '../database/database.constants.js';
import { notifications, tenants } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { dayOf } from '../i18n/time-zones.js';
import { EntitlementsService } from '../subscriptions/entitlements.service.js';
import { kindOf } from './export-worker.service.js';
import { authorityOf } from './exports.service.js';

/** How often the check looks: each client's days turn at its own midnight. */
export const CONTRACT_CHECK_EVERY_MS = 60 * 60_000;
/** The notices before a contract's end, in days (docs/specs/data-export.md). */
export const NOTICE_DAYS = [7, 30, 90] as const;

/** Days from one calendar day to another. */
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * The notices before a contract ends (docs/specs/data-export.md, "Notices
 * before the end"): 90, 30 and 7 days before the end date Trustline's
 * staff set, on the client's calendar, its administrators and holders of
 * `data.export` for the whole organization are told, in the app and by
 * email at once (`contract_ending`), that its data can be exported before
 * then. Each notice once per end date: a date set late gets the nearest
 * notice only, and a date moved gets its own. Nothing for a cancelled
 * client. Built as the other checks: started by `main.ts` only, safe in any
 * number of processes (the client's lock), clients one at a time.
 */
@Injectable()
export class ContractNotices implements OnModuleDestroy {
  private readonly logger = new Logger(ContractNotices.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly entitlements: EntitlementsService,
  ) {}

  start(everyMs = CONTRACT_CHECK_EVERY_MS) {
    if (!this.stopped) return;
    this.stopped = false;
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date())
          .catch((error: unknown) => this.logger.error(`Contract notices failed: ${kindOf(error)}`))
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

  /** One pass: the notices due today, for every active client or these. */
  async run(now = new Date(), only?: string[]) {
    const clients = await this.db
      .select({ id: tenants.id, timeZone: tenants.timeZone })
      .from(tenants)
      .where(only ? inArray(tenants.id, only) : eq(tenants.status, 'active'))
      .orderBy(asc(tenants.id));
    let told = 0;
    for (const client of clients) {
      try {
        told += await this.notify(client, now);
      } catch (error) {
        this.logger.error(`Contract notices failed for client ${client.id}: ${kindOf(error)}`);
      }
    }
    return { told };
  }

  private notify(client: { id: string; timeZone: string }, now: Date) {
    return this.tenantDb.withTenant(client.id, async (tx) => {
      const { rows: lock } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtextextended(${`trustline.contract.${client.id}`}, 0)) as locked`,
      );
      if (!lock[0].locked) return 0;
      const ent = await this.entitlements.of(tx, client.id);
      if (!ent?.endsOn || ent.status === 'cancelled') return 0;
      const left = daysBetween(dayOf(now, client.timeZone), ent.endsOn);
      if (left < 0) return 0;
      const days = NOTICE_DAYS.find((n) => left <= n);
      if (!days) return 0;
      const [sent] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.kind, 'contract_ending'),
            sql`${notifications.data} ->> 'endsOn' = ${ent.endsOn}`,
            sql`(${notifications.data} ->> 'days')::int <= ${days}`,
          ),
        )
        .limit(1);
      if (sent) return 0;
      const to = await authorityOf(tx);
      if (to.length === 0) return 0;
      await tx.insert(notifications).values(
        to.map((userId) => ({
          tenantId: client.id,
          userId,
          kind: 'contract_ending' as const,
          data: { endsOn: ent.endsOn!, days, serious: false },
        })),
      );
      return to.length;
    });
  }
}
