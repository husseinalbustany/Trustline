import { createHmac, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
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
  EntitlementsService, exitWindowOf,
  issuedBeforeReset,
} from '../subscriptions/entitlements.service.js';
import type {
  ModuleCode,
  ModuleKey,
  SubscriptionStatus,
} from '../subscriptions/modules.js';
import { hashToken, ProvisioningService } from './provisioning.service.js';
import { READ_ONLY_PERMISSIONS, type Permission } from './permissions.js';
import { buildScope, covers, type Scope } from './scope.js';
import { SecurityNotices } from './security-notices.service.js';
import { accessOpen } from './external-access.service.js';
import { SignInCodes } from './sign-in-codes.service.js';
import { dayOf, shiftDay, startOfDay } from '../i18n/time-zones.js';

export const MAX_FAILED_ATTEMPTS = 5;

/** A signing PIN: 6 to 12 digits (business decision 9). */
const SIGNING_PIN = /^\d{6,12}$/;
/** Setting a signing PIN needs a sign-in this recent, for this session. */
export const SIGNING_PIN_FRESH_MS = 10 * 60_000;

/** Wrong signing PINs, from the last right one, that lock PIN signing. */
export const SIGNING_PIN_MAX_FAILURES = 10;

/**
 * PINs too often chosen to be safe, beyond what the rules below catch
 * (security review 11).
 */
const COMMON_PINS = new Set([
  '000123', '102030', '111222', '112358', '121314', '123000', '123654',
  '131313', '147258', '147852', '159357', '159753', '202020', '246810',
  '258369', '258456', '314159', '369258', '456789', '520520', '741852',
  '753951', '789456', '852456', '963741', '963852', '1234321', '13579',
  '135790', '24680', '246802', '102938', '1029384756',
]);

