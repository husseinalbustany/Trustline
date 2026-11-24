import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { orgUnits } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { SessionGuard, type AuthedRequest } from '../identity/session.guard.js';

@Controller('org-units')
@UseGuards(SessionGuard)
export class OrgUnitsController {
  constructor(private readonly tenantDb: TenantDb) {}

  /** The organization's facilities, departments and units. */
  @Get()
  list(@Req() req: AuthedRequest) {
    return this.tenantDb.withTenant(req.auth.tenant.id, (tx) =>
      tx
        .select({
          id: orgUnits.id,
          parentId: orgUnits.parentId,
          type: orgUnits.type,
          code: orgUnits.code,
          name: orgUnits.name,
        })
        .from(orgUnits)
        .orderBy(asc(orgUnits.code)),
    );
  }
}
