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
  riskBands,
  riskCategories,
  riskCommittees,
  riskImpactDomains,
  riskMatrices,
  riskMatrixCells,
  riskMatrixLevels,
  roles,
  tenants,
} from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';
import { SYSTEM_ROLES } from '../src/identity/permissions.js';
import { ProvisioningService } from '../src/identity/provisioning.service.js';
import type { EntitlementsService } from '../src/subscriptions/entitlements.service.js';
import { applyToOwnRows, startsWith } from './support/migration.js';

const MIGRATION = '0075_risk_management_grants_rules_and_existing_clients';
const isRisk = (p: string) => p.startsWith('risks.');

/**
 * Migration 0075, sections 9 and 10, for the clients that existed before
 * the risks module: the
 * module's permissions on their built-in roles, and the same starting
 * matrix, categories and committees a new client gets, each audited once
 * per client. Run on clients of this test's own, twice, in a transaction
 * that is rolled back.
 */
describe('the risks migration, for clients that existed before it', () => {
  const run = randomBytes(4).toString('hex');
  const prefix = `rskmig-${run}`;
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  // Without its grants and its rules (CREATE …): either would hold the
  // tables against every other test file until this one rolls back.
  const text = readFileSync(resolve(import.meta.dirname, `../drizzle/${MIGRATION}.sql`), 'utf8');
  const statements = text
    .slice(text.indexOf('-- 9. '), text.indexOf('-- 11. '))
    .split('--> statement-breakpoint')
    .filter((s) => !/^\s*(GRANT|CREATE)/m.test(s.replace(/--.*$/gm, '')))
    .filter((s) => s.trim().length > 0);
  const ours = `"tenant_id" in (select id from public.tenants where ${startsWith('slug', prefix)})`;

  afterAll(() => owner.pool.end());

  /** A client as it was: its built-in roles without the module's permissions. */
  async function legacy(tx: Transaction, suffix: string) {
    const [t] = await tx
      .insert(tenants)
      .values({ slug: `${prefix}-${suffix}`, name: { en: 'Before' }, accreditationStandard: 'JCI' })
      .returning({ id: tenants.id });
    await tx.insert(roles).values(
      SYSTEM_ROLES.map((r) => ({
        ...r,
        description: { en: 'As it was.' },
        permissions: r.permissions.filter((p) => !isRisk(p)),
        tenantId: t.id,
        isSystem: true,
      })),
    );
    return t.id;
  }

  /** What a client has of the module's settings, without ids. */
  async function settingsOf(tx: Transaction, tenantId: string) {
    const committees = await tx
      .select({ id: riskCommittees.id, code: riskCommittees.code, name: riskCommittees.name, position: riskCommittees.position, memberRoleId: riskCommittees.memberRoleId })
      .from(riskCommittees)
      .where(eq(riskCommittees.tenantId, tenantId))
      .orderBy(asc(riskCommittees.code));
    const codeOf = new Map(committees.map((c) => [c.id, c.code]));
    const categories = await tx
      .select({ code: riskCategories.code, name: riskCategories.name, position: riskCategories.position, appetite: riskCategories.appetite, toleranceBand: riskCategories.toleranceBand, appetiteStatement: riskCategories.appetiteStatement })
      .from(riskCategories)
      .where(eq(riskCategories.tenantId, tenantId))
      .orderBy(asc(riskCategories.code));
    const matrices = await tx
      .select({ id: riskMatrices.id, version: riskMatrices.version, status: riskMatrices.status, likelihoodLevels: riskMatrices.likelihoodLevels, impactLevels: riskMatrices.impactLevels, putInUseBy: riskMatrices.putInUseBy })
      .from(riskMatrices)
      .where(eq(riskMatrices.tenantId, tenantId));
    const parts = [];
    for (const m of matrices) {
      parts.push({
        version: m.version,
        status: m.status,
        size: [m.likelihoodLevels, m.impactLevels],
        putInUseBy: m.putInUseBy,
        levels: await tx
          .select({ axis: riskMatrixLevels.axis, level: riskMatrixLevels.level, label: riskMatrixLevels.label, descriptor: riskMatrixLevels.descriptor, frequency: riskMatrixLevels.frequency })
          .from(riskMatrixLevels)
          .where(eq(riskMatrixLevels.matrixId, m.id))
          .orderBy(asc(riskMatrixLevels.axis), asc(riskMatrixLevels.level)),
        domains: await tx
          .select({ name: riskImpactDomains.name, descriptors: riskImpactDomains.descriptors, position: riskImpactDomains.position, active: riskImpactDomains.active })
          .from(riskImpactDomains)
          .where(eq(riskImpactDomains.matrixId, m.id))
          .orderBy(asc(riskImpactDomains.position)),
        bands: (
          await tx
            .select({ code: riskBands.code, name: riskBands.name, reviewIntervalDays: riskBands.reviewIntervalDays, committee: riskBands.escalateToCommitteeId, signature: riskBands.acceptanceNeedsSignature })
            .from(riskBands)
            .where(eq(riskBands.matrixId, m.id))
            .orderBy(asc(riskBands.code))
        ).map((b) => ({ ...b, committee: b.committee ? codeOf.get(b.committee) : null })),
        cells: await tx
          .select({ likelihood: riskMatrixCells.likelihood, impact: riskMatrixCells.impact, band: riskMatrixCells.bandCode })
          .from(riskMatrixCells)
          .where(eq(riskMatrixCells.matrixId, m.id))
          .orderBy(asc(riskMatrixCells.likelihood), asc(riskMatrixCells.impact)),
      });
    }
    return { committees: committees.map(({ id: _id, ...c }) => c), categories, matrices: parts };
  }

  it('gives them the permissions and the starting settings of a new client, audited once each', async () => {
    const rollback = new Error('rollback');
    let found: Record<string, unknown> = {};
    await expect(
      owner.db.transaction(async (tx) => {
        const old = await legacy(tx, 'old');
        // A client that had renamed nothing yet but made a committee of its
        // own under a starting code keeps it as it is.
        const kept = await legacy(tx, 'kept');
        await tx.insert(riskCommittees).values({ tenantId: kept, code: 'risk_committee', name: { en: 'Our own' }, position: 7 });
        await applyToOwnRows(tx, statements, {
          tenants: startsWith('slug', prefix),
          roles: ours,
          risk_committees: ours,
          risk_categories: ours,
          risk_matrices: ours,
          risk_matrix_levels: ours,
          risk_impact_domains: ours,
          risk_bands: ours,
          risk_matrix_cells: ours,
        });
        // A client made now gets the same from the code, once however often.
        const fresh = (
          await tx
            .insert(tenants)
            .values({ slug: `x${prefix}-new`, name: { en: 'New' }, accreditationStandard: 'JCI' })
            .returning({ id: tenants.id })
        )[0].id;
        const provisioning = new ProvisioningService({} as EntitlementsService);
        await provisioning.ensureSystemRoles(tx, fresh);
        await provisioning.ensureRiskDefaults(tx, fresh);
        await provisioning.ensureRiskDefaults(tx, fresh);
        const roleRows = await tx
          .select({ code: roles.code, permissions: roles.permissions, description: roles.description })
          .from(roles)
          .where(eq(roles.tenantId, old));
        const entries = async (tenantId: string, action: 'built_in_roles_changed_by_system' | 'risk_defaults_created_by_system') =>
          (
            await tx
              .select({ actorId: auditLog.actorId, changes: auditLog.changes })
              .from(auditLog)
              .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, action)))
          ).filter((e) => (e.changes as { migration?: string }).migration === MIGRATION);
        found = {
          permissions: Object.fromEntries(roleRows.map((r) => [r.code, r.permissions.filter(isRisk).sort()])),
          descriptions: Object.fromEntries(roleRows.map((r) => [r.code, r.description])),
          roleEntries: await entries(old, 'built_in_roles_changed_by_system'),
          defaultEntries: await entries(old, 'risk_defaults_created_by_system'),
          migrated: await settingsOf(tx, old),
          provisioned: await settingsOf(tx, fresh),
          kept: (await settingsOf(tx, kept)).committees,
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    const expected = Object.fromEntries(SYSTEM_ROLES.map((r) => [r.code, r.permissions.filter(isRisk).sort()]));
    expect(found.permissions).toEqual(expected);
    expect(expected).toMatchObject({
      administrator: ['risks.approve', 'risks.manage', 'risks.view'],
      quality_officer: ['risks.approve', 'risks.manage', 'risks.view'],
      department_manager: ['risks.manage', 'risks.view'],
      approving_authority: ['risks.approve', 'risks.view'],
      external_reviewer: ['risks.view'],
      reporter: [],
    });
    const descriptions = found.descriptions as Record<string, unknown>;
    for (const code of ['quality_officer', 'department_manager', 'external_reviewer']) {
      expect(descriptions[code]).toEqual(SYSTEM_ROLES.find((r) => r.code === code)!.description);
    }
    // Exactly what each role got (security review 15).
    expect(found.roleEntries).toEqual([
      {
        actorId: null,
        changes: {
          migration: MIGRATION,
          roles: ['administrator', 'approving_authority', 'department_manager', 'external_reviewer', 'quality_officer'],
          permissionsAdded: {
            administrator: ['risks.view', 'risks.manage', 'risks.approve'],
            approving_authority: ['risks.view', 'risks.approve'],
            department_manager: ['risks.view', 'risks.manage'],
            external_reviewer: ['risks.view'],
            quality_officer: ['risks.view', 'risks.manage', 'risks.approve'],
          },
        },
      },
    ]);
    expect(found.defaultEntries).toHaveLength(1);
    expect(found.defaultEntries).toMatchObject([
      {
        actorId: null,
        changes: {
          migration: MIGRATION,
          matrix: { version: 1, likelihoodLevels: 5, impactLevels: 5 },
          categories: expect.arrayContaining(['people_safety', 'strategy']),
          committees: ['risk_committee', 'governing_body'],
        },
      },
    ]);
    const migrated = found.migrated as Awaited<ReturnType<typeof settingsOf>>;
    expect(migrated.matrices).toHaveLength(1);
    expect(migrated.matrices[0]).toMatchObject({ version: 1, status: 'in_use', size: [5, 5], putInUseBy: null });
    expect(migrated).toEqual(found.provisioned);
    expect(found.kept).toEqual([
      { code: 'governing_body', name: expect.any(Object), position: 2, memberRoleId: null },
      { code: 'risk_committee', name: { en: 'Our own' }, position: 7, memberRoleId: null },
    ]);
  });

  /**
   * Migration 0075, section 11: the starting acceptance and closure routes
   * for a client that has none, as a new client gets them, audited once;
   * none for a client that made its own, nor where a role is missing.
   */
  it('gives them the starting acceptance and closure routes of a new client, audited once', async () => {
    const ROUTES = MIGRATION;
    const section = text
      .slice(text.indexOf('-- 11. '))
      .split('--> statement-breakpoint')
      .filter((x) => x.trim().length > 0);
    const rollback = new Error('rollback');
    let found: Record<string, unknown> = {};
    const routesOf = async (tx: Transaction, tenantId: string) => {
      const list = await tx
        .select({ id: approvalRoutes.id, subject: approvalRoutes.subject, variant: approvalRoutes.variant, name: approvalRoutes.name, active: approvalRoutes.active })
        .from(approvalRoutes)
        .where(and(eq(approvalRoutes.tenantId, tenantId), eq(approvalRoutes.subject, 'risk_acceptance')))
        .orderBy(asc(approvalRoutes.variant));
      const closure = await tx
        .select({ id: approvalRoutes.id, subject: approvalRoutes.subject, variant: approvalRoutes.variant, name: approvalRoutes.name, active: approvalRoutes.active })
        .from(approvalRoutes)
        .where(and(eq(approvalRoutes.tenantId, tenantId), eq(approvalRoutes.subject, 'risk_closure')));
      const codeOf = new Map((await tx.select({ id: roles.id, code: roles.code }).from(roles).where(eq(roles.tenantId, tenantId))).map((r) => [r.id, r.code]));
      const out = [];
      for (const r of [...list, ...closure]) {
        const steps = await tx
          .select({ position: approvalRouteSteps.position, kind: approvalRouteSteps.kind, roleId: approvalRouteSteps.assigneeRoleId, dueInDays: approvalRouteSteps.dueInDays })
          .from(approvalRouteSteps)
          .where(eq(approvalRouteSteps.routeId, r.id))
          .orderBy(asc(approvalRouteSteps.position));
        out.push({ subject: r.subject, variant: r.variant, name: r.name, active: r.active, steps: steps.map((x) => ({ ...x, roleId: codeOf.get(x.roleId!) })) });
      }
      return out;
    };
    await expect(
      owner.db.transaction(async (tx) => {
        const all = async (suffix: string) => {
          const [t] = await tx
            .insert(tenants)
            .values({ slug: `${prefix}-${suffix}`, name: { en: 'Before' }, accreditationStandard: 'JCI' })
            .returning({ id: tenants.id });
          await tx.insert(roles).values(SYSTEM_ROLES.map((r) => ({ ...r, tenantId: t.id, isSystem: true })));
          return t.id;
        };
        const old = await all('routes');
        // A client with a closure route of its own keeps it, and gets the others.
        const own = await all('ownroute');
        await tx.insert(approvalRoutes).values({ tenantId: own, name: { en: 'Ours' }, subject: 'risk_closure', variant: null, active: false });
        // A client without the Approving authority gets only the closure route.
        const without = await all('noauthority');
        await tx.delete(roles).where(and(eq(roles.tenantId, without), eq(roles.code, 'approving_authority')));
        await applyToOwnRows(tx, section, { tenants: startsWith('slug', prefix) });
        const fresh = (
          await tx
            .insert(tenants)
            .values({ slug: `x${prefix}-routes-new`, name: { en: 'New' }, accreditationStandard: 'JCI' })
            .returning({ id: tenants.id })
        )[0].id;
        const provisioning = new ProvisioningService({} as EntitlementsService);
        await provisioning.ensureSystemRoles(tx, fresh);
        await provisioning.ensureRiskRoutes(tx, fresh);
        await provisioning.ensureRiskRoutes(tx, fresh);
        const entries = async (tenantId: string) =>
          (
            await tx
              .select({ actorId: auditLog.actorId, changes: auditLog.changes })
              .from(auditLog)
              .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'risk_defaults_created_by_system')))
          ).filter((e) => (e.changes as { migration?: string }).migration === ROUTES);
        found = {
          migrated: await routesOf(tx, old),
          provisioned: await routesOf(tx, fresh),
          own: await routesOf(tx, own),
          without: await routesOf(tx, without),
          oldEntries: await entries(old),
          withoutEntries: await entries(without),
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(found.migrated).toEqual(found.provisioned);
    expect(found.migrated).toMatchObject([
      { variant: 'extreme', steps: [{ kind: 'review', roleId: 'quality_officer', dueInDays: 7 }, { kind: 'approve', roleId: 'approving_authority', dueInDays: 7 }] },
      { variant: 'high', steps: [{ kind: 'approve', roleId: 'approving_authority' }] },
      { variant: 'medium', steps: [{ kind: 'approve', roleId: 'approving_authority' }] },
      { subject: 'risk_closure', variant: null, steps: [{ kind: 'approve', roleId: 'quality_officer' }] },
    ]);
    expect((found.own as { subject: string; name: unknown }[]).filter((r) => r.subject === 'risk_closure')).toEqual([
      expect.objectContaining({ name: { en: 'Ours' }, active: false, steps: [] }),
    ]);
    expect((found.own as unknown[]).length).toBe(4);
    expect((found.without as { subject: string }[]).map((r) => r.subject)).toEqual(['risk_closure']);
    expect(found.oldEntries).toEqual([
      {
        actorId: null,
        changes: {
          migration: ROUTES,
          routes: [
            { subject: 'risk_acceptance', variant: 'medium' },
            { subject: 'risk_acceptance', variant: 'high' },
            { subject: 'risk_acceptance', variant: 'extreme' },
            { subject: 'risk_closure', variant: null },
          ],
        },
      },
    ]);
    expect(found.withoutEntries).toEqual([
      { actorId: null, changes: { migration: ROUTES, routes: [{ subject: 'risk_closure', variant: null }] } },
    ]);
  });
});
