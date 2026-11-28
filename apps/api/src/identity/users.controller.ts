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
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Transaction } from '../database/client.js';
import {
  orgUnits,
  roleAssignments,
  roles,
  sessions,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { pgErrorCode } from '../database/errors.js';
import { fitsLanguages, localizedText, sameText } from '../i18n/locales.js';
import { optionalLine } from '../i18n/text.js';
import { OrgUnitsService } from '../organization/org-units.service.js';
import type { Permission } from './permissions.js';
import { ProvisioningService, type RoleGrant } from './provisioning.service.js';
import { covers, mayGrant } from './scope.js';
import { SecurityNotices } from './security-notices.service.js';
import {
  requirePermission,
  SessionGuard,
  whileSuspended,
  type AuthedRequest,
} from './session.guard.js';
import {
  ForModule,
  OpenWhileSuspended,
} from '../subscriptions/module.decorator.js';

const profile = {
  name: localizedText(200),
  orgUnitId: z
    .uuid()
    .nullish()
    .transform((v) => v ?? null),
  // One line each, and no control characters: see text.ts.
  employeeNumber: optionalLine(50),
  jobTitle: optionalLine(200),
  phone: optionalLine(50),
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

// A user sits in one org unit and may hold roles for others.
const homeUnit = alias(orgUnits, 'home_unit');
const grantUnit = alias(orgUnits, 'grant_unit');

const publicUser = {
  id: users.id,
  name: users.name,
  email: users.email,
  orgUnitId: users.orgUnitId,
  // Named here, switched off or not, so a screen that lists only the units
  // in use can still show where someone is, and not move them by accident.
  // With its type, so the screen can say "department" or "unit" beside it.
  orgUnit: {
    id: homeUnit.id,
    type: homeUnit.type,
    name: homeUnit.name,
    active: homeUnit.active,
  },
  employeeNumber: users.employeeNumber,
  jobTitle: users.jobTitle,
  phone: users.phone,
  status: users.status,
  lockedUntil: users.lockedUntil,
  // The day only (UTC). The exact moment could be matched against the time
  // of an anonymous report to learn who made it.
  lastSignInAt: sql<
    string | null
  >`to_char(${users.lastSignInAt} at time zone 'UTC', 'YYYY-MM-DD')`,
  createdAt: users.createdAt,
};

/** The profile fields compared one to one when a user is edited. */
const PLAIN_FIELDS = [
  'orgUnitId',
  'employeeNumber',
  'jobTitle',
  'phone',
] as const;

@Controller('users')
@UseGuards(SessionGuard)
@ForModule('core')
export class UsersController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly orgUnits: OrgUnitsService,
    private readonly notices: SecurityNotices,
  ) {}

  private async withRoles(tx: Transaction, userId?: string) {
    const list = await tx
      .select(publicUser)
      .from(users)
      .leftJoin(homeUnit, eq(homeUnit.id, users.orgUnitId))
      .where(userId ? eq(users.id, userId) : undefined)
      .orderBy(asc(users.email));
    const grants = await tx
      .select({
        userId: roleAssignments.userId,
        roleId: roleAssignments.roleId,
        orgUnitId: roleAssignments.orgUnitId,
        orgUnit: {
          id: grantUnit.id,
          type: grantUnit.type,
          name: grantUnit.name,
          active: grantUnit.active,
        },
        code: roles.code,
        name: roles.name,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .leftJoin(grantUnit, eq(grantUnit.id, roleAssignments.orgUnitId))
      .where(userId ? eq(roleAssignments.userId, userId) : undefined)
      .orderBy(asc(roles.code), asc(grantUnit.code));
    return list.map((user) => ({
      ...user,
      roles: grants
        .filter((g) => g.userId === user.id)
        .map((g) => ({
          roleId: g.roleId,
          orgUnitId: g.orgUnitId,
          orgUnit: g.orgUnit,
          code: g.code,
          name: g.name,
        })),
    }));
  }

  /**
   * Refuses to place or manage someone outside the part of the organization
   * the actor manages users for. Someone with no org unit belongs to the
   * organization as a whole, so only a whole-organization manager acts on
   * them.
   */
  private assertInReach(req: AuthedRequest, orgUnitId: string | null) {
    if (!covers(req.auth, 'users.manage', orgUnitId)) {
      throw new ForbiddenException({ code: 'outside_scope' });
    }
  }

  /**
   * Refuses to hand out a role that allows more than the actor may do, or
   * allows it in more places: every permission of every role must be one the
   * actor holds for the place the role is granted for, and a role for the
   * whole organization only comes from someone who holds all of it for the
   * whole organization. Without this, anyone who manages one department's
   * users could make an administrator.
   */
  private async assertCanGrant(
    tx: Transaction,
    req: AuthedRequest,
    grants: RoleGrant[],
  ) {
    const byRole = await this.provisioning.permissionsByRole(
      tx,
      grants.map((g) => g.roleId),
    );
    if (byRole === null) throw new BadRequestException();
    const within = grants.every((grant) =>
      (byRole.get(grant.roleId) ?? []).every((p) =>
        mayGrant(req.auth, p as Permission, grant.orgUnitId),
      ),
    );
    if (!within) {
      throw new ForbiddenException({ code: 'cannot_grant_higher_access' });
    }
  }

  /**
   * Refuses to act on someone outside the actor's part of the organization,
   * or who may do more than the actor, or the same in more places: the actor
   * must hold each of their permissions at each place they hold it. Without
   * this, a reset link would let one department's user manager take over an
   * administrator.
   */
  private async assertCanManage(
    tx: Transaction,
    req: AuthedRequest,
    target: { id: string; orgUnitId: string | null },
  ) {
    this.assertInReach(req, target.orgUnitId);
    const theirs = await this.provisioning.grantsOfUser(tx, target.id);
    const within = theirs.every((grant) =>
      grant.permissions.every((p) =>
        mayGrant(req.auth, p as Permission, grant.orgUnitId),
      ),
    );
    if (!within) {
      throw new ForbiddenException({ code: 'cannot_manage_higher_access' });
    }
  }

  /**
   * Refuses a role granted for an org unit that is switched off. A grant the
   * user already holds there may stay, since this replaces the whole list.
   */
  private async assertGrantUnits(
    tx: Transaction,
    userId: string,
    grants: RoleGrant[],
  ) {
    const held = await this.heldGrants(tx, userId);
    const added = grants.filter(
      (g) =>
        !held.some((h) => h.roleId === g.roleId && h.orgUnitId === g.orgUnitId),
    );
    await this.orgUnits.assertActive(
      tx,
      added.map((g) => g.orgUnitId),
    );
  }

  /** The roles a user holds, and where. */
  private heldGrants(tx: Transaction, userId: string) {
    return tx
      .select({
        roleId: roleAssignments.roleId,
        orgUnitId: roleAssignments.orgUnitId,
      })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, userId));
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
        this.assertInReach(req, input.orgUnitId);
        await this.assertCanGrant(tx, req, grants);
        // Their own unit and the units their roles are for: all in use.
        await this.orgUnits.assertActive(tx, [
          input.orgUnitId,
          ...grants.map((g) => g.orgUnitId),
        ]);
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

  /**
   * Open while the subscription is suspended for disabling someone, and
   * only that (`{ status: "disabled" }` and nothing else): a hospital can
   * always cut a leaver's access.
   */
  @Patch(':id')
  @OpenWhileSuspended()
  async update(
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
    await whileSuspended(req, () => {
      const sent = Object.keys(body as object);
      return sent.length === 1 && parsed.data.status === 'disabled';
    });
    const { status, ...fields } = parsed.data;
    const { tenant, user: actor } = req.auth;
    if (fields.name && !fitsLanguages(fields.name, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
    if (status && userId === actor.id) {
      throw new ConflictException({ code: 'cannot_change_self' });
    }

    return await this.guarded(() =>
      this.tenantDb.withTenant(tenant.id, async (tx) => {
        // Locked, so what is recorded as changed is what did change.
        const [existing] = await tx
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!existing) throw new NotFoundException();
        await this.assertCanManage(tx, req, existing);
        assertStaff(existing);

        // Only what differs from what is stored is written and recorded.
        const changes: Partial<typeof fields> = {};
        if (fields.name && !sameText(fields.name, existing.name)) {
          changes.name = fields.name;
        }
        for (const key of PLAIN_FIELDS) {
          const value = fields[key];
          if (value !== undefined && value !== existing[key]) {
            changes[key] = value;
          }
        }
        // Re-enabling returns someone who never set a password to "invited".
        const wanted =
          status === 'active' && !existing.passwordHash ? 'invited' : status;
        const nextStatus =
          wanted && wanted !== existing.status ? wanted : undefined;
        const changed = [
          ...Object.keys(changes),
          ...(nextStatus ? ['status'] : []),
        ];
        if (changed.length === 0) {
          const [same] = await this.withRoles(tx, userId);
          return same;
        }

        // A disabled account holds no place under the `users` limit, so
        // enabling it again takes one.
        if (existing.status === 'disabled' && nextStatus) {
          await this.provisioning.makeRoomForUser(tx, tenant.id);
        }
        // Enabled again, they hold what their roles give once more: whoever
        // is given `policies.import` so is named to the others (security
        // review 12, L6).
        const importers =
          existing.status === 'disabled' && nextStatus
            ? await this.provisioning.importHolders(tx)
            : null;

        // Someone may stay in a unit that was switched off since, but
        // nobody is moved into one, nor out of the actor's reach.
        if (changes.orgUnitId !== undefined) {
          this.assertInReach(req, changes.orgUnitId);
          await this.orgUnits.assertActive(tx, [changes.orgUnitId]);
        }

        await tx
          .update(users)
          .set({
            ...changes,
            ...(nextStatus && { status: nextStatus }),
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        if (nextStatus === 'disabled') {
          await this.revokeSessions(tx, userId);
          // A link issued earlier must not work if they are enabled again.
          await this.provisioning.voidInvites(tx, userId);
        }
        if (importers) {
          await this.provisioning.tellOfImportGrants(tx, tenant.id, actor.id, importers);
        }

        // Which fields changed, and for a move or a change of status, from
        // what to what. Never the names or contact details themselves.
        await this.provisioning.audit(
          tx,
          tenant.id,
          actor.id,
          'user_updated',
          'user',
          userId,
          {
            changed,
            ...(changes.orgUnitId !== undefined && {
              orgUnitId: { from: existing.orgUnitId, to: changes.orgUnitId },
            }),
            ...(nextStatus && {
              status: { from: existing.status, to: nextStatus },
            }),
          },
        );
        const [updated] = await this.withRoles(tx, userId);
        return updated;
      }),
    );
  }

  /**
   * Open while the subscription is suspended for taking roles away, and
   * only that: the new list must be among the grants the user holds now.
   */
  @Put(':id/roles')
  @OpenWhileSuspended()
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
        // Locked, so two changes at once are made one after the other, and
        // what is compared below is what the user holds now.
        const [existing] = await tx
          .select({ id: users.id, orgUnitId: users.orgUnitId, kind: users.kind })
          .from(users)
          .where(eq(users.id, userId))
          .for('update');
        if (!existing) throw new NotFoundException();
        await this.assertCanManage(tx, req, existing);
        assertStaff(existing);
        await whileSuspended(req, async () => {
          const held = await this.heldGrants(tx, userId);
          return parsed.data.roles.every((g) =>
            held.some(
              (h) => h.roleId === g.roleId && h.orgUnitId === g.orgUnitId,
            ),
          );
        });
        await this.assertCanGrant(tx, req, parsed.data.roles);
        await this.assertGrantUnits(tx, userId, parsed.data.roles);
        // The list before, kept with the new one (audit-trail.md, item 4).
        const before = await this.heldGrants(tx, userId);
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
          { before, roles: parsed.data.roles },
        );
        const [updated] = await this.withRoles(tx, userId);
        return updated;
      }),
    );
  }

  /**
   * A new one-time link to set a password, for a first sign-in or a reset.
   * Open while the subscription is suspended, so that staff can always get
   * in to report: it changes nothing but the link, and is audited.
   */
  @Post(':id/invite')
  @OpenWhileSuspended()
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
      await this.assertCanManage(tx, req, existing);
      assertStaff(existing);
      if (existing.status === 'disabled') {
        throw new ConflictException({ code: 'user_disabled' });
      }
      // A person who signs through single sign-on, with a signing PIN, is
      // given no password by a link an administrator holds (security review
      // 11): it would let whoever holds the link sign as them.
      if (existing.signingPinHash || existing.ssoSubject) {
        throw new ConflictException({ code: 'signs_with_pin' });
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

  /**
   * Resets a person's signing PIN (business decision 9), for whoever may
   * manage them: it is removed, and they set a new one after signing in
   * again. An administrator can never set or see one. Audited; the person
   * is told in Trustline. Open while the subscription is suspended, as the
   * sign-in link is.
   */
  @Delete(':id/signing-pin')
  @HttpCode(204)
  @OpenWhileSuspended()
  resetSigningPin(@Param('id') id: string, @Req() req: AuthedRequest) {
    requirePermission(req, 'users.manage');
    const userId = this.parseId(id);
    const { tenant, user: actor } = req.auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const [existing] = await tx
        .select({ id: users.id, orgUnitId: users.orgUnitId, signingPinHash: users.signingPinHash })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!existing) throw new NotFoundException();
      await this.assertCanManage(tx, req, existing);
      if (!existing.signingPinHash) {
        throw new ConflictException({ code: 'no_signing_pin' });
      }
      // Cleared, lock and count included: they set a new one after signing
      // in again, and every session of theirs ends (security review 11).
      await tx
        .update(users)
        .set({
          signingPinHash: null,
          signingPinSetAt: null,
          signingPinFailures: 0,
          signingPinLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
      await this.revokeSessions(tx, userId);
      await this.provisioning.audit(tx, tenant.id, actor.id, 'signing_pin_reset', 'user', userId, null);
      await this.notices.tell(tx, tenant.id, userId, { kind: 'signing_pin_changed', action: 'reset' });
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

/**
 * An external reviewer's account is changed only through its access
 * (`/users/external`): never given another role, enabled again or sent a
 * new link here. 409 `external_reviewer`.
 */
function assertStaff(user: { kind: string }) {
  if (user.kind === 'external_reviewer') {
    throw new ConflictException({ code: 'external_reviewer' });
  }
}
