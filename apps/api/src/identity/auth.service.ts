import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Transaction } from '../database/client.js';
import { DATABASE } from '../database/database.constants.js';
import {
  roleAssignments,
  roles,
  sessions,
  tenants,
  users,
  userTokens,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { hashPassword, verifyPassword } from '../security/passwords.js';
import { hashToken, ProvisioningService } from './provisioning.service.js';

export const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
export const SESSION_HOURS = 8;
export const MIN_PASSWORD_LENGTH = 12;

export type AuthContext = {
  token: string;
  tenant: {
    id: string;
    slug: string;
    nameEn: string;
    nameAr: string;
    accreditationStandard: string;
  };
  user: {
    id: string;
    nameEn: string;
    nameAr: string;
    email: string;
    orgUnitId: string | null;
  };
  permissions: string[];
};

const uuid = z.uuid();

@Injectable()
export class AuthService {
  // Verified when the organization or email is unknown, so every refusal
  // takes as long as a wrong password.
  private dummyHash?: Promise<string>;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  private async burnTime(password: string) {
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await this.dummyHash);
  }

  /** A client that exists, is active, and allows password sign-in. */
  private async findTenant(slug: string, forPassword: boolean) {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug.trim().toLowerCase()));
    if (!tenant || tenant.status !== 'active') return null;
    if (forPassword && tenant.signInMethod === 'sso') return null;
    return tenant;
  }

  private async permissionsOf(tx: Transaction, userId: string) {
    const rows = await tx
      .select({ permissions: roles.permissions })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));
    return [...new Set(rows.flatMap((r) => r.permissions))].sort();
  }

  /** Returns a session token, or null if sign-in is refused for any reason. */
  async login(input: {
    org: string;
    email: string;
    password: string;
    client: 'web' | 'mobile';
    ip: string | null;
  }): Promise<string | null> {
    const tenant = await this.findTenant(input.org, true);
    if (!tenant) {
      await this.burnTime(input.password);
      return null;
    }

    // Read, verify, then write in separate steps: the password check is slow
    // and must not hold a database connection while it runs.
    const [user] = await this.tenantDb.withTenant(tenant.id, (tx) =>
      tx
        .select()
        .from(users)
        .where(eq(users.email, input.email.trim().toLowerCase())),
    );

    if (!user || !user.passwordHash || user.status !== 'active') {
      await this.burnTime(input.password);
      return null;
    }

    const valid = await verifyPassword(input.password, user.passwordHash);

    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      // Re-read under a row lock, so parallel guesses are counted one by one
      // and a lock set a moment ago is seen.
      const [fresh] = await tx
        .select()
        .from(users)
        .where(eq(users.id, user.id))
        .for('update');
      const locked = fresh.lockedUntil && fresh.lockedUntil > new Date();
      const stillValid =
        valid &&
        fresh.status === 'active' &&
        fresh.passwordHash === user.passwordHash;

      if (locked || !stillValid) {
        if (!locked) {
          await tx
            .update(users)
            .set({
              failedAttempts: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else ${users.failedAttempts} + 1 end`,
              lockedUntil: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${users.lockedUntil} end`,
            })
            .where(eq(users.id, user.id));
        }
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'sign_in_failed',
          'user',
          user.id,
          { locked: !!locked },
          input.ip,
        );
        return null;
      }

      // The tenant id travels in the token so the session can be looked up
      // under that tenant's row-level security.
      const token = `${tenant.id}.${randomBytes(32).toString('base64url')}`;
      await tx.delete(sessions).where(lt(sessions.expiresAt, new Date()));
      await tx.insert(sessions).values({
        tenantId: tenant.id,
        userId: user.id,
        tokenHash: hashToken(token),
        client: input.client,
        expiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000),
      });
      await tx
        .update(users)
        .set({ failedAttempts: 0, lockedUntil: null, lastSignInAt: new Date() })
        .where(eq(users.id, user.id));
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'sign_in',
        'user',
        user.id,
        { client: input.client },
        input.ip,
      );
      return token;
    });
  }

  /** Who a session token belongs to, or null if it is not a live session. */
  async resolve(token: string): Promise<AuthContext | null> {
    const tenantId = uuid.safeParse(token.split('.')[0]);
    if (!tenantId.success) return null;

    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId.data));
    if (!tenant || tenant.status !== 'active') return null;

    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select({ user: users })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenHash, hashToken(token)),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
          ),
        );
      if (!row || row.user.status !== 'active') return null;

      const { user } = row;
      return {
        token,
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          nameEn: tenant.nameEn,
          nameAr: tenant.nameAr,
          accreditationStandard: tenant.accreditationStandard,
        },
        user: {
          id: user.id,
          nameEn: user.nameEn,
          nameAr: user.nameAr,
          email: user.email,
          orgUnitId: user.orgUnitId,
        },
        permissions: await this.permissionsOf(tx, user.id),
      };
    });
  }

  async logout(auth: AuthContext) {
    await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.tokenHash, hashToken(auth.token)));
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'sign_out',
        'user',
        auth.user.id,
      );
    });
  }

  private async findInvite(tx: Transaction, token: string) {
    const [row] = await tx
      .select({ invite: userTokens, user: users })
      .from(userTokens)
      .innerJoin(users, eq(users.id, userTokens.userId))
      .where(
        and(
          eq(userTokens.tokenHash, hashToken(token)),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, new Date()),
        ),
      );
    return row && row.user.status !== 'disabled' ? row : null;
  }

  /** Who a set-password link is for, or null if it cannot be used. */
  async checkInvite(org: string, token: string) {
    const tenant = await this.findTenant(org, true);
    if (!tenant) return null;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const row = await this.findInvite(tx, token);
      if (!row) return null;
      return {
        nameEn: row.user.nameEn,
        nameAr: row.user.nameAr,
        email: row.user.email,
        organizationEn: tenant.nameEn,
        organizationAr: tenant.nameAr,
      };
    });
  }

  /** Sets the password from a one-time link. False if the link is not valid. */
  async acceptInvite(org: string, token: string, password: string) {
    const tenant = await this.findTenant(org, true);
    // Check the link before the slow hash, so a bad one costs nothing, and
    // take the same time whether or not the organization exists.
    const usable =
      tenant &&
      (await this.tenantDb.withTenant(tenant.id, (tx) =>
        this.findInvite(tx, token),
      ));
    if (!tenant || !usable) return false;

    const passwordHash = await hashPassword(password);
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const row = await this.findInvite(tx, token);
      if (!row) return false;
      // Claim the link in one statement: of two requests at once, one wins.
      const claimed = await tx
        .update(userTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(userTokens.id, row.invite.id), isNull(userTokens.usedAt)))
        .returning({ id: userTokens.id });
      if (claimed.length === 0) return false;
      await tx
        .update(users)
        .set({
          passwordHash,
          passwordChangedAt: new Date(),
          status: 'active',
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, row.user.id));
      // A new password ends every session that used the old one.
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(eq(sessions.userId, row.user.id), isNull(sessions.revokedAt)),
        );
      await this.provisioning.audit(
        tx,
        tenant.id,
        row.user.id,
        'password_set',
        'user',
        row.user.id,
        { purpose: row.invite.purpose },
      );
      return true;
    });
  }
}
