import { randomBytes } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Transaction } from '../database/client.js';
import { DATABASE } from '../database/database.constants.js';
import {
  orgUnits,
  roleAssignments,
  roles,
  sessions,
  tenants,
  users,
  userTokens,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { Localized } from '../i18n/locales.js';
import { hashPassword, verifyPassword } from '../security/passwords.js';
import {
  allows,
  EntitlementsService,
  issuedBeforeReset,
} from '../subscriptions/entitlements.service.js';
import type {
  ModuleCode,
  ModuleKey,
  SubscriptionStatus,
} from '../subscriptions/modules.js';
import { hashToken, ProvisioningService } from './provisioning.service.js';
import { buildScope, covers, type Scope } from './scope.js';

export const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
export const SESSION_HOURS = 8;
export const MIN_PASSWORD_LENGTH = 12;

export type AuthContext = {
  token: string;
  tenant: {
    id: string;
    slug: string;
    name: Localized;
    locales: string[];
    defaultLocale: string;
    accreditationStandard: string;
    /** Whether the hospital takes reports without sign-in. */
    publicReporting: boolean;
    /**
     * The hospital's own clock, as an IANA name. Screens show dates and
     * times in it, so everyone in a hospital reads the same day.
     */
    timeZone: string;
    /**
     * The modules the client's subscription has on now. Core is not listed:
     * every client has it.
     */
    modules: ModuleCode[];
    /**
     * The state of the subscription as this user is to be told of it, and
     * the notice to show them. To those who manage the settings of the
     * whole organization, the status as it is, with a `past_due` notice.
     * To anyone else, `suspended` as it is (it changes what works), and
     * any other status as `active`: a trial or an overdue payment is not
     * theirs to know. Nothing commercial in either.
     */
    subscription: {
      status: Exclude<SubscriptionStatus, 'cancelled'>;
      notice: null | 'past_due' | 'suspended';
    };
  };
  user: {
    id: string;
    name: Localized;
    email: string;
    orgUnitId: string | null;
  };
  /** Everything the user's roles allow, wherever they were granted. */
  permissions: string[];
  /** Where each of those permissions applies. Ask it with `covers()`. */
  scope: Scope;
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
    private readonly entitlements: EntitlementsService,
  ) {}

  private async burnTime(password: string) {
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await this.dummyHash);
  }

  /**
   * A client by its identifier, for a request that has no session yet: null
   * unless it exists and is active, its subscription is not cancelled and
   * has `module`, and, when the request is about a password, it allows
   * password sign-in. Sign-in and the public reporting routes both find the
   * hospital this way, and only this way, each naming the module it is for
   * (`'core'` for signing in), so a client without the module is answered
   * like one that does not exist.
   */
  async findTenant(slug: string, forPassword: boolean, module: ModuleKey) {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug.trim().toLowerCase()));
    if (!tenant || tenant.status !== 'active') return null;
    if (forPassword && tenant.signInMethod === 'sso') return null;
    const entitlements = await this.tenantDb.withTenant(tenant.id, (tx) =>
      this.entitlements.of(tx, tenant.id),
    );
    if (entitlements?.status === 'cancelled') return null;
    if (!allows(entitlements, module)) return null;
    return tenant;
  }

  /** What a user's roles allow, and for which part of the organization. */
  private async accessOf(tx: Transaction, userId: string) {
    const grants = await tx
      .select({
        permissions: roles.permissions,
        orgUnitId: roleAssignments.orgUnitId,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));
    // The tree is only needed when a role was granted for one unit.
    const units = grants.some((g) => g.orgUnitId)
      ? await tx
          .select({ id: orgUnits.id, parentId: orgUnits.parentId })
          .from(orgUnits)
      : [];
    return {
      permissions: [...new Set(grants.flatMap((g) => g.permissions))].sort(),
      scope: buildScope(grants, units),
    };
  }

  /** Returns a session token, or null if sign-in is refused for any reason. */
  async login(input: {
    org: string;
    email: string;
    password: string;
    client: 'web' | 'mobile';
    ip: string | null;
  }): Promise<string | null> {
    const tenant = await this.findTenant(input.org, true, 'core');
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
        .select({ user: users, createdAt: sessions.createdAt })
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
      return this.contextIn(tx, tenant, row.user, token, row.createdAt);
    });
  }

  /**
   * The context of an active user of an active client, in a transaction of
   * that client. `issuedAt`: when the session was, to be refused if it is
   * from before the client or its subscription was last reset; null only
   * for BackgroundContext (email/background-context.ts), which builds one
   * with no session for the email digest and is provided to EmailModule
   * alone. Everything else gets a context from `resolve`, with a session.
   */
  async contextIn(
    tx: Transaction,
    tenant: typeof tenants.$inferSelect,
    user: typeof users.$inferSelect,
    token: string,
    issuedAt: Date | null,
  ): Promise<AuthContext | null> {
    // A cancelled subscription ends access as a suspended client does,
    // and a session from before the client was suspended or its
    // subscription cancelled stays ended when either is made active
    // again, whether or not its revocation was written.
    const entitlements = await this.entitlements.of(tx, tenant.id);
    if (entitlements?.status === 'cancelled') return null;
    if (issuedAt && issuedBeforeReset(issuedAt, tenant, entitlements)) {
      return null;
    }
    const stored = entitlements?.status ?? 'active';

    const access = await this.accessOf(tx, user.id);
    const administers = covers(access, 'settings.manage', null);
    // What is commercial (a trial, a payment overdue) only to the
    // client's administrators; to anyone else it is active. A suspension
    // changes what works, so everyone is told of it.
    const status = administers || stored === 'suspended' ? stored : 'active';
    return {
      token,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        locales: tenant.locales,
        defaultLocale: tenant.defaultLocale,
        accreditationStandard: tenant.accreditationStandard,
        publicReporting: tenant.publicReporting,
        timeZone: tenant.timeZone,
        // No subscription (there should be none without): core only.
        modules: entitlements?.modules ?? [],
        subscription: {
          status,
          notice:
            status === 'suspended'
              ? 'suspended'
              : status === 'past_due' && administers
                ? 'past_due'
                : null,
        },
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        orgUnitId: user.orgUnitId,
      },
      ...access,
    };
  }

  /**
   * Checks the password of the person signed in, re-entered for a
   * signature, exactly as sign-in checks it: the same hash, the same
   * counter of wrong passwords, the same lock after five of them, and the
   * same entry in the audit log on a failure (`password_confirmation_failed`,
   * with what it was for). The password itself is never stored, logged or
   * audited.
   *
   * Refuses with 401 `wrong_password`, or 401 `password_locked` while the
   * account is locked (whatever was typed). Neither ends the session: the
   * person is signed in, and only the signature is refused. Call it before
   * the transaction that signs, not inside it: a refusal must be counted
   * even though nothing else is written, and the slow hash must not hold a
   * connection.
   */
  async confirmPassword(
    auth: AuthContext,
    password: string,
    purpose: string,
    ip: string | null = null,
  ): Promise<void> {
    const tenantId = auth.tenant.id;
    const [user] = await this.tenantDb.withTenant(tenantId, (tx) =>
      tx
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, auth.user.id)),
    );
    const valid = user?.passwordHash
      ? await verifyPassword(password, user.passwordHash)
      : (await this.burnTime(password), false);
    const outcome = await this.tenantDb.withTenant(tenantId, async (tx) => {
      // Under a row lock, as at sign-in: parallel guesses are counted one by
      // one, and a lock set a moment ago is seen.
      const [fresh] = await tx
        .select({
          status: users.status,
          passwordHash: users.passwordHash,
          lockedUntil: users.lockedUntil,
        })
        .from(users)
        .where(eq(users.id, auth.user.id))
        .for('update');
      const locked = !!fresh?.lockedUntil && fresh.lockedUntil > new Date();
      const stillValid =
        valid &&
        fresh?.status === 'active' &&
        fresh.passwordHash === user?.passwordHash;
      if (!locked && stillValid) {
        await tx
          .update(users)
          .set({ failedAttempts: 0, lockedUntil: null })
          .where(eq(users.id, auth.user.id));
        return 'ok' as const;
      }
      if (!locked) {
        await tx
          .update(users)
          .set({
            failedAttempts: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else ${users.failedAttempts} + 1 end`,
            lockedUntil: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${users.lockedUntil} end`,
          })
          .where(eq(users.id, auth.user.id));
      }
      await this.provisioning.audit(
        tx,
        tenantId,
        auth.user.id,
        'password_confirmation_failed',
        'user',
        auth.user.id,
        { locked, purpose },
        ip,
      );
      return locked ? ('locked' as const) : ('wrong' as const);
    });
    if (outcome === 'locked') {
      throw new UnauthorizedException({ code: 'password_locked' });
    }
    if (outcome === 'wrong') {
      throw new UnauthorizedException({ code: 'wrong_password' });
    }
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

  /**
   * A one-time link that can still be used: not used, not expired, not for
   * a disabled account, and not issued before the client last went to or
   * from suspended or its subscription to or from cancelled.
   */
  private async findInvite(tx: Transaction, tenantId: string, token: string) {
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
    if (!row || row.user.status === 'disabled') return null;
    // Read afresh, in this transaction: a link checked before a slow
    // password hash is checked again after it.
    const [client] = await tx
      .select({ accessResetAt: tenants.accessResetAt })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const entitlements = await this.entitlements.of(tx, tenantId);
    if (issuedBeforeReset(row.invite.createdAt, client ?? null, entitlements)) {
      return null;
    }
    return row;
  }

  /** Who a set-password link is for, or null if it cannot be used. */
  async checkInvite(org: string, token: string) {
    const tenant = await this.findTenant(org, true, 'core');
    if (!tenant) return null;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const row = await this.findInvite(tx, tenant.id, token);
      if (!row) return null;
      return {
        name: row.user.name,
        email: row.user.email,
        organization: tenant.name,
        defaultLocale: tenant.defaultLocale,
      };
    });
  }

  /** Sets the password from a one-time link. False if the link is not valid. */
  async acceptInvite(org: string, token: string, password: string) {
    const tenant = await this.findTenant(org, true, 'core');
    // Check the link before the slow hash, so a bad one costs nothing, and
    // take the same time whether or not the organization exists.
    const usable =
      tenant &&
      (await this.tenantDb.withTenant(tenant.id, (tx) =>
        this.findInvite(tx, tenant.id, token),
      ));
    if (!tenant || !usable) return false;

    const passwordHash = await hashPassword(password);
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const row = await this.findInvite(tx, tenant.id, token);
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
