import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { createDatabase } from '../src/database/client.js';
import { orgUnits } from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';
import { lastDays } from '../src/i18n/time-zones.js';
import { createPlatformAdmin } from '../src/platform/create-admin.js';
import { removeTestData } from './cleanup.js';

// Awaiting sign-off, the sixth status, is reached only by a sentinel event
// or a death: test/incident-safeguards.e2e-spec.ts covers it.
type Status = 'new' | 'triaged' | 'in_progress' | 'closed' | 'rejected';
const STATUSES: Status[] = [
  'new',
  'triaged',
  'in_progress',
  'closed',
  'rejected',
];

describe('incident reporting', () => {
  const run = randomBytes(4).toString('hex');
  const prefix = `inc-${run}`;
  const staffEmail = `staff-inc-${run}@test.invalid`;
  const staffPassword = `platform-pass-${run}`;
  const password = `hospital-pass-${run}`;
  // Words that must never reach the audit log.
  const SECRET_TEXT = `private-wording-${run}`;
  const year = new Date().getUTCFullYear();
  // The owner role: to build the org unit tree (there is no API for it yet)
  // and to look at what was stored.
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  let app: INestApplication<App>;
  let platform: string;
  const http = () => request(app.getHttpServer());

  type Hospital = {
    id: string;
    slug: string;
    cookie: string;
    roles: Record<string, string>;
    categories: Record<string, string>;
  };
  type Staff = { id: string; email: string; cookie: string };
  let a: Hospital;
  let b: Hospital;

  // Hospital A: one facility, two departments, and a unit under the first.
  let facility: string;
  let wardDept: string;
  let labDept: string;
  let wardUnit: string;
  let bUnit: string;

  let reporter: Staff;
  let otherReporter: Staff;
  let noRoles: Staff;
  let wardViewer: Staff; // sees the ward department and what is beneath it
  let allViewer: Staff; // sees everything, triages nothing
  let wardTriager: Staff;
  let labTriager: Staff;
  let quality: Staff; // triages everywhere
  let invitedId: string; // a user who has not set a password yet

  const cookieOf = (res: request.Response) =>
    res.get('Set-Cookie')![0].split(';')[0];

  const login = (org: string, email: string) =>
    http().post('/auth/login').send({ org, email, password });

  async function createHospital(suffix: string): Promise<Hospital> {
    const slug = `${prefix}-${suffix}`;
    const adminEmail = `admin-inc-${suffix}-${run}@test.invalid`;
    const tenant = await http()
      .post('/platform/tenants')
      .set('Cookie', platform)
      .send({
        slug,
        name: { en: `Hospital ${suffix}` },
        accreditationStandard: 'JCI',
        locales: ['en'],
        defaultLocale: 'en',
        signInMethod: 'password',
        dataRegion: null,
      })
      .expect(201);
    const created = await http()
      .post(`/platform/tenants/${tenant.body.id}/administrators`)
      .set('Cookie', platform)
      .send({ name: { en: 'Admin' }, email: adminEmail })
      .expect(201);
    await http()
      .post('/auth/invite/accept')
      .send({ org: slug, token: created.body.invite.token, password })
      .expect(204);
    const cookie = cookieOf(await login(slug, adminEmail).expect(200));
    const roleList = await http()
      .get('/roles')
      .set('Cookie', cookie)
      .expect(200);
    const categoryList = await http()
      .get('/incident-categories')
      .set('Cookie', cookie)
      .expect(200);
    return {
      id: tenant.body.id,
      slug,
      cookie,
      roles: Object.fromEntries(
        roleList.body.roles.map((r: { code: string; id: string }) => [
          r.code,
          r.id,
        ]),
      ),
      categories: Object.fromEntries(
        categoryList.body.map((c: { code: string; id: string }) => [
          c.code,
          c.id,
        ]),
      ),
    };
  }

  async function createUnit(
    tenantId: string,
    type: 'facility' | 'department' | 'unit',
    code: string,
    parentId: string | null,
  ) {
    const [unit] = await owner.db
      .insert(orgUnits)
      .values({ tenantId, type, code, parentId, name: { en: `Unit ${code}` } })
      .returning({ id: orgUnits.id });
    return unit.id;
  }

  /** Creates a user in hospital A with one role, and signs them in. */
  async function createStaff(
    name: string,
    grant: { role: string; orgUnitId: string | null } | null,
  ): Promise<Staff> {
    const email = `${name}-inc-${run}@test.invalid`;
    const created = await http()
      .post('/users')
      .set('Cookie', a.cookie)
      .send({
        name: { en: `Test ${name}` },
        email,
        roles: grant
          ? [{ roleId: a.roles[grant.role], orgUnitId: grant.orgUnitId }]
          : [],
      })
      .expect(201);
    await http()
      .post('/auth/invite/accept')
      .send({ org: a.slug, token: created.body.invite.token, password })
      .expect(204);
    const cookie = cookieOf(await login(a.slug, email).expect(200));
    return { id: created.body.user.id as string, email, cookie };
  }

  const validReport = (overrides: Record<string, unknown> = {}) => ({
    type: 'incident',
    categoryId: a.categories.equipment,
    orgUnitId: wardDept,
    occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
    description: `An infusion pump alarm did not sound. ${SECRET_TEXT}`,
    harmLevel: 'none',
    anonymous: false,
    ...overrides,
  });

  /** Reports an incident and returns its id and reference. */
  async function report(
    who: Staff,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; reference: string }> {
    const res = await http()
      .post('/incidents')
      .set('Cookie', who.cookie)
      .send(validReport(overrides))
      .expect(201);
    return res.body;
  }

  const triage = (
    cookie: string,
    id: string,
    overrides: Record<string, unknown> = {},
  ) =>
    http()
      .post(`/incidents/${id}/triage`)
      .set('Cookie', cookie)
      .send({
        harmLevel: 'mild',
        isSentinel: false,
        ownerUnitId: wardDept,
        ...overrides,
      });

  const move = (cookie: string, id: string, to: string, note?: string) =>
    http()
      .post(`/incidents/${id}/status`)
      .set('Cookie', cookie)
      .send({ to, ...(note !== undefined && { note }) });

  const open = (cookie: string, id: string) =>
    http().get(`/incidents/${id}`).set('Cookie', cookie);

  const listOf = async (cookie: string, query = '') => {
    const res = await http()
      .get(`/incidents?pageSize=100${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body as {
      total: number;
      items: { id: string; reference: string; status: Status }[];
    };
  };

  const summaryOf = async (cookie: string) => {
    const res = await http()
      .get('/incidents/summary')
      .set('Cookie', cookie)
      .expect(200);
    return res.body as {
      open: number;
      awaitingTriage: number;
      closedLast30Days: number;
      assignedToMe: number;
      serious: number;
      overdue: number;
      triagedOnTime: number | null;
      medianSecondsToReport: number | null;
      last30Days: { from: string; to: string };
    };
  };

  /**
   * A summary with nothing in it. The hospitals of this file keep the
   * default time zone, UTC, so their last 30 days are UTC days.
   */
  const EMPTY_SUMMARY = {
    open: 0,
    awaitingTriage: 0,
    closedLast30Days: 0,
    assignedToMe: 0,
    serious: 0,
    overdue: 0,
    triagedOnTime: null,
    medianSecondsToReport: null,
    last30Days: (({ from, to }) => ({ from, to }))(lastDays(30, 'UTC')),
  };

  /** A new incident in the ward department, taken to the given status. */
  async function incidentIn(status: Status) {
    const { id } = await report(reporter);
    const q = quality.cookie;
    if (status === 'rejected') {
      await move(q, id, 'rejected', 'Not an incident').expect(200);
    } else if (status !== 'new') {
      await triage(q, id).expect(200);
      if (status === 'in_progress') {
        await move(q, id, 'in_progress').expect(200);
      }
      if (status === 'closed') {
        await move(q, id, 'closed', 'Pump replaced').expect(200);
      }
    }
    return id;
  }

  beforeAll(async () => {
    await createPlatformAdmin({
      email: staffEmail,
      name: 'Staff',
      password: staffPassword,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupApp(app);
    await app.init();
    platform = cookieOf(
      await http()
        .post('/platform/auth/login')
        .send({ email: staffEmail, password: staffPassword })
        .expect(200),
    );
    a = await createHospital('a');
    b = await createHospital('b');

    facility = await createUnit(a.id, 'facility', 'MAIN', null);
    wardDept = await createUnit(a.id, 'department', 'WARD', facility);
    labDept = await createUnit(a.id, 'department', 'LAB', facility);
    wardUnit = await createUnit(a.id, 'unit', 'WARD-3', wardDept);
    bUnit = await createUnit(b.id, 'facility', 'MAIN', null);

    reporter = await createStaff('reporter', {
      role: 'reporter',
      orgUnitId: null,
    });
    otherReporter = await createStaff('other-reporter', {
      role: 'reporter',
      orgUnitId: null,
    });
    noRoles = await createStaff('no-roles', null);
    wardViewer = await createStaff('ward-viewer', {
      role: 'department_manager',
      orgUnitId: wardDept,
    });
    allViewer = await createStaff('all-viewer', {
      role: 'department_manager',
      orgUnitId: null,
    });
    wardTriager = await createStaff('ward-triager', {
      role: 'quality_officer',
      orgUnitId: wardDept,
    });
    labTriager = await createStaff('lab-triager', {
      role: 'quality_officer',
      orgUnitId: labDept,
    });
    quality = await createStaff('quality', {
      role: 'quality_officer',
      orgUnitId: null,
    });
    const invited = await http()
      .post('/users')
      .set('Cookie', a.cookie)
      .send({
        name: { en: 'Test invited' },
        email: `invited-inc-${run}@test.invalid`,
        roles: [],
      })
      .expect(201);
    invitedId = invited.body.user.id;
  }, 120_000);

  afterAll(async () => {
    await removeTestData(prefix, staffEmail);
    await owner.pool.end();
    await app.close();
  });

  describe('scope in the session', () => {
    it('says where each permission applies, and leaves the permission list as it was', async () => {
      const admin = await http()
        .get('/auth/me')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(admin.body.permissions).toContain('incidents.triage');
      expect(Object.keys(admin.body.scope).sort()).toEqual(
        admin.body.permissions,
      );
      expect(new Set(Object.values(admin.body.scope))).toEqual(
        new Set(['all']),
      );

      const scoped = await http()
        .get('/auth/me')
        .set('Cookie', wardViewer.cookie)
        .expect(200);
      expect(scoped.body.permissions).toEqual([
        'actions.manage',
        'incidents.report',
        'incidents.view',
        'policies.view',
        'reports.view',
      ]);
      // The department and the unit beneath it, not its sibling or parent.
      expect(scoped.body.scope['incidents.view']).toEqual(
        [wardDept, wardUnit].sort(),
      );
      expect(scoped.body.scope['incidents.triage']).toBeUndefined();

      const none = await http()
        .get('/auth/me')
        .set('Cookie', noRoles.cookie)
        .expect(200);
      expect(none.body.permissions).toEqual([]);
      expect(none.body.scope).toEqual({});
    });

    it('still lets a role granted for one unit pass a plain permission check', async () => {
      // requirePermission means "holds it anywhere": reporting is not scoped.
      await report(wardViewer, { orgUnitId: labDept });
    });
  });

  describe('without a session', () => {
    it('refuses every route', async () => {
      const id = '00000000-0000-4000-8000-000000000000';
      await http().get('/incident-categories').expect(401);
      await http().post('/incidents').send(validReport()).expect(401);
      await http().get('/incidents').expect(401);
      await http().get('/incidents/summary').expect(401);
      await http().get('/incidents/assignable-users').expect(401);
      await http().get(`/incidents/${id}`).expect(401);
      await http().post(`/incidents/${id}/triage`).send({}).expect(401);
      await http().post(`/incidents/${id}/status`).send({}).expect(401);
      await http().post(`/incidents/${id}/comments`).send({}).expect(401);
      await http().get('/settings/reporting').expect(401);
      await http()
        .put('/settings/reporting')
        .send({ publicReporting: true })
        .expect(401);
    });
  });

  describe('categories', () => {
    it('lists the active ones in order, to any signed-in user', async () => {
      const res = await http()
        .get('/incident-categories')
        .set('Cookie', noRoles.cookie)
        .expect(200);
      expect(res.body.map((c: { code: string }) => c.code)).toEqual([
        'medication',
        'fall',
        'infection',
        'equipment',
        'identification',
        'clinical_care',
        'laboratory',
        'facility',
        'security',
        'other',
      ]);
      expect(res.body[0]).toEqual({
        id: a.categories.medication,
        code: 'medication',
        name: expect.objectContaining({ en: 'Medication' }),
      });
    });

    it('leaves out one that was switched off, and refuses a report under it', async () => {
      await owner.db.execute(
        sql`update incident_categories set active = false where id = ${a.categories.security}`,
      );
      const res = await http()
        .get('/incident-categories')
        .set('Cookie', reporter.cookie)
        .expect(200);
      expect(res.body.map((c: { code: string }) => c.code)).not.toContain(
        'security',
      );
      const refused = await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ categoryId: a.categories.security }))
        .expect(400);
      expect(refused.body.code).toBe('unknown_category');
    });
  });

  describe('reporting', () => {
    it('numbers reports in order within the year', async () => {
      // Earlier tests have already reported, so start from the counter.
      const before = await owner.db.execute<{ last_number: number }>(
        sql`select last_number from reference_counters where tenant_id = ${a.id} and prefix = 'INC' and year = ${year}`,
      );
      const last = before.rows[0]?.last_number ?? 0;
      const number = (n: number) => `INC-${year}-${String(n).padStart(5, '0')}`;

      const first = await report(reporter);
      const second = await report(reporter);
      expect(first.reference).toBe(number(last + 1));
      expect(second.reference).toBe(number(last + 2));
      expect(Object.keys(first).sort()).toEqual(['id', 'reference']);
    });

    it('gives the first report of a hospital the number 00001', async () => {
      const bReporter = await http()
        .post('/incidents')
        .set('Cookie', b.cookie)
        .send(validReport({ categoryId: b.categories.other, orgUnitId: bUnit }))
        .expect(201);
      expect(bReporter.body.reference).toBe(`INC-${year}-00001`);
      const next = await http()
        .post('/incidents')
        .set('Cookie', b.cookie)
        .send(validReport({ categoryId: b.categories.other, orgUnitId: bUnit }))
        .expect(201);
      expect(next.body.reference).toBe(`INC-${year}-00002`);
    });

    it('stores what was reported, trimmed', async () => {
      const { id } = await report(reporter, {
        type: 'near_miss',
        description: '  A wet floor had no sign.  ',
        immediateAction: '  Sign placed.  ',
        orgUnitId: wardUnit,
      });
      const res = await open(reporter.cookie, id).expect(200);
      expect(res.body).toMatchObject({
        type: 'near_miss',
        description: 'A wet floor had no sign.',
        immediateAction: 'Sign placed.',
        harmLevel: 'none',
        isSentinel: false,
        status: 'new',
        category: { id: a.categories.equipment },
        orgUnit: { id: wardUnit, name: { en: 'Unit WARD-3' } },
        ownerUnit: null,
        assignedTo: null,
        reporter: { id: reporter.id, name: { en: 'Test reporter' } },
      });
    });

    it('refuses someone without the permission to report', async () => {
      const res = await http()
        .post('/incidents')
        .set('Cookie', noRoles.cookie)
        .send(validReport())
        .expect(403);
      expect(res.body.code).toBe('missing_permission');
    });

    it('refuses invalid input', async () => {
      const bad: Record<string, unknown>[] = [
        { description: '' },
        { description: '   ' },
        { description: 'x'.repeat(5001) },
        { immediateAction: 'x'.repeat(2001) },
        { type: 'accident' },
        { harmLevel: 'catastrophic' },
        { anonymous: 'yes' },
        { categoryId: 'not-an-id' },
        { orgUnitId: null },
        { occurredAt: 'yesterday' },
        { occurredAt: '2026-01-01' },
        { status: 'closed' },
        { reportedBy: reporter.id },
        { patientName: 'nobody' },
      ];
      for (const overrides of bad) {
        await http()
          .post('/incidents')
          .set('Cookie', reporter.cookie)
          .send(validReport(overrides))
          .expect(400);
      }
      const { description: _omitted, ...withoutDescription } = validReport();
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(withoutDescription)
        .expect(400);
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ description: 'x'.repeat(5000) }))
        .expect(201);
    });

    it('refuses a time in the future, allowing for a clock that runs fast', async () => {
      const inMinutes = (m: number) =>
        new Date(Date.now() + m * 60_000).toISOString();
      const res = await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ occurredAt: inMinutes(60) }))
        .expect(400);
      expect(res.body.code).toBe('occurred_in_future');
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ occurredAt: inMinutes(10) }))
        .expect(400);
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ occurredAt: inMinutes(2) }))
        .expect(201);
    });

    it("refuses another hospital's category or org unit", async () => {
      const category = await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ categoryId: b.categories.equipment }))
        .expect(400);
      expect(category.body.code).toBe('unknown_category');
      const unit = await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ orgUnitId: bUnit }))
        .expect(400);
      expect(unit.body.code).toBe('unknown_org_unit');
    });

    it('does not use up a number for a refused report', async () => {
      const first = await report(reporter);
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ orgUnitId: bUnit }))
        .expect(400);
      const second = await report(reporter);
      expect(Number(second.reference.slice(-5))).toBe(
        Number(first.reference.slice(-5)) + 1,
      );
    });
  });

  describe('anonymous reports', () => {
    let anonymous: { id: string; reference: string };

    beforeAll(async () => {
      const res = await http()
        .post('/incidents')
        .set('Cookie', otherReporter.cookie)
        .set('X-Forwarded-For', '203.0.113.9')
        .send(validReport({ anonymous: true, orgUnitId: labDept }))
        .expect(201);
      anonymous = res.body;
    });

    it('returns the reference once', () => {
      expect(anonymous.reference).toMatch(new RegExp(`^INC-${year}-\\d{5}$`));
    });

    it('cannot be found again by whoever made it', async () => {
      await open(otherReporter.cookie, anonymous.id).expect(404);
      const mine = await listOf(otherReporter.cookie);
      expect(mine.items.map((i) => i.id)).not.toContain(anonymous.id);
      await http()
        .post(`/incidents/${anonymous.id}/comments`)
        .set('Cookie', otherReporter.cookie)
        .send({ body: 'Any news?', visibility: 'everyone' })
        .expect(404);
    });

    it('is stored with nothing that names the reporter', async () => {
      const stored = await owner.db.execute<{ reported_by: string | null }>(
        sql`select reported_by from incidents where id = ${anonymous.id}`,
      );
      expect(stored.rows).toEqual([{ reported_by: null }]);

      const events = await owner.db.execute<{
        kind: string;
        actor_id: string | null;
        details: unknown;
      }>(
        sql`select kind, actor_id, details from incident_events where incident_id = ${anonymous.id}`,
      );
      expect(events.rows).toEqual([
        { kind: 'reported', actor_id: null, details: null },
      ]);

      const audit = await owner.db.execute<{
        action: string;
        actor_id: string | null;
        ip_address: string | null;
        changes: unknown;
      }>(
        sql`select action, actor_id, ip_address, changes from audit_log where tenant_id = ${a.id} and entity_id = ${anonymous.id}`,
      );
      expect(audit.rows).toEqual([
        {
          action: 'incident_reported',
          actor_id: null,
          ip_address: null,
          changes: {
            reference: anonymous.reference,
            type: 'incident',
            anonymous: true,
          },
        },
      ]);

      // Nothing the reporter did is linked to it from the other side either.
      const linked = await owner.db.execute(
        sql`select 1 from audit_log
            where tenant_id = ${a.id}
              and (actor_id = ${otherReporter.id} or changes::text like ${`%${otherReporter.id}%`})
              and (entity_id = ${anonymous.id}
                   or changes::text like ${`%${anonymous.id}%`}
                   or changes::text like ${`%${anonymous.reference}%`})`,
      );
      expect(linked.rows).toHaveLength(0);
      const comments = await owner.db.execute(
        sql`select 1 from incident_comments where incident_id = ${anonymous.id}`,
      );
      expect(comments.rows).toHaveLength(0);
    });

    it('shows no reporter to those who handle it', async () => {
      const res = await open(quality.cookie, anonymous.id).expect(200);
      expect(res.body.reporter).toBeNull();
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0]).toMatchObject({
        kind: 'reported',
        actor: null,
      });
      expect(JSON.stringify(res.body)).not.toContain(otherReporter.id);
    });
  });

  describe('who sees what', () => {
    let inWard: string; // happened in the ward department
    let inWardUnit: string; // happened in the unit beneath it
    let inLab: string; // happened in the other department
    let inLabForWard: string; // happened in the lab, owned by the ward

    beforeAll(async () => {
      inWard = (await report(reporter, { orgUnitId: wardDept })).id;
      inWardUnit = (await report(otherReporter, { orgUnitId: wardUnit })).id;
      inLab = (await report(otherReporter, { orgUnitId: labDept })).id;
      inLabForWard = (await report(otherReporter, { orgUnitId: labDept })).id;
      await triage(quality.cookie, inLabForWard, {
        ownerUnitId: wardDept,
      }).expect(200);
    });

    it('shows a reporter only their own', async () => {
      await open(reporter.cookie, inWard).expect(200);
      await open(reporter.cookie, inWardUnit).expect(404);
      await open(reporter.cookie, inLab).expect(404);

      const list = await listOf(reporter.cookie);
      expect(list.items.map((i) => i.id)).toContain(inWard);
      expect(list.items.map((i) => i.id)).not.toContain(inWardUnit);
      expect(list.total).toBe(list.items.length);
      const stored = await owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from incidents where reported_by = ${reporter.id}`,
      );
      expect(list.total).toBe(stored.rows[0].n);
    });

    it('shows someone with no rights nothing', async () => {
      await open(noRoles.cookie, inWard).expect(404);
      expect(await listOf(noRoles.cookie)).toEqual({ items: [], total: 0 });
      expect(await summaryOf(noRoles.cookie)).toEqual(EMPTY_SUMMARY);
    });

    it('shows a department viewer their department and the unit beneath it', async () => {
      const ward = await open(wardViewer.cookie, inWard).expect(200);
      expect(ward.body).toMatchObject({ access: 'full', canTriage: false });
      await open(wardViewer.cookie, inWardUnit).expect(200);
      // Owned by their department, though it happened elsewhere.
      await open(wardViewer.cookie, inLabForWard).expect(200);
      await open(wardViewer.cookie, inLab).expect(404);

      const ids = (await listOf(wardViewer.cookie)).items.map((i) => i.id);
      expect(ids).toEqual(
        expect.arrayContaining([inWard, inWardUnit, inLabForWard]),
      );
      expect(ids).not.toContain(inLab);
    });

    it('counts for a department viewer only what they may see', async () => {
      const before = await summaryOf(wardViewer.cookie);
      await report(otherReporter, { orgUnitId: labDept });
      expect(await summaryOf(wardViewer.cookie)).toEqual(before);
      await report(otherReporter, { orgUnitId: wardUnit });
      expect(await summaryOf(wardViewer.cookie)).toEqual({
        ...before,
        open: before.open + 1,
        awaitingTriage: before.awaitingTriage + 1,
      });
    });

    it('shows a whole-organization viewer everything', async () => {
      for (const id of [inWard, inWardUnit, inLab, inLabForWard]) {
        const res = await open(allViewer.cookie, id).expect(200);
        expect(res.body).toMatchObject({ access: 'full', canTriage: false });
      }
      const list = await listOf(allViewer.cookie);
      const stored = await owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from incidents where tenant_id = ${a.id}`,
      );
      expect(list.total).toBe(stored.rows[0].n);
    });

    it('shows another hospital none of it', async () => {
      await open(b.cookie, inWard).expect(404);
      await triage(b.cookie, inWard, { ownerUnitId: bUnit }).expect(404);
      await move(b.cookie, inWard, 'rejected', 'No').expect(404);
      await http()
        .post(`/incidents/${inWard}/comments`)
        .set('Cookie', b.cookie)
        .send({ body: 'Hello', visibility: 'everyone' })
        .expect(404);
      const list = await listOf(b.cookie);
      // Hospital B has only the two reports it made itself.
      expect(list.total).toBe(2);
      expect(list.items.map((i) => i.reference).sort()).toEqual([
        `INC-${year}-00001`,
        `INC-${year}-00002`,
      ]);
      expect(await summaryOf(b.cookie)).toEqual({
        ...EMPTY_SUMMARY,
        open: 2,
        awaitingTriage: 2,
      });
    });

    it('answers 404 for an id that is not one', async () => {
      await open(quality.cookie, 'not-an-id').expect(404);
      await open(quality.cookie, '00000000-0000-4000-8000-000000000000').expect(
        404,
      );
    });
  });

  describe('the list', () => {
    it('is newest first, with the fields the screen needs and a short excerpt', async () => {
      const long = `${'Long description. '.repeat(20)}end`;
      const older = await report(reporter, { description: long });
      const newer = await report(reporter, { description: 'Short one.' });
      const res = await http()
        .get('/incidents?mine=true&pageSize=2')
        .set('Cookie', reporter.cookie)
        .expect(200);
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
        newer.id,
        older.id,
      ]);
      expect(res.body.total).toBeGreaterThan(2);
      const [first, second] = res.body.items;
      expect(Object.keys(first).sort()).toEqual([
        'access',
        'assignedToMe',
        'category',
        'channel',
        'closeDueAt',
        'descriptionExcerpt',
        'harmLevel',
        'id',
        'isSentinel',
        'occurredAt',
        'orgUnit',
        'overdue',
        'ownerUnit',
        'reference',
        'reportedAt',
        'status',
        'triageDueAt',
        'type',
      ]);
      expect(first).toMatchObject({
        reference: newer.reference,
        type: 'incident',
        category: {
          id: a.categories.equipment,
          name: expect.objectContaining({
            en: 'Equipment and medical devices',
          }),
        },
        orgUnit: { id: wardDept, name: { en: 'Unit WARD' } },
        ownerUnit: null,
        harmLevel: 'none',
        isSentinel: false,
        status: 'new',
        descriptionExcerpt: 'Short one.',
        // Their own report, seen as its reporter sees it.
        access: 'reporter',
        channel: 'app',
      });
      expect(second.descriptionExcerpt).toHaveLength(140);
      expect(long.startsWith(second.descriptionExcerpt.slice(0, 139))).toBe(
        true,
      );
    });

    it('pages without repeating or dropping anything', async () => {
      const all = await listOf(reporter.cookie);
      const seen: string[] = [];
      for (let page = 1; seen.length < all.total; page++) {
        const res = await http()
          .get(`/incidents?page=${page}&pageSize=3`)
          .set('Cookie', reporter.cookie)
          .expect(200);
        expect(res.body.total).toBe(all.total);
        expect(res.body.items.length).toBeGreaterThan(0);
        seen.push(...res.body.items.map((i: { id: string }) => i.id));
      }
      expect(seen).toEqual(all.items.map((i) => i.id));
    });

    it('filters by status and by "reported by me"', async () => {
      const mine = await report(quality, { orgUnitId: labDept });
      await move(quality.cookie, mine.id, 'rejected', 'Duplicate').expect(200);

      const rejected = await listOf(quality.cookie, '&status=rejected');
      expect(rejected.items.map((i) => i.id)).toContain(mine.id);
      expect(rejected.items.every((i) => i.status === 'rejected')).toBe(true);

      const reportedByMe = await listOf(quality.cookie, '&mine=true');
      expect(reportedByMe.items.map((i) => i.id)).toEqual([mine.id]);
      const everything = await listOf(quality.cookie, '&status=&mine=false');
      expect(everything.total).toBeGreaterThan(reportedByMe.total);
    });

    it('refuses a query it does not understand', async () => {
      for (const query of [
        'status=open',
        'mine=yes',
        'page=0',
        'page=x',
        'pageSize=101',
        'pageSize=0',
        'sort=asc',
        'status=new&status=closed',
        'open=yes',
        'open=1',
        'serious=yes',
        'open=true&open=false',
      ]) {
        await http()
          .get(`/incidents?${query}`)
          .set('Cookie', quality.cookie)
          .expect(400);
      }
    });
  });

  describe('the reporter-only view', () => {
    let id: string;
    const INTERNAL_TEXT = `internal-remark-${run}`;

    beforeAll(async () => {
      id = (await report(reporter, { orgUnitId: labDept })).id;
      await triage(quality.cookie, id, {
        ownerUnitId: labDept,
        assignedTo: labTriager.id,
      }).expect(200);
      await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', quality.cookie)
        .send({ body: INTERNAL_TEXT, visibility: 'internal' })
        .expect(201);
      await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', quality.cookie)
        .send({ body: 'Thank you, we are looking.', visibility: 'everyone' })
        .expect(201);
    });

    it('shows the incident without anything internal', async () => {
      const res = await open(reporter.cookie, id).expect(200);
      expect(res.body).toMatchObject({
        access: 'reporter',
        canTriage: false,
        status: 'triaged',
        // The department is named, the person is not.
        ownerUnit: { id: labDept },
        assignedTo: null,
      });
      expect(res.body.comments).toHaveLength(1);
      expect(res.body.comments[0]).toMatchObject({
        body: 'Thank you, we are looking.',
        visibility: 'everyone',
        author: { id: quality.id },
      });
      expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual([
        'reported',
        'triaged',
        'commented',
      ]);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(INTERNAL_TEXT);
      expect(body).not.toContain(labTriager.id);
      expect(body).not.toContain('internal');
    });

    it('shows all of it to someone with full access', async () => {
      const res = await open(quality.cookie, id).expect(200);
      expect(res.body).toMatchObject({
        access: 'full',
        canTriage: true,
        assignedTo: { id: labTriager.id, name: { en: 'Test lab-triager' } },
      });
      expect(res.body.comments).toHaveLength(2);
      expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual([
        'reported',
        'triaged',
        'assigned',
        'commented',
        'commented',
      ]);
    });

    it('lets the reporter comment for everyone, not internally', async () => {
      const refused = await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', reporter.cookie)
        .send({ body: 'A private note', visibility: 'internal' })
        .expect(403);
      expect(refused.body.code).toBe('internal_not_allowed');
      const posted = await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', reporter.cookie)
        .send({ body: '  One more detail.  ', visibility: 'everyone' })
        .expect(201);
      expect(posted.body).toMatchObject({ visibility: 'everyone' });
      const res = await open(quality.cookie, id).expect(200);
      expect(res.body.comments.at(-1)).toMatchObject({
        id: posted.body.id,
        body: 'One more detail.',
        author: { id: reporter.id },
      });
    });

    it('refuses an invalid comment', async () => {
      for (const body of [
        { body: '', visibility: 'everyone' },
        { body: '   ', visibility: 'everyone' },
        { body: 'x'.repeat(2001), visibility: 'everyone' },
        { body: 'No visibility' },
        { body: 'Bad visibility', visibility: 'public' },
        { body: 'Extra', visibility: 'everyone', authorId: quality.id },
      ]) {
        await http()
          .post(`/incidents/${id}/comments`)
          .set('Cookie', reporter.cookie)
          .send(body)
          .expect(400);
      }
    });

    it('does not let the reporter triage or change status', async () => {
      // No triage permission at all.
      const none = await triage(reporter.cookie, id).expect(403);
      expect(none.body.code).toBe('missing_permission');
      await move(reporter.cookie, id, 'in_progress').expect(403);
      await triage(allViewer.cookie, id).expect(403);
    });

    it('answers 403 to a triager who sees it only because they reported it', async () => {
      // The ward triager reports something that happened in the lab.
      const own = await report(wardTriager, { orgUnitId: labDept });
      const res = await open(wardTriager.cookie, own.id).expect(200);
      expect(res.body).toMatchObject({ access: 'reporter', canTriage: false });
      const refused = await triage(wardTriager.cookie, own.id).expect(403);
      expect(refused.body.code).toBe('outside_scope');
      await move(wardTriager.cookie, own.id, 'rejected', 'No').expect(403);
      const stored = await open(quality.cookie, own.id).expect(200);
      expect(stored.body.status).toBe('new');
    });
  });

  describe('triage', () => {
    it('sets harm, sentinel, category, owner and assignee', async () => {
      const { id } = await report(reporter, { orgUnitId: wardUnit });
      const res = await triage(wardTriager.cookie, id, {
        harmLevel: 'severe',
        isSentinel: true,
        categoryId: a.categories.fall,
        ownerUnitId: labDept,
        assignedTo: labTriager.id,
      }).expect(200);
      expect(res.body).toMatchObject({
        id,
        status: 'triaged',
        harmLevel: 'severe',
        isSentinel: true,
        category: { id: a.categories.fall },
        ownerUnit: { id: labDept },
        assignedTo: { id: labTriager.id },
        access: 'full',
        canTriage: true,
      });
      expect(res.body.triagedAt).toBeTruthy();
      // The owning department's triager now sees it too.
      await open(labTriager.cookie, id).expect(200);
    });

    it('can be done again while triaged, and records a new assignment only when it changes', async () => {
      const { id } = await report(reporter);
      await triage(quality.cookie, id).expect(200);
      await triage(quality.cookie, id, { harmLevel: 'moderate' }).expect(200);
      const again = await triage(quality.cookie, id, {
        assignedTo: wardTriager.id,
      }).expect(200);
      expect(again.body.events.map((e: { kind: string }) => e.kind)).toEqual([
        'reported',
        'triaged',
        'assigned',
        'triaged',
        'triaged',
        'assigned',
      ]);
      // Leaving the assignee out takes the person off it.
      const cleared = await triage(quality.cookie, id).expect(200);
      expect(cleared.body.assignedTo).toBeNull();
    });

    it('stays possible while work is in progress, and leaves the status as it is', async () => {
      const id = await incidentIn('in_progress');
      const res = await triage(quality.cookie, id, {
        harmLevel: 'moderate',
        ownerUnitId: labDept,
      }).expect(200);
      expect(res.body).toMatchObject({
        status: 'in_progress',
        harmLevel: 'moderate',
        ownerUnit: { id: labDept },
        canRetriage: true,
      });
      expect(res.body.events.at(-2)).toMatchObject({
        kind: 'triaged',
        fromStatus: 'in_progress',
        toStatus: 'in_progress',
        details: {
          harmLevel: { from: 'mild', to: 'moderate' },
          ownerUnitId: { from: wardDept, to: labDept },
        },
      });
      expect(res.body.events.at(-1)).toMatchObject({ kind: 'assigned' });
    });

    it('is refused once the incident has ended', async () => {
      for (const status of ['closed', 'rejected'] as const) {
        const id = await incidentIn(status);
        const res = await triage(quality.cookie, id).expect(409);
        expect(res.body.code).toBe('invalid_transition');
        const stored = await open(quality.cookie, id).expect(200);
        expect(stored.body.canRetriage).toBe(false);
      }
    });

    it('answers 404 to a triager scoped to another department', async () => {
      const { id } = await report(reporter, { orgUnitId: wardUnit });
      await triage(labTriager.cookie, id).expect(404);
      await move(labTriager.cookie, id, 'rejected', 'No').expect(404);
      await open(labTriager.cookie, id).expect(404);
      await triage(wardTriager.cookie, id).expect(200);
    });

    it('needs an active user of this hospital as assignee', async () => {
      const { id } = await report(reporter);
      const bAdmin = await http()
        .get('/auth/me')
        .set('Cookie', b.cookie)
        .expect(200);
      const disabled = await createStaff('disabled', {
        role: 'reporter',
        orgUnitId: null,
      });
      await http()
        .patch(`/users/${disabled.id}`)
        .set('Cookie', a.cookie)
        .send({ status: 'disabled' })
        .expect(200);
      for (const assignedTo of [
        bAdmin.body.user.id,
        invitedId,
        disabled.id,
        '00000000-0000-4000-8000-000000000000',
      ]) {
        const res = await triage(quality.cookie, id, { assignedTo }).expect(
          400,
        );
        expect(res.body.code).toBe('unknown_assignee');
      }
      const stored = await open(quality.cookie, id).expect(200);
      expect(stored.body.status).toBe('new');
      await triage(quality.cookie, id, { assignedTo: reporter.id }).expect(200);
    });

    it("refuses invalid input and another hospital's unit or category", async () => {
      const { id } = await report(reporter);
      for (const overrides of [
        { harmLevel: 'bad' },
        { isSentinel: 'no' },
        { ownerUnitId: null },
        { ownerUnitId: 'not-an-id' },
        { assignedTo: 'not-an-id' },
        { status: 'closed' },
      ]) {
        await triage(quality.cookie, id, overrides).expect(400);
      }
      await http()
        .post(`/incidents/${id}/triage`)
        .set('Cookie', quality.cookie)
        .send({ harmLevel: 'mild', isSentinel: false })
        .expect(400);
      const unit = await triage(quality.cookie, id, {
        ownerUnitId: bUnit,
      }).expect(400);
      expect(unit.body.code).toBe('unknown_org_unit');
      const category = await triage(quality.cookie, id, {
        categoryId: b.categories.fall,
      }).expect(400);
      expect(category.body.code).toBe('unknown_category');
    });
  });

  describe('status changes', () => {
    const allowed = new Set([
      'triaged>in_progress',
      'triaged>closed',
      'in_progress>closed',
      'new>rejected',
      // Set aside after triage too, when it turns out to be a duplicate or
      // not an incident (second quality review, D1).
      'triaged>rejected',
      'closed>in_progress',
      // Set aside before triage, a report is reopened to be triaged like a
      // new one, not sent straight on to work with no handling department
      // (regression after the second quality review). One set aside after
      // triage goes back to triaged: test/incident-reopen-and-pause.e2e-spec.ts.
      'rejected>new',
    ]);

    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const ok = allowed.has(`${from}>${to}`);
        it(`${from} to ${to} is ${ok ? 'allowed' : 'refused'}`, async () => {
          const id = await incidentIn(from);
          const res = await move(quality.cookie, id, to, 'A reason');
          if (ok) {
            expect(res.status).toBe(200);
            expect(res.body.status).toBe(to);
          } else {
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('invalid_transition');
            const stored = await open(quality.cookie, id).expect(200);
            expect(stored.body.status).toBe(from);
          }
        });
      }
    }

    it('needs a note to close, reject or reopen, but not to start work', async () => {
      const triaged = await incidentIn('triaged');
      for (const note of [undefined, '', '   ']) {
        const res = await move(quality.cookie, triaged, 'closed', note).expect(
          400,
        );
        expect(res.body.code).toBe('note_required');
      }
      await move(quality.cookie, triaged, 'in_progress').expect(200);
      await move(quality.cookie, triaged, 'closed').expect(400);

      const fresh = await incidentIn('new');
      await move(quality.cookie, fresh, 'rejected').expect(400);
      const closed = await incidentIn('closed');
      await move(quality.cookie, closed, 'in_progress').expect(400);
      const rejected = await incidentIn('rejected');
      await move(quality.cookie, rejected, 'new').expect(400);
    });

    it('keeps the note where it belongs', async () => {
      const id = await incidentIn('triaged');
      const closed = await move(
        quality.cookie,
        id,
        'closed',
        '  Pump replaced and checked.  ',
      ).expect(200);
      expect(closed.body.closureSummary).toBe('Pump replaced and checked.');
      expect(closed.body.closedAt).toBeTruthy();

      const reopened = await move(
        quality.cookie,
        id,
        'in_progress',
        'It failed again.',
      ).expect(200);
      expect(reopened.body).toMatchObject({
        status: 'in_progress',
        closedAt: null,
        closureSummary: null,
      });

      const other = await incidentIn('new');
      const rejected = await move(
        quality.cookie,
        other,
        'rejected',
        'Reported twice.',
      ).expect(200);
      expect(rejected.body.rejectionReason).toBe('Reported twice.');
    });

    it('refuses invalid input', async () => {
      const id = await incidentIn('triaged');
      await move(quality.cookie, id, 'done').expect(400);
      await move(quality.cookie, id, 'closed', 'x'.repeat(2001)).expect(400);
      await http()
        .post(`/incidents/${id}/status`)
        .set('Cookie', quality.cookie)
        .send({ note: 'No target' })
        .expect(400);
      await http()
        .post(`/incidents/${id}/status`)
        .set('Cookie', quality.cookie)
        .send({ to: 'closed', note: 'Done', closedBy: reporter.id })
        .expect(400);
    });
  });

  describe('the timeline', () => {
    it('is complete and in order for a whole life', async () => {
      const { id } = await report(reporter, { orgUnitId: wardUnit });
      const q = quality.cookie;
      await triage(q, id, { assignedTo: wardTriager.id }).expect(200);
      await move(q, id, 'in_progress').expect(200);
      const comment = await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', wardTriager.cookie)
        .send({ body: 'Checked the pump.', visibility: 'internal' })
        .expect(201);
      await move(q, id, 'closed', 'Pump replaced.').expect(200);
      await move(q, id, 'in_progress', 'Fault returned.').expect(200);

      const res = await open(q, id).expect(200);
      const events = res.body.events as {
        kind: string;
        occurredAt: string;
        actor: { id: string } | null;
        fromStatus: Status | null;
        toStatus: Status | null;
        details: Record<string, unknown> | null;
      }[];
      expect(
        events.map((e) => [e.kind, e.fromStatus, e.toStatus, e.actor?.id]),
      ).toEqual([
        ['reported', null, 'new', reporter.id],
        ['triaged', 'new', 'triaged', quality.id],
        ['assigned', null, null, quality.id],
        ['status_changed', 'triaged', 'in_progress', quality.id],
        ['commented', null, null, wardTriager.id],
        ['closed', 'in_progress', 'closed', quality.id],
        ['reopened', 'closed', 'in_progress', quality.id],
      ]);
      const times = events.map((e) => Date.parse(e.occurredAt));
      expect(times).toEqual([...times].sort((x, y) => x - y));
      expect(events[2].details).toEqual({
        ownerUnitId: wardDept,
        assignedTo: wardTriager.id,
      });
      expect(events[4].details).toEqual({
        commentId: comment.body.id,
        visibility: 'internal',
      });
      expect(events[5].details).toEqual({ note: 'Pump replaced.' });
      // Reopened, it has a new deadline to close by, counted from the
      // reopening; the one it had is kept beside it.
      expect(events[6].details).toEqual({
        note: 'Fault returned.',
        closeDueAt: { from: expect.any(String), to: expect.any(String) },
      });
      const deadlines = events[6].details!.closeDueAt as Record<string, string>;
      expect(res.body.closeDueAt).toBe(deadlines.to);
      expect(Date.parse(deadlines.to)).toBeGreaterThan(
        Date.parse(deadlines.from),
      );

      // The reporter sees the same life without its internal parts.
      const theirs = await open(reporter.cookie, id).expect(200);
      expect(theirs.body.events.map((e: { kind: string }) => e.kind)).toEqual([
        'reported',
        'triaged',
        'status_changed',
        'closed',
        'reopened',
      ]);
      expect(JSON.stringify(theirs.body)).not.toContain(wardTriager.id);
      // Without either deadline: they are for those handling it.
      expect(theirs.body.events.at(-1).details).toEqual({
        note: 'Fault returned.',
      });
      expect(JSON.stringify(theirs.body)).not.toContain(deadlines.from);
      expect(JSON.stringify(theirs.body)).not.toContain(deadlines.to);
    });
  });

  describe('the assignee', () => {
    const INTERNAL_TEXT = `for-the-team-${run}`;
    let assignee: Staff; // may report, and nothing else
    let id: string;
    const none = EMPTY_SUMMARY;

    beforeAll(async () => {
      assignee = await createStaff('assignee', {
        role: 'reporter',
        orgUnitId: null,
      });
      id = (await report(reporter, { orgUnitId: wardDept })).id;
    });

    it('sees nothing of it before being assigned', async () => {
      await open(assignee.cookie, id).expect(404);
      expect(await listOf(assignee.cookie)).toEqual({ items: [], total: 0 });
      expect(await summaryOf(assignee.cookie)).toEqual(none);
    });

    it('can open, list and count the incident once assigned', async () => {
      await triage(quality.cookie, id, { assignedTo: assignee.id }).expect(200);
      await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', quality.cookie)
        .send({ body: INTERNAL_TEXT, visibility: 'internal' })
        .expect(201);

      const res = await open(assignee.cookie, id).expect(200);
      expect(res.body).toMatchObject({
        access: 'full',
        canTriage: false,
        assignedTo: { id: assignee.id },
      });
      expect(res.body.comments).toEqual([
        expect.objectContaining({
          body: INTERNAL_TEXT,
          visibility: 'internal',
        }),
      ]);
      expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual([
        'reported',
        'triaged',
        'assigned',
        'commented',
      ]);

      const list = await listOf(assignee.cookie);
      expect(list.total).toBe(1);
      expect(list.items.map((i) => i.id)).toEqual([id]);
      // Assigned to them, not reported by them.
      expect(await listOf(assignee.cookie, '&mine=true')).toEqual({
        items: [],
        total: 0,
      });
      expect(await summaryOf(assignee.cookie)).toEqual({
        ...none,
        open: 1,
        assignedToMe: 1,
        // The one incident they handle was triaged within its time.
        triagedOnTime: 100,
      });
    });

    it('can post both kinds of comment', async () => {
      for (const visibility of ['internal', 'everyone']) {
        await http()
          .post(`/incidents/${id}/comments`)
          .set('Cookie', assignee.cookie)
          .send({ body: 'Looking into it.', visibility })
          .expect(201);
      }
      const res = await open(quality.cookie, id).expect(200);
      expect(
        res.body.comments
          .filter(
            (c: { author: { id: string } }) => c.author.id === assignee.id,
          )
          .map((c: { visibility: string }) => c.visibility),
      ).toEqual(['internal', 'everyone']);
    });

    it('cannot triage or change status without the right to triage', async () => {
      // No triage right anywhere: refused before the incident is looked at.
      const triaged = await triage(assignee.cookie, id).expect(403);
      expect(triaged.body.code).toBe('missing_permission');
      const moved = await move(assignee.cookie, id, 'in_progress').expect(403);
      expect(moved.body.code).toBe('missing_permission');
      const stored = await open(quality.cookie, id).expect(200);
      expect(stored.body.status).toBe('triaged');
    });

    it('answers 403 outside_scope to an assignee whose triage right is for elsewhere', async () => {
      const other = await report(reporter, { orgUnitId: wardDept });
      await open(labTriager.cookie, other.id).expect(404);
      await triage(quality.cookie, other.id, {
        assignedTo: labTriager.id,
      }).expect(200);

      const res = await open(labTriager.cookie, other.id).expect(200);
      expect(res.body).toMatchObject({ access: 'full', canTriage: false });
      const triaged = await triage(labTriager.cookie, other.id).expect(403);
      expect(triaged.body.code).toBe('outside_scope');
      const moved = await move(
        labTriager.cookie,
        other.id,
        'closed',
        'Done',
      ).expect(403);
      expect(moved.body.code).toBe('outside_scope');
      const stored = await open(quality.cookie, other.id).expect(200);
      expect(stored.body).toMatchObject({
        status: 'triaged',
        assignedTo: { id: labTriager.id },
      });
    });

    it('loses access when taken off the incident', async () => {
      // Handed to someone else.
      await triage(quality.cookie, id, { assignedTo: wardTriager.id }).expect(
        200,
      );
      await open(assignee.cookie, id).expect(404);
      expect(await listOf(assignee.cookie)).toEqual({ items: [], total: 0 });
      expect(await summaryOf(assignee.cookie)).toEqual(none);
      await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', assignee.cookie)
        .send({ body: 'Still here?', visibility: 'everyone' })
        .expect(404);

      // Back on it, then left with nobody assigned.
      await triage(quality.cookie, id, { assignedTo: assignee.id }).expect(200);
      await open(assignee.cookie, id).expect(200);
      await triage(quality.cookie, id).expect(200);
      await open(assignee.cookie, id).expect(404);
    });
  });

  describe('choosing an assignee', () => {
    const assignable = (cookie: string) =>
      http().get('/incidents/assignable-users').set('Cookie', cookie);

    it('lists active users only, by email, with no contact details', async () => {
      const placed = await http()
        .post('/users')
        .set('Cookie', a.cookie)
        .send({
          name: { en: 'Test placed' },
          email: `placed-inc-${run}@test.invalid`,
          orgUnitId: wardUnit,
          phone: '0000 000',
          roles: [],
        })
        .expect(201);
      await http()
        .post('/auth/invite/accept')
        .send({ org: a.slug, token: placed.body.invite.token, password })
        .expect(204);
      const gone = await createStaff('gone', {
        role: 'reporter',
        orgUnitId: null,
      });
      await http()
        .patch(`/users/${gone.id}`)
        .set('Cookie', a.cookie)
        .send({ status: 'disabled' })
        .expect(200);

      const res = await assignable(quality.cookie).expect(200);
      const list = res.body as {
        id: string;
        name: Record<string, string>;
        orgUnitId: string | null;
      }[];
      for (const item of list) {
        expect(Object.keys(item).sort()).toEqual(['id', 'name', 'orgUnitId']);
      }
      expect(JSON.stringify(res.body)).not.toContain('@');
      expect(JSON.stringify(res.body)).not.toContain('0000 000');

      const active = await owner.db.execute<{ id: string }>(
        sql`select id from users where tenant_id = ${a.id} and status = 'active' order by email`,
      );
      expect(list.map((u) => u.id)).toEqual(active.rows.map((r) => r.id));
      const ids = list.map((u) => u.id);
      expect(ids).toEqual(expect.arrayContaining([reporter.id, quality.id]));
      expect(ids).not.toContain(invitedId);
      expect(ids).not.toContain(gone.id);

      expect(list.find((u) => u.id === placed.body.user.id)).toEqual({
        id: placed.body.user.id,
        name: { en: 'Test placed' },
        orgUnitId: wardUnit,
      });
      expect(list.find((u) => u.id === reporter.id)).toEqual({
        id: reporter.id,
        name: { en: 'Test reporter' },
        orgUnitId: null,
      });
    });

    it('is open to a triager for one department, as the permission is held somewhere', async () => {
      await assignable(wardTriager.cookie).expect(200);
    });

    it('refuses someone without the right to triage', async () => {
      for (const who of [reporter, allViewer, noRoles]) {
        const res = await assignable(who.cookie).expect(403);
        expect(res.body.code).toBe('missing_permission');
      }
    });

    it("never shows another hospital's users", async () => {
      const mine = await http()
        .get('/auth/me')
        .set('Cookie', b.cookie)
        .expect(200);
      const theirs = await assignable(b.cookie).expect(200);
      expect(theirs.body).toEqual([
        { id: mine.body.user.id, name: { en: 'Admin' }, orgUnitId: null },
      ]);
      const ours = await assignable(quality.cookie).expect(200);
      expect(ours.body.map((u: { id: string }) => u.id)).not.toContain(
        mine.body.user.id,
      );
    });
  });

  describe('the summary', () => {
    it('matches the list for each kind of caller', async () => {
      for (const who of [reporter, wardViewer, labTriager, allViewer]) {
        const summary = await summaryOf(who.cookie);
        const total = async (status: Status) =>
          (await listOf(who.cookie, `&status=${status}`)).total;
        expect(summary.awaitingTriage).toBe(await total('new'));
        expect(summary.open).toBe(
          (await total('new')) +
            (await total('triaged')) +
            (await total('in_progress')) +
            (await listOf(who.cookie, '&status=awaiting_sign_off')).total,
        );
        expect(summary.closedLast30Days).toBe(await total('closed'));
      }
    });

    it('follows an incident through its life', async () => {
      const start = await summaryOf(quality.cookie);
      const { id } = await report(reporter);
      const q = quality.cookie;
      expect(await summaryOf(q)).toEqual({
        ...start,
        open: start.open + 1,
        awaitingTriage: start.awaitingTriage + 1,
      });
      await triage(q, id).expect(200);
      expect(await summaryOf(q)).toEqual({ ...start, open: start.open + 1 });
      await move(q, id, 'closed', 'Done.').expect(200);
      expect(await summaryOf(q)).toEqual({
        ...start,
        closedLast30Days: start.closedLast30Days + 1,
      });
      // Closed long ago: no longer counted.
      await owner.db.execute(
        sql`update incidents set closed_at = now() - interval '31 days' where id = ${id}`,
      );
      expect(await summaryOf(q)).toEqual(start);
    });
  });

  describe('the lists behind the summary', () => {
    const OPEN = ['new', 'triaged', 'in_progress', 'awaiting_sign_off'];
    type Item = {
      id: string;
      status: string;
      harmLevel: string;
      isSentinel: boolean;
      assignedToMe: boolean;
    };
    const find = async (cookie: string, query: string) => {
      const res = await http()
        .get(`/incidents?pageSize=100${query}`)
        .set('Cookie', cookie)
        .expect(200);
      return res.body as { total: number; items: Item[] };
    };
    const isSerious = (i: Item) =>
      i.isSentinel || ['severe', 'death'].includes(i.harmLevel);
    let waiting: string; // a sentinel event awaiting sign-off, assigned
    let ended: string; // a severe incident, closed, assigned to the same
    let flagged: string; // a sentinel event whose harm was only mild

    beforeAll(async () => {
      // So that every filter has something to keep and something to drop:
      // serious and open, serious and closed, both assigned to one person.
      waiting = (await report(reporter, { harmLevel: 'severe' })).id;
      await triage(quality.cookie, waiting, {
        harmLevel: 'severe',
        isSentinel: true,
        assignedTo: labTriager.id,
      }).expect(200);
      await move(quality.cookie, waiting, 'awaiting_sign_off', 'Done.').expect(
        200,
      );
      ended = (await report(reporter, { harmLevel: 'severe' })).id;
      await triage(quality.cookie, ended, {
        harmLevel: 'severe',
        assignedTo: labTriager.id,
      }).expect(200);
      await move(quality.cookie, ended, 'closed', 'Done.').expect(200);
      flagged = (await report(reporter, { harmLevel: 'mild' })).id;
      await triage(quality.cookie, flagged, {
        harmLevel: 'mild',
        isSentinel: true,
      }).expect(200);
    });

    it('show exactly the incidents each count counted, for each kind of caller', async () => {
      for (const who of [
        reporter,
        wardViewer,
        labTriager,
        allViewer,
        quality,
      ]) {
        const summary = await summaryOf(who.cookie);
        const open = await find(who.cookie, '&open=true');
        expect(open.total).toBe(summary.open);
        expect(open.items).toHaveLength(open.total);
        expect(open.items.every((i) => OPEN.includes(i.status))).toBe(true);

        const serious = await find(who.cookie, '&open=true&serious=true');
        expect(serious.total).toBe(summary.serious);
        expect(serious.items.every(isSerious)).toBe(true);
        expect(serious.items.every((i) => OPEN.includes(i.status))).toBe(true);

        const mine = await find(who.cookie, '&open=true&assignedToMe=true');
        expect(mine.total).toBe(summary.assignedToMe);
        expect(mine.items.every((i) => i.assignedToMe)).toBe(true);

        expect((await find(who.cookie, '&status=new')).total).toBe(
          summary.awaitingTriage,
        );
      }
    });

    it('keep what is open and drop what has ended, awaiting sign-off included', async () => {
      const open = await find(
        labTriager.cookie,
        '&open=true&assignedToMe=true',
      );
      expect(open.items.map((i) => i.id)).toContain(waiting);
      expect(open.items.map((i) => i.id)).not.toContain(ended);
      expect((await summaryOf(labTriager.cookie)).assignedToMe).toBe(
        open.total,
      );
      // Without "open", what is assigned to them includes what has ended.
      const all = await find(labTriager.cookie, '&assignedToMe=true');
      expect(all.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([waiting, ended]),
      );
      expect(all.total).toBeGreaterThan(open.total);
    });

    it('find the serious ones whatever their status, unless asked for the open ones', async () => {
      const serious = await find(quality.cookie, '&serious=true');
      // Serious by its harm or by being a sentinel event, either is enough.
      expect(serious.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([waiting, ended, flagged]),
      );
      expect(serious.items.every(isSerious)).toBe(true);
      const everything = await find(quality.cookie, '');
      expect(serious.total).toBe(everything.items.filter(isSerious).length);
      expect(serious.total).toBeLessThan(everything.total);
      // A filter left at false is a filter not set.
      expect(
        (await find(quality.cookie, '&open=false&serious=false')).total,
      ).toBe(everything.total);
      // Combined with another filter, both hold.
      const closedSerious = await find(
        quality.cookie,
        '&serious=true&status=closed',
      );
      expect(closedSerious.items.map((i) => i.id)).toContain(ended);
      expect(closedSerious.items.map((i) => i.id)).not.toContain(waiting);
      expect(
        (await find(quality.cookie, '&open=true&status=closed')).total,
      ).toBe(0);
    });

    it('stay inside what the caller may see', async () => {
      // Someone with no rights gets nothing, whatever they ask for.
      for (const query of ['&open=true', '&serious=true']) {
        expect(await listOf(noRoles.cookie, query)).toEqual({
          items: [],
          total: 0,
        });
      }
      const theirs = await find(b.cookie, '&open=true');
      expect(theirs.items.map((i) => i.id)).not.toContain(waiting);
    });
  });

  describe('the audit log', () => {
    it('records every change, without any of the free text', async () => {
      const { id } = await report(reporter, {
        description: `Details. ${SECRET_TEXT}`,
        immediateAction: `Action. ${SECRET_TEXT}`,
      });
      const q = quality.cookie;
      await triage(q, id, { assignedTo: wardTriager.id }).expect(200);
      const comment = await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', q)
        .send({ body: `Comment. ${SECRET_TEXT}`, visibility: 'internal' })
        .expect(201);
      await move(q, id, 'closed', `Note. ${SECRET_TEXT}`).expect(200);

      const { rows } = await owner.db.execute<{
        action: string;
        actor_id: string | null;
        entity_type: string;
        changes: Record<string, unknown>;
      }>(
        sql`select action, actor_id, entity_type, changes from audit_log where tenant_id = ${a.id} and entity_id = ${id} order by occurred_at, id`,
      );
      expect(rows.map((r) => r.entity_type)).toEqual(Array(4).fill('incident'));
      const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
      expect(Object.keys(byAction).sort()).toEqual([
        'incident_commented',
        'incident_reported',
        'incident_status_changed',
        'incident_triaged',
      ]);
      expect(byAction.incident_reported).toMatchObject({
        actor_id: reporter.id,
        changes: { type: 'incident', anonymous: false },
      });
      expect(byAction.incident_triaged).toMatchObject({
        actor_id: quality.id,
        changes: {
          from: 'new',
          to: 'triaged',
          harmLevel: { from: 'none', to: 'mild' },
          ownerUnitId: { from: null, to: wardDept },
          assignedTo: { from: null, to: wardTriager.id },
        },
      });
      // Only what changed is listed.
      expect(Object.keys(byAction.incident_triaged.changes).sort()).toEqual([
        'assignedTo',
        'from',
        'harmLevel',
        'ownerUnitId',
        'to',
      ]);
      expect(byAction.incident_commented).toMatchObject({
        actor_id: quality.id,
        changes: { commentId: comment.body.id, visibility: 'internal' },
      });
      expect(byAction.incident_status_changed).toMatchObject({
        actor_id: quality.id,
        changes: { from: 'triaged', to: 'closed' },
      });

      // None of the words anyone wrote, anywhere in this hospital's log.
      const leaked = await owner.db.execute(
        sql`select 1 from audit_log where tenant_id = ${a.id} and changes::text like ${`%${SECRET_TEXT}%`}`,
      );
      expect(leaked.rows).toHaveLength(0);
    });

    it('writes nothing for a refused change', async () => {
      const id = await incidentIn('new');
      const count = async () =>
        (
          await owner.db.execute<{ n: number }>(
            sql`select (select count(*) from audit_log where entity_id = ${id})::int + (select count(*) from incident_events where incident_id = ${id})::int as n`,
          )
        ).rows[0].n;
      const before = await count();
      await move(quality.cookie, id, 'closed', 'Too early').expect(409);
      await triage(quality.cookie, id, { ownerUnitId: bUnit }).expect(400);
      await triage(labTriager.cookie, id).expect(404);
      expect(await count()).toBe(before);
    });
  });

  describe('rules a quality department expects', () => {
    it('keeps type and harm in agreement', async () => {
      for (const type of ['near_miss', 'hazard']) {
        const res = await http()
          .post('/incidents')
          .set('Cookie', reporter.cookie)
          .send(validReport({ type, harmLevel: 'mild' }))
          .expect(400);
        expect(res.body.code).toBe('harm_not_applicable');
      }
      const { id } = await report(reporter, { type: 'near_miss' });
      const harm = await triage(quality.cookie, id, {
        harmLevel: 'mild',
      }).expect(400);
      expect(harm.body.code).toBe('harm_not_applicable');
      const sentinel = await triage(quality.cookie, id, {
        harmLevel: 'none',
        isSentinel: true,
      }).expect(400);
      expect(sentinel.body.code).toBe('sentinel_not_applicable');
      await triage(quality.cookie, id, { harmLevel: 'none' }).expect(200);
    });

    it('does not let a serious report be rejected, and does not offer it', async () => {
      const { id } = await report(reporter, { harmLevel: 'severe' });
      const before = await open(quality.cookie, id).expect(200);
      expect(before.body.moves).toEqual([]);
      expect(before.body.canRetriage).toBe(true);
      const refused = await move(quality.cookie, id, 'rejected', 'No').expect(
        409,
      );
      expect(refused.body.code).toBe('serious_cannot_be_rejected');

      const mild = await report(reporter);
      const offered = await open(quality.cookie, mild.id).expect(200);
      expect(offered.body.moves).toEqual([
        {
          to: 'rejected',
          noteRequired: true,
          revisionRequired: false,
          kind: 'reject',
        },
      ]);
      // Nothing is offered to someone who may not triage.
      const theirs = await open(reporter.cookie, mild.id).expect(200);
      expect(theirs.body).toMatchObject({ moves: [], canRetriage: false });
      const triaged = await triage(quality.cookie, mild.id).expect(200);
      expect(triaged.body.moves).toEqual([
        {
          to: 'in_progress',
          noteRequired: false,
          revisionRequired: false,
          kind: 'start',
        },
        {
          to: 'closed',
          noteRequired: true,
          revisionRequired: false,
          kind: 'close',
        },
        // Still not serious: it can be set aside after triage too.
        {
          to: 'rejected',
          noteRequired: true,
          revisionRequired: false,
          kind: 'reject',
        },
      ]);
    });

    it('records what each triage changed, and names what the timeline points at', async () => {
      const { id } = await report(reporter, { harmLevel: 'moderate' });
      await triage(quality.cookie, id, {
        harmLevel: 'severe',
        isSentinel: true,
        categoryId: a.categories.fall,
        ownerUnitId: labDept,
        assignedTo: labTriager.id,
      }).expect(200);
      const res = await open(quality.cookie, id).expect(200);
      const triaged = res.body.events.find(
        (e: { kind: string }) => e.kind === 'triaged',
      );
      expect(triaged.details).toEqual({
        harmLevel: { from: 'moderate', to: 'severe' },
        isSentinel: { from: false, to: true },
        categoryId: { from: a.categories.equipment, to: a.categories.fall },
        ownerUnitId: { from: null, to: labDept },
      });
      expect(res.body.people).toEqual({
        [labTriager.id]: { en: 'Test lab-triager' },
      });
      expect(res.body.units).toEqual({ [labDept]: { en: 'Unit LAB' } });
      expect(Object.keys(res.body.categories).sort()).toEqual(
        [a.categories.equipment, a.categories.fall].sort(),
      );
      // The reporter gets the names their own entries point at: no person.
      const theirs = await open(reporter.cookie, id).expect(200);
      expect(theirs.body.people).toEqual({});
      expect(theirs.body.units).toEqual({ [labDept]: { en: 'Unit LAB' } });
      expect(theirs.body.orgUnit).toMatchObject({ active: true });
    });

    it('refuses a decision made on an out-of-date screen', async () => {
      const { id } = await report(reporter);
      const first = await open(quality.cookie, id).expect(200);
      expect(first.body.revision).toBe(1);
      // A comment by someone else does not make the screen out of date.
      await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', reporter.cookie)
        .send({ body: 'More detail.', visibility: 'everyone' })
        .expect(201);
      const triaged = await triage(quality.cookie, id, {
        revision: 1,
      }).expect(200);
      expect(triaged.body.revision).toBe(2);

      const stale = await triage(a.cookie, id, {
        revision: 1,
        isSentinel: true,
      }).expect(409);
      expect(stale.body.code).toBe('stale_incident');
      const staleMove = await http()
        .post(`/incidents/${id}/status`)
        .set('Cookie', a.cookie)
        .send({ to: 'closed', note: 'Done', revision: 1 })
        .expect(409);
      expect(staleMove.body.code).toBe('stale_incident');
      const stored = await open(quality.cookie, id).expect(200);
      expect(stored.body).toMatchObject({
        status: 'triaged',
        isSentinel: false,
        revision: 2,
      });
      const moved = await http()
        .post(`/incidents/${id}/status`)
        .set('Cookie', a.cookie)
        .send({ to: 'in_progress', revision: 2 })
        .expect(200);
      expect(moved.body.revision).toBe(3);
      // Without a revision the call behaves as before.
      await move(a.cookie, id, 'closed', 'Done').expect(200);
      await triage(quality.cookie, id, { revision: 0 }).expect(400);
    });

    it('tells a scoped triager the incident was handed off, and keeps the change', async () => {
      const { id, reference } = await report(otherReporter, {
        orgUnitId: labDept,
      });
      await triage(quality.cookie, id, { ownerUnitId: wardDept }).expect(200);
      await open(wardTriager.cookie, id).expect(200);
      const res = await triage(wardTriager.cookie, id, {
        ownerUnitId: labDept,
      }).expect(200);
      expect(res.body).toEqual({ id, reference, handedOff: true });
      await open(wardTriager.cookie, id).expect(404);
      const stored = await open(quality.cookie, id).expect(200);
      expect(stored.body.ownerUnit).toMatchObject({ id: labDept });
      expect(stored.body.events.at(-2)).toMatchObject({
        kind: 'triaged',
        actor: { id: wardTriager.id },
        details: { ownerUnitId: { from: wardDept, to: labDept } },
      });
      expect(stored.body.events.at(-1)).toMatchObject({ kind: 'assigned' });
    });

    it('refuses a time before 1900', async () => {
      const res = await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ occurredAt: '1899-12-31T23:59:59Z' }))
        .expect(400);
      expect(res.body.code).toBe('occurred_too_long_ago');
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport({ occurredAt: '0000-01-01T00:00:00Z' }))
        .expect(400);
    });

    it('keeps a believable start time, ignores any other, and reports the median', async () => {
      const startedAt = (secondsAgo: number) =>
        new Date(Date.now() - secondsAgo * 1000).toISOString();
      const stored = async (id: string) =>
        (
          await owner.db.execute<{ took: number | null }>(
            sql`select extract(epoch from reported_at - report_started_at)::float as took from incidents where id = ${id}`,
          )
        ).rows[0].took;
      const timed = await createStaff('timed', {
        role: 'reporter',
        orgUnitId: null,
      });
      expect((await summaryOf(timed.cookie)).medianSecondsToReport).toBeNull();
      const quick = await report(timed, { startedAt: startedAt(60) });
      const slow = await report(timed, { startedAt: startedAt(100) });
      expect(await stored(quick.id)).toBeGreaterThanOrEqual(60);
      expect(await stored(quick.id)).toBeLessThan(70);
      for (const wrong of [
        startedAt(25 * 3600),
        startedAt(-3600),
        'half past nine',
        '0000-01-01T00:00:00Z',
      ]) {
        const ignored = await report(timed, { startedAt: wrong });
        expect(await stored(ignored.id)).toBeNull();
      }
      const anonymous = await http()
        .post('/incidents')
        .set('Cookie', timed.cookie)
        .send(validReport({ anonymous: true, startedAt: startedAt(30) }))
        .expect(201);
      expect(await stored(anonymous.body.id)).toBeGreaterThanOrEqual(30);
      const median = (await summaryOf(timed.cookie)).medianSecondsToReport!;
      expect(median).toBeGreaterThanOrEqual(80);
      expect(median).toBeLessThan(90);
      expect(await stored(slow.id)).toBeGreaterThanOrEqual(100);
    });

    it('filters and sorts the list inside what the caller may see', async () => {
      const finder = await createStaff('finder', {
        role: 'quality_officer',
        orgUnitId: wardDept,
      });
      const before = await listOf(finder.cookie);
      const death = await report(reporter, {
        harmLevel: 'death',
        orgUnitId: wardUnit,
      });
      const hazard = await report(reporter, {
        type: 'hazard',
        orgUnitId: wardDept,
      });
      const elsewhere = await report(reporter, { orgUnitId: labDept });
      await triage(quality.cookie, death.id, {
        harmLevel: 'death',
        isSentinel: true,
        ownerUnitId: wardDept,
        assignedTo: finder.id,
      }).expect(200);
      const ids = async (query: string) =>
        (await listOf(finder.cookie, query)).items.map((i) => i.id);

      expect(await ids('&type=hazard')).toContain(hazard.id);
      expect(await ids('&type=hazard')).not.toContain(death.id);
      expect(await ids('&harmLevel=death&sentinel=true')).toContain(death.id);
      expect(await ids('&sentinel=false')).not.toContain(death.id);
      expect(await ids('&assignedToMe=true')).toEqual([death.id]);
      expect(await ids(`&orgUnitId=${wardUnit}`)).toContain(death.id);
      expect(await ids(`&orgUnitId=${wardUnit}`)).not.toContain(hazard.id);
      // A unit outside their view, or another hospital's: no rows, no error.
      expect(await ids(`&orgUnitId=${labDept}`)).not.toContain(elsewhere.id);
      expect(await ids(`&orgUnitId=${bUnit}`)).toEqual([]);
      expect(await ids(`&reference=${death.reference.toLowerCase()}`)).toEqual([
        death.id,
      ]);
      expect(await ids(`&reference=inc-${year}-`)).toContain(hazard.id);
      expect(await ids(`&reference=${elsewhere.reference}`)).toEqual([]);
      // Digits alone are a number: they also match the end of a reference.
      const digits = death.reference.slice(-5);
      const number = String(Number(digits));
      for (const typed of [digits, number, digits.slice(1)]) {
        const found = await listOf(finder.cookie, `&reference=${typed}`);
        expect(found.items.map((i) => i.id)).toContain(death.id);
        expect(found.items.every((i) => i.reference.endsWith(typed))).toBe(
          true,
        );
        expect(found.total).toBe(found.items.length);
      }
      // Still inside what they may see, and still a prefix for anything else.
      expect(await ids(`&reference=${elsewhere.reference.slice(-5)}`)).toEqual(
        [],
      );
      expect(await ids(`&reference=${digits}x`)).toEqual([]);
      expect(await ids(`&reference=-${digits}`)).toEqual([]);
      expect(await ids(`&reference=${year}`)).toEqual([]);
      expect(await ids('&reference=99999999')).toEqual([]);
      const today = new Date().toISOString().slice(0, 10);
      expect(await ids(`&from=${today}&to=${today}`)).toContain(death.id);
      expect(await ids('&to=2000-01-01')).toEqual([]);
      const filtered = await listOf(finder.cookie, '&type=hazard');
      expect(filtered.total).toBe(filtered.items.length);

      const byHarm = await ids('&sort=harm');
      expect(byHarm[0]).toBe(death.id);
      expect(byHarm).toHaveLength(before.total + 2);
      const oldest = await ids('&sort=oldest');
      expect(oldest).toEqual([...(await ids('&sort=newest'))].reverse());
      const item = (await listOf(finder.cookie, '&assignedToMe=true'))
        .items[0] as unknown as { assignedToMe: boolean };
      expect(item.assignedToMe).toBe(true);
      expect(await summaryOf(finder.cookie)).toMatchObject({
        assignedToMe: 1,
      });
      expect((await summaryOf(finder.cookie)).serious).toBeGreaterThanOrEqual(
        1,
      );
      for (const query of [
        'type=x',
        'sentinel=1',
        'from=yesterday',
        'reference=%25',
        'reference=4_2',
        `reference=${'4'.repeat(21)}`,
      ]) {
        await http()
          .get(`/incidents?${query}`)
          .set('Cookie', finder.cookie)
          .expect(400);
      }
    });
  });

  describe('at the same moment', () => {
    it('gives every report its own number', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => report(reporter)),
      );
      const numbers = results.map((r) => Number(r.reference.slice(-5)));
      expect(new Set(numbers).size).toBe(8);
      const sorted = [...numbers].sort((x, y) => x - y);
      expect(sorted.at(-1)! - sorted[0]).toBe(7);
    });

    it('lets only one of two opposite decisions through', async () => {
      const id = await incidentIn('triaged');
      const [rejected, closed] = await Promise.all([
        move(quality.cookie, id, 'rejected', 'Not an incident'),
        move(a.cookie, id, 'closed', 'Done.'),
      ]);
      // Either order is valid, but never both from "triaged": once set
      // aside it cannot be closed, and once closed it cannot be set aside.
      expect([rejected.status, closed.status].sort((x, y) => x - y)).toEqual([
        200, 409,
      ]);
    });
  });

  describe('a query the database refuses', () => {
    it('gets a plain 500, and none of the report reaches the server log', async () => {
      const written: string[] = [];
      const spies = [process.stdout, process.stderr].map((stream) =>
        vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
          written.push(String(chunk));
          return true;
        }),
      );
      // Wind hospital B's counter back, so the next reference is one taken.
      const wind = (by: number) =>
        owner.db.execute(
          sql`update reference_counters set last_number = last_number + ${by} where tenant_id = ${b.id} and prefix = 'INC' and year = ${year}`,
        );
      await wind(-1);
      try {
        const res = await http()
          .post('/incidents')
          .set('Cookie', b.cookie)
          .send(
            validReport({ categoryId: b.categories.other, orgUnitId: bUnit }),
          )
          .expect(500);
        expect(res.body).toEqual({
          statusCode: 500,
          message: 'Internal server error',
        });
      } finally {
        for (const spy of spies) spy.mockRestore();
        await wind(1);
      }
      const log = written.join('');
      expect(log).toContain('code=23505');
      expect(log).toContain('constraint=incidents_tenant_id_reference_key');
      expect(log).not.toContain(SECRET_TEXT);
      expect(log).not.toContain('infusion pump');
    });
  });
});
