import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  approvalRoutes,
  approvalRouteSteps,
  auditLog,
  documentCategories,
  documentTypes,
  incidentCategories,
  incidentResponseRules,
  roleAssignments,
  roles,
  sessions,
  users,
  userTokens,
  notifications,
} from '../database/schema.js';
import type { Localized } from '../i18n/locales.js';
import { DEFAULT_INCIDENT_CATEGORIES } from '../incidents/categories.js';
import {
  DEFAULT_RESPONSE_RULES,
  HARM_LEVELS,
} from '../incidents/response-rules.js';
import {
  DEFAULT_DOCUMENT_CATEGORIES,
  DEFAULT_DOCUMENT_TYPES,
  DEFAULT_ROUTE_NAMES,
  DEFAULT_ROUTE_STEPS,
  FALLBACK_APPROVER,
} from '../policies/defaults.js';
import { EntitlementsService } from '../subscriptions/entitlements.service.js';
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
  constructor(private readonly entitlements: EntitlementsService) {}

  /**
   * The client's named users, as its `users` limit counts them: everyone
   * invited or active. A disabled account cannot sign in and holds no
   * place, so disabling someone who left frees theirs; enabling them again
   * takes one (see `makeRoomForUser`).
   */
  async countNamedUsers(tx: Transaction) {
    const [{ named }] = await tx
      .select({ named: count() })
      .from(users)
      .where(ne(users.status, 'disabled'));
    return named;
  }

  /**
   * Refuses with 409 `limit_reached` when the client has as many named
   * users as its subscription allows. In the transaction that adds one,
   * before adding it: two at once take turns, so they cannot both take the
   * last place.
   */
  makeRoomForUser(tx: Transaction, tenantId: string) {
    return this.entitlements.makeRoom(tx, tenantId, 'users', (t) =>
      this.countNamedUsers(t),
    );
  }

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

  /**
   * Ends every session and one-time link of the client the transaction is
   * scoped to: for a client being suspended, or its subscription cancelled.
   */
  async endAllAccess(tx: Transaction) {
    const now = new Date();
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(isNull(sessions.revokedAt));
    await tx
      .update(userTokens)
      .set({ usedAt: now })
      .where(isNull(userTokens.usedAt));
  }

  /**
   * Creates the built-in roles, or brings them in line with the code. A
   * role the client made itself under the code of a built-in role added
   * later (`approving_authority`) stays the client's own, as migration 0045
   * leaves it: it is not taken over.
   */
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
        },
        setWhere: sql`${roles.isSystem}`,
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

  /**
   * Adds what the policies module starts with (policies/defaults.ts) where
   * the client does not have it yet: the three document types, the
   * categories, and, for each type that has no approval route at all, its
   * starting route. What the client has already, changed, switched off or
   * made itself is left alone. Safe to repeat. Needs the built-in roles,
   * which the route's steps name: call it after `ensureSystemRoles`.
   */
  async ensurePolicyDefaults(tx: Transaction, tenantId: string) {
    await tx
      .insert(documentTypes)
      .values(DEFAULT_DOCUMENT_TYPES.map((t) => ({ ...t, tenantId })))
      .onConflictDoNothing({
        target: [documentTypes.tenantId, documentTypes.code],
      });
    await tx
      .insert(documentCategories)
      .values(DEFAULT_DOCUMENT_CATEGORIES.map((c) => ({ ...c, tenantId })))
      .onConflictDoNothing({
        target: [documentCategories.tenantId, documentCategories.code],
      });
    const types = await tx
      .select({ id: documentTypes.id, code: documentTypes.code })
      .from(documentTypes)
      .where(
        and(
          // Named, not left to row-level security: the seed runs this as
          // the owner role, which sees every client.
          eq(documentTypes.tenantId, tenantId),
          inArray(
            documentTypes.code,
            DEFAULT_DOCUMENT_TYPES.map((t) => t.code),
          ),
          sql`not exists (select from ${approvalRoutes} r where r.tenant_id = ${tenantId} and r.document_type_id = ${documentTypes.id})`,
        ),
      );
    if (types.length === 0) return;
    const builtIn = await tx
      .select({ id: roles.id, code: roles.code })
      .from(roles)
      .where(
        and(
          eq(roles.tenantId, tenantId),
          eq(roles.isSystem, true),
          inArray(roles.code, [
            ...DEFAULT_ROUTE_STEPS.map((s) => s.roleCode),
            FALLBACK_APPROVER,
          ]),
        ),
      );
    const roleOf = new Map(builtIn.map((r) => [r.code, r.id]));
    // The steps whose built-in role the client has. A client whose own role
    // holds a step's code has no built-in one of that code (ensureSystemRoles
    // leaves its role alone). A route is never made without an approval step
    // (security review 7, finding 5): with no Approving authority, the
    // Administrator approves, as the starting route did before it, and the
    // audit entry says so. With neither, no route is made, and documents of
    // the type cannot be sent until the client makes one (409 `no_route`).
    let steps = DEFAULT_ROUTE_STEPS.filter((s) => roleOf.has(s.roleCode));
    let fallback: { missing: string[]; approvedBy: string } | null = null;
    if (!steps.some((s) => s.kind === 'approve')) {
      if (!roleOf.has(FALLBACK_APPROVER)) return;
      const approve = DEFAULT_ROUTE_STEPS.find((s) => s.kind === 'approve')!;
      fallback = {
        missing: DEFAULT_ROUTE_STEPS.filter((s) => !roleOf.has(s.roleCode)).map(
          (s) => s.roleCode,
        ),
        approvedBy: FALLBACK_APPROVER,
      };
      steps = [...steps, { ...approve, roleCode: FALLBACK_APPROVER }];
    }
    steps = steps.map((s, i) => ({ ...s, position: i + 1 }));
    for (const type of types) {
      const [route] = await tx
        .insert(approvalRoutes)
        .values({
          tenantId,
          name: DEFAULT_ROUTE_NAMES[type.code],
          subject: 'document',
          documentTypeId: type.id,
        })
        .returning({ id: approvalRoutes.id });
      await tx.insert(approvalRouteSteps).values(
        steps.map((s) => ({
          tenantId,
          routeId: route.id,
          position: s.position,
          kind: s.kind,
          assigneeRoleId: roleOf.get(s.roleCode)!,
          dueInDays: s.dueInDays,
        })),
      );
      if (fallback) {
        await this.audit(
          tx,
          tenantId,
          null,
          'approval_route_created',
          'approval_route',
          route.id,
          {
            documentTypeId: type.id,
            startingRoute: true,
            steps: steps.map((s) => ({
              position: s.position,
              kind: s.kind,
              roleCode: s.roleCode,
              dueInDays: s.dueInDays,
            })),
            fallback,
          },
        );
      }
    }
  }

  async createUser(
    tx: Transaction,
    tenantId: string,
    input: NewUser,
    grants: RoleGrant[],
    actorId: string | null,
  ) {
    await this.makeRoomForUser(tx, tenantId);
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

  /**
   * What email needs of people: their address, language and status, for
   * these ids. Named columns: never a hash.
   */
  mailboxesOf(tx: Transaction, userIds: string[]) {
    if (userIds.length === 0) return Promise.resolve([]);
    return tx
      .select({
        id: users.id,
        email: users.email,
        preferredLocale: users.preferredLocale,
        status: users.status,
      })
      .from(users)
      .where(inArray(users.id, userIds));
  }

  /** The ids of the client's active users, for the daily digest. */
  async activeUserIds(tx: Transaction) {
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.status, 'active'));
    return rows.map((r) => r.id);
  }

  /**
   * Sets a person's own language (null: the organization's default) and
   * returns what it was before.
   */
  async setPreferredLocale(
    tx: Transaction,
    userId: string,
    locale: string | null,
  ) {
    const [before] = await tx
      .select({ preferredLocale: users.preferredLocale })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!before) return null;
    if (before.preferredLocale !== locale) {
      await tx
        .update(users)
        .set({ preferredLocale: locale, updatedAt: new Date() })
        .where(eq(users.id, userId));
    }
    return before.preferredLocale;
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

  /**
   * The audit entries of one record, of these actions, newest first, one
   * page of them, with how many there are in all: for a history shown on
   * the record itself (a document's changes). In the caller's transaction,
   * so within its client.
   */
  async trailOf(
    tx: Transaction,
    entityType: string,
    entityId: string,
    actions: string[],
    paging: { page: number; pageSize: number },
  ) {
    const where = and(
      eq(auditLog.entityType, entityType),
      eq(auditLog.entityId, entityId),
      inArray(auditLog.action, actions),
    );
    const [{ total }] = await tx
      .select({ total: count() })
      .from(auditLog)
      .where(where);
    const items = await tx
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorId: auditLog.actorId,
        changes: auditLog.changes,
        occurredAt: auditLog.occurredAt,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.occurredAt), desc(auditLog.id))
      .limit(paging.pageSize)
      .offset((paging.page - 1) * paging.pageSize);
    return { items, total };
  }

  /**
   * The other entry the admin portal writes in a client's own audit log:
   * that Trustline's staff set the last day the client may import its
   * existing documents (`import_window_changed`), with the reason. As
   * `auditSubscriptionChange`, for a transaction of the platform role.
   */
  async auditImportWindowChange(
    tx: Transaction,
    tenantId: string,
    changes: Record<string, unknown>,
  ) {
    await tx.execute(sql`
      insert into ${auditLog} (tenant_id, action, entity_type, entity_id, changes)
      values (${tenantId}, 'import_window_changed', 'tenant', ${tenantId}, ${JSON.stringify(changes)}::jsonb)
    `);
  }

  /**
   * An entry the admin portal writes in a client's own audit log: what
   * it changed of the client's subscription (`subscription_changed`), by
   * nobody of the client's. Only for a transaction of the platform role,
   * which may set no other column (migration 0035): the id, the time, the
   * actor and the address are the database's defaults. Not through
   * `insert()`, which names every column of the table.
   */
  async auditSubscriptionChange(
    tx: Transaction,
    tenantId: string,
    changes: Record<string, unknown>,
  ) {
    await tx.execute(sql`
      insert into ${auditLog} (tenant_id, action, entity_type, entity_id, changes)
      values (${tenantId}, 'subscription_changed', 'subscription', ${tenantId}, ${JSON.stringify(changes)}::jsonb)
    `);
  }
}
