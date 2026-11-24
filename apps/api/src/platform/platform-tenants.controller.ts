import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import {
  platformAdmins,
  platformAuditLog,
  tenants,
} from '../database/schema.js';
import {
  PlatformAuthGuard,
  type PlatformRequest,
} from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { pgErrorCode } from '../database/errors.js';
import { roleAssignments, roles, sessions, users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';

const name = z.string().trim().min(1).max(200);

const settings = {
  nameEn: name,
  nameAr: name,
  accreditationStandard: z.enum(['JCI', 'CBAHI']),
  defaultLocale: z.enum(['en', 'ar']),
  plan: z.enum(['starter', 'professional', 'enterprise']),
  signInMethod: z.enum(['password', 'sso', 'both']),
  dataRegion: z
    .string()
    .trim()
    .max(100)
    .nullable()
    .transform((v) => v || null),
};

const createSchema = z.strictObject({
  // Lowercase letters, digits and hyphens. Fixed once created.
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/),
  ...settings,
});

const updateSchema = z
  .strictObject({ ...settings, status: z.enum(['active', 'suspended']) })
  .partial();

const idSchema = z.uuid();

const administratorSchema = z.strictObject({
  nameEn: name,
  nameAr: name,
  email: z.email().max(320),
});

const isUniqueViolation = (e: unknown) => pgErrorCode(e) === '23505';

@Controller('platform/tenants')
@UseGuards(PlatformAuthGuard)
export class PlatformTenantsController {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly auth: PlatformAuthService,
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Get()
  list() {
    return this.db.select().from(tenants).orderBy(asc(tenants.nameEn));
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    try {
      // The client and its audit entry are saved together or not at all.
      const tenant = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(tenants)
          .values(parsed.data)
          .returning();
        await this.auth.audit(
          req.platformAdmin.id,
          'client_created',
          created.id,
          { slug: created.slug },
          tx,
        );
        return created;
      });
      // Safe to repeat: creating an administrator runs it again.
      await this.tenantDb.withTenant(tenant.id, (tx) =>
        this.provisioning.ensureSystemRoles(tx, tenant.id),
      );
      return tenant;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException({ code: 'slug_taken' });
      }
      throw e;
    }
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, this.parseId(id)));
    if (!tenant) throw new NotFoundException();

    const activity = await this.db
      .select({
        id: platformAuditLog.id,
        action: platformAuditLog.action,
        details: platformAuditLog.details,
        createdAt: platformAuditLog.createdAt,
        adminName: platformAdmins.name,
      })
      .from(platformAuditLog)
      .leftJoin(platformAdmins, eq(platformAdmins.id, platformAuditLog.adminId))
      .where(eq(platformAuditLog.targetTenantId, tenant.id))
      .orderBy(desc(platformAuditLog.createdAt))
      .limit(20);

    return { ...tenant, activity };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      throw new BadRequestException();
    }
    const tenantId = this.parseId(id);
    const tenant = await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!before) throw new NotFoundException();
      const [after] = await tx
        .update(tenants)
        .set(parsed.data)
        .where(eq(tenants.id, tenantId))
        .returning();
      // What changed, with the old and new value of each field.
      const changes = Object.fromEntries(
        (Object.keys(parsed.data) as (keyof typeof parsed.data)[])
          .filter((key) => before[key] !== after[key])
          .map((key) => [key, { from: before[key], to: after[key] }]),
      );
      await this.auth.audit(
        req.platformAdmin.id,
        'client_updated',
        tenantId,
        { changes },
        tx,
      );
      return after;
    });

    // Suspension ends every session, so reactivating does not revive them.
    if (parsed.data.status === 'suspended') {
      await this.tenantDb.withTenant(tenant.id, (tx) =>
        tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(isNull(sessions.revokedAt)),
      );
    }
    return tenant;
  }

  /**
   * Creates a hospital's first administrator and returns a one-time link for
   * them to set a password. This is the only hospital data the portal writes,
   * and it is refused once the hospital has an administrator: from then on
   * the hospital adds its own, and the portal cannot let itself in.
   */
  @Post(':id/administrators')
  async createAdministrator(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const parsed = administratorSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, this.parseId(id)));
    if (!tenant) throw new NotFoundException();
    if (tenant.status !== 'active') {
      throw new ConflictException({ code: 'client_suspended' });
    }
    // The link sets a password, which a single sign-on only client cannot use.
    if (tenant.signInMethod === 'sso') {
      throw new ConflictException({ code: 'password_sign_in_disabled' });
    }

    try {
      const result = await this.tenantDb.withTenant(tenant.id, async (tx) => {
        await this.provisioning.ensureSystemRoles(tx, tenant.id);
        const [administrator] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.code, 'administrator'));
        const [existing] = await tx
          .select({ id: users.id })
          .from(roleAssignments)
          .innerJoin(users, eq(users.id, roleAssignments.userId))
          .where(
            and(
              eq(roleAssignments.roleId, administrator.id),
              ne(users.status, 'disabled'),
            ),
          )
          .limit(1);
        if (existing) {
          throw new ConflictException({ code: 'administrator_exists' });
        }
        // Recorded first, on the portal's side, so the account can never
        // exist without a record of which staff member created it.
        await this.auth.audit(
          req.platformAdmin.id,
          'client_administrator_created',
          tenant.id,
          { email: parsed.data.email.trim().toLowerCase() },
        );
        const user = await this.provisioning.createUser(
          tx,
          tenant.id,
          parsed.data,
          [{ roleId: administrator.id, orgUnitId: null }],
          null,
        );
        const invite = await this.provisioning.createInvite(
          tx,
          tenant.id,
          user.id,
          'invitation',
        );
        // The hospital's own log says the account came from Trustline staff.
        await this.provisioning.audit(
          tx,
          tenant.id,
          null,
          'administrator_created_by_platform',
          'user',
          user.id,
          {
            platformAdminId: req.platformAdmin.id,
            platformAdminEmail: req.platformAdmin.email,
          },
        );
        return {
          user: { id: user.id, email: user.email, nameEn: user.nameEn },
          invite: { ...invite, org: tenant.slug },
        };
      });
      return result;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException({ code: 'email_taken' });
      }
      throw e;
    }
  }

  private parseId(id: string) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    return parsed.data;
  }
}
