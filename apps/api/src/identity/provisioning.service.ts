import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  auditLog,
  incidentCategories,
  incidentResponseRules,
  roleAssignments,
  roles,
  users,
  userTokens,
} from '../database/schema.js';
import type { Localized } from '../i18n/locales.js';
import { DEFAULT_INCIDENT_CATEGORIES } from '../incidents/categories.js';
import {
  DEFAULT_RESPONSE_RULES,
  HARM_LEVELS,
} from '../incidents/response-rules.js';
import { SYSTEM_ROLES } from './permissions.js';

export const INVITE_HOURS = 72;

export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export type RoleGrant = { roleId: string; orgUnitId: string | null };

export type NewUser = {
  name: Localized;
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
  /**
   * What each of these roles allows, by role id, or null if one of them does
   * not exist in this hospital.
   */
  async permissionsByRole(tx: Transaction, roleIds: string[]) {
    const ids = [...new Set(roleIds)];
    if (ids.length === 0) return new Map<string, string[]>();
    const found = await tx
      .select({ id: roles.id, permissions: roles.permissions })
      .from(roles)
      .where(inArray(roles.id, ids));
    if (found.length !== ids.length) return null;
    return new Map(found.map((r) => [r.id, r.permissions]));
  }

  /**
   * What a user's current roles allow, one entry per grant, each with the
   * place it was granted for (null: the whole organization).
   */
  grantsOfUser(tx: Transaction, userId: string) {
    return tx
      .select({
        permissions: roles.permissions,
        orgUnitId: roleAssignments.orgUnitId,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));
  }

  /** Ends every unused set-password link of a user. */
  async voidInvites(tx: Transaction, userId: string) {
    await tx
      .update(userTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(userTokens.userId, userId), isNull(userTokens.usedAt)));
  }

  /** Creates the built-in roles, or brings them in line with the code. */
  async ensureSystemRoles(tx: Transaction, tenantId: string) {
    await tx
      .insert(roles)
      .values(SYSTEM_ROLES.map((r) => ({ ...r, tenantId, isSystem: true })))
      .onConflictDoUpdate({
        target: [roles.tenantId, roles.code],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          permissions: sql`excluded.permissions`,
          isSystem: true,
        },
      });
  }

  /**
   * Adds the default incident categories a client does not have yet. Ones it
   * already has are left alone, so its own renaming, order and switched-off
   * categories survive. Safe to repeat.
   */
  async ensureIncidentCategories(tx: Transaction, tenantId: string) {
    await tx
      .insert(incidentCategories)
      .values(DEFAULT_INCIDENT_CATEGORIES.map((c) => ({ ...c, tenantId })))
      .onConflictDoNothing({
        target: [incidentCategories.tenantId, incidentCategories.code],
      });
  }

  /**
   * Adds the starting response rules (how soon to triage and to close, by
   * harm level) a client does not have yet. Ones it already has are left
   * alone: they are the hospital's own decision. Safe to repeat.
   */
  async ensureResponseRules(tx: Transaction, tenantId: string) {
    await tx
      .insert(incidentResponseRules)
      .values(
        HARM_LEVELS.map((harmLevel) => ({
          ...DEFAULT_RESPONSE_RULES[harmLevel],
          harmLevel,
          tenantId,
        })),
      )
      .onConflictDoNothing({
        target: [
          incidentResponseRules.tenantId,
          incidentResponseRules.harmLevel,
        ],
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
    await this.voidInvites(tx, userId);
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
