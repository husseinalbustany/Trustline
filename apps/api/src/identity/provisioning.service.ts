import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  auditLog,
  roleAssignments,
  roles,
  users,
  userTokens,
} from '../database/schema.js';
import { SYSTEM_ROLES } from './permissions.js';

export const INVITE_HOURS = 72;

export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export type RoleGrant = { roleId: string; orgUnitId: string | null };

export type NewUser = {
  nameEn: string;
  nameAr: string;
  email: string;
  orgUnitId?: string | null;
  employeeNumber?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
};

/**
 * Creates the records a hospital account is made of. Every method takes a
 * transaction already scoped to the tenant by TenantDb.withTenant().
 */
@Injectable()
export class ProvisioningService {
  /** Creates the built-in roles, or brings them in line with the code. */
  async ensureSystemRoles(tx: Transaction, tenantId: string) {
    await tx
      .insert(roles)
      .values(SYSTEM_ROLES.map((r) => ({ ...r, tenantId, isSystem: true })))
      .onConflictDoUpdate({
        target: [roles.tenantId, roles.code],
        set: {
          nameEn: sql`excluded.name_en`,
          nameAr: sql`excluded.name_ar`,
          description: sql`excluded.description`,
          permissions: sql`excluded.permissions`,
          isSystem: true,
        },
      });
  }

  async createUser(
    tx: Transaction,
    tenantId: string,
    input: NewUser,
    grants: RoleGrant[],
    actorId: string | null,
  ) {
    const [user] = await tx
      .insert(users)
      .values({ ...input, email: input.email.trim().toLowerCase(), tenantId })
      .returning();
    await this.setRoles(tx, tenantId, user.id, grants, actorId);
    await this.audit(tx, tenantId, actorId, 'user_created', 'user', user.id, {
      email: user.email,
    });
    return user;
  }

  async setRoles(
    tx: Transaction,
    tenantId: string,
    userId: string,
    grants: RoleGrant[],
    actorId: string | null,
  ) {
    await tx.delete(roleAssignments).where(eq(roleAssignments.userId, userId));
    if (grants.length === 0) return;
    await tx.insert(roleAssignments).values(
      grants.map((g) => ({
        tenantId,
        userId,
        roleId: g.roleId,
        orgUnitId: g.orgUnitId,
        grantedBy: actorId,
      })),
    );
  }

  /**
   * Issues a one-time link token for setting a password, replacing any
   * earlier unused one. Only the hash is stored.
   */
  async createInvite(
    tx: Transaction,
    tenantId: string,
    userId: string,
    purpose: 'invitation' | 'password_reset',
  ) {
    await tx
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(userTokens.userId, userId), isNull(userTokens.usedAt)));
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_HOURS * 3_600_000);
    await tx.insert(userTokens).values({
      tenantId,
      userId,
      purpose,
      tokenHash: hashToken(token),
      expiresAt,
    });
    return { token, expiresAt };
  }

  async audit(
    tx: Transaction,
    tenantId: string,
    actorId: string | null,
    action: string,
    entityType: string | null = null,
    entityId: string | null = null,
    changes: Record<string, unknown> | null = null,
    ipAddress: string | null = null,
  ) {
    await tx.insert(auditLog).values({
      tenantId,
      actorId,
      action,
      entityType,
      entityId,
      changes,
      ipAddress,
    });
  }
}
