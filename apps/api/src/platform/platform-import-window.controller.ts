import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Transaction } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import { policyImportWindows, tenants } from '../database/schema.js';
import { line } from '../i18n/text.js';
import { dayOf, shiftDay } from '../i18n/time-zones.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { importWindowOf } from '../policies/import-window.js';
import { ForModule } from '../subscriptions/module.decorator.js';
import {
  PlatformAuthGuard,
  type PlatformRequest,
} from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';

/** How far ahead a window may be set: a year and a day. */
const MAX_DAYS_AHEAD = 366;

const windowSchema = z.strictObject({
  closesOn: z.iso.date(),
  reason: line(1, 500),
});

/**
 * The window in which a client may import its existing documents (security
 * review 7, finding 2), for Trustline's staff: open for 90 days from the
 * day the policies module was first switched on, unless staff set another
 * last day, to reopen it or close it, with a reason. Each change is written
 * to the platform audit log and to the client's own, in the same
 * transaction.
 */
@Controller('platform/tenants/:id/import-window')
@UseGuards(PlatformAuthGuard)
@ForModule('core')
export class PlatformImportWindowController {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly auth: PlatformAuthService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Get()
  async get(@Param('id') id: string) {
    const tenant = await this.tenantOf(this.db, id);
    return this.view(this.db, tenant);
  }

  /**
   * Sets the last day imports are accepted: from the module's first day
   * (which closes it at once if that is past) to a year and a day from
   * today, on the client's calendar (400 `invalid_closes_on` with the
   * `earliest` and `latest`). 409 `policies_never_on` for a client that has
   * never had the module: its window starts when it first has it.
   */
  @Put()
  async set(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const parsed = windowSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const { closesOn, reason } = parsed.data;
    return this.db.transaction(async (tx) => {
      // One change at a time per client: the client's row is held, so that
      // what each change is audited as having been is what it was.
      const tenant = await this.tenantOf(tx, id, true);
      const before = await importWindowOf(tx, tenant);
      if (!before.startRecorded) {
        throw new ConflictException({ code: 'policies_never_on' });
      }
      const latest = shiftDay(dayOf(new Date(), tenant.timeZone), MAX_DAYS_AHEAD);
      if (closesOn < before.startedOn || closesOn > latest) {
        throw new BadRequestException({
          code: 'invalid_closes_on',
          earliest: before.startedOn,
          latest,
        });
      }
      const admin = req.platformAdmin;
      await tx
        .insert(policyImportWindows)
        .values({ tenantId: tenant.id, closesOn, reason, setBy: admin.id })
        .onConflictDoUpdate({
          target: policyImportWindows.tenantId,
          set: { closesOn, reason, setBy: admin.id, setAt: new Date() },
        });
      const change = { closesOn: { from: before.closesOn, to: closesOn }, reason };
      await this.auth.audit(admin.id, 'import_window_set', tenant.id, change, tx);
      await this.provisioning.auditImportWindowChange(tx, tenant.id, {
        ...change,
        platformAdminId: admin.id,
        platformAdminEmail: admin.email,
      });
      return this.view(tx, tenant);
    });
  }

  private async view(db: Database | Transaction, tenant: { id: string; timeZone: string }) {
    const window = await importWindowOf(db, tenant);
    const [set] = await db
      .select({
        reason: policyImportWindows.reason,
        setBy: policyImportWindows.setBy,
        setAt: policyImportWindows.setAt,
      })
      .from(policyImportWindows)
      .where(eq(policyImportWindows.tenantId, tenant.id));
    return {
      // Null for a client that has never had the module.
      startedOn: window.startRecorded ? window.startedOn : null,
      closesOn: window.startRecorded ? window.closesOn : null,
      latestApprovedOn: window.startRecorded ? window.latestApprovedOn : null,
      open: window.startRecorded && window.open,
      setByTrustline: window.setByTrustline,
      reason: set?.reason ?? null,
      setBy: set?.setBy ?? null,
      setAt: set?.setAt ?? null,
    };
  }

  private async tenantOf(db: Database | Transaction, id: string, lock = false) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    const query = db
      .select({ id: tenants.id, timeZone: tenants.timeZone })
      .from(tenants)
      .where(eq(tenants.id, parsed.data));
    const [tenant] = lock ? await query.for('update') : await query;
    if (!tenant) throw new NotFoundException();
    return tenant;
  }
}
