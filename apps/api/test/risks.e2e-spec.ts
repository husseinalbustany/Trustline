import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createDatabase } from '../src/database/client.js';
import { auditLog, riskMatrices, riskMatrixCells, riskRatings, risks, tenants } from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { requireEnv } from '../src/env.js';
import {
  DEFAULT_BANDS,
  DEFAULT_CATEGORIES,
  DEFAULT_COMMITTEES,
  DEFAULT_DOMAINS,
  DEFAULT_IMPACT,
  DEFAULT_LIKELIHOOD,
  defaultBandOf,
} from '../src/risks/defaults.js';
import { testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

const NO_LIMITS = { users: null, sites: null, storageMb: null, aiCreditsPerMonth: null };
const NO_EXTRAS = { sso: false, publicReporting: false, clinicalAiSuggestions: false };

type Matrix = {
  id: string;
  version: number;
  status: string;
  revision: number;
  likelihoodLevels: number;
  impactLevels: number;
  likelihood: { level: number; label: Record<string, string>; descriptor: Record<string, string> | null; frequency: Record<string, string> | null }[];
  impact: { level: number; label: Record<string, string>; descriptor: Record<string, string> | null }[];
  domains: { id: string; name: Record<string, string>; descriptors: Record<string, Record<string, string>>; position: number; active: boolean }[];
  bands: { code: string; name: Record<string, string>; reviewIntervalDays: number; escalateToCommitteeId: string | null; acceptanceNeedsSignature: boolean }[];
  cells: { likelihood: number; impact: number; band: string }[];
};

/**
 * Risk management, steps 1 and 2 (docs/specs/risk-management.md): the
 * settings (permissions and built-in roles, the starting matrix,
 * categories and committees, changed only by a manager for the whole
 * organization) and the register (scope by unit, the organization's own
 * risks, 404 out of reach, stale revisions, the rating rules, moves), each
 * route answering 401 without a session, 403 without its permission, 404
 * for another client's record and 400 for what it does not take, and the
 * module answering 404 like an unknown route where it is off.
 */
describe('risk management', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();

  let h: Hospital;
  let other: Hospital;
  let off: Hospital;
  let facility: string;
  let d1: string;
  let u1: string;
  let d2: string;
  let otherUnit: string;

  let quality: Staff;
  let d1Manager: Staff;
  let d2Viewer: Staff;
  let wholeViewer: Staff;
  let reporter: Staff;
  let otherQuality: Staff;

  let categories: Record<string, string>;
  let committees: Record<string, string>;
  let matrix: Matrix;

  const as = (who: { cookie: string }) => ({
    get: (url: string) => http().get(url).set('Cookie', who.cookie),
    post: (url: string) => http().post(url).set('Cookie', who.cookie),
    patch: (url: string) => http().patch(url).set('Cookie', who.cookie),
  });

  const riskBody = (unitId: string | null, extra: Record<string, unknown> = {}) => ({
    orgUnitId: unitId,
    categoryId: categories.people_safety,
    title: { en: `Slips on a wet floor ${run}` },
    cause: { en: 'Floors are mopped while people walk through.' },
    event: { en: 'Someone slips in a corridor.' },
    consequence: { en: 'A fall, with injury.' },
    ownerId: reporter.id,
    inherent: { likelihood: 4, impact: 3 },
    // 6: Medium, within the starting tolerance.
    current: { likelihood: 2, impact: 3 },
    ...extra,
  });

  const create = async (who: Staff, unitId: string | null, extra: Record<string, unknown> = {}) =>
    (await as(who).post('/risks').send(riskBody(unitId, extra)).expect(201)).body as {
      id: string;
      reference: string;
      revision: number;
      status: string;
    };

  const auditOf = (tenantId: string, action: string, entityId?: string) =>
    bench.owner.db
      .select({ changes: auditLog.changes, actorId: auditLog.actorId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, action),
          entityId ? eq(auditLog.entityId, entityId) : undefined,
        ),
      );

  beforeAll(async () => {
    bench = await testBench('rk', run);
    h = await bench.createHospital('main');
    other = await bench.createHospital('other');
    off = await bench.createHospital('off');
    facility = await bench.createUnit(h, 'facility', 'F', null);
    d1 = await bench.createUnit(h, 'department', 'D1', facility);
    u1 = await bench.createUnit(h, 'unit', 'U1', d1);
    d2 = await bench.createUnit(h, 'department', 'D2', facility);
    otherUnit = await bench.createUnit(other, 'facility', 'OF', null);
    await bench.createRole(h, 'risk_reader', ['risks.view']);

    quality = await bench.createStaff(h, 'quality', { role: 'quality_officer', orgUnitId: null });
    d1Manager = await bench.createStaff(h, 'd1manager', { role: 'department_manager', orgUnitId: d1 });
    d2Viewer = await bench.createStaff(h, 'd2viewer', { role: 'risk_reader', orgUnitId: d2 });
    wholeViewer = await bench.createStaff(h, 'wholeviewer', { role: 'risk_reader', orgUnitId: null });
    reporter = await bench.createStaff(h, 'reporter', { role: 'reporter', orgUnitId: null });
    otherQuality = await bench.createStaff(other, 'otherquality', { role: 'quality_officer', orgUnitId: null });

    const settings = (await as(h).get('/risks/settings').expect(200)).body;
    categories = Object.fromEntries(settings.categories.map((c: { code: string; id: string }) => [c.code, c.id]));
    committees = Object.fromEntries(settings.committees.map((c: { code: string; id: string }) => [c.code, c.id]));
    matrix = settings.matrix;

    // A client whose plan has no risks module.
    const plan = await http()
      .post('/platform/plans')
      .set('Cookie', bench.platform)
      .send({
        code: `${bench.prefix}-norisk`,
        name: { en: 'No risks', ar: 'بلا مخاطر', fr: 'Sans risques' },
        modules: ['incidents', 'policies'],
        limits: NO_LIMITS,
        extras: NO_EXTRAS,
      })
      .expect(201);
    await http()
      .patch(`/platform/tenants/${off.id}/subscription`)
      .set('Cookie', bench.platform)
      .send({ planId: plan.body.id })
      .expect(200);
  }, 120_000);

  afterAll(() => bench.close());

  describe('permissions and built-in roles', () => {
    it('gives the module’s permissions to the built-in roles of a new client', async () => {
      const list = (await as(h).get('/roles').expect(200)).body as {
        roles: { code: string; permissions: string[] }[];
        permissions: string[];
      };
      expect(list.permissions).toEqual(expect.arrayContaining(['risks.view', 'risks.manage', 'risks.approve']));
      const held = (code: string) =>
        list.roles.find((r) => r.code === code)!.permissions.filter((p) => p.startsWith('risks.')).sort();
      expect(held('administrator')).toEqual(['risks.approve', 'risks.manage', 'risks.view']);
      expect(held('quality_officer')).toEqual(['risks.approve', 'risks.manage', 'risks.view']);
      expect(held('department_manager')).toEqual(['risks.manage', 'risks.view']);
      expect(held('approving_authority')).toEqual(['risks.approve', 'risks.view']);
      expect(held('reporter')).toEqual([]);
    });

    it('gave them to the clients that existed before the module, with one audit entry each', async () => {
      // The demo clients: by the migration when they existed before it, by
      // the seed when the database was made after it.
      const [jci] = await bench.owner.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, 'demo-jci'));
      const { rows } = await bench.owner.db.execute<{ code: string; permissions: string[] }>(
        sql`select code, permissions from roles where tenant_id = ${jci.id} and is_system order by code`,
      );
      const of = (code: string) => rows.find((r) => r.code === code)!.permissions.filter((p) => p.startsWith('risks.')).sort();
      expect(of('quality_officer')).toEqual(['risks.approve', 'risks.manage', 'risks.view']);
      expect(of('department_manager')).toEqual(['risks.manage', 'risks.view']);
      expect(of('approving_authority')).toEqual(['risks.approve', 'risks.view']);
      const entries = await auditOf(jci.id, 'built_in_roles_changed_by_system');
      const ours = entries.filter((e) => (e.changes as { migration?: string })?.migration === '0075_risk_management_grants_rules_and_existing_clients');
      // At most once, whatever path made them.
      expect(ours.length).toBeLessThanOrEqual(1);
    });
  });

  describe('the starting settings of a new client', () => {
    it('are the 5×5 matrix, its bands and cells, the categories and the committees of defaults.ts, in three languages', async () => {
      const s = (await as(h).get('/risks/settings').expect(200)).body;
      expect(s).toMatchObject({
        inherentRequired: true,
        frameworkDocumentId: null,
        frameworkDocument: null,
        assessmentThresholdBand: 'high',
        acceptanceMaxMonths: 12,
        revision: 1,
      });
      const m = s.matrix as Matrix;
      expect(m).toMatchObject({ version: 1, status: 'in_use', likelihoodLevels: 5, impactLevels: 5 });
      expect(m.likelihood.map((l) => l.label)).toEqual(DEFAULT_LIKELIHOOD.map((l) => l.label));
      expect(m.likelihood.map((l) => l.frequency)).toEqual(DEFAULT_LIKELIHOOD.map((l) => l.frequency));
      expect(m.impact.map((l) => l.label)).toEqual(DEFAULT_IMPACT.map((l) => l.label));
      expect(m.impact[3].label).toEqual({ en: 'Major', ar: 'كبير', fr: 'Majeur' });
      expect(m.domains.map((d) => d.name)).toEqual(DEFAULT_DOMAINS.map((d) => d.name));
      expect(m.domains[0].descriptors['5']).toEqual(DEFAULT_DOMAINS[0].descriptors[4]);
      expect(m.bands.map((b) => [b.code, b.name, b.reviewIntervalDays, b.acceptanceNeedsSignature])).toEqual(
        DEFAULT_BANDS.map((b) => [b.code, b.name, b.reviewIntervalDays, b.acceptanceNeedsSignature]),
      );
      expect(m.bands.find((b) => b.code === 'high')!.escalateToCommitteeId).toBe(committees.risk_committee);
      expect(m.bands.find((b) => b.code === 'extreme')!.escalateToCommitteeId).toBe(committees.governing_body);
      expect(m.bands.find((b) => b.code === 'medium')!.escalateToCommitteeId).toBeNull();
      expect(m.cells).toHaveLength(25);
      for (const c of m.cells) expect(c.band).toBe(defaultBandOf(c.likelihood, c.impact));
      expect(m.cells.filter((c) => c.band === 'low').map((c) => c.likelihood * c.impact).sort((a, b) => a - b)).toEqual([1, 2, 2, 3, 3]);
      expect(s.categories.map((c: { code: string }) => c.code)).toEqual(DEFAULT_CATEGORIES.map((c) => c.code));
      for (const c of s.categories) {
        expect(c).toMatchObject({ appetite: 'cautious', toleranceBand: 'medium', active: true, appetiteStatement: null });
        expect(c.name).toEqual(DEFAULT_CATEGORIES.find((d) => d.code === c.code)!.name);
      }
      expect(s.committees.map((c: { code: string; name: unknown; memberRoleId: unknown }) => [c.code, c.name, c.memberRoleId])).toEqual(
        DEFAULT_COMMITTEES.map((c) => [c.code, c.name, null]),
      );
    });

    it('are the same for the clients that existed before the module (demo-jci)', async () => {
      const [jci] = await bench.owner.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, 'demo-jci'));
      const { rows: cells } = await bench.owner.db.execute<{ likelihood: number; impact: number; band_code: string }>(
        sql`select c.likelihood, c.impact, c.band_code from risk_matrix_cells c join risk_matrices m on m.id = c.matrix_id
            where m.tenant_id = ${jci.id} and m.version = 1`,
      );
      expect(cells).toHaveLength(25);
      for (const c of cells) expect(c.band_code).toBe(defaultBandOf(c.likelihood, c.impact));
      const { rows: levels } = await bench.owner.db.execute<{ axis: string; level: number; label: unknown; descriptor: unknown; frequency: unknown }>(
        sql`select l.axis, l.level, l.label, l.descriptor, l.frequency from risk_matrix_levels l join risk_matrices m on m.id = l.matrix_id
            where m.tenant_id = ${jci.id} and m.version = 1 order by l.axis, l.level`,
      );
      expect(levels.map((l) => [l.label, l.descriptor, l.frequency])).toEqual([
        ...DEFAULT_LIKELIHOOD.map((l) => [l.label, l.descriptor, l.frequency]),
        ...DEFAULT_IMPACT.map((l) => [l.label, l.descriptor, null]),
      ]);
      const { rows: domains } = await bench.owner.db.execute<{ name: unknown; descriptors: Record<string, unknown> }>(
        sql`select d.name, d.descriptors from risk_impact_domains d join risk_matrices m on m.id = d.matrix_id
            where m.tenant_id = ${jci.id} and m.version = 1 order by d.position`,
      );
      expect(domains.map((d) => d.name)).toEqual(DEFAULT_DOMAINS.map((d) => d.name));
      expect(domains.map((d) => [1, 2, 3, 4, 5].map((i) => d.descriptors[String(i)]))).toEqual(
        DEFAULT_DOMAINS.map((d) => d.descriptors),
      );
      const { rows: bands } = await bench.owner.db.execute<{ code: string; name: unknown; review_interval_days: number; committee: string | null }>(
        sql`select b.code, b.name, b.review_interval_days, c.code as committee from risk_bands b
            join risk_matrices m on m.id = b.matrix_id left join risk_committees c on c.id = b.escalate_to_committee_id
            where m.tenant_id = ${jci.id} and m.version = 1 order by b.code`,
      );
      expect(bands.map((b) => [b.code, b.name, b.review_interval_days, b.committee])).toEqual(
        DEFAULT_BANDS.map((b) => [b.code, b.name, b.reviewIntervalDays, b.escalateTo]),
      );
      const { rows: cats } = await bench.owner.db.execute<{ code: string; name: unknown }>(
        sql`select code, name from risk_categories where tenant_id = ${jci.id} order by position, code`,
      );
      const starting = new Set(DEFAULT_CATEGORIES.map((c) => c.code));
      expect(cats.filter((c) => starting.has(c.code)).map((c) => [c.code, c.name])).toEqual(
        DEFAULT_CATEGORIES.map((c) => [c.code, c.name]),
      );
    });

    it('are made once, whatever runs ensureRiskDefaults again (adding the first administrator)', async () => {
      const { rows } = await bench.owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from risk_matrices where tenant_id = ${h.id}`,
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('when the module is off', () => {
    it('answers every route of it as a route that does not exist, and the data stays', async () => {
      for (const [method, url] of [
        ['get', '/risks'],
        ['get', '/risks/settings'],
        ['get', `/risks/${randomUUID()}`],
        ['post', '/risks'],
        ['patch', '/risks/settings'],
        ['get', '/risks/settings/matrices'],
      ] as const) {
        const res = await http()[method](url).set('Cookie', off.cookie).send({}).expect(404);
        expect(res.body).toEqual({ message: `Cannot ${method.toUpperCase()} ${url}`, error: 'Not Found', statusCode: 404 });
      }
      const { rows } = await bench.owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from risk_categories where tenant_id = ${off.id}`,
      );
      expect(rows[0].n).toBe(DEFAULT_CATEGORIES.length);
    });
  });

  describe('without a session', () => {
    it('answers 401 everywhere', async () => {
      const id = randomUUID();
      await http().get('/risks').expect(401);
      await http().get('/risks/settings').expect(401);
      await http().patch('/risks/settings').send({ revision: 1 }).expect(401);
      await http().get('/risks/settings/matrices').expect(401);
      await http().post('/risks/settings/matrices').send({ copyOf: id }).expect(401);
      await http().patch(`/risks/settings/matrices/${id}`).send({ revision: 1 }).expect(401);
      await http().post(`/risks/settings/matrices/${id}/put-in-use`).send({ revision: 1 }).expect(401);
      await http().post('/risks/settings/categories').send({}).expect(401);
      await http().post('/risks/settings/committees').send({}).expect(401);
      await http().post('/risks').send({}).expect(401);
      await http().get(`/risks/${id}`).expect(401);
      await http().patch(`/risks/${id}`).send({ revision: 1 }).expect(401);
      await http().post(`/risks/${id}/ratings`).send({}).expect(401);
      await http().post(`/risks/${id}/controls`).send({}).expect(401);
      await http().post(`/risks/${id}/proposal/accept`).send({}).expect(401);
    });
  });

  describe('the settings', () => {
    it('are changed only by a manager of risks for the whole organization', async () => {
      for (const who of [d1Manager, d2Viewer, reporter]) {
        const res = await as(who).patch('/risks/settings').send({ revision: 1, inherentRequired: false }).expect(403);
        expect(res.body.code).toBe('missing_permission');
        await as(who).post('/risks/settings/categories').send({ code: 'x_cat', name: { en: 'X' }, appetite: 'open', toleranceBand: 'high' }).expect(403);
        await as(who).post('/risks/settings/committees').send({ code: 'x_com', name: { en: 'X' } }).expect(403);
        await as(who).post('/risks/settings/matrices').send({ copyOf: matrix.id }).expect(403);
        await as(who).patch(`/risks/settings/matrices/${matrix.id}`).send({ revision: matrix.revision }).expect(403);
      }
      // A department manager may read the versions; a reader may not.
      await as(d1Manager).get('/risks/settings/matrices').expect(200);
      await as(d2Viewer).get('/risks/settings/matrices').expect(403);
      await as(reporter).get('/risks/people').expect(403);
      // Anyone signed in reads the criteria, which a rating needs.
      await as(reporter).get('/risks/settings').expect(200);
    });

    it('take a whole-organization manager’s change, with its revision, audited', async () => {
      await as(quality).patch('/risks/settings').send({ revision: 1, acceptanceMaxMonths: 13 }).expect(400);
      await as(quality).patch('/risks/settings').send({ revision: 1, unknown: true }).expect(400);
      await as(quality).patch('/risks/settings').send({ revision: 1, frameworkDocumentId: randomUUID() }).expect(400);
      const changed = await as(quality).patch('/risks/settings').send({ revision: 1, acceptanceMaxMonths: 6 }).expect(200);
      expect(changed.body).toMatchObject({ acceptanceMaxMonths: 6, revision: 2, inherentRequired: true });
      const stale = await as(quality).patch('/risks/settings').send({ revision: 1, acceptanceMaxMonths: 9 }).expect(409);
      expect(stale.body.code).toBe('stale_settings');
      const [entry] = await auditOf(h.id, 'risk_settings_changed');
      expect(entry).toMatchObject({ actorId: quality.id, changes: { acceptanceMaxMonths: { from: 12, to: 6 } } });
      await as(quality).patch('/risks/settings').send({ revision: 2, acceptanceMaxMonths: 12 }).expect(200);
    });

    it('keep categories with appetite and tolerance, per language, each change audited from and to', async () => {
      const bad = await as(quality)
        .post('/risks/settings/categories')
        .send({ code: 'supply', name: { fr: 'Approvisionnement' }, appetite: 'cautious', toleranceBand: 'medium' })
        .expect(400);
      expect(bad.body.code).toBe('language_mismatch');
      await as(quality).post('/risks/settings/categories').send({ code: 'Supply', name: { en: 'Supply' }, appetite: 'cautious', toleranceBand: 'medium' }).expect(400);
      const created = await as(quality)
        .post('/risks/settings/categories')
        .send({ code: 'supply', name: { en: 'Supply chain' }, appetite: 'minimal', toleranceBand: 'low', position: 10 })
        .expect(201);
      expect(created.body).toMatchObject({ code: 'supply', appetite: 'minimal', toleranceBand: 'low', revision: 1 });
      const taken = await as(quality)
        .post('/risks/settings/categories')
        .send({ code: 'supply', name: { en: 'Again' }, appetite: 'minimal', toleranceBand: 'low' })
        .expect(409);
      expect(taken.body.code).toBe('code_taken');
      const updated = await as(quality)
        .patch(`/risks/settings/categories/${created.body.id}`)
        .send({ revision: 1, toleranceBand: 'high', appetiteStatement: { en: 'We accept delays, not shortages.' } })
        .expect(200);
      expect(updated.body).toMatchObject({ toleranceBand: 'high', revision: 2 });
      const stale = await as(quality).patch(`/risks/settings/categories/${created.body.id}`).send({ revision: 1, position: 3 }).expect(409);
      expect(stale.body.code).toBe('stale_category');
      const [entry] = await auditOf(h.id, 'risk_category_updated', created.body.id);
      expect(entry.changes).toMatchObject({ toleranceBand: { from: 'low', to: 'high' } });
      // Another client's category is unknown here.
      const theirs = (await as(other).get('/risks/settings/categories').expect(200)).body[0];
      await as(quality).patch(`/risks/settings/categories/${theirs.id}`).send({ revision: 1, position: 3 }).expect(404);
      await as(quality).patch('/risks/settings/categories/not-an-id').send({ revision: 1 }).expect(404);
      // Switched off, it is listed only to managers asking for it.
      await as(quality).patch(`/risks/settings/categories/${created.body.id}`).send({ revision: 2, active: false }).expect(200);
      const active = (await as(reporter).get('/risks/settings/categories').expect(200)).body;
      expect(active.map((c: { id: string }) => c.id)).not.toContain(created.body.id);
      await as(reporter).get('/risks/settings/categories?includeInactive=true').expect(403);
      const all = (await as(quality).get('/risks/settings/categories?includeInactive=true').expect(200)).body;
      expect(all.map((c: { id: string }) => c.id)).toContain(created.body.id);
    });

    it('keep committees by role, of the client’s own roles only', async () => {
      const unknown = await as(quality)
        .post('/risks/settings/committees')
        .send({ code: 'safety_committee', name: { en: 'Health and safety committee' }, memberRoleId: other.roles.quality_officer })
        .expect(400);
      expect(unknown.body.code).toBe('unknown_role');
      const created = await as(quality)
        .post('/risks/settings/committees')
        .send({ code: 'safety_committee', name: { en: 'Health and safety committee' }, memberRoleId: h.roles.risk_reader, position: 3 })
        .expect(201);
      expect(created.body).toMatchObject({ memberRoleId: h.roles.risk_reader, chairRoleId: null, active: true });
      const [entry] = await auditOf(h.id, 'risk_committee_created', created.body.id);
      expect(entry.actorId).toBe(quality.id);
      const stale = await as(quality).patch(`/risks/settings/committees/${created.body.id}`).send({ revision: 2, active: false }).expect(409);
      expect(stale.body.code).toBe('stale_committee');
      // One the matrix in use escalates to is not switched off.
      const busy = await as(quality).patch(`/risks/settings/committees/${committees.governing_body}`).send({ revision: 1, active: false }).expect(409);
      expect(busy.body.code).toBe('committee_in_use');
      await as(quality).patch(`/risks/settings/committees/${committees.governing_body}`).send({ revision: 1, memberRoleId: h.roles.administrator }).expect(200);
    });
  });

  describe('the matrix', () => {
    it('in use takes wording at once, and refuses what decides a band', async () => {
      const level = matrix.likelihood[2];
      const changed = await as(quality)
        .patch(`/risks/settings/matrices/${matrix.id}`)
        .send({
          revision: matrix.revision,
          levels: [{ axis: 'likelihood', level: 3, label: { en: 'Possible' }, descriptor: { en: 'Has happened here.' }, frequency: { en: level.frequency!.en } }],
          bands: [{ code: 'medium', name: { en: 'Moderate risk' } }],
        })
        .expect(200);
      expect(changed.body.likelihood[2].descriptor).toEqual({ en: 'Has happened here.' });
      expect(changed.body.bands[1].name).toEqual({ en: 'Moderate risk' });
      const [entry] = await auditOf(h.id, 'risk_matrix_changed', matrix.id);
      expect(entry.changes).toMatchObject({ status: 'in_use', levels: [{ axis: 'likelihood', level: 3 }], bands: [{ code: 'medium', changed: ['name'] }] });
      matrix = changed.body;

      const cell = await as(quality)
        .patch(`/risks/settings/matrices/${matrix.id}`)
        .send({ revision: matrix.revision, cells: [{ likelihood: 1, impact: 3, band: 'medium' }] })
        .expect(409);
      expect(cell.body.code).toBe('matrix_in_use');
      const interval = await as(quality)
        .patch(`/risks/settings/matrices/${matrix.id}`)
        .send({ revision: matrix.revision, bands: [{ code: 'high', reviewIntervalDays: 60 }] })
        .expect(409);
      expect(interval.body.code).toBe('matrix_in_use');
      const size = await as(quality)
        .patch(`/risks/settings/matrices/${matrix.id}`)
        .send({ revision: matrix.revision, likelihoodLevels: 4 })
        .expect(409);
      expect(size.body.code).toBe('matrix_in_use');
      const stale = await as(quality)
        .patch(`/risks/settings/matrices/${matrix.id}`)
        .send({ revision: matrix.revision - 1, bands: [{ code: 'low', name: { en: 'Low' } }] })
        .expect(409);
      expect(stale.body.code).toBe('stale_matrix');
      const lang = await as(quality)
        .patch(`/risks/settings/matrices/${matrix.id}`)
        .send({ revision: matrix.revision, bands: [{ code: 'low', name: { ar: 'منخفض' } }] })
        .expect(400);
      expect(lang.body.code).toBe('language_mismatch');
      // Another client's matrix is unknown here.
      const theirs = (await as(other).get('/risks/settings').expect(200)).body.matrix;
      await as(quality).get(`/risks/settings/matrices/${theirs.id}`).expect(404);
      await as(quality).patch(`/risks/settings/matrices/${theirs.id}`).send({ revision: 1 }).expect(404);
    });

    it('is kept fixed by the database once out of draft, whatever the code does', async () => {
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      try {
        const tenantDb = new TenantDb(app.db);
        await expect(
          tenantDb.withTenant(h.id, (tx) =>
            tx.update(riskMatrixCells).set({ bandCode: 'extreme' }).where(eq(riskMatrixCells.matrixId, matrix.id)),
          ),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
        await expect(
          tenantDb.withTenant(h.id, (tx) => tx.update(riskMatrices).set({ impactLevels: 4 }).where(eq(riskMatrices.id, matrix.id))),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
        // A rating is never changed or deleted.
        await expect(
          tenantDb.withTenant(h.id, (tx) => tx.update(riskRatings).set({ score: 1 }).where(eq(riskRatings.tenantId, h.id))),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(
          tenantDb.withTenant(h.id, (tx) => tx.delete(risks).where(eq(risks.tenantId, h.id))),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
      } finally {
        await app.pool.end();
      }
    });

    it('is refused when incomplete or out of order', async () => {
      const full = {
        likelihoodLevels: 3,
        impactLevels: 3,
        levels: [1, 2, 3].flatMap((n) => [
          { axis: 'likelihood', level: n, label: { en: `L${n}` } },
          { axis: 'impact', level: n, label: { en: `I${n}` } },
        ]),
        domains: [{ name: { en: 'Safety' }, descriptors: { '1': { en: 'None' } } }],
        bands: ['low', 'medium', 'high', 'extreme'].map((code) => ({
          code,
          name: { en: code },
          reviewIntervalDays: 90,
          escalateToCommitteeId: null,
          acceptanceNeedsSignature: true,
        })),
        cells: [1, 2, 3].flatMap((l) => [1, 2, 3].map((i) => ({ likelihood: l, impact: i, band: l * i <= 2 ? 'low' : l * i <= 4 ? 'medium' : 'high' }))),
      };
      // Nine cells, one of them twice: one is missing.
      const incomplete = await as(quality).post('/risks/settings/matrices').send({ ...full, cells: [...full.cells.slice(1), full.cells[1]] }).expect(400);
      expect(incomplete.body.code).toBe('matrix_incomplete');
      const disordered = await as(quality)
        .post('/risks/settings/matrices')
        .send({ ...full, cells: full.cells.map((c) => (c.likelihood === 1 && c.impact === 1 ? { ...c, band: 'extreme' } : c)) })
        .expect(400);
      expect(disordered.body.code).toBe('bands_out_of_order');
      const unsigned = await as(quality)
        .post('/risks/settings/matrices')
        .send({ ...full, bands: full.bands.map((b) => ({ ...b, acceptanceNeedsSignature: b.code === 'low' })) })
        .expect(400);
      expect(unsigned.body.code).toBe('signature_required');
      await as(quality).post('/risks/settings/matrices').send({ ...full, likelihoodLevels: 7 }).expect(400);
      // A whole 3×3 matrix makes a draft, which is then discarded.
      const draft = await as(quality).post('/risks/settings/matrices').send(full).expect(201);
      expect(draft.body).toMatchObject({ status: 'draft', likelihoodLevels: 3, impactLevels: 3 });
      const discarded = await as(quality).post(`/risks/settings/matrices/${draft.body.id}/discard`).send({ revision: draft.body.revision }).expect(200);
      expect(discarded.body.status).toBe('retired');
      const [entry] = await auditOf(h.id, 'risk_matrix_discarded', draft.body.id);
      expect(entry.actorId).toBe(quality.id);
    });
  });

  describe('the register', () => {
    let u1Risk: { id: string; reference: string; revision: number };
    let d2Risk: { id: string; revision: number };
    let wholeRisk: { id: string; revision: number };
    let theirRisk: { id: string; revision: number };

    beforeAll(async () => {
      u1Risk = await create(d1Manager, u1);
      d2Risk = await create(quality, d2);
      wholeRisk = await create(quality, null, { title: { en: `Loss of the main supplier ${run}` }, categoryId: categories.operations });
      const theirCategories = (await as(other).get('/risks/settings/categories').expect(200)).body;
      theirRisk = (
        await as(otherQuality)
          .post('/risks')
          .send({ ...riskBody(otherUnit), categoryId: theirCategories[0].id, ownerId: otherQuality.id })
          .expect(201)
      ).body;
    });

    describe('creating a risk', () => {
      it('opens it with a reference, its ratings, a next review and a timeline, audited', async () => {
        const res = await as(quality).get(`/risks/${u1Risk.id}`).expect(200);
        expect(res.body).toMatchObject({
          status: 'open',
          source: 'manual',
          orgUnitId: u1,
          ownerId: reporter.id,
          inherent: { likelihood: 4, impact: 3, score: 12, band: 'high' },
          current: { likelihood: 2, impact: 3, score: 6, band: 'medium' },
          target: null,
          tolerance: 'medium',
          standing: 'within',
          revision: 1,
          rerateNeeded: false,
          currentAboveInherent: false,
          matrixId: matrix.id,
        });
        expect(res.body.reference).toMatch(/^RSK-\d{4}-\d{5}$/);
        expect(res.body.ratings.map((r: { kind: string }) => r.kind).sort()).toEqual(['current', 'inherent']);
        expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual(['created']);
        expect(res.body.people[reporter.id]).toEqual({ en: reporter.name });
        expect(res.body.units[u1]).toEqual({ en: 'Unit U1' });
        // The interval of Medium, 180 days.
        const today = new Date().toISOString().slice(0, 10);
        expect(res.body.nextReviewOn > today).toBe(true);
        const [entry] = await auditOf(h.id, 'risk_created', u1Risk.id);
        expect(entry).toMatchObject({ actorId: d1Manager.id, changes: { reference: u1Risk.reference, status: 'open', source: 'manual' } });
      });

      it('numbers references per client, never reused', async () => {
        const a = await create(quality, d1);
        const b = await create(quality, d1);
        const n = (ref: string) => Number(ref.slice(-5));
        expect(n(b.reference)).toBe(n(a.reference) + 1);
      });

      it('needs risks.manage over the unit, or for the whole organization for a risk of it', async () => {
        const none = await as(reporter).post('/risks').send(riskBody(u1)).expect(403);
        expect(none.body).toMatchObject({ code: 'missing_permission', permission: 'risks.manage' });
        await as(d2Viewer).post('/risks').send(riskBody(d2)).expect(403);
        await as(d1Manager).post('/risks').send(riskBody(d2)).expect(403);
        await as(d1Manager).post('/risks').send(riskBody(null)).expect(403);
      });

      it('refuses what it does not take, and anything of another client', async () => {
        await as(quality).post('/risks').send({ ...riskBody(d1), title: undefined }).expect(400);
        await as(quality).post('/risks').send({ ...riskBody(d1), extra: 1 }).expect(400);
        await as(quality).post('/risks').send({ ...riskBody(d1), cause: {} }).expect(400);
        await as(quality).post('/risks').send({ ...riskBody(d1), title: { en: 'a\u0000b' } }).expect(400);
        const lang = await as(quality).post('/risks').send({ ...riskBody(d1), title: { fr: 'Chutes' } }).expect(400);
        expect(lang.body.code).toBe('language_mismatch');
        const unit = await as(quality).post('/risks').send(riskBody(otherUnit)).expect(400);
        expect(unit.body.code).toBe('unknown_unit');
        const theirCategory = (await as(other).get('/risks/settings/categories').expect(200)).body[0].id;
        const category = await as(quality).post('/risks').send(riskBody(d1, { categoryId: theirCategory })).expect(400);
        expect(category.body.code).toBe('unknown_category');
        const owner = await as(quality).post('/risks').send(riskBody(d1, { ownerId: otherQuality.id })).expect(400);
        expect(owner.body.code).toBe('unknown_owner');
      });

      it('applies the rating rules: within the matrix, inherent required, a target above tolerance, never above the current rating', async () => {
        const range = await as(quality).post('/risks').send(riskBody(d1, { current: { likelihood: 6, impact: 1 } })).expect(400);
        expect(range.body.code).toBe('level_out_of_range');
        const inherent = await as(quality).post('/risks').send(riskBody(d1, { inherent: undefined })).expect(400);
        expect(inherent.body.code).toBe('inherent_required');
        const target = await as(quality)
          .post('/risks')
          .send(riskBody(d1, { inherent: { likelihood: 5, impact: 4 }, current: { likelihood: 4, impact: 4 } }))
          .expect(400);
        expect(target.body.code).toBe('target_required');
        const above = await as(quality)
          .post('/risks')
          .send(riskBody(d1, { current: { likelihood: 2, impact: 3 }, target: { likelihood: 3, impact: 3 } }))
          .expect(400);
        expect(above.body.code).toBe('target_above_current');
        const extreme = await as(quality)
          .post('/risks')
          .send(riskBody(d1, { inherent: { likelihood: 5, impact: 4 }, current: { likelihood: 4, impact: 4 }, target: { likelihood: 2, impact: 2 } }))
          .expect(201);
        expect(extreme.body).toMatchObject({ standing: 'above_not_addressed', highestBand: 'extreme', closureSignOffNeeded: true });
      });
    });

    describe('who sees which risks', () => {
      const listed = async (who: Staff, query = '') =>
        ((await as(who).get(`/risks${query}`).expect(200)).body.items as { id: string }[]).map((r) => r.id);

      it('is scoped by unit: a grant for a unit reaches it and what is beneath it', async () => {
        const d1Sees = await listed(d1Manager);
        expect(d1Sees).toContain(u1Risk.id);
        expect(d1Sees).not.toContain(d2Risk.id);
        const d2Sees = await listed(d2Viewer);
        expect(d2Sees).toContain(d2Risk.id);
        expect(d2Sees).not.toContain(u1Risk.id);
        const all = await listed(quality, '?pageSize=100');
        expect(all).toEqual(expect.arrayContaining([u1Risk.id, d2Risk.id, wholeRisk.id]));
        expect(all).not.toContain(theirRisk.id);
        const underD1 = await listed(quality, `?unitId=${d1}&pageSize=100`);
        expect(underD1).toContain(u1Risk.id);
        expect(underD1).not.toContain(d2Risk.id);
        expect(underD1).not.toContain(wholeRisk.id);
        expect(await listed(quality, '?unitId=whole')).toEqual([wholeRisk.id]);
      });

      it('never names anything of another client, in a list or in the settings', async () => {
        const theirs = (await as(otherQuality).get('/risks?pageSize=100').expect(200)).body;
        expect(theirs.items.map((r: { id: string }) => r.id)).toEqual([theirRisk.id]);
        expect(theirs.total).toBe(1);
        expect(Object.keys(theirs.people)).toEqual([otherQuality.id]);
        const ours = (await as(quality).get('/risks?pageSize=100').expect(200)).body;
        expect(Object.keys(ours.people)).not.toContain(otherQuality.id);
        const settings = (await as(otherQuality).get('/risks/settings').expect(200)).body;
        expect(settings.matrix.id).not.toBe(matrix.id);
        expect(settings.categories.map((c: { id: string }) => c.id)).not.toContain(categories.people_safety);
        await as(otherQuality).get(`/risks?unitId=${d1}`).expect(200).then((r) => expect(r.body.items).toEqual([]));
      });

      it('reads a risk of the whole organization only with a grant for the whole organization', async () => {
        await as(wholeViewer).get(`/risks/${wholeRisk.id}`).expect(200);
        expect(await listed(wholeViewer, '?pageSize=100')).toContain(wholeRisk.id);
        for (const who of [d1Manager, d2Viewer]) {
          await as(who).get(`/risks/${wholeRisk.id}`).expect(404);
          expect(await listed(who, '?pageSize=100')).not.toContain(wholeRisk.id);
        }
      });

      it('answers 404 for a risk out of reach, or of another client, whatever the route', async () => {
        await as(d2Viewer).get(`/risks/${u1Risk.id}`).expect(404);
        await as(d1Manager).get(`/risks/${d2Risk.id}`).expect(404);
        await as(d1Manager).patch(`/risks/${d2Risk.id}`).send({ revision: d2Risk.revision, keywords: ['x'] }).expect(404);
        await as(d1Manager).post(`/risks/${d2Risk.id}/ratings`).send({ revision: 1, kind: 'current', likelihood: 1, impact: 1 }).expect(404);
        await as(quality).get(`/risks/${theirRisk.id}`).expect(404);
        await as(quality).patch(`/risks/${theirRisk.id}`).send({ revision: 1, keywords: ['x'] }).expect(404);
        await as(quality).post(`/risks/${theirRisk.id}/ratings`).send({ revision: 1, kind: 'current', likelihood: 1, impact: 1 }).expect(404);
        await as(quality).post(`/risks/${theirRisk.id}/controls`).send({ revision: 1, description: { en: 'x' }, kind: 'preventive', ownerId: quality.id }).expect(404);
        await as(otherQuality).get(`/risks/${u1Risk.id}`).expect(404);
        await as(quality).get(`/risks/${randomUUID()}`).expect(404);
        await as(quality).get('/risks/not-an-id').expect(404);
      });

      it('lets the owner, with no permission of the module, read and rate their risk, and nothing more', async () => {
        expect(await listed(reporter, '?mine=true&pageSize=100')).toEqual(expect.arrayContaining([u1Risk.id, d2Risk.id, wholeRisk.id]));
        const seen = await as(reporter).get(`/risks/${u1Risk.id}`).expect(200);
        expect(seen.body.moves).toEqual(['rate', 'add_control', 'review', 'add_action']);
        await as(reporter).patch(`/risks/${u1Risk.id}`).send({ revision: seen.body.revision, keywords: ['floor'] }).expect(403);
        const rated = await as(reporter)
          .post(`/risks/${u1Risk.id}/ratings`)
          .send({ revision: seen.body.revision, kind: 'current', likelihood: 1, impact: 3, rationale: { en: 'Signs are now used.' } })
          .expect(200);
        // 3: Low, whose interval is longer: the next review stays.
        expect(rated.body).toMatchObject({ current: { score: 3, band: 'low' }, trend: 'down', nextReviewOn: seen.body.nextReviewOn });
        u1Risk.revision = rated.body.revision;
        // A reader with no place on it sees nothing it may do.
        expect((await as(d2Viewer).get(`/risks/${d2Risk.id}`).expect(200)).body.moves).toEqual([]);
        // Step 6 and 7: a manager of a risk on the register links incidents and closes it.
        expect((await as(quality).get(`/risks/${d2Risk.id}`).expect(200)).body.moves).toEqual([
          'edit',
          'rate',
          'add_control',
          'review',
          'add_action',
          'escalate',
          'link_incident',
          'close',
          'correct',
        ]);
      });
    });

    describe('changing a risk', () => {
      it('refuses a stale revision', async () => {
        const now = (await as(quality).get(`/risks/${d2Risk.id}`).expect(200)).body;
        const ok = await as(quality).patch(`/risks/${d2Risk.id}`).send({ revision: now.revision, keywords: ['floor', 'cleaning'] }).expect(200);
        expect(ok.body.revision).toBe(now.revision + 1);
        for (const res of [
          await as(quality).patch(`/risks/${d2Risk.id}`).send({ revision: now.revision, keywords: ['again'] }).expect(409),
          await as(quality).post(`/risks/${d2Risk.id}/ratings`).send({ revision: now.revision, kind: 'current', likelihood: 1, impact: 1 }).expect(409),
          await as(quality).post(`/risks/${d2Risk.id}/controls`).send({ revision: now.revision, description: { en: 'Signs' }, kind: 'preventive', ownerId: quality.id }).expect(409),
        ]) {
          expect(res.body.code).toBe('stale_risk');
        }
        d2Risk.revision = ok.body.revision;
      });

      it('needs a reason to change the owner, the unit or the category, and both units to move it', async () => {
        const missing = await as(quality).patch(`/risks/${d2Risk.id}`).send({ revision: d2Risk.revision, ownerId: quality.id }).expect(400);
        expect(missing.body.code).toBe('reason_required');
        const moved = await as(quality)
          .patch(`/risks/${d2Risk.id}`)
          .send({ revision: d2Risk.revision, ownerId: quality.id, orgUnitId: d1, reason: 'The department took over the corridor.' })
          .expect(200);
        expect(moved.body).toMatchObject({ ownerId: quality.id, orgUnitId: d1 });
        expect(moved.body.events.at(-1)).toMatchObject({
          kind: 'updated',
          details: { ownerId: { from: reporter.id, to: quality.id }, orgUnitId: { from: d2, to: d1 }, noteId: expect.any(String) },
        });
        const [entry] = await auditOf(h.id, 'risk_updated', d2Risk.id).then((rows) => rows.filter((r) => (r.changes as { noteId?: string }).noteId));
        expect(entry.changes).toMatchObject({ orgUnitId: { from: d2, to: d1 }, noteId: moved.body.events.at(-1).details.noteId });
        // The reason stays on the record, as a note a manager may correct
        // (security review 17, L5).
        expect(moved.body.notes.at(-1)).toMatchObject({
          id: moved.body.events.at(-1).details.noteId,
          kind: 'change_reason',
          text: 'The department took over the corridor.',
          writtenBy: quality.id,
        });
        // The reason's text is in neither the trail nor the timeline (security review 15, M1).
        expect(JSON.stringify(entry.changes)).not.toContain('corridor');
        expect(JSON.stringify(moved.body.events)).not.toContain('corridor');
        d2Risk.revision = moved.body.revision;
        // The D1 manager now manages it, but cannot move it out of their reach.
        const away = await as(d1Manager).patch(`/risks/${d2Risk.id}`).send({ revision: d2Risk.revision, orgUnitId: d2, reason: 'Back' }).expect(403);
        expect(away.body.code).toBe('missing_permission');
        await as(d1Manager).patch(`/risks/${d2Risk.id}`).send({ revision: d2Risk.revision, orgUnitId: otherUnit, reason: 'Away' }).expect(400);
        await as(d1Manager).patch(`/risks/${d2Risk.id}`).send({ revision: d2Risk.revision, status: 'closed' }).expect(400);
      });

      it('refuses a target above the current rating', async () => {
        const now = (await as(quality).get(`/risks/${wholeRisk.id}`).expect(200)).body;
        const above = await as(quality).post(`/risks/${wholeRisk.id}/ratings`).send({ revision: now.revision, kind: 'target', likelihood: 3, impact: 3 }).expect(400);
        expect(above.body.code).toBe('target_above_current');
        const range = await as(quality).post(`/risks/${wholeRisk.id}/ratings`).send({ revision: now.revision, kind: 'target', likelihood: 1, impact: 9 }).expect(400);
        expect(range.status).toBe(400);
        const ok = await as(quality)
          .post(`/risks/${wholeRisk.id}/ratings`)
          .send({ revision: now.revision, kind: 'target', likelihood: 1, impact: 3 })
          .expect(200);
        expect(ok.body.target).toEqual({ likelihood: 1, impact: 3, score: 3, band: 'low' });
        const [entry] = await auditOf(h.id, 'risk_rated', wholeRisk.id);
        expect(entry.changes).toMatchObject({ kind: 'target', from: null, to: { score: 3, band: 'low' } });
      });

      it('brings the next review forward when a current rating puts it in a band reviewed more often', async () => {
        const now = (await as(quality).get(`/risks/${wholeRisk.id}`).expect(200)).body;
        const rated = await as(quality)
          .post(`/risks/${wholeRisk.id}/ratings`)
          .send({ revision: now.revision, kind: 'current', likelihood: 3, impact: 4 })
          .expect(200);
        // High: 90 days, sooner than the 180 of Medium.
        expect(rated.body.current.band).toBe('high');
        expect(rated.body.nextReviewOn < now.nextReviewOn).toBe(true);
        expect(rated.body).toMatchObject({ standing: 'above_not_addressed', closureSignOffNeeded: true, trend: 'up' });
        const listedAbove = (await as(quality).get('/risks?aboveTolerance=true&pageSize=100').expect(200)).body.items.map((r: { id: string }) => r.id);
        expect(listedAbove).toContain(wholeRisk.id);
        expect(listedAbove).not.toContain(u1Risk.id);
      });
    });

    describe('controls', () => {
      it('are added and changed by the owner or a manager, switched off with a reason, with their own revision', async () => {
        const now = (await as(reporter).get(`/risks/${u1Risk.id}`).expect(200)).body;
        await as(reporter).post(`/risks/${u1Risk.id}/controls`).send({ revision: now.revision, description: { en: 'x' }, kind: 'barrier', ownerId: reporter.id }).expect(400);
        const doc = await as(reporter)
          .post(`/risks/${u1Risk.id}/controls`)
          .send({ revision: now.revision, description: { en: 'Signs' }, kind: 'preventive', ownerId: reporter.id, documentId: randomUUID() })
          .expect(400);
        expect(doc.body.code).toBe('unknown_document');
        const added = await as(reporter)
          .post(`/risks/${u1Risk.id}/controls`)
          .send({ revision: now.revision, description: { en: 'Wet floor signs are put out before mopping.' }, kind: 'preventive', hierarchy: 'administrative', ownerId: reporter.id, effectiveness: 'partly_effective' })
          .expect(201);
        expect(added.body).toMatchObject({ kind: 'preventive', effectiveness: 'partly_effective', active: true, revision: 1, riskRevision: now.revision + 1 });
        expect(added.body.assessedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const off = await as(reporter).patch(`/risks/${u1Risk.id}/controls/${added.body.id}`).send({ revision: 1, active: false }).expect(400);
        expect(off.body.code).toBe('reason_required');
        const stale = await as(reporter).patch(`/risks/${u1Risk.id}/controls/${added.body.id}`).send({ revision: 2, effectiveness: 'effective' }).expect(409);
        expect(stale.body.code).toBe('stale_control');
        const switched = await as(reporter)
          .patch(`/risks/${u1Risk.id}/controls/${added.body.id}`)
          .send({ revision: 1, active: false, reason: 'Replaced by a dry-mopping method.' })
          .expect(200);
        expect(switched.body).toMatchObject({ active: false, inactiveReason: 'Replaced by a dry-mopping method.', revision: 2 });
        await as(d2Viewer).patch(`/risks/${u1Risk.id}/controls/${added.body.id}`).send({ revision: 2, active: true }).expect(404);
        await as(quality).patch(`/risks/${d2Risk.id}/controls/${added.body.id}`).send({ revision: 2, active: true }).expect(404);
        const detail = (await as(quality).get(`/risks/${u1Risk.id}`).expect(200)).body;
        expect(detail.controls).toHaveLength(1);
        expect(detail.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['control_added', 'control_updated']));
        const entries = await auditOf(h.id, 'risk_control_updated', u1Risk.id);
        expect(entries[0].changes).toMatchObject({ controlId: added.body.id, active: { from: true, to: false } });
      });
    });

    describe('proposals', () => {
      it('are read only by managers and whoever raised them, and taken onto the register or not', async () => {
        const proposed = await create(quality, d2, { current: undefined, inherent: undefined });
        expect(proposed.status).toBe('proposed');
        await as(d2Viewer).get(`/risks/${proposed.id}`).expect(404);
        await as(reporter).get(`/risks/${proposed.id}`).expect(404);
        const forManager = (await as(quality).get(`/risks/${proposed.id}`).expect(200)).body;
        // Whoever raised it does not take it onto the register (security review 15).
        expect(forManager.moves).toEqual(['edit', 'rate', 'add_control', 'correct', 'reject_proposal']);
        const own = await as(quality)
          .post(`/risks/${proposed.id}/proposal/accept`)
          .send({ revision: 1, ownerId: reporter.id, current: { likelihood: 2, impact: 2 }, inherent: { likelihood: 3, impact: 2 } })
          .expect(403);
        expect(own.body.code).toBe('same_person');
        expect((await as(h).get(`/risks/${proposed.id}`).expect(200)).body.moves).toContain('accept_proposal');
        await as(d2Viewer).post(`/risks/${proposed.id}/proposal/accept`).send({}).expect(403);
        await as(h).post(`/risks/${proposed.id}/proposal/accept`).send({ revision: 1, ownerId: reporter.id }).expect(400);
        const inherent = await as(h)
          .post(`/risks/${proposed.id}/proposal/accept`)
          .send({ revision: 1, ownerId: reporter.id, current: { likelihood: 2, impact: 2 } })
          .expect(400);
        expect(inherent.body.code).toBe('inherent_required');
        const accepted = await as(h)
          .post(`/risks/${proposed.id}/proposal/accept`)
          .send({ revision: 1, ownerId: reporter.id, current: { likelihood: 2, impact: 2 }, inherent: { likelihood: 3, impact: 2 } })
          .expect(200);
        expect(accepted.body).toMatchObject({ status: 'open', current: { score: 4, band: 'medium' } });
        await as(reporter).get(`/risks/${proposed.id}`).expect(200);
        const again = await as(quality).post(`/risks/${proposed.id}/proposal/reject`).send({ revision: accepted.body.revision, reason: 'Duplicate' }).expect(409);
        expect(again.body.code).toBe('not_proposed');

        const duplicate = await create(quality, d2, { current: undefined, inherent: undefined });
        await as(quality).post(`/risks/${duplicate.id}/proposal/reject`).send({ revision: 1 }).expect(400);
        const rejected = await as(quality).post(`/risks/${duplicate.id}/proposal/reject`).send({ revision: 1, reason: `A duplicate of ${proposed.reference}.` }).expect(200);
        expect(rejected.body).toMatchObject({ status: 'rejected', rejectReason: `A duplicate of ${proposed.reference}.`, moves: ['correct'] });
        expect((await as(quality).get('/risks?status=rejected').expect(200)).body.items.map((r: { id: string }) => r.id)).toContain(duplicate.id);
        const [entry] = await auditOf(h.id, 'risk_proposal_rejected', duplicate.id);
        expect(entry.actorId).toBe(quality.id);
      });
    });

    describe('a new version of the matrix put in use', () => {
      it('re-bands the risks on the register at once, says so in their timeline, and keeps earlier ratings', async () => {
        // A risk at likelihood 1, impact 3: Low on version 1.
        const low = await create(quality, d1, { current: { likelihood: 1, impact: 3 }, inherent: { likelihood: 2, impact: 3 } });
        expect((await as(quality).get(`/risks/${low.id}`).expect(200)).body.current.band).toBe('low');
        const draft = await as(quality).post('/risks/settings/matrices').send({ copyOf: matrix.id }).expect(201);
        // The 3×3 draft discarded above took a version number of its own.
        expect(draft.body.status).toBe('draft');
        expect(draft.body.version).toBeGreaterThan(matrix.version + 1);
        const twice = await as(quality).post('/risks/settings/matrices').send({ copyOf: matrix.id }).expect(409);
        expect(twice.body.code).toBe('draft_exists');
        const edited = await as(quality)
          .patch(`/risks/settings/matrices/${draft.body.id}`)
          .send({ revision: draft.body.revision, cells: [{ likelihood: 1, impact: 3, band: 'medium' }, { likelihood: 3, impact: 1, band: 'medium' }], bands: [{ code: 'high', reviewIntervalDays: 60 }] })
          .expect(200);
        const size = await as(quality).patch(`/risks/settings/matrices/${draft.body.id}`).send({ revision: edited.body.revision, impactLevels: 4 }).expect(409);
        expect(size.body.code).toBe('matrix_size_fixed');
        const preview = (await as(quality).get(`/risks/settings/matrices/${draft.body.id}`).expect(200)).body.preview;
        expect(preview.risksChangingBand).toBeGreaterThanOrEqual(2);
        expect(preview.risksOutOfRange).toBe(0);
        // Only a manager for the whole organization puts it in use.
        await as(d1Manager).post(`/risks/settings/matrices/${draft.body.id}/put-in-use`).send({ revision: edited.body.revision }).expect(403);
        await as(quality).post(`/risks/settings/matrices/${draft.body.id}/put-in-use`).send({ revision: draft.body.revision }).expect(409);
        const used = await as(quality).post(`/risks/settings/matrices/${draft.body.id}/put-in-use`).send({ revision: edited.body.revision }).expect(200);
        expect(used.body).toMatchObject({ status: 'in_use', risksRebanded: preview.risksChangingBand });
        const versions = (await as(quality).get('/risks/settings/matrices').expect(200)).body;
        expect(versions.find((v: { id: string }) => v.id === matrix.id).status).toBe('retired');
        const after = (await as(quality).get(`/risks/${low.id}`).expect(200)).body;
        expect(after).toMatchObject({ current: { likelihood: 1, impact: 3, band: 'medium' }, matrixId: draft.body.id, rerateNeeded: false });
        expect(after.events.at(-1)).toMatchObject({ kind: 'rebanded', details: { version: draft.body.version, bands: { current: { from: 'low', to: 'medium' } } } });
        // The rating itself keeps the band it was given, on its version.
        expect(after.ratings.find((r: { kind: string }) => r.kind === 'current')).toMatchObject({ band: 'low', matrixId: matrix.id });
        const [entry] = await auditOf(h.id, 'risk_matrix_put_in_use', draft.body.id);
        expect(entry.changes).toMatchObject({ previousMatrixId: matrix.id, risksOutOfRange: 0 });
        expect((entry.changes as { riskIds: string[] }).riskIds).toContain(low.id);
        // A retired version takes nothing; a new rating is on the new one.
        const retired = await as(quality).patch(`/risks/settings/matrices/${matrix.id}`).send({ revision: versions.find((v: { id: string }) => v.id === matrix.id).revision, bands: [{ code: 'low', name: { en: 'Lowest' } }] }).expect(409);
        expect(retired.body.code).toBe('matrix_retired');
        const rated = await as(quality).post(`/risks/${low.id}/ratings`).send({ revision: after.revision, kind: 'current', likelihood: 1, impact: 2 }).expect(200);
        expect(rated.body.ratings[0]).toMatchObject({ matrixId: draft.body.id, band: 'low' });
        matrix = used.body;
      });
    });

    describe('while the subscription is suspended', () => {
      it('keeps only a current rating open', async () => {
        const now = (await as(quality).get(`/risks/${wholeRisk.id}`).expect(200)).body;
        await http().patch(`/platform/tenants/${h.id}/subscription`).set('Cookie', bench.platform).send({ status: 'suspended' }).expect(200);
        try {
          const seen = (await as(quality).get(`/risks/${wholeRisk.id}`).expect(200)).body;
          expect(seen.moves).toEqual(['rate', 'escalate']);
          const edit = await as(quality).patch(`/risks/${wholeRisk.id}`).send({ revision: now.revision, keywords: ['x'] }).expect(403);
          expect(edit.body.code).toBe('subscription_suspended');
          const target = await as(quality).post(`/risks/${wholeRisk.id}/ratings`).send({ revision: now.revision, kind: 'target', likelihood: 1, impact: 1 }).expect(403);
          expect(target.body.code).toBe('subscription_suspended');
          await as(quality).patch('/risks/settings').send({ revision: 3, inherentRequired: false }).expect(403);
          await as(quality).post(`/risks/${wholeRisk.id}/ratings`).send({ revision: now.revision, kind: 'current', likelihood: 3, impact: 3 }).expect(200);
        } finally {
          await http().patch(`/platform/tenants/${h.id}/subscription`).set('Cookie', bench.platform).send({ status: 'active' }).expect(200);
        }
      });
    });
  });
});
