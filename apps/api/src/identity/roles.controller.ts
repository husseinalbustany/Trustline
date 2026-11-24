import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { pgErrorCode } from '../database/errors.js';
import { roleAssignments, roles } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import {
  fitsLanguages,
  localizedText,
  optionalLocalizedText,
  type Localized,
} from '../i18n/locales.js';
import { PERMISSIONS, type Permission } from './permissions.js';
import { ProvisioningService } from './provisioning.service.js';
import { covers } from './scope.js';
import {
  requireEverywhere,
  requirePermission,
  SessionGuard,
  type AuthedRequest,
} from './session.guard.js';

const fields = {
  name: localizedText(100),
  description: optionalLocalizedText(500),
  permissions: z
    .array(z.enum(PERMISSIONS))
    .transform((list) => [...new Set(list)].sort()),
};

const createSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,48}[a-z0-9]$/),
  ...fields,
});

const updateSchema = z.strictObject(fields).partial();

@Controller('roles')
@UseGuards(SessionGuard)
export class RolesController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * Anyone managing users needs the list, to assign roles; holding either
   * right anywhere is enough to read it. Writing a role is different: it
   * changes what its holders may do across the hospital, so every write
   * below needs `roles.manage` for the whole organization.
   */
  @Get()
  async list(@Req() req: AuthedRequest) {
    if (!req.auth.permissions.includes('users.manage')) {
      requirePermission(req, 'roles.manage');
    }
    const list = await this.tenantDb.withTenant(req.auth.tenant.id, (tx) =>
      tx
        .select({
          id: roles.id,
          code: roles.code,
          name: roles.name,
          description: roles.description,
          isSystem: roles.isSystem,
          permissions: roles.permissions,
          assignments: count(roleAssignments.id),
        })
        .from(roles)
        .leftJoin(roleAssignments, eq(roleAssignments.roleId, roles.id))
        .groupBy(roles.id)
        .orderBy(asc(roles.code)),
    );
    return { roles: list, permissions: PERMISSIONS };
  }

  /**
   * Nobody builds a role that allows more than they may do themselves. A role
   * belongs to the hospital as a whole and can be granted anywhere in it, so
   * each of its permissions must be one the actor holds for the whole
   * organization: holding it for one department is not enough.
   */
  private assertWithinOwn(req: AuthedRequest, permissions?: Permission[]) {
    if (permissions?.some((p) => !covers(req.auth, p, null))) {
      throw new ForbiddenException({ code: 'cannot_grant_higher_access' });
    }
  }

  /** A role is named in the client's default language, in its languages only. */
  private assertLanguages(
    req: AuthedRequest,
    data: { name?: Localized; description?: Localized | null },
  ) {
    const { tenant } = req.auth;
    const nameFits = !data.name || fitsLanguages(data.name, tenant);
    const descriptionFits = fitsLanguages(data.description, tenant, {
      required: false,
    });
    if (!nameFits || !descriptionFits) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'roles.manage');
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    this.assertWithinOwn(req, parsed.data.permissions);
    this.assertLanguages(req, parsed.data);
    const { tenant, user: actor } = req.auth;
    try {
      return await this.tenantDb.withTenant(tenant.id, async (tx) => {
        const [role] = await tx
          .insert(roles)
          .values({ ...parsed.data, tenantId: tenant.id })
          .returning();
        await this.provisioning.audit(
          tx,
          tenant.id,
          actor.id,
          'role_created',
          'role',
          role.id,
          { code: role.code, permissions: role.permissions },
        );
        return role;
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') {
        throw new ConflictException({ code: 'code_taken' });
      }
      throw e;
    }
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requireEverywhere(req, 'roles.manage');
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      throw new BadRequestException();
    }
    this.assertWithinOwn(req, parsed.data.permissions);
    this.assertLanguages(req, parsed.data);
    const { tenant, user: actor } = req.auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const role = await this.editable(tx, id, actor.id);
      const [updated] = await tx
        .update(roles)
        .set(parsed.data)
        .where(eq(roles.id, role.id))
        .returning();
      await this.provisioning.audit(
        tx,
        tenant.id,
        actor.id,
        'role_updated',
        'role',
        role.id,
        {
          changed: Object.keys(parsed.data),
          before: role.permissions,
          after: updated.permissions,
        },
      );
      return updated;
    });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'roles.manage');
    const { tenant, user: actor } = req.auth;
    await this.tenantDb.withTenant(tenant.id, async (tx) => {
      const role = await this.editable(tx, id, actor.id);
      try {
        // A savepoint, so a refusal here leaves the transaction usable.
        await tx.transaction((sp) =>
          sp.delete(roles).where(eq(roles.id, role.id)),
        );
      } catch (e) {
        // Still granted to someone: the foreign key refuses the delete.
        if (pgErrorCode(e) === '23503') {
          throw new ConflictException({ code: 'role_in_use' });
        }
        throw e;
      }
      await this.provisioning.audit(
        tx,
        tenant.id,
        actor.id,
        'role_deleted',
        'role',
        role.id,
        { code: role.code },
      );
    });
  }

  /**
   * The role, if it exists here, is not built in, and is not one the actor
   * holds: editing your own role would be changing your own access.
   */
  private async editable(
    tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0],
    id: string,
    actorId: string,
  ) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    const [role] = await tx
      .select()
      .from(roles)
      .where(eq(roles.id, parsed.data));
    if (!role) throw new NotFoundException();
    if (role.isSystem) throw new ConflictException({ code: 'system_role' });
    const [own] = await tx
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.roleId, role.id),
          eq(roleAssignments.userId, actorId),
        ),
      )
      .limit(1);
    if (own) throw new ConflictException({ code: 'cannot_change_own_role' });
    return role;
  }
}
