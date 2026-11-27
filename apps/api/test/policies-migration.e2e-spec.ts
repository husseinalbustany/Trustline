import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { createDatabase, type Transaction } from '../src/database/client.js';
import {
  approvalRoutes,
  approvalRouteSteps,
  auditLog,
  documentCategories,
  documentTypes,
  roles,
  tenants,
} from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';
import { SYSTEM_ROLES } from '../src/identity/permissions.js';
import { ProvisioningService } from '../src/identity/provisioning.service.js';
import type { EntitlementsService } from '../src/subscriptions/entitlements.service.js';
import { applyToOwnRows, startsWith } from './support/migration.js';

const NEW = ['policies.approve', 'policies.view_all'];

/**
 * Migration 0039 for the clients that existed before the policies module:
 * the two new permissions on their built-in roles, audited, and the same
 * starting types, categories and routes a new client gets. Run on clients
 * of this test's own, in a transaction that is rolled back.
 */
describe('the policies migration, for clients that existed before it', () => {
  const run = randomBytes(4).toString('hex');
  const prefix = `polmig-${run}`;
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  const statements = readFileSync(
    resolve(import.meta.dirname, '../drizzle/0039_policies_grants_and_existing_clients.sql'),
    'utf8',
  )
    .split('--> statement-breakpoint')
    // Without its grants: a grant would hold the tables against every other
    // test file until this one rolls back.
    .filter((s) => !/^\s*GRANT/m.test(s.replace(/--.*$/gm, '')));
  const ours = `"tenant_id" in (select id from public.tenants where ${startsWith('slug', prefix)})`;

  afterAll(() => owner.pool.end());

  /** A client as it was: its built-in roles without the new permissions. */
  async function legacy(tx: Transaction, suffix: string) {
    const [t] = await tx
      .insert(tenants)
      .values({ slug: `${prefix}-${suffix}`, name: { en: 'Before' }, accreditationStandard: 'JCI' })
      .returning({ id: tenants.id });
    await tx.insert(roles).values(
      SYSTEM_ROLES.map((r) => ({
        ...r,
        permissions: r.permissions.filter((p) => !NEW.includes(p)),
        tenantId: t.id,
        isSystem: true,
      })),
    );
    return t.id;
  }

  /** What a client has of the module's settings, without ids. */
  async function settingsOf(tx: Transaction, tenantId: string) {
    const typeList = await tx
      .select({
        id: documentTypes.id,
        code: documentTypes.code,
        name: documentTypes.name,
        numberPrefix: documentTypes.numberPrefix,
        sections: documentTypes.sections,
        defaultReviewMonths: documentTypes.defaultReviewMonths,
        position: documentTypes.position,
      })
      .from(documentTypes)
      .where(eq(documentTypes.tenantId, tenantId))
      .orderBy(asc(documentTypes.code));
    const categoryList = await tx
      .select({ code: documentCategories.code, name: documentCategories.name, position: documentCategories.position })
      .from(documentCategories)
      .where(eq(documentCategories.tenantId, tenantId))
      .orderBy(asc(documentCategories.code));
    const routes = [];
    for (const type of typeList) {
      const found = await tx
        .select({ id: approvalRoutes.id, name: approvalRoutes.name })
        .from(approvalRoutes)
        .where(and(eq(approvalRoutes.tenantId, tenantId), eq(approvalRoutes.documentTypeId, type.id)));
      for (const route of found) {
        const steps = await tx
          .select({
            position: approvalRouteSteps.position,
            kind: approvalRouteSteps.kind,
            role: roles.code,
            dueInDays: approvalRouteSteps.dueInDays,
          })
          .from(approvalRouteSteps)
          .innerJoin(roles, eq(roles.id, approvalRouteSteps.assigneeRoleId))
          .where(eq(approvalRouteSteps.routeId, route.id))
          .orderBy(asc(approvalRouteSteps.position));
        routes.push({ type: type.code, name: route.name, steps });
      }
    }
    return {
      types: typeList.map(({ id: _id, ...t }) => t),
      categories: categoryList,
      routes,
    };
  }

  it('gives them the new permissions, audited, and what a new client starts with, once', async () => {
    const rollback = new Error('rollback');
    let found: Record<string, unknown> = {};
    await expect(
      owner.db.transaction(async (tx) => {
        const old = await legacy(tx, 'old');
        const fresh = await legacy(tx, 'new');
        // Narrowed to this test's clients, and applied twice.
        await applyToOwnRows(tx, statements, {
          tenants: startsWith('slug', prefix),
          roles: ours,
          document_types: ours,
          approval_routes: ours,
        });
        // A client made now gets the same from the code.
        await tx.delete(approvalRouteSteps).where(eq(approvalRouteSteps.tenantId, fresh));
        await tx.delete(approvalRoutes).where(eq(approvalRoutes.tenantId, fresh));
        await tx.delete(documentTypes).where(eq(documentTypes.tenantId, fresh));
        await tx.delete(documentCategories).where(eq(documentCategories.tenantId, fresh));
        const provisioning = new ProvisioningService({} as EntitlementsService);
        await provisioning.ensurePolicyDefaults(tx, fresh);
        await provisioning.ensurePolicyDefaults(tx, fresh);
        const permissions = Object.fromEntries(
          (
            await tx
              .select({ code: roles.code, permissions: roles.permissions })
              .from(roles)
              .where(eq(roles.tenantId, old))
          ).map((r) => [r.code, NEW.filter((p) => r.permissions.includes(p))]),
        );
        const entries = await tx
          .select({ actorId: auditLog.actorId, changes: auditLog.changes })
          .from(auditLog)
          .where(and(eq(auditLog.tenantId, old), eq(auditLog.action, 'built_in_roles_changed_by_system')));
        found = {
          permissions,
          entries,
          migrated: await settingsOf(tx, old),
          provisioned: await settingsOf(tx, fresh),
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(found.permissions).toEqual({
      administrator: NEW,
      quality_officer: NEW,
      department_manager: NEW,
      reporter: [],
    });
    expect(found.entries).toEqual([
      {
        actorId: null,
        changes: {
          migration: '0039_policies_grants_and_existing_clients',
          roles: ['administrator', 'department_manager', 'quality_officer'],
          permissionsAdded: NEW,
        },
      },
    ]);
    const migrated = found.migrated as Awaited<ReturnType<typeof settingsOf>>;
    expect(migrated.types.map((t) => t.code)).toEqual(['policy', 'procedure', 'work_instruction']);
    expect(migrated.categories).toHaveLength(6);
    expect(migrated.routes.map((r) => [r.type, r.steps.map((s) => `${s.kind}:${s.role}:${s.dueInDays}`)])).toEqual([
      ['policy', ['review:quality_officer:7', 'approve:administrator:7']],
      ['procedure', ['review:quality_officer:7', 'approve:administrator:7']],
      ['work_instruction', ['review:quality_officer:7', 'approve:administrator:7']],
    ]);
    // Word for word what the code gives a new client.
    expect(migrated).toEqual(found.provisioned);
  });

  it('match the built-in roles in the code', () => {
    for (const code of ['administrator', 'quality_officer', 'department_manager']) {
      const role = SYSTEM_ROLES.find((r) => r.code === code)!;
      expect(NEW.every((p) => role.permissions.includes(p as never))).toBe(true);
    }
    expect(SYSTEM_ROLES.find((r) => r.code === 'reporter')!.permissions).toEqual(['incidents.report', 'policies.view']);
  });
});
