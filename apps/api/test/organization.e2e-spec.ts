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
import { requireEnv } from '../src/env.js';
import { createPlatformAdmin } from '../src/platform/create-admin.js';
import { removeTestData } from './cleanup.js';

type UnitType = 'facility' | 'department' | 'unit';
type Unit = {
  id: string;
  parentId: string | null;
  type: UnitType;
  code: string;
  name: Record<string, string>;
  active: boolean;
};

describe('organization structure', () => {
  const run = randomBytes(4).toString('hex');
  const prefix = `org-${run}`;
  const staffEmail = `staff-org-${run}@test.invalid`;
  const staffPassword = `platform-pass-${run}`;
  const password = `hospital-pass-${run}`;
  // Wording used in unit names, which must never reach the audit log.
  const SECRET_NAME = `private-name-${run}`;
  // The owner role, only to look at what was stored.
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
  let a: Hospital; // works in English and Arabic
  let b: Hospital;
  let reporter: Staff; // may not manage the organization
  let quality: Staff; // triages everywhere, may not manage the organization

  // Hospital A's first tree, built through the API in the first test.
  let facility: Unit;
  let department: Unit;
  let unit: Unit;
  let bFacility: Unit;

  const cookieOf = (res: request.Response) =>
    res.get('Set-Cookie')![0].split(';')[0];

  const login = (org: string, email: string) =>
    http().post('/auth/login').send({ org, email, password });

  async function createHospital(
    suffix: string,
    locales: string[],
  ): Promise<Hospital> {
    const slug = `${prefix}-${suffix}`;
    const adminEmail = `admin-org-${suffix}-${run}@test.invalid`;
    const tenant = await http()
      .post('/platform/tenants')
      .set('Cookie', platform)
      .send({
        slug,
        name: { en: `Hospital ${suffix}` },
        accreditationStandard: 'JCI',
        locales,
        defaultLocale: 'en',
        plan: 'professional',
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

  /** Creates a user in hospital A with one role everywhere, and signs in. */
  async function createStaff(name: string, role: string): Promise<Staff> {
    const email = `${name}-org-${run}@test.invalid`;
    const created = await http()
      .post('/users')
      .set('Cookie', a.cookie)
      .send({
        name: { en: `Test ${name}` },
        email,
        roles: [{ roleId: a.roles[role], orgUnitId: null }],
      })
      .expect(201);
    await http()
      .post('/auth/invite/accept')
      .send({ org: a.slug, token: created.body.invite.token, password })
      .expect(204);
    const cookie = cookieOf(await login(a.slug, email).expect(200));
    return { id: created.body.user.id as string, email, cookie };
  }

  const create = (cookie: string, body: Record<string, unknown>) =>
    http().post('/org-units').set('Cookie', cookie).send(body);

  const patch = (cookie: string, id: string, body: Record<string, unknown>) =>
    http().patch(`/org-units/${id}`).set('Cookie', cookie).send(body);

  /** Creates a unit in a hospital (A unless said otherwise). */
  async function add(
    type: UnitType,
    code: string,
    parentId: string | null,
    cookie = a.cookie,
  ): Promise<Unit> {
    const res = await create(cookie, {
      type,
      code,
      name: { en: `${SECRET_NAME} ${code}` },
      parentId,
    }).expect(201);
    return res.body;
  }

  const listOf = async (cookie: string, query = ''): Promise<Unit[]> => {
    const res = await http()
      .get(`/org-units${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body;
  };

  const everything = (cookie: string) =>
    listOf(cookie, '?includeInactive=true');

  const stored = async (id: string) =>
    (await everything(a.cookie)).find((u) => u.id === id)!;

  const auditOf = async (id: string) => {
    const { rows } = await owner.db.execute<{
      action: string;
      actor_id: string | null;
      entity_type: string;
      changes: Record<string, unknown>;
    }>(
      sql`select action, actor_id, entity_type, changes from audit_log where tenant_id = ${a.id} and entity_id = ${id} order by occurred_at, id`,
    );
    return rows;
  };

  const validReport = (orgUnitId: string) => ({
    type: 'incident',
    categoryId: a.categories.equipment,
    orgUnitId,
    occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
    description: 'An infusion pump alarm did not sound.',
    harmLevel: 'none',
    anonymous: false,
  });

  const newUser = (overrides: Record<string, unknown>) =>
    http()
      .post('/users')
      .set('Cookie', a.cookie)
      .send({
        name: { en: 'Test placed' },
        email: `u${randomBytes(4).toString('hex')}-org-${run}@test.invalid`,
        roles: [],
        ...overrides,
      });

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
    a = await createHospital('a', ['en', 'ar']);
    b = await createHospital('b', ['en']);
    reporter = await createStaff('reporter', 'reporter');
    quality = await createStaff('quality', 'quality_officer');
  }, 120_000);

  afterAll(async () => {
    await removeTestData(prefix, staffEmail);
    await owner.pool.end();
    await app.close();
  });

  describe('building the structure', () => {
    it('starts a new hospital with no org units', async () => {
      expect(await listOf(a.cookie)).toEqual([]);
      expect(await everything(a.cookie)).toEqual([]);
    });

    it('lets an administrator build a facility, a department and a unit', async () => {
      const first = await create(a.cookie, {
        type: 'facility',
        code: 'MAIN',
        name: { en: `${SECRET_NAME} Main Hospital`, ar: 'المستشفى الرئيسي' },
      }).expect(201);
      facility = first.body;
      expect(first.body).toEqual({
        id: expect.any(String),
        parentId: null,
        type: 'facility',
        code: 'MAIN',
        name: { en: `${SECRET_NAME} Main Hospital`, ar: 'المستشفى الرئيسي' },
        active: true,
      });

      const second = await create(a.cookie, {
        type: 'department',
        code: 'MAIN-NUR',
        name: { en: '  Nursing  ' },
        parentId: facility.id,
      }).expect(201);
      department = second.body;
      expect(second.body).toEqual({
        id: expect.any(String),
        parentId: facility.id,
        type: 'department',
        code: 'MAIN-NUR',
        name: { en: 'Nursing' },
        active: true,
      });

      const third = await create(a.cookie, {
        type: 'unit',
        code: 'MAIN-NUR-ICU-2',
        name: { en: 'Intensive Care Unit 2' },
        parentId: department.id,
      }).expect(201);
      unit = third.body;
      expect(third.body).toMatchObject({
        parentId: department.id,
        type: 'unit',
        code: 'MAIN-NUR-ICU-2',
        active: true,
      });

      // A facility may say outright that it has no parent.
      bFacility = await add('facility', 'MAIN', null, b.cookie);
    });

    it('lists the structure in code order to any signed-in user', async () => {
      const list = await listOf(reporter.cookie);
      expect(list).toEqual([facility, department, unit]);
      expect(list.map((u) => u.code)).toEqual([
        'MAIN',
        'MAIN-NUR',
        'MAIN-NUR-ICU-2',
      ]);
      expect(await listOf(reporter.cookie, '?includeInactive=false')).toEqual(
        list,
      );
    });

    it('needs a session', async () => {
      await http().get('/org-units').expect(401);
      await http().get('/org-units?includeInactive=true').expect(401);
      await http()
        .post('/org-units')
        .send({ type: 'facility', code: 'NOBODY', name: { en: 'Nobody' } })
        .expect(401);
      await http()
        .patch(`/org-units/${facility.id}`)
        .send({ name: { en: 'Nobody' } })
        .expect(401);
    });

    it('refuses every parent of the wrong level', async () => {
      const attempts: [UnitType, string | null | undefined][] = [
        // A facility has no parent.
        ['facility', facility.id],
        ['facility', department.id],
        ['facility', unit.id],
        // A department sits under a facility.
        ['department', undefined],
        ['department', null],
        ['department', department.id],
        ['department', unit.id],
        // A unit sits under a department.
        ['unit', undefined],
        ['unit', null],
        ['unit', facility.id],
        ['unit', unit.id],
        // A parent that is not this hospital's, or is nobody's.
        ['department', bFacility.id],
        ['department', '00000000-0000-4000-8000-000000000000'],
        ['unit', '00000000-0000-4000-8000-000000000000'],
      ];
      for (const [type, parentId] of attempts) {
        const res = await create(a.cookie, {
          type,
          code: 'WRONG-PARENT',
          name: { en: 'Wrong parent' },
          ...(parentId !== undefined && { parentId }),
        });
        expect([type, parentId, res.status]).toEqual([type, parentId, 400]);
        expect(res.body.code).toBe('invalid_parent');
      }
      expect(await everything(a.cookie)).toHaveLength(3);
    });

    it('refuses invalid input', async () => {
      const valid = {
        type: 'department',
        code: 'MAIN-LAB',
        name: { en: 'Laboratory' },
        parentId: facility.id,
      };
      for (const overrides of [
        { type: 'ward' },
        { type: undefined },
        { code: undefined },
        { code: 'A' },
        { code: 'main-lab' },
        { code: 'MAIN LAB' },
        { code: 'MAIN_LAB' },
        { code: 'MAIN-LAB\n' },
        { code: 'X'.repeat(41) },
        { code: 42 },
        { name: undefined },
        { name: 'Laboratory' },
        { name: {} },
        { name: { en: '   ' } },
        { name: { en: 'x'.repeat(201) } },
        { name: { de: 'Labor' } },
        { parentId: 'not-an-id' },
        { active: false },
        { id: '00000000-0000-4000-8000-000000000000' },
        { tenantId: b.id },
      ]) {
        const res = await create(a.cookie, { ...valid, ...overrides });
        expect([overrides, res.status]).toEqual([overrides, 400]);
      }
      await http()
        .get('/org-units?includeInactive=yes')
        .set('Cookie', a.cookie)
        .expect(400);
      await http()
        .get('/org-units?other=1')
        .set('Cookie', a.cookie)
        .expect(400);
      expect(await everything(a.cookie)).toHaveLength(3);
    });

    it('accepts a code of 2 and of 40 characters', async () => {
      const short = await add('department', 'A1', facility.id);
      const long = await add('department', 'X'.repeat(40), facility.id);
      expect(short.code).toBe('A1');
      expect(long.code).toHaveLength(40);
    });

    it('refuses a code already used in the hospital, not one used elsewhere', async () => {
      const res = await create(a.cookie, {
        type: 'department',
        code: 'MAIN-NUR',
        name: { en: 'Nursing again' },
        parentId: facility.id,
      }).expect(409);
      expect(res.body.code).toBe('code_taken');
      // Whatever the level.
      const other = await create(a.cookie, {
        type: 'facility',
        code: 'MAIN-NUR',
        name: { en: 'Nursing again' },
      }).expect(409);
      expect(other.body.code).toBe('code_taken');
      // Hospital B already has its own MAIN, and may have a MAIN-NUR too.
      await add('department', 'MAIN-NUR', bFacility.id, b.cookie);
    });

    it("refuses a name outside the client's languages", async () => {
      const named = (name: Record<string, string>) =>
        create(a.cookie, {
          type: 'department',
          code: 'MAIN-FR',
          name,
          parentId: facility.id,
        });
      // French is not one of hospital A's languages.
      const french = await named({ en: 'Pharmacy', fr: 'Pharmacie' });
      expect(french.status).toBe(400);
      expect(french.body.code).toBe('language_mismatch');
      // Its default language is English: Arabic alone is not enough.
      const arabicOnly = await named({ ar: 'الصيدلية' });
      expect(arabicOnly.status).toBe(400);
      expect(arabicOnly.body.code).toBe('language_mismatch');

      for (const name of [{ fr: 'Soins' }, { ar: 'التمريض' }]) {
        const res = await patch(a.cookie, department.id, { name }).expect(400);
        expect(res.body.code).toBe('language_mismatch');
      }
      // Hospital B works in English only.
      const arabic = await patch(b.cookie, bFacility.id, {
        name: { en: 'Main', ar: 'الرئيسي' },
      }).expect(400);
      expect(arabic.body.code).toBe('language_mismatch');
      expect((await stored(department.id)).name).toEqual({ en: 'Nursing' });
    });
  });

  describe('permission', () => {
    it('refuses every write without organization.manage', async () => {
      for (const who of [reporter, quality]) {
        const created = await create(who.cookie, {
          type: 'facility',
          code: 'NOT-ALLOWED',
          name: { en: 'Not allowed' },
        }).expect(403);
        expect(created.body).toMatchObject({
          code: 'missing_permission',
          permission: 'organization.manage',
        });
        for (const body of [
          { name: { en: 'Renamed' } },
          { parentId: null },
          { active: false },
          // Refused before the input is looked at.
          { nonsense: true },
        ]) {
          const res = await patch(who.cookie, unit.id, body).expect(403);
          expect(res.body.code).toBe('missing_permission');
        }
        // And before learning whether the unit exists.
        await patch(who.cookie, bFacility.id, { active: false }).expect(403);
      }
      expect(await stored(unit.id)).toEqual(unit);
      expect(
        (await everything(a.cookie)).some((u) => u.code === 'NOT-ALLOWED'),
      ).toBe(false);
    });

    it('shows the units switched off only to someone who manages the structure', async () => {
      for (const who of [reporter, quality]) {
        const res = await http()
          .get('/org-units?includeInactive=true')
          .set('Cookie', who.cookie)
          .expect(403);
        expect(res.body).toMatchObject({
          code: 'missing_permission',
          permission: 'organization.manage',
        });
        // The usual list stays open to them.
        await http().get('/org-units').set('Cookie', who.cookie).expect(200);
      }
      await http()
        .get('/org-units?includeInactive=true')
        .set('Cookie', a.cookie)
        .expect(200);
    });
  });

  describe('organization.manage held for one department only', () => {
    it('is refused on create, update, move and the switched-off list', async () => {
      const role = await http()
        .post('/roles')
        .set('Cookie', a.cookie)
        .send({
          code: 'structure_local',
          name: { en: 'Local structure' },
          permissions: ['organization.manage'],
        })
        .expect(201);
      const email = `local-org-${run}@test.invalid`;
      const created = await newUser({
        email,
        orgUnitId: department.id,
        roles: [{ roleId: role.body.id, orgUnitId: department.id }],
      }).expect(201);
      await http()
        .post('/auth/invite/accept')
        .send({ org: a.slug, token: created.body.invite.token, password })
        .expect(204);
      const local = cookieOf(await login(a.slug, email).expect(200));
      const me = await http().get('/auth/me').set('Cookie', local).expect(200);
      expect(me.body.permissions).toEqual(['organization.manage']);

      const before = await auditOf(unit.id);
      const refusals = [
        // Even inside the department the role was granted for.
        await create(local, {
          type: 'unit',
          code: 'LOCAL-NEW',
          name: { en: 'Local new' },
          parentId: department.id,
        }),
        await patch(local, unit.id, { name: { en: 'Renamed locally' } }),
        await patch(local, unit.id, { parentId: bFacility.id }),
        await patch(local, unit.id, { active: false }),
        await http()
          .get('/org-units?includeInactive=true')
          .set('Cookie', local),
      ];
      for (const res of refusals) {
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          code: 'missing_permission',
          permission: 'organization.manage',
        });
      }
      expect(await stored(unit.id)).toEqual(unit);
      expect(await auditOf(unit.id)).toEqual(before);
      await http().get('/org-units').set('Cookie', local).expect(200);
    });
  });

  describe("another hospital's units", () => {
    it('are never listed', async () => {
      const ours = await everything(a.cookie);
      const theirs = await everything(b.cookie);
      expect(theirs.map((u) => u.code)).toEqual(['MAIN', 'MAIN-NUR']);
      expect(theirs[0]).toEqual(bFacility);
      const theirIds = new Set(theirs.map((u) => u.id));
      expect(ours.some((u) => theirIds.has(u.id))).toBe(false);
      expect(
        (await listOf(reporter.cookie)).some((u) => theirIds.has(u.id)),
      ).toBe(false);
    });

    it('cannot be changed: 404, as for one that does not exist', async () => {
      for (const body of [
        { name: { en: 'Hijacked' } },
        { active: false },
        { parentId: null },
      ]) {
        const res = await patch(a.cookie, bFacility.id, body).expect(404);
        expect(res.body.code).toBeUndefined();
      }
      await patch(a.cookie, '00000000-0000-4000-8000-000000000000', {
        active: false,
      }).expect(404);
      await patch(a.cookie, 'not-an-id', { active: false }).expect(404);
      expect((await everything(b.cookie))[0]).toEqual(bFacility);
    });

    it('cannot be used as a parent', async () => {
      const moved = await patch(a.cookie, department.id, {
        parentId: bFacility.id,
      }).expect(400);
      expect(moved.body.code).toBe('invalid_parent');
      expect((await stored(department.id)).parentId).toBe(facility.id);
    });
  });

  describe('changing a unit', () => {
    let secondFacility: Unit;
    let surgery: Unit; // a department
    let theatre: Unit; // a unit under it

    beforeAll(async () => {
      secondFacility = await add('facility', 'EAST', null);
      surgery = await add('department', 'MAIN-SUR', facility.id);
      theatre = await add('unit', 'MAIN-SUR-OR', surgery.id);
    });

    it('renames it, in one language or several', async () => {
      const res = await patch(a.cookie, theatre.id, {
        name: { en: 'Operating Theatre', ar: 'غرفة العمليات' },
      }).expect(200);
      expect(res.body).toEqual({
        ...theatre,
        name: { en: 'Operating Theatre', ar: 'غرفة العمليات' },
      });
      expect(await stored(theatre.id)).toEqual(res.body);
      // The whole name is replaced: a language left out is removed.
      const english = await patch(a.cookie, theatre.id, {
        name: { en: 'Operating Theatre', ar: '' },
      }).expect(200);
      expect(english.body.name).toEqual({ en: 'Operating Theatre' });
    });

    it('refuses invalid input, and never changes the code or the type', async () => {
      for (const body of [
        {},
        { code: 'MAIN-SUR-NEW' },
        { type: 'department' },
        { name: { en: 'Renamed' }, code: 'MAIN-SUR-NEW' },
        { name: {} },
        { name: { en: '' } },
        { name: { en: 'x'.repeat(201) } },
        { name: null },
        { parentId: 'not-an-id' },
        { active: 'no' },
        { active: null },
        { tenantId: b.id },
        { updatedAt: new Date().toISOString() },
      ]) {
        const res = await patch(a.cookie, theatre.id, body);
        expect([body, res.status]).toEqual([body, 400]);
      }
      expect(await stored(theatre.id)).toMatchObject({
        code: 'MAIN-SUR-OR',
        type: 'unit',
        name: { en: 'Operating Theatre' },
      });
    });

    it('moves a unit to another department, and a department to another facility', async () => {
      const movedUnit = await patch(a.cookie, theatre.id, {
        parentId: department.id,
      }).expect(200);
      expect(movedUnit.body).toMatchObject({
        id: theatre.id,
        parentId: department.id,
        type: 'unit',
        code: 'MAIN-SUR-OR',
      });
      await patch(a.cookie, theatre.id, { parentId: surgery.id }).expect(200);

      const movedDepartment = await patch(a.cookie, surgery.id, {
        parentId: secondFacility.id,
      }).expect(200);
      expect(movedDepartment.body).toMatchObject({
        id: surgery.id,
        parentId: secondFacility.id,
        type: 'department',
      });
      // What is beneath it goes with it.
      expect((await stored(theatre.id)).parentId).toBe(surgery.id);
    });

    it('refuses to move a unit under itself, its descendants or the wrong level', async () => {
      const attempts: [Unit, string | null][] = [
        // Under itself.
        [surgery, surgery.id],
        [theatre, theatre.id],
        [secondFacility, secondFacility.id],
        // Under what is beneath it.
        [surgery, theatre.id],
        [secondFacility, surgery.id],
        [secondFacility, theatre.id],
        // The wrong level.
        [surgery, department.id],
        [surgery, null],
        [theatre, facility.id],
        [theatre, unit.id],
        [theatre, null],
        [secondFacility, facility.id],
        // Nowhere.
        [theatre, '00000000-0000-4000-8000-000000000000'],
      ];
      for (const [moved, parentId] of attempts) {
        const res = await patch(a.cookie, moved.id, { parentId });
        expect([moved.code, parentId, res.status]).toEqual([
          moved.code,
          parentId,
          400,
        ]);
        expect(res.body.code).toBe('invalid_parent');
      }
      expect(await stored(surgery.id)).toMatchObject({
        parentId: secondFacility.id,
      });
      expect(await stored(theatre.id)).toMatchObject({ parentId: surgery.id });
      expect(await stored(secondFacility.id)).toMatchObject({ parentId: null });
    });

    it('records when it was changed', async () => {
      // In milliseconds, read as the owner.
      const read = async () => {
        const { rows } = await owner.db.execute<{
          created: number;
          updated: number;
        }>(
          sql`select (extract(epoch from created_at) * 1000)::float8 as created,
                     (extract(epoch from updated_at) * 1000)::float8 as updated
              from org_units where id = ${theatre.id}`,
        );
        return rows[0];
      };
      const before = await read();
      await patch(a.cookie, theatre.id, {
        name: { en: 'Operating Theatre 1' },
      }).expect(200);
      const after = await read();
      expect(after.created).toBe(before.created);
      expect(after.updated).toBeGreaterThan(before.updated);
      expect(after.updated).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  describe('switching off and on', () => {
    let site: Unit; // a facility
    let dept: Unit;
    let ward: Unit;
    let otherWard: Unit;

    const off = (id: string) => patch(a.cookie, id, { active: false });
    const on = (id: string) => patch(a.cookie, id, { active: true });

    beforeAll(async () => {
      site = await add('facility', 'WEST', null);
      dept = await add('department', 'WEST-MED', site.id);
      ward = await add('unit', 'WEST-MED-1', dept.id);
      otherWard = await add('unit', 'WEST-MED-2', dept.id);
    });

    it('refuses to switch off a unit with active children', async () => {
      for (const parent of [site, dept]) {
        const res = await off(parent.id).expect(409);
        expect(res.body.code).toBe('has_active_children');
      }
      // One of two children off is not enough.
      await off(ward.id).expect(200);
      const res = await off(dept.id).expect(409);
      expect(res.body.code).toBe('has_active_children');
      expect(await stored(dept.id)).toMatchObject({ active: true });
      expect(await stored(site.id)).toMatchObject({ active: true });
    });

    it('switches off from the bottom up', async () => {
      const last = await off(otherWard.id).expect(200);
      expect(last.body).toEqual({ ...otherWard, active: false });
      const middle = await off(dept.id).expect(200);
      expect(middle.body).toEqual({ ...dept, active: false });
      const top = await off(site.id).expect(200);
      expect(top.body).toEqual({ ...site, active: false });
    });

    it('hides what is off from the usual list and shows it when asked', async () => {
      const offIds = [site.id, dept.id, ward.id, otherWard.id];
      for (const cookie of [a.cookie, reporter.cookie]) {
        const usual = await listOf(cookie);
        expect(usual.some((u) => offIds.includes(u.id))).toBe(false);
        expect(usual.every((u) => u.active)).toBe(true);
        expect(usual.length).toBeGreaterThan(0);
      }
      const all = await everything(a.cookie);
      expect(
        all.filter((u) => offIds.includes(u.id)).map((u) => [u.code, u.active]),
      ).toEqual([
        ['WEST', false],
        ['WEST-MED', false],
        ['WEST-MED-1', false],
        ['WEST-MED-2', false],
      ]);
      // Still in code order, on and off together.
      const codes = all.map((u) => u.code);
      expect(codes).toEqual(
        (
          await owner.db.execute<{ code: string }>(
            sql`select code from org_units where tenant_id = ${a.id} order by code`,
          )
        ).rows.map((r) => r.code),
      );
      expect(all.some((u) => u.active)).toBe(true);
    });

    it('refuses to switch on a unit under an inactive parent', async () => {
      for (const child of [ward, dept]) {
        const res = await on(child.id).expect(409);
        expect(res.body.code).toBe('parent_inactive');
      }
      expect(await stored(ward.id)).toMatchObject({ active: false });
      expect(await stored(dept.id)).toMatchObject({ active: false });
    });

    it('still renames and moves a unit that is off', async () => {
      const renamed = await patch(a.cookie, ward.id, {
        name: { en: 'Former medical ward' },
      }).expect(200);
      expect(renamed.body).toMatchObject({
        active: false,
        name: { en: 'Former medical ward' },
      });
      // From one inactive department to an active one and back: it stays off.
      const moved = await patch(a.cookie, ward.id, {
        parentId: department.id,
      }).expect(200);
      expect(moved.body).toMatchObject({
        active: false,
        parentId: department.id,
      });
      await patch(a.cookie, ward.id, { parentId: dept.id }).expect(200);
    });

    it('puts nothing active under an inactive parent', async () => {
      const created = await create(a.cookie, {
        type: 'unit',
        code: 'WEST-MED-3',
        name: { en: 'Ward 3' },
        parentId: dept.id,
      }).expect(409);
      expect(created.body.code).toBe('parent_inactive');
      // An active unit cannot be moved there either,
      const mover = await add('unit', 'MAIN-NUR-MOVER', department.id);
      const moved = await patch(a.cookie, mover.id, {
        parentId: dept.id,
      }).expect(409);
      expect(moved.body.code).toBe('parent_inactive');
      expect(await stored(mover.id)).toEqual(mover);
      // unless it is switched off in the same change.
      const both = await patch(a.cookie, mover.id, {
        parentId: dept.id,
        active: false,
      }).expect(200);
      expect(both.body).toEqual({ ...mover, parentId: dept.id, active: false });
    });

    it('switches on from the top down', async () => {
      const top = await on(site.id).expect(200);
      expect(top.body).toEqual({ ...site, active: true });
      await on(dept.id).expect(200);
      const bottom = await on(ward.id).expect(200);
      expect(bottom.body).toMatchObject({ id: ward.id, active: true });
      const usual = await listOf(reporter.cookie);
      expect(usual.map((u) => u.id)).toEqual(
        expect.arrayContaining([site.id, dept.id, ward.id]),
      );
      expect(usual.some((u) => u.id === otherWard.id)).toBe(false);
    });

    it('moves a unit and switches it on in one change, where the parent is on', async () => {
      const res = await patch(a.cookie, otherWard.id, {
        parentId: department.id,
        active: true,
      }).expect(200);
      expect(res.body).toMatchObject({
        parentId: department.id,
        active: true,
      });
    });
  });

  describe('changes made at the same moment', () => {
    it('never leave an active unit under an inactive parent', async () => {
      const top = await add('facility', 'RACE', null);
      for (let round = 0; round < 8; round++) {
        const parent = await add('department', `RACE-${round}`, top.id);
        const idle = await add('unit', `RACE-${round}-IDLE`, parent.id);
        await patch(a.cookie, idle.id, { active: false }).expect(200);
        // The parent is switched off while one unit is created under it and
        // another is switched on.
        const [off, created, on] = await Promise.all([
          patch(a.cookie, parent.id, { active: false }),
          create(a.cookie, {
            type: 'unit',
            code: `RACE-${round}-NEW`,
            name: { en: 'New' },
            parentId: parent.id,
          }),
          patch(a.cookie, idle.id, { active: true }),
        ]);
        expect([200, 409]).toContain(off.status);
        expect([201, 409]).toContain(created.status);
        expect([200, 409]).toContain(on.status);

        const after = await everything(a.cookie);
        const parentNow = after.find((u) => u.id === parent.id)!;
        const activeChildren = after.filter(
          (u) => u.parentId === parent.id && u.active,
        );
        if (off.status === 200) {
          // Switched off first: both others were refused.
          expect(parentNow.active).toBe(false);
          expect(activeChildren).toEqual([]);
          expect(created.body.code).toBe('parent_inactive');
          expect(on.body.code).toBe('parent_inactive');
        } else {
          expect(off.body.code).toBe('has_active_children');
          expect(parentNow.active).toBe(true);
          expect(activeChildren.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('an inactive unit', () => {
    let closing: Unit; // a unit that will be switched off
    let open: Unit; // one that stays on, in the same department
    let incidentId: string;
    let member: { id: string; cookie: string };
    let newcomerId: string;

    const refused = async (res: request.Response) => {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('unknown_org_unit');
    };

    beforeAll(async () => {
      closing = await add('unit', 'MAIN-NUR-OLD', department.id);
      open = await add('unit', 'MAIN-NUR-NEW', department.id);

      // While it is on: an incident happens there, someone works there and
      // holds a role for it.
      const filed = await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport(closing.id))
        .expect(201);
      incidentId = filed.body.id;
      await http()
        .post(`/incidents/${incidentId}/triage`)
        .set('Cookie', quality.cookie)
        .send({ harmLevel: 'mild', isSentinel: false, ownerUnitId: closing.id })
        .expect(200);

      const email = `member-org-${run}@test.invalid`;
      const created = await newUser({
        email,
        orgUnitId: closing.id,
        roles: [{ roleId: a.roles.department_manager, orgUnitId: closing.id }],
      }).expect(201);
      await http()
        .post('/auth/invite/accept')
        .send({ org: a.slug, token: created.body.invite.token, password })
        .expect(204);
      member = {
        id: created.body.user.id,
        cookie: cookieOf(await login(a.slug, email).expect(200)),
      };
      const newcomer = await newUser({}).expect(201);
      newcomerId = newcomer.body.user.id;

      await patch(a.cookie, closing.id, { active: false }).expect(200);
    });

    it('is hidden from the usual list and shown with includeInactive', async () => {
      const usual = await listOf(reporter.cookie);
      expect(usual.some((u) => u.id === closing.id)).toBe(false);
      expect(usual.some((u) => u.id === open.id)).toBe(true);
      expect(await stored(closing.id)).toEqual({ ...closing, active: false });
    });

    it('is refused for a new incident', async () => {
      await refused(
        await http()
          .post('/incidents')
          .set('Cookie', reporter.cookie)
          .send(validReport(closing.id)),
      );
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport(open.id))
        .expect(201);
    });

    it('is refused as the owner at triage', async () => {
      const filed = await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport(open.id))
        .expect(201);
      const triage = (ownerUnitId: string) =>
        http()
          .post(`/incidents/${filed.body.id}/triage`)
          .set('Cookie', quality.cookie)
          .send({ harmLevel: 'mild', isSentinel: false, ownerUnitId });
      await refused(await triage(closing.id));
      const still = await http()
        .get(`/incidents/${filed.body.id}`)
        .set('Cookie', quality.cookie)
        .expect(200);
      expect(still.body).toMatchObject({ status: 'new', ownerUnit: null });
      await triage(open.id).expect(200);
    });

    it('is refused for a new user, as their unit or for a role', async () => {
      await refused(await newUser({ orgUnitId: closing.id }));
      await refused(
        await newUser({
          roles: [{ roleId: a.roles.reporter, orgUnitId: closing.id }],
        }),
      );
      // A unit that does not exist here gets the same answer.
      await refused(await newUser({ orgUnitId: bFacility.id }));
      await refused(
        await newUser({
          roles: [{ roleId: a.roles.reporter, orgUnitId: bFacility.id }],
        }),
      );
      await newUser({
        orgUnitId: open.id,
        roles: [{ roleId: a.roles.reporter, orgUnitId: open.id }],
      }).expect(201);
    });

    it('is refused when moving a user into it or granting a role for it', async () => {
      await refused(
        await http()
          .patch(`/users/${newcomerId}`)
          .set('Cookie', a.cookie)
          .send({ orgUnitId: closing.id }),
      );
      await refused(
        await http()
          .patch(`/users/${newcomerId}`)
          .set('Cookie', a.cookie)
          .send({ orgUnitId: bFacility.id }),
      );
      await refused(
        await http()
          .put(`/users/${newcomerId}/roles`)
          .set('Cookie', a.cookie)
          .send({
            roles: [{ roleId: a.roles.reporter, orgUnitId: closing.id }],
          }),
      );
      await refused(
        await http()
          .put(`/users/${newcomerId}/roles`)
          .set('Cookie', a.cookie)
          .send({
            roles: [{ roleId: a.roles.reporter, orgUnitId: bFacility.id }],
          }),
      );
      const user = await http()
        .get(`/users/${newcomerId}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(user.body).toMatchObject({ orgUnitId: null, roles: [] });

      // A unit that is on is accepted for both.
      await http()
        .patch(`/users/${newcomerId}`)
        .set('Cookie', a.cookie)
        .send({ orgUnitId: open.id })
        .expect(200);
      await http()
        .put(`/users/${newcomerId}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [{ roleId: a.roles.reporter, orgUnitId: open.id }] })
        .expect(200);
    });

    it('keeps the incident filed there open to read, with its history', async () => {
      const res = await http()
        .get(`/incidents/${incidentId}`)
        .set('Cookie', quality.cookie)
        .expect(200);
      expect(res.body).toMatchObject({
        id: incidentId,
        status: 'triaged',
        orgUnit: { id: closing.id, name: closing.name },
        ownerUnit: { id: closing.id, name: closing.name },
      });
      expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual(
        expect.arrayContaining(['reported', 'triaged']),
      );
      // The reporter still opens it, and it is still in the list.
      await http()
        .get(`/incidents/${incidentId}`)
        .set('Cookie', reporter.cookie)
        .expect(200);
      const list = await http()
        .get('/incidents?pageSize=100')
        .set('Cookie', quality.cookie)
        .expect(200);
      expect(
        list.body.items.find((i: { id: string }) => i.id === incidentId),
      ).toMatchObject({ orgUnit: { id: closing.id } });
      // It can still be worked on and closed.
      await http()
        .post(`/incidents/${incidentId}/status`)
        .set('Cookie', quality.cookie)
        .send({ to: 'closed', note: 'Resolved' })
        .expect(200);
    });

    it('leaves the people and role grants already there untouched', async () => {
      const before = await http()
        .get(`/users/${member.id}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(before.body).toMatchObject({
        orgUnitId: closing.id,
        roles: [{ code: 'department_manager', orgUnitId: closing.id }],
      });
      // Their role for the unit still lets them see what happened in it.
      await http()
        .get(`/incidents/${incidentId}`)
        .set('Cookie', member.cookie)
        .expect(200);

      // Their profile can be edited without moving them,
      const edited = await http()
        .patch(`/users/${member.id}`)
        .set('Cookie', a.cookie)
        .send({ name: { en: 'Test member' }, orgUnitId: closing.id })
        .expect(200);
      expect(edited.body).toMatchObject({ orgUnitId: closing.id });
      // and a role added next to the one they hold there,
      const grants = [
        { roleId: a.roles.department_manager, orgUnitId: closing.id },
        { roleId: a.roles.reporter, orgUnitId: null },
      ];
      const kept = await http()
        .put(`/users/${member.id}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: grants })
        .expect(200);
      expect(kept.body.roles).toHaveLength(2);
      // but not a new role for the unit that is off.
      await refused(
        await http()
          .put(`/users/${member.id}/roles`)
          .set('Cookie', a.cookie)
          .send({
            roles: [
              ...grants,
              { roleId: a.roles.reporter, orgUnitId: closing.id },
            ],
          }),
      );
      const after = await http()
        .get(`/users/${member.id}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(after.body.roles).toHaveLength(2);
    });

    it('can be chosen again once it is switched back on', async () => {
      await patch(a.cookie, closing.id, { active: true }).expect(200);
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(validReport(closing.id))
        .expect(201);
      await newUser({ orgUnitId: closing.id }).expect(201);
    });
  });

  describe('the audit log', () => {
    it('records who created and changed a unit, with no names', async () => {
      const top = await add('facility', 'AUDIT', null);
      const other = await add('facility', 'AUDIT-2', null);
      const dept = await add('department', 'AUDIT-D', top.id);
      await patch(a.cookie, dept.id, {
        name: { en: `${SECRET_NAME} renamed` },
      }).expect(200);
      await patch(a.cookie, dept.id, { parentId: other.id }).expect(200);
      await patch(a.cookie, dept.id, { active: false }).expect(200);
      await patch(a.cookie, dept.id, {
        name: { en: `${SECRET_NAME} again` },
        parentId: top.id,
        active: true,
      }).expect(200);

      const adminId = (
        await http().get('/auth/me').set('Cookie', a.cookie).expect(200)
      ).body.user.id;
      expect(await auditOf(top.id)).toEqual([
        {
          action: 'org_unit_created',
          actor_id: adminId,
          entity_type: 'org_unit',
          changes: { type: 'facility', parentId: null },
        },
      ]);
      const entry = (action: string, changes: Record<string, unknown>) => ({
        action,
        actor_id: adminId,
        entity_type: 'org_unit',
        changes,
      });
      const log = await auditOf(dept.id);
      expect(log.slice(0, 4)).toEqual([
        entry('org_unit_created', { type: 'department', parentId: top.id }),
        entry('org_unit_updated', { changed: ['name'] }),
        // A move is an action of its own.
        entry('org_unit_moved', { from: top.id, to: other.id }),
        entry('org_unit_updated', { changed: ['active'], active: false }),
      ]);
      // One change that moves, renames and switches on: the move apart from
      // the rest, both written at the same moment.
      expect(log).toHaveLength(6);
      expect(log.slice(4)).toEqual(
        expect.arrayContaining([
          entry('org_unit_moved', { from: other.id, to: top.id }),
          entry('org_unit_updated', {
            changed: ['name', 'active'],
            active: true,
          }),
        ]),
      );
    });

    it('has an entry for every unit created, and none holding a name', async () => {
      const { rows } = await owner.db.execute<{ missing: number }>(
        sql`select count(*)::int as missing from org_units u
            where u.tenant_id in (${a.id}, ${b.id}) and not exists (
              select from audit_log l
              where l.tenant_id = u.tenant_id and l.entity_id = u.id
                and l.entity_type = 'org_unit' and l.action = 'org_unit_created')`,
      );
      expect(rows[0].missing).toBe(0);
      const leaked = await owner.db.execute(
        sql`select 1 from audit_log
            where tenant_id in (${a.id}, ${b.id})
              and (changes::text like ${`%${SECRET_NAME}%`} or changes ? 'name')`,
      );
      expect(leaked.rows).toEqual([]);
    });

    it('records nothing for a refused change or one that changes nothing', async () => {
      const top = await add('facility', 'QUIET', null);
      const dept = await add('department', 'QUIET-D', top.id);
      await patch(a.cookie, top.id, { active: false }).expect(409);
      await patch(a.cookie, dept.id, { parentId: dept.id }).expect(400);
      await patch(reporter.cookie, dept.id, { active: false }).expect(403);
      // The same values it already has.
      const same = await patch(a.cookie, dept.id, {
        name: dept.name,
        parentId: top.id,
        active: true,
      }).expect(200);
      expect(same.body).toEqual(dept);
      expect((await auditOf(dept.id)).map((r) => r.action)).toEqual([
        'org_unit_created',
      ]);
      expect((await auditOf(top.id)).map((r) => r.action)).toEqual([
        'org_unit_created',
      ]);
      // A refused creation leaves nothing behind either.
      await create(a.cookie, {
        type: 'facility',
        code: 'QUIET',
        name: { en: 'Quiet again' },
      }).expect(409);
      const { rows } = await owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from org_units where tenant_id = ${a.id} and code = 'QUIET'`,
      );
      expect(rows[0].n).toBe(1);
    });
  });
});
