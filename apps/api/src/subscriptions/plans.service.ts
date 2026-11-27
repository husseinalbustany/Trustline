import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import { plans, subscriptions } from '../database/schema.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import {
  effectiveEntitlements,
  visibleChanges,
} from './entitlements.service.js';
import { missingDependency, type ModuleCode } from './modules.js';
import {
  inEveryLanguage,
  type CreatePlanInput,
  type UpdatePlanInput,
} from './subscription-input.js';

/** What the admin portal is shown of a plan. */
const planFields = {
  id: plans.id,
  code: plans.code,
  name: plans.name,
  description: plans.description,
  modules: plans.modules,
  limits: plans.limits,
  extras: plans.extras,
  prices: plans.prices,
  active: plans.active,
  position: plans.position,
  createdAt: plans.createdAt,
  updatedAt: plans.updatedAt,
};

/** How many clients are on the plan. */
const subscribers = sql<number>`(select count(*)::int from ${subscriptions} where ${subscriptions.planId} = ${plans.id})`;

export type Plan = Awaited<ReturnType<PlansService['get']>>;

/** The fields of a plan whose change the platform audit log records. */
export const PLAN_FIELDS = [
  'name',
  'description',
  'modules',
  'limits',
  'extras',
  'prices',
  'active',
  'position',
] as const;

/**
 * The plans Trustline offers. Trustline's own data, written by the admin
 * portal as the platform role, in a transaction the caller opens so that it
 * can write its audit entry in the same one. A plan is retired, never
 * deleted: the clients on it keep it, and no other can be given it.
 */
@Injectable()
export class PlansService {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly provisioning: ProvisioningService,
  ) {}

  /** Every plan, retired ones too, in the order the portal shows them. */
  list() {
    return this.db
      .select({ ...planFields, subscribers })
      .from(plans)
      .orderBy(asc(plans.position), asc(plans.code));
  }

  async get(id: string, db: Database | Transaction = this.db) {
    const [plan] = await db
      .select({ ...planFields, subscribers })
      .from(plans)
      .where(eq(plans.id, id));
    if (!plan) throw new NotFoundException();
    return plan;
  }

  /** 400 `language_mismatch` unless written in every language. */
  private assertLanguages(input: UpdatePlanInput) {
    if (!inEveryLanguage(input.name) || !inEveryLanguage(input.description)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
  }

  async create(tx: Transaction, input: CreatePlanInput) {
    this.assertLanguages(input);
    assertDependencies(input.modules);
    const [created] = await tx
      .insert(plans)
      .values({ ...input, description: input.description ?? null })
      .returning({ id: plans.id });
    return this.get(created.id, tx);
  }

  /**
   * Changes a plan, and returns it as it was and as it is. Its modules must
   * still meet their needs on their own, and together with the add-ons of
   * every client on it: otherwise 400 `module_dependency_missing`, with the
   * client's id when it is a client's add-on that would be left without.
   *
   * Every client on the plan for whom this changes what it may use (its
   * modules, its limits) gets an entry in its own audit log, in the same
   * transaction, naming the member of staff.
   */
  async update(
    tx: Transaction,
    id: string,
    input: UpdatePlanInput,
    admin: { id: string; email: string },
  ) {
    this.assertLanguages(input);
    const [locked] = await tx
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.id, id))
      .for('update');
    if (!locked) throw new NotFoundException();
    const before = await this.get(id, tx);
    const onIt = await tx
      .select({
        tenantId: subscriptions.tenantId,
        status: subscriptions.status,
        addOnModules: subscriptions.addOnModules,
        limitOverrides: subscriptions.limitOverrides,
      })
      .from(subscriptions)
      .where(eq(subscriptions.planId, id))
      .for('update');
    if (input.modules) {
      assertDependencies(input.modules);
      for (const { tenantId, addOnModules } of onIt) {
        assertDependencies(
          [...input.modules, ...addOnModules] as ModuleCode[],
          tenantId,
        );
      }
    }
    await tx
      .update(plans)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(plans.id, id));
    const after = await this.get(id, tx);

    for (const subscription of onIt) {
      const seen = visibleChanges(
        {
          planCode: before.code,
          status: subscription.status,
          ...effectiveEntitlements(before, subscription),
        },
        {
          planCode: after.code,
          status: subscription.status,
          ...effectiveEntitlements(after, subscription),
        },
      );
      if (!seen) continue;
      await this.provisioning.audit(
        tx,
        subscription.tenantId,
        null,
        'subscription_changed',
        'subscription',
        subscription.tenantId,
        {
          ...seen,
          planUpdated: after.code,
          platformAdminId: admin.id,
          platformAdminEmail: admin.email,
        },
      );
    }
    return { before, after };
  }

  /**
   * A plan a client can be put on: one that exists (else 400
   * `unknown_plan`) and is not retired (else 400 `plan_retired`).
   */
  async assignable(tx: Transaction, where: { id: string } | { code: string }) {
    const [plan] = await tx
      .select({ id: plans.id, code: plans.code, active: plans.active })
      .from(plans)
      .where(
        'id' in where ? eq(plans.id, where.id) : eq(plans.code, where.code),
      );
    if (!plan) throw new BadRequestException({ code: 'unknown_plan' });
    if (!plan.active) throw new BadRequestException({ code: 'plan_retired' });
    return plan;
  }
}

/**
 * 400 `{ code: "module_dependency_missing", module, requiresAnyOf }` unless
 * every module in the set has what it needs.
 */
export function assertDependencies(
  modules: readonly ModuleCode[],
  tenantId?: string,
) {
  const missing = missingDependency(modules);
  if (missing) {
    throw new BadRequestException({
      code: 'module_dependency_missing',
      ...missing,
      ...(tenantId && { tenantId }),
    });
  }
}
