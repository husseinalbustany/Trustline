import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import { plans, subscriptions } from '../database/schema.js';
import { dayOf } from '../i18n/time-zones.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import {
  effectiveEntitlements,
  visibleChanges,
} from './entitlements.service.js';
import type { ModuleCode } from './modules.js';
import { assertDependencies, PlansService } from './plans.service.js';
import type { UpdateSubscriptionInput } from './subscription-input.js';

/**
 * The plan a new client is put on when the admin portal names none: the
 * one every client that existed before plans was moved to (migration
 * 0033). Until the portal's screens send a plan, so that a client created
 * from them gets what every client got until now. Retired, it is not used,
 * and a plan must be named (400 `plan_required`).
 */
export const PLAN_WHEN_NONE_NAMED = 'everything';

/** The stored fields of a subscription that the platform audit log records. */
const STORED = [
  'planId',
  'status',
  'startsOn',
  'renewsOn',
  'trialEndsOn',
  'addOnModules',
  'limitOverrides',
  'note',
] as const;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export type SubscriptionView = Awaited<
  ReturnType<SubscriptionsService['read']>
>;

/**
 * Clients' subscriptions, as the admin portal manages them: as the platform
 * role, which alone writes them, in a transaction the caller opens so that
 * its audit entry goes in the same one.
 */
@Injectable()
export class SubscriptionsService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly plans: PlansService,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * A client's subscription as the portal shows it: what is stored, the
   * plan, and what the two make (`effective`). 404 without one.
   */
  async read(tenantId: string, db: Database | Transaction = this.db) {
    const [row] = await db
      .select({
        subscription: subscriptions,
        plan: {
          id: plans.id,
          code: plans.code,
          name: plans.name,
          active: plans.active,
          modules: plans.modules,
          limits: plans.limits,
          extras: plans.extras,
        },
      })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(subscriptions.tenantId, tenantId));
    if (!row) throw new NotFoundException();
    const { subscription, plan } = row;
    const { modules, limits, extras } = effectiveEntitlements(
      plan,
      subscription,
    );
    return {
      tenantId: subscription.tenantId,
      plan: {
        id: plan.id,
        code: plan.code,
        name: plan.name,
        active: plan.active,
      },
      status: subscription.status,
      startsOn: subscription.startsOn,
      renewsOn: subscription.renewsOn,
      trialEndsOn: subscription.trialEndsOn,
      addOnModules: subscription.addOnModules,
      limitOverrides: subscription.limitOverrides,
      note: subscription.note,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      effective: { modules, limits, extras },
    };
  }

  /**
   * The subscription of a client being created: active from today, in the
   * client's time zone, on the plan named, or on PLAN_WHEN_NONE_NAMED.
   */
  async start(
    tx: Transaction,
    tenant: { id: string; timeZone: string },
    planId: string | undefined,
  ) {
    let plan;
    try {
      plan = await this.plans.assignable(
        tx,
        planId ? { id: planId } : { code: PLAN_WHEN_NONE_NAMED },
      );
    } catch (e) {
      if (planId) throw e;
      throw new BadRequestException({ code: 'plan_required' });
    }
    await tx.insert(subscriptions).values({
      tenantId: tenant.id,
      planId: plan.id,
      status: 'active',
      startsOn: dayOf(new Date(), tenant.timeZone),
    });
    return plan;
  }

  /**
   * Changes a client's subscription and returns what changed, for the
   * platform audit log. What the client sees change (its plan, its status,
   * the modules it has and its limits) is also written to the client's own
   * audit log, in the same transaction, with the member of staff who did it.
   *
   * Refused with 400 and a code: `unknown_plan`, `plan_retired` (moving to
   * a retired plan; staying on one is allowed), `trial_end_required` (a
   * trial with no end), `invalid_dates` (a renewal or trial end before the
   * start), `module_dependency_missing` (`module`, `requiresAnyOf`).
   */
  async change(
    tx: Transaction,
    tenantId: string,
    input: UpdateSubscriptionInput,
    admin: { id: string; email: string },
  ) {
    const [current] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId))
      .for('update');
    if (!current) throw new NotFoundException();
    const before = await this.read(tenantId, tx);

    if (input.planId && input.planId !== current.planId) {
      await this.plans.assignable(tx, { id: input.planId });
    }
    const next = { ...current, ...input };
    if (next.status === 'trial' && !next.trialEndsOn) {
      throw new BadRequestException({ code: 'trial_end_required' });
    }
    for (const day of [next.renewsOn, next.trialEndsOn]) {
      if (day && day < next.startsOn) {
        throw new BadRequestException({ code: 'invalid_dates' });
      }
    }
    const [plan] = await tx
      .select({ modules: plans.modules })
      .from(plans)
      .where(eq(plans.id, next.planId));
    assertDependencies([...plan.modules, ...next.addOnModules] as ModuleCode[]);

    const changes = Object.fromEntries(
      STORED.filter((key) => !same(current[key], next[key])).map((key) => [
        key,
        { from: current[key], to: next[key] },
      ]),
    );
    if (Object.keys(changes).length === 0)
      return { before, after: before, changes };

    // Going to or from cancelled voids every session and one-time link
    // issued until now (see `accessResetAt`): by the database's clock, as a
    // session's own time is, and taken under the row's lock, after any
    // change to cancelled before this one was committed.
    const resets =
      (current.status === 'cancelled') !== (next.status === 'cancelled');
    await tx
      .update(subscriptions)
      .set({
        ...input,
        ...(resets && { accessResetAt: sql`clock_timestamp()` }),
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.tenantId, tenantId));
    const after = await this.read(tenantId, tx);

    const seen = visibleChanges(
      {
        planCode: before.plan.code,
        status: before.status,
        ...before.effective,
      },
      { planCode: after.plan.code, status: after.status, ...after.effective },
    );
    if (seen) {
      await this.provisioning.auditSubscriptionChange(tx, tenantId, {
        ...seen,
        platformAdminId: admin.id,
        platformAdminEmail: admin.email,
      });
    }
    return { before, after, changes };
  }
}
