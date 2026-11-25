import { Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import { tenants } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from './auth.service.js';
import { ProvisioningService } from './provisioning.service.js';

/**
 * The settings of a hospital that the hospital itself may change. The rest of
 * its record belongs to the admin portal, and the application role cannot
 * write it.
 */
@Injectable()
export class TenantSettingsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * Switches reporting without sign-in on or off for the caller's hospital.
   * Inside the hospital's own transaction: the database lets the application
   * change this on no other client's record. Asking for what is already so
   * writes nothing.
   */
  async setPublicReporting(auth: AuthContext, publicReporting: boolean) {
    const { tenant, user } = auth;
    await this.tenantDb.withTenant(tenant.id, async (tx) => {
      // One statement reads the old value and writes the new, so two people
      // switching at once leave one audit entry each for a real change.
      const changed = await tx
        .update(tenants)
        .set({ publicReporting })
        .where(
          and(
            eq(tenants.id, tenant.id),
            ne(tenants.publicReporting, publicReporting),
          ),
        )
        .returning({ id: tenants.id });
      if (changed.length === 0) return;
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'public_reporting_changed',
        'tenant',
        tenant.id,
        { from: !publicReporting, to: publicReporting },
      );
    });
    return { publicReporting, slug: tenant.slug };
  }
}
