import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { setupApp } from '../../src/app.setup.js';
import { createDatabase } from '../../src/database/client.js';
import { orgUnits } from '../../src/database/schema.js';
import { requireEnv } from '../../src/env.js';
import { createPlatformAdmin } from '../../src/platform/create-admin.js';
import { removeTestData } from '../cleanup.js';

export type Hospital = {
  id: string;
  slug: string;
  /** The session of its first administrator. */
  cookie: string;
  adminId: string;
  roles: Record<string, string>;
  categories: Record<string, string>;
};

export type Staff = { id: string; email: string; name: string; cookie: string };

/**
 * What an end-to-end test of the hospital side needs: the application, a
 * signed-in member of Trustline staff to create hospitals with, and helpers
 * to people them. Everything is created through the API, under a prefix of
 * the run's own, and removed by `close()`.
 */
export async function testBench(tag: string, run: string) {
  const prefix = `${tag}-${run}`;
  const staffEmail = `staff-${tag}-${run}@test.invalid`;
  const staffPassword = `platform-pass-${run}`;
  const password = `hospital-pass-${run}`;
  // The owner role: to build the org unit tree, to move records in time and
  // to look at what was stored.
  const owner = createDatabase(requireEnv('DATABASE_URL'));

  await createPlatformAdmin({
    email: staffEmail,
    name: 'Staff',
    password: staffPassword,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app: INestApplication<App> = moduleRef.createNestApplication();
  setupApp(app);
  await app.init();
  const http = () => request(app.getHttpServer());

  const cookieOf = (res: request.Response) =>
    res.get('Set-Cookie')![0].split(';')[0];
  const login = (org: string, email: string) =>
    http().post('/auth/login').send({ org, email, password });

  const platform = cookieOf(
    await http()
      .post('/platform/auth/login')
      .send({ email: staffEmail, password: staffPassword })
      .expect(200),
  );

  /** Creates a hospital with its first administrator, signed in. */
  async function createHospital(
    suffix: string,
    settings: Record<string, unknown> = {},
  ): Promise<Hospital> {
    const slug = `${prefix}-${suffix}`;
    const adminEmail = `admin-${tag}-${suffix}-${run}@test.invalid`;
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
        ...settings,
      })
      .expect(201);
    const created = await http()
      .post(`/platform/tenants/${tenant.body.id}/administrators`)
      .set('Cookie', platform)
      .send({ name: { en: `Admin ${suffix}` }, email: adminEmail })
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
      adminId: created.body.user.id,
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
    hospital: Hospital,
    type: 'facility' | 'department' | 'unit',
    code: string,
    parentId: string | null,
  ) {
    const [unit] = await owner.db
      .insert(orgUnits)
      .values({
        tenantId: hospital.id,
        type,
        code,
        parentId,
        name: { en: `Unit ${code}` },
      })
      .returning({ id: orgUnits.id });
    return unit.id;
  }

  /** Adds a role of the hospital's own, with exactly these permissions. */
  async function createRole(
    hospital: Hospital,
    code: string,
    permissions: string[],
  ) {
    const role = await http()
      .post('/roles')
      .set('Cookie', hospital.cookie)
      .send({ code, name: { en: code }, permissions })
      .expect(201);
    hospital.roles[code] = role.body.id;
  }

  /**
   * Creates a user with one role (or none). Signed in, unless `signIn` is
   * false: then they stay invited and have never set a password.
   */
  async function createStaff(
    hospital: Hospital,
    name: string,
    grant: { role: string; orgUnitId: string | null } | null,
    { signIn = true } = {},
  ): Promise<Staff> {
    const email = `${name}-${tag}-${run}@test.invalid`;
    const created = await http()
      .post('/users')
      .set('Cookie', hospital.cookie)
      .send({
        name: { en: `Person ${name}` },
        email,
        roles: grant
          ? [{ roleId: hospital.roles[grant.role], orgUnitId: grant.orgUnitId }]
          : [],
      })
      .expect(201);
    const id = created.body.user.id as string;
    if (!signIn) return { id, email, name: `Person ${name}`, cookie: '' };
    await http()
      .post('/auth/invite/accept')
      .send({ org: hospital.slug, token: created.body.invite.token, password })
      .expect(204);
    const cookie = cookieOf(await login(hospital.slug, email).expect(200));
    return { id, email, name: `Person ${name}`, cookie };
  }

  async function close() {
    await removeTestData(prefix, staffEmail);
    await owner.pool.end();
    await app.close();
  }

  return {
    app,
    http,
    owner,
    platform,
    prefix,
    cookieOf,
    login,
    createHospital,
    createUnit,
    createRole,
    createStaff,
    close,
  };
}

export type TestBench = Awaited<ReturnType<typeof testBench>>;
