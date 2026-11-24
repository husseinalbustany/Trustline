import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import {
  platformAdmins,
  platformAuditLog,
  platformSessions,
} from '../database/schema.js';
import { hashPassword, verifyPassword } from '../security/passwords.js';

export const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
export const SESSION_HOURS = 8;

export type PlatformAdmin = { id: string; email: string; name: string };

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class PlatformAuthService {
  // Verified when the email is unknown, so that case takes as long as a wrong
  // password and does not reveal which emails exist.
  private dummyHash?: Promise<string>;

  constructor(@Inject(PLATFORM_DATABASE) private readonly db: Database) {}

  /** Returns a session token and the admin, or null if sign-in is refused. */
  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; admin: PlatformAdmin } | null> {
    const [admin] = await this.db
      .select()
      .from(platformAdmins)
      .where(eq(platformAdmins.email, email.trim().toLowerCase()));

    if (!admin) {
      this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
      await verifyPassword(password, await this.dummyHash);
      return null;
    }

    const locked = admin.lockedUntil && admin.lockedUntil > new Date();
    const valid = await verifyPassword(password, admin.passwordHash);

    if (locked || !valid) {
      if (!locked) await this.recordFailure(admin.id);
      await this.audit(admin.id, 'sign_in_failed', null, { locked: !!locked });
      return null;
    }

    const token = randomBytes(32).toString('base64url');
    await this.db
      .delete(platformSessions)
      .where(lt(platformSessions.expiresAt, new Date()));
    await this.db.insert(platformSessions).values({
      tokenHash: hashToken(token),
      adminId: admin.id,
      expiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000),
    });
    await this.db
      .update(platformAdmins)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(platformAdmins.id, admin.id));
    await this.audit(admin.id, 'sign_in');

    return {
      token,
      admin: { id: admin.id, email: admin.email, name: admin.name },
    };
  }

  private async recordFailure(adminId: string) {
    // One statement, so parallel attempts cannot skip the lock.
    await this.db
      .update(platformAdmins)
      .set({
        failedAttempts: sql`case when ${platformAdmins.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then 0 else ${platformAdmins.failedAttempts} + 1 end`,
        lockedUntil: sql`case when ${platformAdmins.failedAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} then now() + make_interval(mins => ${LOCK_MINUTES}) else ${platformAdmins.lockedUntil} end`,
      })
      .where(eq(platformAdmins.id, adminId));
  }

  async findSession(token: string): Promise<PlatformAdmin | null> {
    const [row] = await this.db
      .select({
        id: platformAdmins.id,
        email: platformAdmins.email,
        name: platformAdmins.name,
        expiresAt: platformSessions.expiresAt,
      })
      .from(platformSessions)
      .innerJoin(
        platformAdmins,
        eq(platformAdmins.id, platformSessions.adminId),
      )
      .where(eq(platformSessions.tokenHash, hashToken(token)));
    if (!row || row.expiresAt <= new Date()) return null;
    return { id: row.id, email: row.email, name: row.name };
  }

  async logout(token: string, adminId: string) {
    await this.db
      .delete(platformSessions)
      .where(eq(platformSessions.tokenHash, hashToken(token)));
    await this.audit(adminId, 'sign_out');
  }

  async audit(
    adminId: string,
    action: string,
    targetTenantId: string | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    await this.db
      .insert(platformAuditLog)
      .values({ adminId, action, targetTenantId, details });
  }
}