/** Whether digits read as a day: DDMMYY, MMDDYY, YYMMDD and the 8-digit forms. */
function looksLikeDate(pin: string) {
  const ok = (d: number, m: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const n = (from: number, len: number) => Number(pin.slice(from, from + len));
  if (pin.length === 6) {
    return ok(n(0, 2), n(2, 2)) || ok(n(2, 2), n(0, 2)) || ok(n(4, 2), n(2, 2));
  }
  if (pin.length === 8) {
    const year = (y: number) => y >= 1900 && y <= 2099;
    return (
      (year(n(4, 4)) && (ok(n(0, 2), n(2, 2)) || ok(n(2, 2), n(0, 2)))) ||
      (year(n(0, 4)) && ok(n(6, 2), n(4, 2)))
    );
  }
  return false;
}

/**
 * Whether a PIN is too easily guessed (business decision 9, security
 * review 11): fewer than three different digits; digits going up or down
 * one at a time (123456, 987654, 890123); a block repeated (121212,
 * 123123); each digit doubled (112233); the same read both ways (123321);
 * a day (311290, 19800521); or one of the most common.
 */
export function pinTooSimple(pin: string) {
  // Digits only (SIGNING_PIN): one character each.
  const digits = pin.split('').map(Number);
  const steps = digits.slice(1).map((d, i) => (d - digits[i] + 10) % 10);
  if (new Set(digits).size < 3) return true;
  if (steps.every((s) => s === 1) || steps.every((s) => s === 9)) return true;
  for (let size = 1; size <= pin.length / 2; size++) {
    if (pin.length % size === 0 && pin.slice(0, size).repeat(pin.length / size) === pin) {
      return true;
    }
  }
  if (pin.length % 2 === 0 && /^(?:(\d)\1)+$/.test(pin)) return true;
  if (pin === pin.split('').reverse().join('')) return true;
  if (looksLikeDate(pin)) return true;
  return COMMON_PINS.has(pin);
}

/**
 * What is hashed of a PIN (security review 11): an HMAC of it with the
 * server's pepper (`SIGNING_PIN_PEPPER`, 32 characters or more, from the
 * environment), so that a copy of the database alone does not give the
 * PINs up to guessing. Without a pepper no PIN is set or checked (503
 * `signing_pin_unavailable`).
 */
export function pinSecret(pin: string) {
  const pepper = process.env.SIGNING_PIN_PEPPER?.trim() ?? '';
  if (pepper.length < 32) {
    throw new ServiceUnavailableException({ code: 'signing_pin_unavailable' });
  }
  return createHmac('sha256', pepper).update(`trustline.signing-pin.${pin}`).digest('base64url');
}
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
    /**
     * A cancelled client's exit window, while it is open and the user may
     * export its data (docs/specs/data-export.md): its last day. Then only
     * the routes marked `@OpenInExitWindow()` answer. Null otherwise.
     */
    exit: { until: string } | null;
  };
  user: {
    id: string;
    name: Localized;
    email: string;
    orgUnitId: string | null;
    /**
     * `external_reviewer` for a surveyor's time-limited, read-only access
     * (docs/specs/audit-trail.md), with its days; `staff` otherwise.
     */
    kind: 'staff' | 'external_reviewer';
    access: { from: string; until: string } | null;
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
    private readonly notices: SecurityNotices,
    private readonly codes: SignInCodes,
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
  async findTenant(
    slug: string,
    forPassword: boolean,
    module: ModuleKey,
    // Signing in alone: a cancelled client in its exit window is found,
    // for its holders of `data.export` (docs/specs/data-export.md).
    options: { exitWindow?: boolean } = {},
  ) {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug.trim().toLowerCase()));
    if (!tenant || tenant.status !== 'active') return null;
    if (forPassword && tenant.signInMethod === 'sso') return null;
    const entitlements = await this.tenantDb.withTenant(tenant.id, (tx) =>
      this.entitlements.of(tx, tenant.id),
    );
    if (entitlements?.status === 'cancelled') {
      const open = options.exitWindow && exitWindowOf(entitlements, dayOf(new Date(), tenant.timeZone));
      return open && module === 'core' ? tenant : null;
    }
    if (!allows(entitlements, module)) return null;
    return tenant;
  }

  /** What a user's roles allow, and for which part of the organization. */
  private async accessOf(tx: Transaction, userId: string, kind: 'staff' | 'external_reviewer' = 'staff') {
    const held = await tx
      .select({
        permissions: roles.permissions,
        orgUnitId: roleAssignments.orgUnitId,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));
    // An external reviewer reads, whatever their role says: a role widened
    // since it was given still gives them nothing more (security review 14,
    // M2), nor a reporter's name.
    const grants =
      kind === 'external_reviewer'
        ? held.map((g) => ({ ...g, permissions: g.permissions.filter((p) => READ_ONLY_PERMISSIONS.includes(p as Permission)) }))
        : held;
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

  /**
   * A session token; for an external reviewer, after the right password, a
   * challenge instead, the one-time code going to them by email
   * (`loginWithCode` finishes the sign-in); or null if sign-in is refused
   * for any reason.
   */
  async login(input: {
    org: string;
    email: string;
    password: string;
    client: 'web' | 'mobile';
    ip: string | null;
  }): Promise<{ token: string } | { challenge: string } | null> {
    const tenant = await this.findTenant(input.org, true, 'core', { exitWindow: true });
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

    const outcome = await this.tenantDb.withTenant(tenant.id, async (tx) => {
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

      // An external reviewer: only within their days, and then with a
      // one-time code by email as well (decision 2).
      if (fresh.kind === 'external_reviewer') {
        if (!accessOpen(fresh, dayOf(new Date(), tenant.timeZone))) {
          await this.provisioning.audit(tx, tenant.id, user.id, 'sign_in_failed', 'user', user.id, {
            locked: false,
            reason: 'outside_access',
          }, input.ip);
          return null;
        }
        const issued = await this.codes.issue(tx, tenant.id, user.id, input.client);
        if (!issued) {
          await this.provisioning.audit(tx, tenant.id, user.id, 'sign_in_failed', 'user', user.id, {
            locked: false,
            reason: 'too_many_codes',
          }, input.ip);
          return null;
        }
        return { issued, user: fresh };
      }
      // A cancelled client in its exit window: only those who may export
      // its data for the whole organization (docs/specs/data-export.md).
      // Anyone else is refused as before it was open, and told nothing.
      const entitlements = await this.entitlements.of(tx, tenant.id);
      if (entitlements?.status === 'cancelled') {
        const access = await this.accessOf(tx, fresh.id, fresh.kind);
        if (fresh.kind !== 'staff' || !covers(access, 'data.export', null)) {
          await this.provisioning.audit(tx, tenant.id, user.id, 'sign_in_failed', 'user', user.id, {
            locked: false,
            reason: 'subscription_cancelled',
          }, input.ip);
          return null;
        }
      }
      return { token: await this.openSession(tx, tenant, fresh, input.client, input.ip, null) };
    });
    if (!outcome) return null;
    if (!('issued' in outcome) || !outcome.issued) return { token: outcome.token! };
    await this.codes.send(tenant, outcome.user, outcome.issued);
    return { challenge: outcome.issued.challenge };
  }

  /**
   * The second step of an external reviewer's sign-in: the challenge and
   * the code they were sent. A session token, or null (wrong, used, expired,
   * or out of their days). A wrong code is recorded as a failed sign-in.
   */
  async loginWithCode(input: { org: string; challenge: string; code: string; ip: string | null }) {
    const tenant = await this.findTenant(input.org, true, 'core');
    if (!tenant) return null;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const taken = await this.codes.take(tx, input.challenge, input.code);
      if (!taken.userId) return null;
      const [user] = await tx.select().from(users).where(eq(users.id, taken.userId)).for('update');
      const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
      if (!taken.ok || locked) {
        // A wrong code counts as a wrong password does, toward the same
        // lock (security review 14, M3): codes cannot be tried round after
        // round. Locked, even the right one is refused.
        if (!locked) {
          await tx
            .update(users)
            .set({
              failedAttempts: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else ${users.failedAttempts} + 1 end`,
              lockedUntil: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${users.lockedUntil} end`,
            })
            .where(eq(users.id, taken.userId));
        }
        await this.provisioning.audit(tx, tenant.id, taken.userId, 'sign_in_failed', 'user', taken.userId, {
          locked,
          reason: 'wrong_code',
        }, input.ip);
        return null;
      }
      if (
        !user ||
        user.status !== 'active' ||
        user.kind !== 'external_reviewer' ||
        !accessOpen(user, dayOf(new Date(), tenant.timeZone))
      ) {
        return null;
      }
      const client: 'web' | 'mobile' = taken.client === 'mobile' ? 'mobile' : 'web';
      return {
        token: await this.openSession(tx, tenant, user, client, input.ip, 'email_code'),
        client,
      };
    });
  }

  /**
   * Opens a session, in the sign-in's transaction: recorded, the failures
   * counted back to none. An external reviewer's ends with their last day,
   * on the client's clock, if that comes first.
   */
  private async openSession(
    tx: Transaction,
    tenant: typeof tenants.$inferSelect,
    user: typeof users.$inferSelect,
    client: 'web' | 'mobile',
    ip: string | null,
    secondFactor: 'email_code' | null,
  ) {
    // The tenant id travels in the token so the session can be looked up
    // under that tenant's row-level security.
    const token = `${tenant.id}.${randomBytes(32).toString('base64url')}`;
    let expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
    if (user.kind === 'external_reviewer' && user.accessUntil) {
      const end = startOfDay(shiftDay(user.accessUntil, 1), tenant.timeZone);
      if (end < expiresAt) expiresAt = end;
    }
    await tx.delete(sessions).where(lt(sessions.expiresAt, new Date()));
    await tx.insert(sessions).values({
      tenantId: tenant.id,
      userId: user.id,
      tokenHash: hashToken(token),
      client,
      expiresAt,
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
      secondFactor ? { client, secondFactor } : { client },
      ip,
    );
    return token;
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
      // An external reviewer's session holds only within their days, on
      // every request (decision 2).
      if (!accessOpen(row.user, dayOf(new Date(), tenant.timeZone))) return null;
      return this.contextIn(tx, tenant, row.user, token, row.createdAt);
    });
  }

  /**
   * The context of a person as if they were signed in, with no session, for
   * BackgroundContext (email/background-context.ts) alone, which builds the
   * email digest as the person and is provided to EmailModule alone. It
   * takes no token and no session time, so neither can be left out by
   * mistake elsewhere. Lint (`.oxlintrc.json`) refuses a call to it outside
   * identity/ and email/ (security review 9, finding 6). Every request gets
   * its context from `resolve`, with a session.
   */
  backgroundContextIn(
    tx: Transaction,
    tenant: typeof tenants.$inferSelect,
    user: typeof users.$inferSelect,
  ): Promise<AuthContext | null> {
    return this.contextIn(tx, tenant, user, '', null);
  }

  /**
   * The context of an active user of an active client, in a transaction of
   * that client. `issuedAt`: when the session was, to be refused if it is
   * from before the client or its subscription was last reset; null only
   * from `backgroundContextIn`.
   */
  private async contextIn(
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
    // Cancelled: nobody, but in the exit window those who may export its
    // data for the whole organization (docs/specs/data-export.md), and
    // only to the export screens.
    let exit: { until: string } | null = null;
    if (entitlements?.status === 'cancelled') {
      const until = exitWindowOf(entitlements, dayOf(new Date(), tenant.timeZone));
      if (!until || user.kind !== 'staff') return null;
      exit = { until };
    }
    if (issuedAt && issuedBeforeReset(issuedAt, tenant, entitlements)) {
      return null;
    }
    const stored = exit ? 'suspended' : (entitlements?.status ?? 'active');

    const access = await this.accessOf(tx, user.id, user.kind);
    if (exit && !covers(access, 'data.export', null)) return null;
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
        // No subscription (there should be none without): core only. In
        // the exit window, none: only the export routes answer.
        modules: exit ? [] : (entitlements?.modules ?? []),
        subscription: {
          status,
          notice:
            status === 'suspended'
              ? 'suspended'
              : status === 'past_due' && administers
                ? 'past_due'
                : null,
        },
        exit,
      },
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        orgUnitId: user.orgUnitId,
        kind: user.kind,
        access:
          user.kind === 'external_reviewer' && user.accessFrom && user.accessUntil
            ? { from: user.accessFrom, until: user.accessUntil }
            : null,
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
        .select({
          id: users.id,
          passwordHash: users.passwordHash,
          signingPinHash: users.signingPinHash,
          signingPinLockedAt: users.signingPinLockedAt,
        })
        .from(users)
        .where(eq(users.id, auth.user.id)),
    );
    // A person with a password signs with it; one with none (who signs in
    // only through single sign-on) with their signing PIN (business
    // decision 9); one with neither cannot sign until they set a PIN.
    const credential = user?.passwordHash ?? user?.signingPinHash ?? null;
    if (user && !credential) {
      throw new ForbiddenException({ code: 'signing_pin_required' });
    }
    const byPin = !!user && !user.passwordHash;
    // Locked after SIGNING_PIN_MAX_FAILURES wrong PINs, until an
    // administrator resets it (security review 11).
    if (byPin && user.signingPinLockedAt) {
      throw new ForbiddenException({ code: 'signing_pin_locked' });
    }
    const valid = credential
      ? await verifyPassword(byPin ? pinSecret(password) : password, credential)
      : (await this.burnTime(password), false);
    const outcome = await this.tenantDb.withTenant(tenantId, async (tx) => {
      // Under a row lock, as at sign-in: parallel guesses are counted one by
      // one, and a lock set a moment ago is seen.
      const [fresh] = await tx
        .select({
          status: users.status,
          passwordHash: users.passwordHash,
          signingPinHash: users.signingPinHash,
          signingPinFailures: users.signingPinFailures,
          signingPinLockedAt: users.signingPinLockedAt,
          lockedUntil: users.lockedUntil,
        })
        .from(users)
        .where(eq(users.id, auth.user.id))
        .for('update');
      if (byPin && fresh?.signingPinLockedAt) return 'pin_locked' as const;
      const locked = !!fresh?.lockedUntil && fresh.lockedUntil > new Date();
      // The same credential as was checked, unchanged since.
      const stillValid =
        valid &&
        fresh?.status === 'active' &&
        (fresh.passwordHash ?? fresh.signingPinHash ?? null) === credential;
      if (!locked && stillValid) {
        await tx
          .update(users)
          .set({ failedAttempts: 0, lockedUntil: null, ...(byPin && { signingPinFailures: 0 }) })
          .where(eq(users.id, auth.user.id));
        return 'ok' as const;
      }
      // Wrong PINs count up to SIGNING_PIN_MAX_FAILURES whatever the short
      // locks in between, and only a right one sets them back.
      const pinFailures = byPin && !locked ? (fresh?.signingPinFailures ?? 0) + 1 : 0;
      const pinLocksNow = byPin && pinFailures >= SIGNING_PIN_MAX_FAILURES;
      if (!locked) {
        await tx
          .update(users)
          .set({
            failedAttempts: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else ${users.failedAttempts} + 1 end`,
            lockedUntil: sql`case when ${users.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${users.lockedUntil} end`,
            ...(byPin && { signingPinFailures: pinFailures }),
            ...(pinLocksNow && { signingPinLockedAt: new Date() }),
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
        { locked, purpose, ...(byPin && { pin: true, pinFailures }), ...(pinLocksNow && { pinLocked: true }) },
        ip,
      );
      if (pinLocksNow) {
        // Whoever was guessing loses the session they guessed in, and the
        // person is told, in the app and by an email they cannot switch off.
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(eq(sessions.tokenHash, hashToken(auth.token)));
        await this.provisioning.audit(tx, tenantId, null, 'signing_pin_locked', 'user', auth.user.id, {
          failures: pinFailures,
        });
        await this.notices.tell(tx, tenantId, auth.user.id, { kind: 'signing_pin_locked' });
        return 'pin_locked' as const;
      }
      return locked ? ('locked' as const) : ('wrong' as const);
    });
    if (outcome === 'pin_locked') {
      throw new ForbiddenException({ code: 'signing_pin_locked' });
    }
    if (outcome === 'locked') {
      throw new UnauthorizedException({ code: 'password_locked' });
    }
    if (outcome === 'wrong') {
      throw new UnauthorizedException({ code: 'wrong_password' });
    }
  }

  /**
   * How the person signs (business decision 9): with their password; with
   * their signing PIN if they have no password; or not at all until they
   * set one.
   */
  async signingMethodOf(auth: AuthContext): Promise<'password' | 'pin' | 'none'> {
    const [user] = await this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select({ passwordHash: users.passwordHash, signingPinHash: users.signingPinHash })
        .from(users)
        .where(eq(users.id, auth.user.id)),
    );
    if (user?.passwordHash) return 'password';
    return user?.signingPinHash ? 'pin' : 'none';
  }

  /**
   * Sets or changes the person's own signing PIN (business decision 9,
   * security review 11): only for a person with no password (409
   * `signs_with_password`), only within SIGNING_PIN_FRESH_MS of signing in
   * for this session (403 `fresh_sign_in_required`), only a PIN that is not
   * too simple (400 `pin_too_simple`), and, to change one, with the current
   * PIN (400 `current_pin_required`), checked and counted as any signature.
   * The cheap checks come before any hashing. Hashed with the server's
   * pepper; audited; the person's other sessions are ended; and they are
   * told in the app and by an email they cannot switch off.
   */
  async setSigningPin(
    auth: AuthContext,
    input: { pin: string; currentPin?: string },
    ip: string | null,
  ) {
    const { pin, currentPin } = input;
    if (!SIGNING_PIN.test(pin)) throw new BadRequestException();
    if (pinTooSimple(pin)) throw new BadRequestException({ code: 'pin_too_simple' });
    const [user] = await this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select({ passwordHash: users.passwordHash, signingPinHash: users.signingPinHash })
        .from(users)
        .where(eq(users.id, auth.user.id)),
    );
    if (!user) throw new UnauthorizedException();
    if (user.passwordHash) throw new ConflictException({ code: 'signs_with_password' });
    await this.assertFreshSignIn(auth);
    if (user.signingPinHash) {
      if (!currentPin) throw new BadRequestException({ code: 'current_pin_required' });
      await this.confirmPassword(auth, currentPin, 'signing_pin_change', ip);
    }
    const hash = await hashPassword(pinSecret(pin));
    await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [fresh] = await tx
        .select({
          passwordHash: users.passwordHash,
          signingPinHash: users.signingPinHash,
          signingPinLockedAt: users.signingPinLockedAt,
        })
        .from(users)
        .where(eq(users.id, auth.user.id))
        .for('update');
      if (!fresh) throw new UnauthorizedException();
      if (fresh.passwordHash) throw new ConflictException({ code: 'signs_with_password' });
      // Changed or reset by someone else meanwhile: asked again.
      if (fresh.signingPinHash !== user.signingPinHash) {
        throw new ConflictException({ code: 'stale_signing_pin' });
      }
      if (fresh.signingPinLockedAt) throw new ForbiddenException({ code: 'signing_pin_locked' });
      const action = user.signingPinHash ? 'changed' : 'set';
      const now = new Date();
      await tx
        .update(users)
        .set({ signingPinHash: hash, signingPinSetAt: now, signingPinFailures: 0, updatedAt: now })
        .where(eq(users.id, auth.user.id));
      // Every other session of theirs ends: one someone else holds included.
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(sessions.userId, auth.user.id),
            isNull(sessions.revokedAt),
            sql`${sessions.tokenHash} <> ${hashToken(auth.token)}`,
          ),
        );
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'signing_pin_set',
        'user',
        auth.user.id,
        { action },
        ip,
      );
      await this.notices.tell(tx, auth.tenant.id, auth.user.id, { kind: 'signing_pin_changed', action });
    });
  }

  /**
   * 403 `fresh_sign_in_required` unless this session began within
   * SIGNING_PIN_FRESH_MS. Single sign-on is not built: when it is, this
   * must ask for a session of `method` 'sso' whose sign-in the identity
   * provider confirmed by a forced re-authentication (its `auth_time`),
   * not the session row's own time (docs/specs/identity-signing-pin.md).
   */
  private async assertFreshSignIn(auth: AuthContext) {
    const [session] = await this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select({ createdAt: sessions.createdAt })
        .from(sessions)
        .where(eq(sessions.tokenHash, hashToken(auth.token))),
    );
    if (!session || session.createdAt.getTime() < Date.now() - SIGNING_PIN_FRESH_MS) {
      throw new ForbiddenException({ code: 'fresh_sign_in_required' });
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
