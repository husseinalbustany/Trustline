import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { clientAiSchema } from '../ai/ai-input.js';
import {
  connectionColumns,
  microUsd,
  monthOf,
  readClientAi,
  usageOf,
  usd,
  whereOf,
  type ClientAi,
} from '../ai/client-ai.js';
import { AI_FEATURES, type AiFeature } from '../ai/features.js';
import type { Database, Transaction } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import {
  aiClientFeatures,
  aiClientSettings,
  aiProviderConnections,
  notifications,
  tenants,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { AccessService } from '../identity/access.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { EntitlementsService } from '../subscriptions/entitlements.service.js';
import { ForModule } from '../subscriptions/module.decorator.js';
import {
  PlatformAuthGuard,
  type PlatformRequest,
} from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What is stored of a feature's choice, for the platform log. */
const choiceOf = (ai: ClientAi, feature: AiFeature) => {
  const choice = ai.features[feature];
  return choice ? { connectionId: choice.connection.id, model: choice.model, quickModel: choice.quickModel } : null;
};

/** What the client is told of a feature's choice: where it is processed, and the model. */
const seenChoiceOf = (ai: ClientAi, feature: AiFeature) => {
  const choice = ai.features[feature];
  return choice ? { ...whereOf(choice.connection), model: choice.model } : null;
};

/**
 * How a client is offered AI, for Trustline's staff (docs/specs/ai-
 * providers-and-allowances.md, "Per-client configuration"): AI offered or
 * not; for each feature the connection and model, or not offered; the
 * allowances where they differ from the plan's; whether the medical option
 * may be offered; and the client's own spending limit. With the month's
 * usage and cost.
 *
 * Every change is written to the platform audit log, and what the client
 * can see change (all but the spending limit) to the client's own, in the
 * same transaction. A change of the provider of any feature, or of whether
 * AI is offered, tells the client's administrators in the app.
 */
@Controller('platform/tenants/:id/ai')
@UseGuards(PlatformAuthGuard)
@ForModule('core')
export class PlatformTenantAiController {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly auth: PlatformAuthService,
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly access: AccessService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Get()
  async get(@Param('id') id: string) {
    const tenant = await this.tenantOf(this.db, id);
    return this.view(this.db, tenant);
  }

  /**
   * Changes what is sent, leaving the rest. A feature set to null is no
   * longer offered. 400 `unknown_connection`, `connection_inactive` or
   * `unknown_model` (with the `feature`) for a choice that cannot serve.
   */
  @Patch()
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = clientAiSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) throw new BadRequestException();
    const input = parsed.data;
    const tenant = await this.tenantOf(this.db, id);
    const admin = req.platformAdmin;

    // The notice to the client's administrators is written as the
    // application, which alone may read who they are and write to them: its
    // transaction is opened around the platform's, so that neither commits
    // without the other being written.
    return this.tenantDb.withTenant(tenant.id, (appTx) =>
      this.db.transaction(async (tx) => {
        // One change at a time per client.
        await tx.insert(aiClientSettings).values({ tenantId: tenant.id }).onConflictDoNothing();
        await tx.select({ tenantId: aiClientSettings.tenantId }).from(aiClientSettings).where(eq(aiClientSettings.tenantId, tenant.id)).for('update');
        const before = await readClientAi(tx, tenant.id);

        for (const feature of AI_FEATURES) {
          const choice = input.features?.[feature];
          if (!choice) continue;
          const [connection] = await tx.select(connectionColumns).from(aiProviderConnections).where(eq(aiProviderConnections.id, choice.connectionId));
          if (!connection) throw new BadRequestException({ code: 'unknown_connection', feature });
          if (!connection.active) throw new BadRequestException({ code: 'connection_inactive', feature });
          for (const model of [choice.model, choice.quickModel]) {
            if (model && !connection.models.some((m) => m.id === model)) {
              throw new BadRequestException({ code: 'unknown_model', feature, model });
            }
          }
        }

        await tx
          .update(aiClientSettings)
          .set({
            ...(input.offered !== undefined && { offered: input.offered }),
            ...(input.allowanceOverrides !== undefined && { allowanceOverrides: input.allowanceOverrides }),
            ...(input.medicalOptionAllowed !== undefined && { medicalOptionAllowed: input.medicalOptionAllowed }),
            ...(input.monthlySpendingLimitUsd !== undefined && {
              monthlySpendingLimitMicroUsd: microUsd(input.monthlySpendingLimitUsd),
            }),
            updatedAt: new Date(),
          })
          .where(eq(aiClientSettings.tenantId, tenant.id));
        const cleared = AI_FEATURES.filter((f) => input.features && Object.hasOwn(input.features, f) && input.features[f] === null);
        if (cleared.length > 0) {
          await tx.delete(aiClientFeatures).where(and(eq(aiClientFeatures.tenantId, tenant.id), inArray(aiClientFeatures.feature, cleared)));
        }
        for (const feature of AI_FEATURES) {
          const choice = input.features?.[feature];
          if (!choice) continue;
          const values = { connectionId: choice.connectionId, model: choice.model, quickModel: choice.quickModel, updatedAt: new Date() };
          await tx
            .insert(aiClientFeatures)
            .values({ tenantId: tenant.id, feature, ...values })
            .onConflictDoUpdate({ target: [aiClientFeatures.tenantId, aiClientFeatures.feature], set: values });
        }
        const after = await readClientAi(tx, tenant.id);

        // Trustline's log: every stored field that changed.
        const changes: Record<string, unknown> = {};
        const field = (key: string, from: unknown, to: unknown) => {
          if (!same(from, to)) changes[key] = { from, to };
        };
        field('offered', before.settings?.offered ?? false, after.settings?.offered ?? false);
        for (const feature of AI_FEATURES) field(`features.${feature}`, choiceOf(before, feature), choiceOf(after, feature));
        field('allowanceOverrides', before.settings?.allowanceOverrides ?? {}, after.settings?.allowanceOverrides ?? {});
        field('medicalOptionAllowed', before.settings?.medicalOptionAllowed ?? false, after.settings?.medicalOptionAllowed ?? false);
        field(
          'monthlySpendingLimitUsd',
          usd(before.settings?.monthlySpendingLimitMicroUsd ?? null),
          usd(after.settings?.monthlySpendingLimitMicroUsd ?? null),
        );
        if (Object.keys(changes).length === 0) return this.view(tx, tenant);
        await this.auth.audit(admin.id, 'ai_client_settings_updated', tenant.id, { changes }, tx);

        // The client's log: what it can see change. Not its spending limit,
        // which is Trustline's control of its own costs.
        const seen: Record<string, unknown> = {};
        const offered = { from: before.settings?.offered ?? false, to: after.settings?.offered ?? false };
        if (offered.from !== offered.to) seen.offered = offered;
        const features = Object.fromEntries(
          AI_FEATURES.filter((f) => !same(seenChoiceOf(before, f), seenChoiceOf(after, f))).map((f) => [
            f,
            { from: seenChoiceOf(before, f), to: seenChoiceOf(after, f) },
          ]),
        );
        if (Object.keys(features).length > 0) seen.features = features;
        const allowances = Object.fromEntries(
          AI_FEATURES.filter((f) => before.allowances[f] !== after.allowances[f]).map((f) => [
            f,
            { from: before.allowances[f], to: after.allowances[f] },
          ]),
        );
        if (Object.keys(allowances).length > 0) seen.allowances = allowances;
        if ((before.settings?.medicalOptionAllowed ?? false) !== (after.settings?.medicalOptionAllowed ?? false)) {
          seen.medicalOptionAllowed = { from: before.settings?.medicalOptionAllowed ?? false, to: after.settings?.medicalOptionAllowed ?? false };
        }
        if (Object.keys(seen).length > 0) {
          await this.provisioning.auditAiSettingsChange(tx, tenant.id, {
            ...seen,
            platformAdminId: admin.id,
            platformAdminName: admin.name,
          });
        }

        // A change of provider: a feature now served by another
        // connection, or by none, or by one where there was none; or AI
        // offered or withdrawn as a whole.
        const providerOf = (ai: ClientAi, f: AiFeature) => (ai.settings?.offered ? (ai.features[f]?.connection.id ?? null) : null);
        const moved = AI_FEATURES.filter((f) => providerOf(before, f) !== providerOf(after, f));
        if (moved.length > 0 && (await this.entitlements.mayUse(appTx, tenant.id, 'ai_assistant'))) {
          await this.tellAdministrators(appTx, tenant.id, moved);
        }
        return this.view(tx, tenant);
      }),
    );
  }

  /** To the holders of `settings.manage` for the whole organization. */
  private async tellAdministrators(appTx: Transaction, tenantId: string, features: AiFeature[]) {
    const holders = await this.access.holders(appTx, ['settings.manage'], []);
    const to = [...holders.everywhere('settings.manage')];
    if (to.length === 0) return;
    await appTx.insert(notifications).values(
      to.map((userId) => ({
        tenantId,
        userId,
        kind: 'ai_provider_changed' as const,
        data: { features: features.join(','), serious: false },
      })),
    );
  }

  private async view(db: Database | Transaction, tenant: { id: string; timeZone: string }) {
    const ai = await readClientAi(db, tenant.id);
    const month = monthOf(new Date(), tenant.timeZone);
    const usage = await usageOf(db, tenant.id, month);
    return {
      tenantId: tenant.id,
      offered: ai.settings?.offered ?? false,
      features: Object.fromEntries(
        AI_FEATURES.map((f) => {
          const choice = ai.features[f];
          return [
            f,
            choice
              ? {
                  connection: {
                    id: choice.connection.id,
                    name: choice.connection.name,
                    ...whereOf(choice.connection),
                    active: choice.connection.active,
                  },
                  model: choice.model,
                  quickModel: choice.quickModel,
                }
              : null,
          ];
        }),
      ),
      planAllowances: ai.planAllowances,
      allowanceOverrides: ai.settings?.allowanceOverrides ?? {},
      allowances: ai.allowances,
      medicalOptionAllowed: ai.settings?.medicalOptionAllowed ?? false,
      monthlySpendingLimitUsd: usd(ai.settings?.monthlySpendingLimitMicroUsd ?? null),
      clientEnabled: ai.settings?.clientEnabled ?? false,
      clientSwitchedAt: ai.settings?.clientSwitchedAt ?? null,
      month,
      usage: Object.fromEntries(
        AI_FEATURES.map((f) => [
          f,
          { used: usage.byFeature[f].used, requests: usage.byFeature[f].requests, costUsd: usd(usage.byFeature[f].costMicroUsd) },
        ]),
      ),
      costUsd: usd(usage.costMicroUsd),
    };
  }

  private async tenantOf(db: Database | Transaction, id: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    const [tenant] = await db.select({ id: tenants.id, timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, parsed.data));
    if (!tenant) throw new NotFoundException();
    return tenant;
  }
}
