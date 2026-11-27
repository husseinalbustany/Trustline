import { ConflictException, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { plans, subscriptions } from '../database/schema.js';
import type { Localized } from '../i18n/locales.js';
import {
  EXTRAS,
  LIMITS,
  usableModules,
  type EnforcedLimit,
  type Extras,
  type LimitKey,
  type Limits,
  type ModuleCode,
  type ModuleKey,
  type SubscriptionStatus,
} from './modules.js';

/** What a client may use, worked out from its subscription and plan. */
export type Entitlements = {
  status: SubscriptionStatus;
  plan: { id: string; code: string; name: Localized };
  startsOn: string;
  renewsOn: string | null;
  trialEndsOn: string | null;
  /** The plan's modules and the add-ons, as stored. */
  planModules: ModuleCode[];
  addOnModules: ModuleCode[];
  /** What is on: plan and add-ons, less any whose needs are not met. */
  modules: ModuleCode[];
  /** The plan's limits with the subscription's overrides. Null: no limit. */
  limits: Limits;
  extras: Extras;
};

/** Plan and add-ons, overrides over the plan's limits, the plan's extras. */
export function effectiveEntitlements(
  plan: { modules: string[]; limits: Partial<Limits>; extras: Partial<Extras> },
  subscription: { addOnModules: string[]; limitOverrides: Partial<Limits> },
) {
  const limits = {} as Limits;
  for (const key of LIMITS) {
    limits[key] = Object.hasOwn(subscription.limitOverrides, key)
      ? (subscription.limitOverrides[key] ?? null)
      : (plan.limits[key] ?? null);
  }
  const extras = {} as Extras;
  for (const key of EXTRAS) extras[key] = plan.extras[key] === true;
  return {
    planModules: usableModules(plan.modules),
    addOnModules: usableModules([
      ...plan.modules,
      ...subscription.addOnModules,
    ]).filter((m) => subscription.addOnModules.includes(m)),
    modules: usableModules([...plan.modules, ...subscription.addOnModules]),
    limits,
    extras,
  };
}

/**
 * The one place that answers "may this client use module X?" and "what is
 * this client's limit for Y?", from its subscription. Every question is
 * asked in a transaction already scoped to the client by
 * TenantDb.withTenant(), as the application role, which may read what a
 * subscription and a plan entitle a client to and nothing commercial.
 *
 * Read afresh every time, never cached: a module switched off is off on the
 * next request, in every API process.
 */
@Injectable()
export class EntitlementsService {
  /** The client's entitlements, or null if it has no subscription. */
  async of(tx: Transaction, tenantId: string): Promise<Entitlements | null> {
    // Named columns: the application role may not read a plan's prices or
    // the subscription's note.
    const [row] = await tx
      .select({
        status: subscriptions.status,
        startsOn: subscriptions.startsOn,
        renewsOn: subscriptions.renewsOn,
        trialEndsOn: subscriptions.trialEndsOn,
        addOnModules: subscriptions.addOnModules,
        limitOverrides: subscriptions.limitOverrides,
        planId: plans.id,
        planCode: plans.code,
        planName: plans.name,
        modules: plans.modules,
        limits: plans.limits,
        extras: plans.extras,
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(subscriptions.tenantId, tenantId));
    if (!row) return null;
    return {
      status: row.status,
      plan: { id: row.planId, code: row.planCode, name: row.planName },
      startsOn: row.startsOn,
      renewsOn: row.renewsOn,
      trialEndsOn: row.trialEndsOn,
      ...effectiveEntitlements(row, row),
    };
  }

  /**
   * Whether the client may use this module now. Core always; anything else
   * only while its subscription includes it and has not been cancelled.
   */
  async mayUse(tx: Transaction, tenantId: string, module: ModuleKey) {
    const entitlements = await this.of(tx, tenantId);
    return allows(entitlements, module);
  }

  /** The client's limit for this quantity. Null: no limit. */
  async limitOf(tx: Transaction, tenantId: string, limit: LimitKey) {
    return (await this.of(tx, tenantId))?.limits[limit] ?? null;
  }

  /**
   * Makes room for `adding` more of a limited quantity, or refuses with 409
   * `{ code: "limit_reached", limit, max }`. Call it in the transaction that
   * adds them, before adding; `used` counts what there is now, in the same
   * transaction.
   *
   * Two transactions making room in one client for the same quantity take
   * turns: the second waits until the first has ended and then counts what
   * the first added. So two requests can never both take the last place.
   * What is already there is never touched, even above a limit lowered
   * since.
   */
  async makeRoom(
    tx: Transaction,
    tenantId: string,
    limit: EnforcedLimit,
    used: (tx: Transaction) => Promise<number>,
    adding = 1,
  ) {
    // Held until the transaction ends. A lock of its own, not a row's: the
    // application role cannot lock the subscription, which it only reads.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`trustline.limit.${limit}.${tenantId}`}, 0))`,
    );
    const max = await this.limitOf(tx, tenantId, limit);
    if (max === null) return;
    if ((await used(tx)) + adding > max) {
      throw new ConflictException({ code: 'limit_reached', limit, max });
    }
  }
}

/** Whether these entitlements open this module. */
export function allows(
  entitlements: Pick<Entitlements, 'status' | 'modules'> | null,
  module: ModuleKey,
) {
  if (module === 'core') return true;
  if (!entitlements || entitlements.status === 'cancelled') return false;
  return entitlements.modules.includes(module);
}

/** What a client sees of its subscription, to tell what changed. */
type Seen = {
  planCode: string;
  status: SubscriptionStatus;
  modules: readonly ModuleCode[];
  limits: Limits;
};

/**
 * What changed between two states of a subscription that the client can
 * see, for its own audit log, or null: its plan (by code), its status, the
 * modules switched on and off, and its limits. Never a note, a date or
 * anything commercial.
 */
export function visibleChanges(before: Seen, after: Seen) {
  const seen: Record<string, unknown> = {};
  if (before.planCode !== after.planCode) {
    seen.plan = { from: before.planCode, to: after.planCode };
  }
  if (before.status !== after.status) {
    seen.status = { from: before.status, to: after.status };
  }
  const on = after.modules.filter((m) => !before.modules.includes(m));
  const off = before.modules.filter((m) => !after.modules.includes(m));
  if (on.length > 0 || off.length > 0) seen.modules = { on, off };
  const limits = Object.fromEntries(
    LIMITS.filter((key) => before.limits[key] !== after.limits[key]).map(
      (key) => [key, { from: before.limits[key], to: after.limits[key] }],
    ),
  );
  if (Object.keys(limits).length > 0) seen.limits = limits;
  return Object.keys(seen).length > 0 ? seen : null;
}
