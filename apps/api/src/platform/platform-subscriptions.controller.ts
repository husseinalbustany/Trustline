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
import { isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import { sessions } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { OrgUnitsService } from '../organization/org-units.service.js';
import { ForModule } from '../subscriptions/module.decorator.js';
import { updateSubscriptionSchema } from '../subscriptions/subscription-input.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import {
  PlatformAuthGuard,
  type PlatformRequest,
} from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';

/**
 * A client's subscription, for Trustline's staff: read it, with what it
 * makes and what the client uses of its limits, and change it. Every change
 * is written to the platform audit log, and what the client sees change to
 * the client's own, in the same transaction.
 */
@Controller('platform/tenants/:id/subscription')
@UseGuards(PlatformAuthGuard)
@ForModule('core')
export class PlatformSubscriptionsController {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly subscriptions: SubscriptionsService,
    private readonly auth: PlatformAuthService,
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly orgUnits: OrgUnitsService,
  ) {}

  @Get()
  async get(@Param('id') id: string) {
    const tenantId = this.parseId(id);
    const subscription = await this.subscriptions.read(tenantId);
    return { ...subscription, usage: await this.usage(tenantId) };
  }

  @Patch()
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const tenantId = this.parseId(id);
    const parsed = updateSubscriptionSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      throw new BadRequestException();
    }
    const { before, after, changes } = await this.db.transaction(async (tx) => {
      const result = await this.subscriptions.change(
        tx,
        tenantId,
        parsed.data,
        req.platformAdmin,
      );
      if (Object.keys(result.changes).length > 0) {
        await this.auth.audit(
          req.platformAdmin.id,
          'subscription_updated',
          tenantId,
          { changes: result.changes },
          tx,
        );
      }
      return result;
    });
    // Cancelling ends every session, as suspending a client does, so that
    // a subscription made active again does not revive them.
    if (
      changes.status &&
      after.status === 'cancelled' &&
      before.status !== 'cancelled'
    ) {
      await this.tenantDb.withTenant(tenantId, (tx) =>
        tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(isNull(sessions.revokedAt)),
      );
    }
    return { ...after, usage: await this.usage(tenantId) };
  }

  /** What the client uses of the limits that are counted. */
  private usage(tenantId: string) {
    return this.tenantDb.withTenant(tenantId, async (tx) => ({
      users: await this.provisioning.countNamedUsers(tx),
      sites: await this.orgUnits.countSites(tx),
    }));
  }

  private parseId(id: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    return parsed.data;
  }
}
