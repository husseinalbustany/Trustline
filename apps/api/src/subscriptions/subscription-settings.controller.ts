import {
  Controller,
  Get,
  NotFoundException,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TenantDb } from '../database/tenant-db.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import {
  requireEverywhere,
  SessionGuard,
  type AuthedRequest,
} from '../identity/session.guard.js';
import { OrgUnitsService } from '../organization/org-units.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { ForModule } from './module.decorator.js';
import { LIMITS, MODULES, type LimitKey } from './modules.js';

/**
 * What the client's own administrators are shown of its subscription: the
 * plan, which modules are on and off, each limit with what is used of it,
 * the status and the dates. Nothing commercial: no price, no note.
 */
@Controller('settings')
@UseGuards(SessionGuard)
@ForModule('core')
export class SubscriptionSettingsController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly entitlements: EntitlementsService,
    private readonly provisioning: ProvisioningService,
    private readonly orgUnits: OrgUnitsService,
  ) {}

  /** For the whole organization's settings managers, like every setting. */
  @Get('subscription')
  subscription(@Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    const { id } = req.auth.tenant;
    return this.tenantDb.withTenant(id, async (tx) => {
      const found = await this.entitlements.of(tx, id);
      if (!found) throw new NotFoundException();
      // Counted the way each limit counts them. Storage and AI credits are
      // not counted yet: nothing uses either.
      const used: Record<LimitKey, number | null> = {
        users: await this.provisioning.countNamedUsers(tx),
        sites: await this.orgUnits.countSites(tx),
        storageMb: null,
        aiCreditsPerMonth: null,
      };
      return {
        plan: { code: found.plan.code, name: found.plan.name },
        status: found.status,
        startsOn: found.startsOn,
        renewsOn: found.renewsOn,
        trialEndsOn: found.trialEndsOn,
        modules: MODULES.map((code) => ({
          code,
          enabled: found.modules.includes(code),
          // Where it comes from, when it is on.
          from: !found.modules.includes(code)
            ? null
            : found.planModules.includes(code)
              ? 'plan'
              : 'add_on',
        })),
        limits: Object.fromEntries(
          LIMITS.map((key) => [
            key,
            { max: found.limits[key], used: used[key] },
          ]),
        ),
      };
    });
  }
}
