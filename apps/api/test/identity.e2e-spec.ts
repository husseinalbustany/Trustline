import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { createDatabase } from '../src/database/client.js';
import { auditLog } from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';
import { MAX_FAILED_ATTEMPTS } from '../src/identity/auth.service.js';
import { createPlatformAdmin } from '../src/platform/create-admin.js';
import { removeTestData } from './cleanup.js';

describe('hospital users, roles and sign-in', () => {
  const run = randomBytes(4).toString('hex');
  const prefix = `idt-${run}`;
  const staffEmail = `staff-${run}@test.invalid`;
  const staffPassword = `platform-pass-${run}`;
  const password = `hospital-pass-${run}`;
  let app: INestApplication<App>;
  let platform: string; // platform admin cookie
  const http = () => request(app.getHttpServer());

  type Hospital = {
    id: string;
    slug: string;
    adminEmail: string;
    cookie: string;
    roles: Record<string, string>;
  };
  let a: Hospital;
  let b: Hospital;

  const cookieOf = (res: request.Response) =>
    res.get('Set-Cookie')![0].split(';')[0];

  const login = (org: string, email: string, pw: string) =>
    http().post('/auth/login').send({ org, email, password: pw });

  async function createHospital(suffix: string): Promise<Hospital> {
    const slug = `${prefix}-${suffix}`;
    const adminEmail = `admin-${suffix}-${run}@test.invalid`;
    const tenant = await http()
      .post('/platform/tenants')
      .set('Cookie', platform)
      .send({
        slug,
        nameEn: `Hospital ${suffix}`,
        nameAr: `مستشفى ${suffix}`,
        accreditationStandard: 'JCI',
        defaultLocale: 'en',
        plan: 'professional',
        signInMethod: 'password',
        dataRegion: null,
      })
      .expect(201);
    const created = await http()
      .post(`/platform/tenants/${tenant.body.id}/administrators`)
      .set('Cookie', platform)
      .send({ nameEn: 'Admin', nameAr: 'مسؤول', email: adminEmail })
      .expect(201);
    await http()
      .post('/auth/invite/accept')
      .send({ org: slug, token: created.body.invite.token, password })
      .expect(204);
    const cookie = cookieOf(
      await login(slug, adminEmail, password).expect(200),
    );
    const list = await http().get('/roles').set('Cookie', cookie).expect(200);
    const roles = Object.fromEntries(
      list.body.roles.map((r: { code: string; id: string }) => [r.code, r.id]),
    );
    return { id: tenant.body.id, slug, adminEmail, cookie, roles };
  }

  /** Creates a user in hospital A, sets their password, and signs them in. */
  async function createStaff(name: string, roleCode: string) {
    const email = `${name}-${run}@test.invalid`;
    const created = await http()
      .post('/users')
      .set('Cookie', a.cookie)
      .send({
        nameEn: name,
        nameAr: name,
        email,
        roles: [{ roleId: a.roles[roleCode], orgUnitId: null }],
      })
      .expect(201);
    await http()
      .post('/auth/invite/accept')
      .send({ org: a.slug, token: created.body.invite.token, password })
      .expect(204);
    const cookie = cookieOf(await login(a.slug, email, password).expect(200));
    return { id: created.body.user.id as string, email, cookie };
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
    await app.init();
    platform = cookieOf(
      await http()
        .post('/platform/auth/login')
        .send({ email: staffEmail, password: staffPassword })
        .expect(200),
    );
    a = await createHospital('a');
    b = await createHospital('b');
  }, 60_000);

  afterAll(async () => {
    await removeTestData(prefix, staffEmail);
    await app.close();
  });

  describe('sign-in', () => {
    it('gives a new client the four built-in roles and a working administrator', async () => {
      expect(Object.keys(a.roles).sort()).toEqual([
        'administrator',
        'department_manager',
        'quality_officer',
        'reporter',
      ]);
      const me = await http()
        .get('/auth/me')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(me.body.tenant.slug).toBe(a.slug);
      expect(me.body.user.email).toBe(a.adminEmail);
      expect(me.body.permissions).toContain('users.manage');
    });

    it('sets a session cookie scripts cannot read', async () => {
      const res = await login(a.slug, a.adminEmail, password).expect(200);
      const [setCookie] = res.get('Set-Cookie')!;
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Strict/);
      expect(res.body).toEqual({ ok: true });
    });

    it('refuses every kind of bad sign-in the same way', async () => {
      const wrongPassword = await login(a.slug, a.adminEmail, 'wrong-password');
      const unknownEmail = await login(a.slug, 'nobody@test.invalid', password);
      const unknownOrg = await login('no-such-org', a.adminEmail, password);
      const otherOrg = await login(b.slug, a.adminEmail, password);
      for (const res of [wrongPassword, unknownEmail, unknownOrg, otherOrg]) {
        expect(res.status).toBe(401);
        expect(res.body).toEqual(wrongPassword.body);
      }
    });

    it('refuses protected routes without a session', async () => {
      await http().get('/auth/me').expect(401);
      await http().get('/users').expect(401);
      await http().get('/roles').expect(401);
      await http().get('/org-units').expect(401);
    });

    it('gives a mobile client a bearer token instead of a cookie', async () => {
      const res = await http()
        .post('/auth/login')
        .send({ org: a.slug, email: a.adminEmail, password, client: 'mobile' })
        .expect(200);
      expect(res.get('Set-Cookie')).toBeUndefined();
      await http()
        .get('/auth/me')
        .set('Authorization', `Bearer ${res.body.token}`)
        .expect(200);
    });

    it('ends the session on sign-out', async () => {
      const cookie = cookieOf(await login(a.slug, a.adminEmail, password));
      await http().post('/auth/logout').set('Cookie', cookie).expect(204);
      await http().get('/auth/me').set('Cookie', cookie).expect(401);
    });

    it('locks the account after repeated wrong passwords', async () => {
      const staff = await createStaff('locked', 'reporter');
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        await login(a.slug, staff.email, 'wrong-password').expect(401);
      }
      await login(a.slug, staff.email, password).expect(401);
    }, 30_000);
  });

  describe('set-password links', () => {
    it('work once, need a long enough password, and name who they are for', async () => {
      const created = await http()
        .post('/users')
        .set('Cookie', a.cookie)
        .send({
          nameEn: 'Invited',
          nameAr: 'مدعو',
          email: `invited-${run}@test.invalid`,
          roles: [],
        })
        .expect(201);
      const link = { org: a.slug, token: created.body.invite.token };
      expect(created.body.user.status).toBe('invited');

      const info = await http()
        .post('/auth/invite/check')
        .send(link)
        .expect(200);
      expect(info.body).toMatchObject({
        nameEn: 'Invited',
        organizationEn: 'Hospital a',
      });

      await login(a.slug, created.body.user.email, password).expect(401);
      await http()
        .post('/auth/invite/accept')
        .send({ ...link, password: 'short' })
        .expect(400);
      await http()
        .post('/auth/invite/accept')
        .send({ ...link, org: b.slug, password })
        .expect(404);
      await http()
        .post('/auth/invite/accept')
        .send({ ...link, password })
        .expect(204);
      await http()
        .post('/auth/invite/accept')
        .send({ ...link, password })
        .expect(404);
      await http().post('/auth/invite/check').send(link).expect(404);
      await login(a.slug, created.body.user.email, password).expect(200);
    });

    it('reset a password and end the sessions that used the old one', async () => {
      const staff = await createStaff('reset', 'reporter');
      const link = await http()
        .post(`/users/${staff.id}/invite`)
        .set('Cookie', a.cookie)
        .expect(201);
      const newPassword = `${password}-new`;
      await http()
        .post('/auth/invite/accept')
        .send({ org: a.slug, token: link.body.token, password: newPassword })
        .expect(204);
      await http().get('/auth/me').set('Cookie', staff.cookie).expect(401);
      await login(a.slug, staff.email, password).expect(401);
      await login(a.slug, staff.email, newPassword).expect(200);
    });
  });

  describe('permissions', () => {
    it('lets a reporter in, but not into user or role management', async () => {
      const reporter = await createStaff('reporter', 'reporter');
      const me = await http().get('/auth/me').set('Cookie', reporter.cookie);
      expect(me.body.permissions).toEqual([
        'incidents.report',
        'policies.view',
      ]);
      await http().get('/org-units').set('Cookie', reporter.cookie).expect(200);
      await http().get('/users').set('Cookie', reporter.cookie).expect(403);
      await http().get('/roles').set('Cookie', reporter.cookie).expect(403);
      await http()
        .post('/users')
        .set('Cookie', reporter.cookie)
        .send({
          nameEn: 'X',
          nameAr: 'X',
          email: `x-${run}@test.invalid`,
          roles: [],
        })
        .expect(403);
      await http()
        .put(`/users/${reporter.id}/roles`)
        .set('Cookie', reporter.cookie)
        .send({ roles: [{ roleId: a.roles.administrator, orgUnitId: null }] })
        .expect(403);
    });

    it('changes what a user can do when their roles change', async () => {
      const staff = await createStaff('promoted', 'reporter');
      await http().get('/users').set('Cookie', staff.cookie).expect(403);
      await http()
        .put(`/users/${staff.id}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [{ roleId: a.roles.administrator, orgUnitId: null }] })
        .expect(200);
      await http().get('/users').set('Cookie', staff.cookie).expect(200);
    });

    it('does not let anyone change their own roles or status', async () => {
      const me = await http().get('/auth/me').set('Cookie', a.cookie);
      const self = `/users/${me.body.user.id}`;
      await http()
        .put(`${self}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [] })
        .expect(409);
      await http()
        .patch(self)
        .set('Cookie', a.cookie)
        .send({ status: 'disabled' })
        .expect(409);
    });

    it('creates, edits and deletes a custom role, and protects built-in ones', async () => {
      const role = await http()
        .post('/roles')
        .set('Cookie', a.cookie)
        .send({
          code: 'policy_author',
          nameEn: 'Policy author',
          nameAr: 'محرر السياسات',
          permissions: ['policies.view', 'policies.manage'],
        })
        .expect(201);
      await http()
        .post('/roles')
        .set('Cookie', a.cookie)
        .send({
          code: 'bad',
          nameEn: 'Bad',
          nameAr: 'Bad',
          permissions: ['everything'],
        })
        .expect(400);
      const edited = await http()
        .patch(`/roles/${role.body.id}`)
        .set('Cookie', a.cookie)
        .send({ permissions: ['policies.view'] })
        .expect(200);
      expect(edited.body.permissions).toEqual(['policies.view']);

      a.roles.policy_author = role.body.id;
      const staff = await createStaff('author', 'policy_author');
      await http()
        .delete(`/roles/${role.body.id}`)
        .set('Cookie', a.cookie)
        .expect(409);
      await http()
        .put(`/users/${staff.id}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [] })
        .expect(200);
      await http()
        .delete(`/roles/${role.body.id}`)
        .set('Cookie', a.cookie)
        .expect(204);

      await http()
        .patch(`/roles/${a.roles.reporter}`)
        .set('Cookie', a.cookie)
        .send({ permissions: ['users.manage'] })
        .expect(409);
      await http()
        .delete(`/roles/${a.roles.reporter}`)
        .set('Cookie', a.cookie)
        .expect(409);
    });
  });

  describe('users', () => {
    it('refuses a duplicate email in one hospital, allows it in another', async () => {
      const email = `shared-${run}@test.invalid`;
      const body = { nameEn: 'Shared', nameAr: 'مشترك', email, roles: [] };
      await http()
        .post('/users')
        .set('Cookie', a.cookie)
        .send(body)
        .expect(201);
      const dup = await http()
        .post('/users')
        .set('Cookie', a.cookie)
        .send(body);
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('email_taken');
      await http()
        .post('/users')
        .set('Cookie', b.cookie)
        .send(body)
        .expect(201);
    });

    it('signs a disabled user out and keeps them out', async () => {
      const staff = await createStaff('leaver', 'reporter');
      await http()
        .patch(`/users/${staff.id}`)
        .set('Cookie', a.cookie)
        .send({ status: 'disabled' })
        .expect(200);
      await http().get('/auth/me').set('Cookie', staff.cookie).expect(401);
      await login(a.slug, staff.email, password).expect(401);
      await http()
        .post(`/users/${staff.id}/invite`)
        .set('Cookie', a.cookie)
        .expect(409);
    });

    it('never returns password hashes', async () => {
      const list = await http()
        .get('/users')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(list.body.length).toBeGreaterThan(1);
      expect(JSON.stringify(list.body)).not.toMatch(/password|scrypt/i);
    });
  });

  describe('separation between hospitals', () => {
    it("shows an administrator only their own hospital's users", async () => {
      const mine = await http()
        .get('/users')
        .set('Cookie', a.cookie)
        .expect(200);
      const emails = mine.body.map((u: { email: string }) => u.email);
      expect(emails).toContain(a.adminEmail);
      expect(emails).not.toContain(b.adminEmail);
    });

    it('cannot read, edit or grant roles across hospitals', async () => {
      const theirs = await http().get('/users').set('Cookie', b.cookie);
      const other = theirs.body[0].id;
      await http().get(`/users/${other}`).set('Cookie', a.cookie).expect(404);
      await http()
        .patch(`/users/${other}`)
        .set('Cookie', a.cookie)
        .send({ nameEn: 'Hijacked' })
        .expect(404);
      await http()
        .post(`/users/${other}/invite`)
        .set('Cookie', a.cookie)
        .expect(404);

      // Another hospital's role cannot be granted here.
      const staff = await createStaff('crossrole', 'reporter');
      await http()
        .put(`/users/${staff.id}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [{ roleId: b.roles.administrator, orgUnitId: null }] })
        .expect(400);
      await http().get('/users').set('Cookie', staff.cookie).expect(403);
    });
  });

  describe('client status', () => {
    const setClient = (id: string, body: object) =>
      http()
        .patch(`/platform/tenants/${id}`)
        .set('Cookie', platform)
        .send(body);

    it('shuts out a suspended client, and lets it back in when reactivated', async () => {
      await setClient(b.id, { status: 'suspended' }).expect(200);
      await http().get('/auth/me').set('Cookie', b.cookie).expect(401);
      await login(b.slug, b.adminEmail, password).expect(401);
      await setClient(b.id, { status: 'active' }).expect(200);
      await http().get('/auth/me').set('Cookie', b.cookie).expect(200);
    });

    it('refuses password sign-in for a client set to single sign-on only', async () => {
      await setClient(b.id, { signInMethod: 'sso' }).expect(200);
      await login(b.slug, b.adminEmail, password).expect(401);
      await setClient(b.id, { signInMethod: 'password' }).expect(200);
      await login(b.slug, b.adminEmail, password).expect(200);
    });
  });

  describe('audit log', () => {
    const owner = createDatabase(requireEnv('DATABASE_URL'));
    const tenantApp = createDatabase(requireEnv('APP_DATABASE_URL'));
    afterAll(() => Promise.all([owner.pool.end(), tenantApp.pool.end()]));

    it('records sign-ins and account changes', async () => {
      const { rows } = await owner.db.execute<{ action: string }>(
        sql`select distinct action from audit_log where tenant_id = ${a.id}`,
      );
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'sign_in',
          'sign_in_failed',
          'sign_out',
          'user_created',
          'user_updated',
          'user_roles_changed',
          'password_set',
          'role_created',
        ]),
      );
    });

    it('cannot be changed or deleted by the application', async () => {
      const scoped = (stmt: 'update' | 'delete') =>
        tenantApp.db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${a.id}, true)`,
          );
          if (stmt === 'update') await tx.update(auditLog).set({ action: 'x' });
          else await tx.delete(auditLog);
        });
      await expect(scoped('update')).rejects.toThrow();
      await expect(scoped('delete')).rejects.toThrow();
    });
  });
});
