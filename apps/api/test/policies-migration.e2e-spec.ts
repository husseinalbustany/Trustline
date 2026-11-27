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
  const statementsOf = (file: string) =>
    readFileSync(resolve(import.meta.dirname, `../drizzle/${file}.sql`), 'utf8')
      .split('--> statement-breakpoint')
      // Without its grants: a grant would hold the tables against every
      // other test file until this one rolls back.
      .filter((s) => !/^\s*GRANT/m.test(s.replace(/--.*$/gm, '')));
  // What a client from before the module went through: the module's
  // starting data (0039), then its rewording after language review 6
  // (0043).
  const statements = [
    ...statementsOf('0039_policies_grants_and_existing_clients'),
    ...statementsOf('0043_policies_grants_and_starting_wording'),
  ];
  const rewording = statementsOf('0043_policies_grants_and_starting_wording');
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
          document_categories: ours,
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

  it('rewords the starting sections and categories only where a client has not renamed them, audited once', async () => {
    const rollback = new Error('rollback');
    let found: Record<string, unknown> = {};
    await expect(
      owner.db.transaction(async (tx) => {
        const id = await legacy(tx, 'renamed');
        // The module's starting data as 0039 gave it.
        await applyToOwnRows(tx, statementsOf('0039_policies_grants_and_existing_clients'), {
          tenants: startsWith('slug', prefix),
          roles: ours,
          document_types: ours,
          document_categories: ours,
          approval_routes: ours,
        });
        // The client renamed the procedure's steps in French, and its INF
        // category in English, itself.
        const [procedure] = await tx
          .select({ id: documentTypes.id, sections: documentTypes.sections })
          .from(documentTypes)
          .where(and(eq(documentTypes.tenantId, id), eq(documentTypes.code, 'procedure')));
        await tx
          .update(documentTypes)
          .set({
            sections: procedure.sections.map((s) =>
              s.key === 'steps' ? { ...s, name: { ...s.name, fr: 'Les étapes chez nous' } } : s,
            ),
          })
          .where(eq(documentTypes.id, procedure.id));
        await tx
          .update(documentCategories)
          .set({ name: { en: 'Our records', ar: 'المعلومات', fr: 'Information' } })
          .where(and(eq(documentCategories.tenantId, id), eq(documentCategories.code, 'INF')));
        await applyToOwnRows(tx, rewording, {
          document_types: ours,
          document_categories: ours,
        });
        const settings = await settingsOf(tx, id);
        const sectionName = (type: string, key: string) =>
          settings.types.find((t) => t.code === type)!.sections.find((s) => s.key === key)!.name;
        found = {
          procedureSteps: sectionName('procedure', 'steps'),
          instructionSteps: sectionName('work_instruction', 'steps'),
          statements: sectionName('policy', 'policy_statements'),
          inf: settings.categories.find((c) => c.code === 'INF')!.name,
          entries: await tx
            .select({ actorId: auditLog.actorId, changes: auditLog.changes })
            .from(auditLog)
            .where(and(eq(auditLog.tenantId, id), eq(auditLog.action, 'policy_defaults_reworded_by_system'))),
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    // Arabic reworded; the French the client wrote kept.
    expect(found.procedureSteps).toEqual({ en: 'Steps', ar: 'خطوات العمل', fr: 'Les étapes chez nous' });
    expect(found.instructionSteps).toEqual({ en: 'Steps', ar: 'خطوات العمل', fr: 'Déroulement' });
    expect(found.statements).toEqual({ en: 'Policy statements', ar: 'بنود السياسة', fr: 'Dispositions' });
    expect(found.inf).toEqual({ en: 'Our records', ar: 'إدارة المعلومات', fr: 'Gestion de l’information' });
    // Applied twice, audited once.
    expect(found.entries).toEqual([
      {
        actorId: null,
        changes: {
          migration: '0043_policies_grants_and_starting_wording',
          types: ['policy', 'procedure', 'work_instruction'],
          categories: ['INF'],
        },
      },
    ]);
  });

  it('match the built-in roles in the code', () => {
    for (const code of ['administrator', 'quality_officer', 'department_manager']) {
      const role = SYSTEM_ROLES.find((r) => r.code === code)!;
      expect(NEW.every((p) => role.permissions.includes(p as never))).toBe(true);
    }
    expect(SYSTEM_ROLES.find((r) => r.code === 'reporter')!.permissions).toEqual(['incidents.report', 'policies.view']);
  });
});
