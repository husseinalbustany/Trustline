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
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { subscriptions, tenants } from '../database/schema.js';
import { dayOf, shiftDay } from '../i18n/time-zones.js';
import { EXIT_WINDOW_DAYS } from '../subscriptions/entitlements.service.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
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
    // Cancelling ends every session and every one-time link of the client,
    // as the application role, which alone may write them. Its transaction
    // is opened around the platform's and written before the platform's
    // commits, so a change that fails revokes nothing and a revocation that
    // fails changes nothing. Neither is what keeps them ended: a session or
    // link issued before the subscription last went to or from cancelled is
    // refused whenever it is used (AuthService), so a subscription made
    // active again brings none of them back.
    const after = await this.tenantDb.withTenant(tenantId, (appTx) =>
      this.db.transaction(async (tx) => {
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
        if (
          result.after.status === 'cancelled' &&
          result.before.status !== 'cancelled'
        ) {
          await this.provisioning.endAllAccess(appTx);
          await this.openExitWindow(tx, tenantId, req.platformAdmin);
        }
        // Made active again: the exit window and the retention of a
        // cancellation that is over are cleared (security review 20, M4).
        if (result.before.status === 'cancelled' && result.after.status !== 'cancelled') {
          await this.clearExitWindow(tx, tenantId, req.platformAdmin);
        }
        return result.after;
      }),
    );
    return { ...after, usage: await this.usage(tenantId) };
  }

  /**
   * On cancelling: the exit window, 90 days from today on the client's
   * calendar unless staff set one already, and the retention date at its
   * end unless set (docs/specs/data-export.md; business decision). In both
   * logs, as the contract's dates are.
   */
  private async openExitWindow(tx: Transaction, tenantId: string, admin: { id: string; name: string }) {
    const [row] = await tx
      .select({ exitUntil: subscriptions.exitUntil, retainUntil: subscriptions.retainUntil, timeZone: tenants.timeZone })
      .from(subscriptions)
      .innerJoin(tenants, eq(tenants.id, subscriptions.tenantId))
      .where(eq(subscriptions.tenantId, tenantId));
    if (!row) return;
    // A window already set that ends today or later stands; one that has
    // ended, from an earlier cancellation, gives way to a new one (security
    // review 20, M4).
    const today = dayOf(new Date(), row.timeZone);
    if (row.exitUntil && row.exitUntil >= today) return;
    const exitUntil = shiftDay(today, EXIT_WINDOW_DAYS);
    const retainUntil = row.retainUntil && row.retainUntil >= exitUntil ? row.retainUntil : exitUntil;
    await tx.update(subscriptions).set({ exitUntil, retainUntil }).where(eq(subscriptions.tenantId, tenantId));
    await this.auth.audit(admin.id, 'exit_window_set', tenantId, { from: row.exitUntil, to: exitUntil }, tx);
    if (retainUntil !== row.retainUntil) {
      await this.auth.audit(admin.id, 'retention_set', tenantId, { from: row.retainUntil, to: retainUntil }, tx);
    }
    await tx.execute(sql`
      insert into audit_log (tenant_id, action, entity_type, entity_id, changes)
      values (${tenantId}, 'contract_end_set', 'tenant', ${tenantId}, ${JSON.stringify({
        exitUntil: { from: row.exitUntil, to: exitUntil },
        ...(retainUntil !== row.retainUntil && { retainUntil: { from: row.retainUntil, to: retainUntil } }),
        platformAdminId: admin.id,
        platformAdminName: admin.name,
      })}::jsonb)`);
  }

  /** The exit window and retention cleared, in both logs, when a cancelled client is made active again. */
  private async clearExitWindow(tx: Transaction, tenantId: string, admin: { id: string; name: string }) {
    const [row] = await tx
      .select({ exitUntil: subscriptions.exitUntil, retainUntil: subscriptions.retainUntil })
      .from(subscriptions)
      .where(eq(subscriptions.tenantId, tenantId));
    if (!row || (!row.exitUntil && !row.retainUntil)) return;
    await tx.update(subscriptions).set({ exitUntil: null, retainUntil: null }).where(eq(subscriptions.tenantId, tenantId));
    if (row.exitUntil) await this.auth.audit(admin.id, 'exit_window_set', tenantId, { from: row.exitUntil, to: null }, tx);
    if (row.retainUntil) await this.auth.audit(admin.id, 'retention_set', tenantId, { from: row.retainUntil, to: null }, tx);
    await tx.execute(sql`
      insert into audit_log (tenant_id, action, entity_type, entity_id, changes)
      values (${tenantId}, 'contract_end_set', 'tenant', ${tenantId}, ${JSON.stringify({
        ...(row.exitUntil && { exitUntil: { from: row.exitUntil, to: null } }),
        ...(row.retainUntil && { retainUntil: { from: row.retainUntil, to: null } }),
        platformAdminId: admin.id,
        platformAdminName: admin.name,
      })}::jsonb)`);
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
