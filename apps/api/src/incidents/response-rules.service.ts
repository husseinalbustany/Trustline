import { Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { incidentResponseRules } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import {
  DEFAULT_RESPONSE_RULES,
  HARM_LEVELS,
  type ResponseRule,
  type ResponseRules,
} from './response-rules.js';

/**
 * A hospital's response rules: how soon it means to triage and to close an
 * incident of each harm level.
 */
@Injectable()
export class ResponseRulesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * The rules in force, for a transaction already scoped to the hospital.
   * Every hospital has its five rows from the day it is created; should one
   * be missing all the same, the starting value stands in, so that a report
   * is never refused, or left without a deadline, for want of a rule.
   */
  async inForce(tx: Transaction): Promise<ResponseRules> {
    const rows = await tx
      .select({
        harmLevel: incidentResponseRules.harmLevel,
        triageWithinHours: incidentResponseRules.triageWithinHours,
        closeWithinDays: incidentResponseRules.closeWithinDays,
      })
      .from(incidentResponseRules);
    const rules = structuredClone(DEFAULT_RESPONSE_RULES);
    for (const { harmLevel, ...rule } of rows) rules[harmLevel] = rule;
    return rules;
  }

  /** As the settings screen shows them: one entry per level, mildest first. */
  private listed(rules: ResponseRules) {
    return {
      rules: HARM_LEVELS.map((harmLevel) => ({
        harmLevel,
        ...rules[harmLevel],
      })),
    };
  }

  get(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) =>
      this.listed(await this.inForce(tx)),
    );
  }

  /**
   * Replaces the hospital's rules. Deadlines already set on incidents stay
   * as they are: the new rules count for reports made from now on, and for
   * a closure deadline counted again at a later triage. Every value that
   * changes is audited with what it was; saving the same values writes
   * nothing.
   */
  set(auth: AuthContext, next: ResponseRules) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      // Makes sure the five rows exist, then holds them: of two people
      // saving at once, the second sees what the first left.
      await this.provisioning.ensureResponseRules(tx, tenant.id);
      await tx
        .select({ harmLevel: incidentResponseRules.harmLevel })
        .from(incidentResponseRules)
        .orderBy(asc(incidentResponseRules.harmLevel))
        .for('update');
      const before = await this.inForce(tx);

      const changes: Record<
        string,
        Partial<Record<keyof ResponseRule, { from: number; to: number }>>
      > = {};
      for (const harmLevel of HARM_LEVELS) {
        for (const key of ['triageWithinHours', 'closeWithinDays'] as const) {
          const from = before[harmLevel][key];
          const to = next[harmLevel][key];
          if (from !== to) {
            changes[harmLevel] = { ...changes[harmLevel], [key]: { from, to } };
          }
        }
      }
      if (Object.keys(changes).length === 0) return this.listed(before);

      for (const harmLevel of Object.keys(changes) as (keyof ResponseRules)[]) {
        await tx
          .insert(incidentResponseRules)
          .values({ tenantId: tenant.id, harmLevel, ...next[harmLevel] })
          .onConflictDoUpdate({
            target: [
              incidentResponseRules.tenantId,
              incidentResponseRules.harmLevel,
            ],
            set: { ...next[harmLevel], updatedAt: new Date() },
          });
      }
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'response_rules_changed',
        'tenant',
        tenant.id,
        changes,
      );
      return this.listed(next);
    });
  }
}
