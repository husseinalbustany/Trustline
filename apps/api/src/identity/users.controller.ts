import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Transaction } from '../database/client.js';
import { roleAssignments, roles, sessions, users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { pgErrorCode } from '../database/errors.js';
import { fitsLanguages, localizedText } from '../i18n/locales.js';
import { ProvisioningService, type RoleGrant } from './provisioning.service.js';
import {
  requirePermission,
  SessionGuard,
  type AuthedRequest,
} from './session.guard.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

const profile = {
  name: localizedText(200),
  orgUnitId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  employeeNumber: optionalText(50),
  jobTitle: optionalText(200),
  phone: optionalText(50),
};

const grantsSchema = z
  .array(
    z.strictObject({
      roleId: z.uuid(),
      orgUnitId: z
        .uuid()
        .nullish()
        .transform((v) => v ?? null),
    }),
  )
  .max(50)
  // The same role in the same place counts once.
  .transform((list) => [
    ...new Map(list.map((g) => [`${g.roleId}:${g.orgUnitId}`, g])).values(),
  ]);

const createSchema = z.strictObject({
  ...profile,
  email: z.email().max(320),
  roles: grantsSchema,
});

const updateSchema = z
  .strictObject({ ...profile, status: z.enum(['active', 'disabled']) })
  .partial();

const rolesSchema = z.strictObject({ roles: grantsSchema });

const publicUser = {
  id: users.id,
  name: users.name,
  email: users.email,
  orgUnitId: users.orgUnitId,
  employeeNumber: users.employeeNumber,
  jobTitle: users.jobTitle,
  phone: users.phone,
  status: users.status,
  lockedUntil: users.lockedUntil,
  lastSignInAt: users.lastSignInAt,
  createdAt: users.createdAt,
};

@Controller('users')
@UseGuards(SessionGuard)
export class UsersController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  private async withRoles(tx: Transaction, userId?: string) {
    const list = await tx
      .select(publicUser)
      .from(users)
      .where(userId ? eq(users.id, userId) : undefined)
      .orderBy(asc(users.email));
    const grants = await tx
      .select({
        userId: roleAssignments.userId,
        roleId: roleAssignments.roleId,
        orgUnitId: roleAssignments.orgUnitId,
        code: roles.code,
        name: roles.name,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(userId ? eq(roleAssignments.userId, userId) : undefined);
    return list.map((user) => ({
      ...user,
      roles: grants
        .filter((g) => g.userId === user.id)
        .map((g) => ({
          roleId: g.roleId,
          orgUnitId: g.orgUnitId,
          code: g.code,
          name: g.name,
        })),
    }));
  }

  /**
   * Refuses to hand out roles that allow more than the actor may do. Without
   * this, anyone who manages users could make an administrator.
   */
  private async assertCanGrant(
    tx: Transaction,
    req: AuthedRequest,
    grants: RoleGrant[],
  ) {
    const wanted = await this.provisioning.permissionsOfRoles(
      tx,
      grants.map((g) => g.roleId),
    );
    if (wanted === null) throw new BadRequestException();
    if (!wanted.every((p) => req.auth.permissions.includes(p))) {
      throw new ForbiddenException({ code: 'cannot_grant_higher_access' });
    }
  }

  /**
   * Refuses to act on someone who may do more than the actor. Without this,
   * a reset link would let a user manager take over an administrator.
   */
  private async assertCanManage(
    tx: Transaction,
    req: AuthedRequest,
    userId: string,
  ) {
    const theirs = await this.provisioning.permissionsOfUser(tx, userId);
    if (!theirs.every((p) => req.auth.permissions.includes(p))) {
      throw new ForbiddenException({ code: 'cannot_manage_higher_access' });
    }
  }

  /** Turns a database refusal into the right client error. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      const code = pgErrorCode(e);
      if (code === '23505')
        throw new ConflictException({ code: 'email_taken' });
      // A role or department that does not exist in this organization.
      if (code === '23503') throw new BadRequestException();
      throw e;
    }
  }

  @Get()
  list(@Req() req: AuthedRequest) {
    requirePermission(req, 'users.manage');
    return this.tenantDb.withTenant(req.auth.tenant.id, (tx) =>
      this.withRoles(tx),
    );
  }

  @Post()
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    requirePermission(req, 'users.manage');
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const { roles: grants, ...input } = parsed.data;
    const { tenant, user: actor } = req.auth;
    if (!fitsLanguages(input.name, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }

    return this.guarded(() =>
      this.tenantDb.withTenant(tenant.id, async (tx) => {
        await this.assertCanGrant(tx, req, grants);
        const user = await this.provisioning.createUser(
          tx,
          tenant.id,
          input,
          grants,
          actor.id,
        );
        const invite = await this.provisioning.createInvite(
          tx,
          tenant.id,
          user.id,
          'invitation',
        );
        const [created] = await this.withRoles(tx, user.id);
        return { user: created, invite: { ...invite, org: tenant.slug } };
      }),
    );
  }

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: AuthedRequest) {
    requirePermission(req, 'users.manage');
    const userId = this.parseId(id);
    const [user] = await this.tenantDb.withTenant(req.auth.tenant.id, (tx) =>
      this.withRoles(tx, userId),
    );
    if (!user) throw new NotFoundException();
    return user;
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'users.manage');
    const userId = this.parseId(id);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      throw new BadRequestException();
    }
    const { status, ...fields } = parsed.data;
    const { tenant, user: actor } = req.auth;
    if (fields.name && !fitsLanguages(fields.name, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
    if (status && userId === actor.id) {
      throw new ConflictException({ code: 'cannot_change_self' });
    }

    return this.guarded(() =>
      this.tenantDb.withTenant(tenant.id, async (tx) => {
        const [existing] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId));
        if (!existing) throw new NotFoundException();
        await this.assertCanManage(tx, req, userId);

        // Re-enabling returns someone who never set a password to "invited".
        const nextStatus =
          status === 'active' && !existing.passwordHash ? 'invited' : status;
        await tx
          .update(users)
          .set({
            ...fields,
            ...(nextStatus && { status: nextStatus }),
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        if (status === 'disabled') {
          await this.revokeSessions(tx, userId);
          // A link issued earlier must not work if they are enabled again.
          await this.provisioning.voidInvites(tx, userId);
        }

        await this.provisioning.audit(
          tx,
          tenant.id,
          actor.id,
          'user_updated',
          'user',
          userId,
          { changed: Object.keys(parsed.data), ...(status && { status }) },
        );
        const [updated] = await this.withRoles(tx, userId);
        return updated;
      }),
    );
  }

  @Put(':id/roles')
  setRoles(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    requirePermission(req, 'users.manage');
    const userId = this.parseId(id);
    const parsed = rolesSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const { tenant, user: actor } = req.auth;
    // Nobody removes or raises their own access.
    if (userId === actor.id) {
      throw new ConflictException({ code: 'cannot_change_self' });
    }

    return this.guarded(() =>
      this.tenantDb.withTenant(tenant.id, async (tx) => {
        const [existing] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, userId));
        if (!existing) throw new NotFoundException();
        await this.assertCanManage(tx, req, userId);
        await this.assertCanGrant(tx, req, parsed.data.roles);
        await this.provisioning.setRoles(
          tx,
          tenant.id,
          userId,
          parsed.data.roles,
          actor.id,
        );
        await this.provisioning.audit(
          tx,
          tenant.id,
          actor.id,
          'user_roles_changed',
          'user',
          userId,
          { roles: parsed.data.roles },
        );
        const [updated] = await this.withRoles(tx, userId);
        return updated;
      }),
    );
  }

  /** A new one-time link to set a password, for a first sign-in or a reset. */
  @Post(':id/invite')
  invite(@Param('id') id: string, @Req() req: AuthedRequest) {
    requirePermission(req, 'users.manage');
    const userId = this.parseId(id);
    const { tenant, user: actor } = req.auth;

    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const [existing] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId));
      if (!existing) throw new NotFoundException();
      await this.assertCanManage(tx, req, userId);
      if (existing.status === 'disabled') {
        throw new ConflictException({ code: 'user_disabled' });
      }
      const purpose = existing.passwordHash ? 'password_reset' : 'invitation';
      const invite = await this.provisioning.createInvite(
        tx,
        tenant.id,
        userId,
        purpose,
      );
      await this.provisioning.audit(
        tx,
        tenant.id,
        actor.id,
        'sign_in_link_created',
        'user',
        userId,
        { purpose },
      );
      return { ...invite, org: tenant.slug };
    });
  }

  private async revokeSessions(tx: Transaction, userId: string) {
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }

  private parseId(id: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    return parsed.data;
  }
}
