import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { aiClientSettings, users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import {
  requireEverywhere,
  SessionGuard,
  whileSuspended,
  type AuthedRequest,
} from '../identity/session.guard.js';
import { ForModule, OpenWhileSuspended } from '../subscriptions/module.decorator.js';
import { clientSwitchSchema } from './ai-input.js';
import {
  monthOf,
  nextMonthStarts,
  offerOf,
  readClientAi,
  usageOf,
  whereOf,
} from './client-ai.js';
import { AI_FEATURES, WARNING_SHARE } from './features.js';

/**
 * The client's AI, as its people see it (docs/specs/ai-providers-and-
 * allowances.md, "What the client sees"): whether AI is available and for
 * which features, which provider processes requests and where, the switch,
 * and the month's usage against each allowance. Of the AI module: a client
 * without it has no such route.
 */
@Controller('ai')
@UseGuards(SessionGuard)
@ForModule('ai_assistant')
export class AiSettingsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * Anyone signed in: what is offered, the provider and where it
   * processes, and whether the organization has switched AI on. Those who
   * hold `settings.manage` for the whole organization also see each
   * feature's model, why a feature is not offered, the month's usage
   * against each allowance, whether the medical option may be offered,
   * and who last switched AI on or off.
   */
  @Get('settings')
  settings(@Req() req: AuthedRequest) {
    return this.tenantDb.withTenant(req.auth.tenant.id, (tx) => this.view(tx, req));
  }

  /**
   * Switches AI on or off for the whole organization: `settings.manage`
   * for the whole organization. On only once Trustline offers at least one
   * feature (409 `ai_not_offered` otherwise). Audited (`ai_use_changed`).
   * While the subscription is suspended it can still be switched off, not
   * on.
   */
  @Put('settings')
  @OpenWhileSuspended()
  async switch(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    const parsed = clientSwitchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const { enabled } = parsed.data;
    await whileSuspended(req, () => !enabled);
    const { id: tenantId, modules } = req.auth.tenant;
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ clientEnabled: aiClientSettings.clientEnabled })
        .from(aiClientSettings)
        .where(eq(aiClientSettings.tenantId, tenantId))
        .for('update');
      if (enabled) {
        const client = await readClientAi(tx, tenantId);
        if (!row || !AI_FEATURES.some((f) => offerOf(client, modules, f).offered)) {
          throw new ConflictException({ code: 'ai_not_offered' });
        }
      }
      if (row && row.clientEnabled !== enabled) {
        await tx
          .update(aiClientSettings)
          .set({ clientEnabled: enabled, clientSwitchedBy: req.auth.user.id, clientSwitchedAt: new Date() })
          .where(eq(aiClientSettings.tenantId, tenantId));
        await this.provisioning.audit(tx, tenantId, req.auth.user.id, 'ai_use_changed', 'tenant', tenantId, {
          from: row.clientEnabled,
          to: enabled,
        });
      }
      return this.view(tx, req);
    });
  }

  private async view(tx: Transaction, req: AuthedRequest) {
    const { id: tenantId, modules, timeZone } = req.auth.tenant;
    const full = covers(req.auth, 'settings.manage', null);
    const client = await readClientAi(tx, tenantId);
    const enabled = client.settings?.clientEnabled ?? false;
    const month = monthOf(new Date(), timeZone);
    const usage = full ? await usageOf(tx, tenantId, month) : null;
    const features = AI_FEATURES.map((feature) => {
      const offer = offerOf(client, modules, feature);
      const choice = client.features[feature];
      const short = {
        feature,
        offered: offer.offered,
        // Offered and switched on: what the feature's screens ask.
        active: offer.offered && enabled,
        provider: offer.offered && choice ? whereOf(choice.connection) : null,
      };
      if (!full) return short;
      const allowance = client.allowances[feature];
      const used = usage!.byFeature[feature].used;
      return {
        ...short,
        reason: offer.offered ? null : offer.reason,
        model: offer.offered && choice ? choice.model : null,
        quickModel: offer.offered && choice ? choice.quickModel : null,
        allowance,
        used,
        warning: allowance !== null && allowance > 0 && used >= Math.ceil(allowance * WARNING_SHARE),
        reached: allowance !== null && used >= allowance,
      };
    });
    const answer = {
      available: features.some((f) => f.offered),
      enabled,
      features,
    };
    if (!full) return answer;
    let switchedBy = null;
    if (client.settings?.clientSwitchedBy) {
      const [person] = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, client.settings.clientSwitchedBy));
      switchedBy = person ?? null;
    }
    return {
      ...answer,
      month,
      resetsOn: nextMonthStarts(month),
      medicalOptionAllowed: client.settings?.medicalOptionAllowed ?? false,
      switchedBy,
      switchedAt: client.settings?.clientSwitchedAt ?? null,
    };
  }
}
