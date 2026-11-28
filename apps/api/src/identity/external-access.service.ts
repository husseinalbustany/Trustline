import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { pgErrorCode } from '../database/errors.js';
import {
  notifications,
  roleAssignments,
  roles,
  sessions,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { fitsLanguages, type Localized } from '../i18n/locales.js';
import { dayOf, daysBetween, shiftDay } from '../i18n/time-zones.js';
import { AccessService } from './access.service.js';
import type { AuthContext } from './auth.service.js';
import { READ_ONLY_PERMISSIONS, type Permission } from './permissions.js';
import { ProvisioningService } from './provisioning.service.js';
import { mayGrant } from './scope.js';

/** The longest access, first and last days included, and its one extension. */
export const EXTERNAL_ACCESS_DAYS = 30;

export type NewExternal = {
  name: Localized;
  email: string;
  organization: string;
  purpose: string;
  from: string;
  until: string;
  roleId: string;
  preferredLocale?: string | null;
};

export type ExternalChange =
  | { until: string; reason: string; revision: number }
  | { end: true; revision: number };

/** Whether an external reviewer's access is open on this day. */
export const accessOpen = (
  user: { kind: string; accessFrom: string | null; accessUntil: string | null; accessEndedAt: Date | null },
  today: string,
) =>
  user.kind !== 'external_reviewer' ||
  (!user.accessEndedAt && !!user.accessFrom && !!user.accessUntil && user.accessFrom <= today && today <= user.accessUntil);

const view = {
  id: users.id,
  name: users.name,
  email: users.email,
  status: users.status,
  organization: users.accessOrganization,
  purpose: users.accessPurpose,
  from: users.accessFrom,
  until: users.accessUntil,
  extendedAt: users.accessExtendedAt,
  extensionReason: users.accessExtensionReason,
  endedAt: users.accessEndedAt,
  revision: users.accessRevision,
  lastSignInAt: users.lastSignInAt,
};

/**
 * Time-limited access for an external surveyor or auditor
 * (docs/specs/audit-trail.md, "Time-limited access for an external
 * surveyor"):
 *
 * - granted by whoever holds `users.manage` and `audit.view` for the whole
 *   organization, for at most 30 days, extendable once with a reason, with
 *   a role that only reads (never `incidents.see_reporter`);
 * - an account marked external, which signs in with its password and a
 *   one-time code by email each time (AuthService), only within its days,
 *   whose sessions refuse every write (SessionGuard), whose every read is
 *   recorded (ReviewerReads), and which is not a named user;
 * - ended by an administrator, or by the daily check when its last day has
 *   passed; every step audited, and every holder of `users.manage` for the
 *   whole organization told in the app.
 */
@Injectable()
export class ExternalAccessService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly access: AccessService,
  ) {}

  /** The external reviewers, with their access and role, latest first. */
  list(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) => this.reviewers(tx));
  }

  private async reviewers(tx: Transaction, id?: string) {
    const rows = await tx
      .select({ ...view, roleId: roles.id, roleCode: roles.code, roleName: roles.name })
      .from(users)
      .leftJoin(roleAssignments, eq(roleAssignments.userId, users.id))
      .leftJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(and(eq(users.kind, 'external_reviewer'), id ? eq(users.id, id) : undefined))
      .orderBy(sql`${users.accessFrom} desc`, asc(users.email));
    return rows.map(({ roleId, roleCode, roleName, ...r }) => ({
      ...r,
      role: roleId ? { id: roleId, code: roleCode, name: roleName } : null,
    }));
  }

  /** Refuses a role that does more than read, or that the caller may not give. */
  private async assertReadOnlyRole(tx: Transaction, auth: AuthContext, roleId: string) {
    const [role] = await tx
      .select({ id: roles.id, permissions: roles.permissions })
      .from(roles)
      .where(eq(roles.id, roleId));
    if (!role) throw new NotFoundException({ code: 'role_not_found' });
    const beyond = role.permissions.filter((p) => !READ_ONLY_PERMISSIONS.includes(p as Permission));
    if (beyond.length > 0) {
      throw new BadRequestException({ code: 'not_read_only', permissions: beyond });
    }
    for (const p of role.permissions) {
      if (!mayGrant(auth, p as Permission, null)) {
        throw new ForbiddenException({ code: 'outside_scope', permission: p });
      }
    }
  }

  /** Refuses days out of order, in the past, or longer than allowed. */
  private assertDays(from: string, until: string, today: string) {
    if (from < today) throw new BadRequestException({ code: 'access_in_past', field: 'from' });
    if (until < from) throw new BadRequestException({ code: 'access_out_of_order', field: 'until' });
    if (daysBetween(from, until) + 1 > EXTERNAL_ACCESS_DAYS) {
      throw new BadRequestException({ code: 'access_too_long', field: 'until', days: EXTERNAL_ACCESS_DAYS });
    }
  }

  /** Grants access: the account, its role for the whole organization, and a one-time link. */
  async grant(auth: AuthContext, input: NewExternal) {
    const { tenant, user: actor } = auth;
    if (!fitsLanguages(input.name, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
    this.assertDays(input.from, input.until, dayOf(new Date(), tenant.timeZone));
    try {
      return await this.tenantDb.withTenant(tenant.id, async (tx) => {
        await this.assertReadOnlyRole(tx, auth, input.roleId);
        // Not a named user: no place is taken (decision 2).
        const [user] = await tx
          .insert(users)
          .values({
            tenantId: tenant.id,
            name: input.name,
            email: input.email.trim().toLowerCase(),
            preferredLocale: input.preferredLocale ?? null,
            kind: 'external_reviewer',
            accessFrom: input.from,
            accessUntil: input.until,
            accessOrganization: input.organization,
            accessPurpose: input.purpose,
          })
          .returning({ id: users.id });
        await this.provisioning.setRoles(tx, tenant.id, user.id, [{ roleId: input.roleId, orgUnitId: null }], actor.id);
        await this.provisioning.audit(tx, tenant.id, actor.id, 'external_access_granted', 'user', user.id, {
          organization: input.organization,
          purpose: input.purpose,
          from: input.from,
          until: input.until,
          roleId: input.roleId,
        });
        await this.tell(tx, tenant.id, actor.id, user.id, 'granted');
        const invite = await this.provisioning.createInvite(tx, tenant.id, user.id, 'invitation');
        const [reviewer] = await this.reviewers(tx, user.id);
        return { reviewer, invite: { ...invite, org: tenant.slug } };
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw new ConflictException({ code: 'email_taken' });
      throw e;
    }
  }

  /** Extends the access once, with a reason, or ends it. */
  change(auth: AuthContext, id: string, input: ExternalChange) {
    const { tenant, user: actor } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const [reviewer] = await tx
        .select({ ...view, kind: users.kind })
        .from(users)
        .where(and(eq(users.id, id), eq(users.kind, 'external_reviewer')))
        .for('update');
      if (!reviewer) throw new NotFoundException();
      if (reviewer.revision !== input.revision) throw new ConflictException({ code: 'stale_access' });
      if (reviewer.endedAt) throw new ConflictException({ code: 'access_ended' });
      if ('end' in input) {
        await this.end(tx, tenant.id, reviewer.id, actor.id, { by: 'administrator', until: reviewer.until });
      } else {
        if (reviewer.extendedAt) throw new ConflictException({ code: 'already_extended' });
        if (input.until <= reviewer.until!) {
          throw new BadRequestException({ code: 'access_out_of_order', field: 'until' });
        }
        if (daysBetween(reviewer.until!, input.until) > EXTERNAL_ACCESS_DAYS) {
          throw new BadRequestException({ code: 'access_too_long', field: 'until', days: EXTERNAL_ACCESS_DAYS });
        }
        await tx
          .update(users)
          .set({
            accessUntil: input.until,
            accessExtendedAt: new Date(),
            accessExtensionReason: input.reason,
            accessRevision: sql`${users.accessRevision} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, reviewer.id));
        await this.provisioning.audit(tx, tenant.id, actor.id, 'external_access_extended', 'user', reviewer.id, {
          from: reviewer.until,
          to: input.until,
          reason: input.reason,
        });
        await this.tell(tx, tenant.id, actor.id, reviewer.id, 'extended');
      }
      const [after] = await this.reviewers(tx, reviewer.id);
      return after;
    });
  }

  /** Ends an access: the account disabled, its sessions and links ended. */
  private async end(
    tx: Transaction,
    tenantId: string,
    userId: string,
    actorId: string | null,
    details: { by: 'administrator' | 'period_over'; until: string | null },
  ) {
    await tx
      .update(users)
      .set({
        status: 'disabled',
        accessEndedAt: new Date(),
        accessRevision: sql`${users.accessRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    await this.provisioning.voidInvites(tx, userId);
    await this.provisioning.audit(tx, tenantId, actorId, 'external_access_ended', 'user', userId, details);
    await this.tell(tx, tenantId, actorId, userId, 'ended');
  }

  /**
   * Ends, on the daily check, every access whose last day has passed on
   * the client's calendar. Audited, with no actor.
   */
  endExpired(tenantId: string, timeZone: string, now: Date) {
    const today = dayOf(now, timeZone);
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      const over = await tx
        .select({ id: users.id, until: users.accessUntil })
        .from(users)
        .where(and(eq(users.kind, 'external_reviewer'), isNull(users.accessEndedAt), lt(users.accessUntil, today)))
        .for('update', { skipLocked: true });
      for (const r of over) {
        await this.end(tx, tenantId, r.id, null, { by: 'period_over', until: r.until });
      }
      return over.length;
    });
  }

  /** Tells every holder of `users.manage` for the whole organization, but the one who acted. */
  private async tell(
    tx: Transaction,
    tenantId: string,
    actorId: string | null,
    personId: string,
    change: 'granted' | 'extended' | 'ended',
  ) {
    const holders = await this.access.holders(tx, ['users.manage'], []);
    const to = [...holders.everywhere('users.manage')].filter((id) => id !== actorId && id !== personId);
    if (to.length === 0) return;
    await tx.insert(notifications).values(
      to.map((userId) => ({
        tenantId,
        userId,
        kind: 'external_access_changed' as const,
        data: { change, personId, serious: false },
      })),
    );
  }
}

/** The last moment of an access: the end of its last day, on the client's clock. */
export const accessEndsAt = (until: string, startOfDay: (day: string) => Date) => startOfDay(shiftDay(until, 1));
