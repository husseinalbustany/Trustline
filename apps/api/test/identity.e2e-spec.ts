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
        name: { en: `Hospital ${suffix}`, ar: `مستشفى ${suffix}` },
        accreditationStandard: 'JCI',
        locales: ['en', 'ar'],
        defaultLocale: 'en',
        signInMethod: 'password',
        dataRegion: null,
      })
      .expect(201);
    const created = await http()
      .post(`/platform/tenants/${tenant.body.id}/administrators`)
      .set('Cookie', platform)
      .send({ name: { en: 'Admin', ar: 'مسؤول' }, email: adminEmail })
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
        name: { en: name, ar: name },
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
      // The report form preselects the user's own unit from this.
      expect(me.body.user).toHaveProperty('orgUnitId', null);
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
          name: { en: 'Invited', ar: 'مدعو' },
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
        name: { en: 'Invited', ar: 'مدعو' },
        organization: { en: 'Hospital a', ar: 'مستشفى a' },
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
          name: { en: 'X', ar: 'X' },
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
          name: { en: 'Policy author', ar: 'محرر السياسات' },
          permissions: ['policies.view', 'policies.manage'],
        })
        .expect(201);
      await http()
        .post('/roles')
        .set('Cookie', a.cookie)
        .send({
          code: 'bad',
          name: { en: 'Bad', ar: 'Bad' },
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

  describe("no one can raise access, their own or anyone else's", () => {
    /** A custom role with exactly these permissions, and a user holding it. */
    async function staffWith(name: string, permissions: string[]) {
      const role = await http()
        .post('/roles')
        .set('Cookie', a.cookie)
        .send({
          code: `${name}_role`,
          name: { en: name, ar: name },
          permissions,
        })
        .expect(201);
      a.roles[`${name}_role`] = role.body.id;
      return {
        ...(await createStaff(name, `${name}_role`)),
        roleId: role.body.id,
      };
    }
    const adminGrant = () => [
      { roleId: a.roles.administrator, orgUnitId: null },
    ];

    it('a user manager cannot create, promote or take over an administrator', async () => {
      const manager = await staffWith('usermgr', ['users.manage']);
      const me = await http().get('/auth/me').set('Cookie', a.cookie);
      const adminId = me.body.user.id;

      // Cannot mint a new administrator.
      const created = await http()
        .post('/users')
        .set('Cookie', manager.cookie)
        .send({
          name: { en: 'Sneak', ar: 'Sneak' },
          email: `sneak-${run}@test.invalid`,
          roles: adminGrant(),
        });
      expect(created.status).toBe(403);
      expect(created.body.code).toBe('cannot_grant_higher_access');

      // Cannot promote someone else.
      const other = await createStaff('bystander', 'reporter');
      await http()
        .put(`/users/${other.id}/roles`)
        .set('Cookie', manager.cookie)
        .send({ roles: adminGrant() })
        .expect(403);

      // Cannot get a reset link for, strip, or disable the administrator.
      const link = await http()
        .post(`/users/${adminId}/invite`)
        .set('Cookie', manager.cookie);
      expect(link.status).toBe(403);
      expect(link.body.code).toBe('cannot_manage_higher_access');
      expect(link.body.token).toBeUndefined();
      await http()
        .put(`/users/${adminId}/roles`)
        .set('Cookie', manager.cookie)
        .send({ roles: [] })
        .expect(403);
      await http()
        .patch(`/users/${adminId}`)
        .set('Cookie', manager.cookie)
        .send({ status: 'disabled' })
        .expect(403);

      // Can still do the ordinary job: add a user with a role they may give.
      await http()
        .post('/users')
        .set('Cookie', manager.cookie)
        .send({
          name: { en: 'New', ar: 'New' },
          email: `new-${run}@test.invalid`,
          roles: [{ roleId: manager.roleId, orgUnitId: null }],
        })
        .expect(201);
      await http()
        .post(`/users/${other.id}/invite`)
        .set('Cookie', manager.cookie)
        .expect(403);
      const equal = await createStaff('peer', 'usermgr_role');
      await http()
        .post(`/users/${equal.id}/invite`)
        .set('Cookie', manager.cookie)
        .expect(201);
    });

    it('a role manager cannot widen a role they hold, or build one beyond their own access', async () => {
      const manager = await staffWith('rolemgr', ['roles.manage']);

      const own = await http()
        .patch(`/roles/${manager.roleId}`)
        .set('Cookie', manager.cookie)
        .send({ permissions: ['roles.manage', 'users.manage'] });
      expect(own.status).toBe(403);
      // Even with permissions they already have, their own role is off limits.
      const ownSame = await http()
        .patch(`/roles/${manager.roleId}`)
        .set('Cookie', manager.cookie)
        .send({ name: { en: 'Renamed' } });
      expect(ownSame.status).toBe(409);
      expect(ownSame.body.code).toBe('cannot_change_own_role');
      await http()
        .delete(`/roles/${manager.roleId}`)
        .set('Cookie', manager.cookie)
        .expect(409);

      const beyond = await http()
        .post('/roles')
        .set('Cookie', manager.cookie)
        .send({
          code: 'beyond_me',
          name: { en: 'Beyond', ar: 'Beyond' },
          permissions: ['users.manage'],
        });
      expect(beyond.status).toBe(403);
      expect(beyond.body.code).toBe('cannot_grant_higher_access');

      const within = await http()
        .post('/roles')
        .set('Cookie', manager.cookie)
        .send({
          code: 'within_me',
          name: { en: 'Within', ar: 'Within' },
          permissions: ['roles.manage'],
        })
        .expect(201);
      await http()
        .patch(`/roles/${within.body.id}`)
        .set('Cookie', manager.cookie)
        .send({ permissions: ['roles.manage', 'settings.manage'] })
        .expect(403);

      const me = await http().get('/auth/me').set('Cookie', manager.cookie);
      expect(me.body.permissions).toEqual(['roles.manage']);
    });

    it('the admin portal can create only the first administrator, and the hospital log says who did', async () => {
      const again = await http()
        .post(`/platform/tenants/${a.id}/administrators`)
        .set('Cookie', platform)
        .send({
          name: { en: 'Second', ar: 'Second' },
          email: `second-${run}@test.invalid`,
        });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('administrator_exists');
      expect(again.body.invite).toBeUndefined();

      const list = await http().get('/users').set('Cookie', a.cookie);
      expect(list.body.map((u: { email: string }) => u.email)).not.toContain(
        `second-${run}@test.invalid`,
      );

      const owner = createDatabase(requireEnv('DATABASE_URL'));
      const { rows } = await owner.db.execute<{
        changes: { platformAdminEmail: string };
      }>(
        sql`select changes from audit_log where tenant_id = ${a.id} and action = 'administrator_created_by_platform'`,
      );
      await owner.pool.end();
      expect(rows).toHaveLength(1);
      expect(rows[0].changes.platformAdminEmail).toBe(staffEmail);
    });
  });

  describe('a user manager for one department', () => {
    let ward: string;
    let lab: string;
    let wardManager: { id: string; cookie: string };
    let colleague: string; // a reporter of the ward
    let everywhere: string; // sits in the ward, reports for the whole hospital
    const email = (name: string) => `${name}-${run}@test.invalid`;

    const addUnit = async (type: string, code: string, parentId?: string) =>
      (
        await http()
          .post('/org-units')
          .set('Cookie', a.cookie)
          .send({ type, code, name: { en: code }, parentId })
          .expect(201)
      ).body.id as string;

    const addUser = (cookie: string, name: string, body: object) =>
      http()
        .post('/users')
        .set('Cookie', cookie)
        .send({ name: { en: name, ar: name }, email: email(name), ...body });

    beforeAll(async () => {
      const site = await addUnit('facility', 'SCOPE');
      ward = await addUnit('department', 'SCOPE-WARD', site);
      lab = await addUnit('department', 'SCOPE-LAB', site);
      const role = await http()
        .post('/roles')
        .set('Cookie', a.cookie)
        .send({
          code: 'ward_admin',
          name: { en: 'Ward admin', ar: 'Ward admin' },
          permissions: [
            'users.manage',
            'roles.manage',
            'incidents.report',
            'policies.view',
          ],
        })
        .expect(201);
      const created = await addUser(a.cookie, 'wardmgr', {
        orgUnitId: ward,
        roles: [{ roleId: role.body.id, orgUnitId: ward }],
      }).expect(201);
      await http()
        .post('/auth/invite/accept')
        .send({ org: a.slug, token: created.body.invite.token, password })
        .expect(204);
      wardManager = {
        id: created.body.user.id,
        cookie: cookieOf(
          await login(a.slug, email('wardmgr'), password).expect(200),
        ),
      };
      const me = await http()
        .get('/auth/me')
        .set('Cookie', wardManager.cookie)
        .expect(200);
      expect(me.body.user.orgUnitId).toBe(ward);
      const reporterAt = async (name: string, orgUnitId: string | null) =>
        (
          await addUser(a.cookie, name, {
            orgUnitId: ward,
            roles: [{ roleId: a.roles.reporter, orgUnitId }],
          }).expect(201)
        ).body.user.id as string;
      colleague = await reporterAt('wardcolleague', ward);
      everywhere = await reporterAt('wardeverywhere', null);
    });

    it('cannot create a user with a role for the whole organization', async () => {
      const res = await addUser(wardManager.cookie, 'wide', {
        orgUnitId: ward,
        roles: [{ roleId: a.roles.reporter, orgUnitId: null }],
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('cannot_grant_higher_access');
      // Nor one for another department.
      const other = await addUser(wardManager.cookie, 'wide', {
        orgUnitId: ward,
        roles: [{ roleId: a.roles.reporter, orgUnitId: lab }],
      });
      expect(other.status).toBe(403);
      const list = await http().get('/users').set('Cookie', a.cookie);
      expect(list.body.map((u: { email: string }) => u.email)).not.toContain(
        email('wide'),
      );
    });

    it("cannot widen someone's role to the whole organization", async () => {
      const res = await http()
        .put(`/users/${colleague}/roles`)
        .set('Cookie', wardManager.cookie)
        .send({ roles: [{ roleId: a.roles.reporter, orgUnitId: null }] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('cannot_grant_higher_access');
      const stored = await http()
        .get(`/users/${colleague}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(stored.body.roles).toEqual([
        expect.objectContaining({ code: 'reporter', orgUnitId: ward }),
      ]);
    });

    it('cannot get a reset link for, edit or re-role someone with wider access', async () => {
      const me = await http().get('/auth/me').set('Cookie', a.cookie);
      for (const target of [everywhere, me.body.user.id as string]) {
        const link = await http()
          .post(`/users/${target}/invite`)
          .set('Cookie', wardManager.cookie);
        expect(link.status).toBe(403);
        expect(link.body.token).toBeUndefined();
      }
      const link = await http()
        .post(`/users/${everywhere}/invite`)
        .set('Cookie', wardManager.cookie);
      expect(link.body.code).toBe('cannot_manage_higher_access');
      const edit = await http()
        .patch(`/users/${everywhere}`)
        .set('Cookie', wardManager.cookie)
        .send({ status: 'disabled' });
      expect(edit.status).toBe(403);
      expect(edit.body.code).toBe('cannot_manage_higher_access');
      const strip = await http()
        .put(`/users/${everywhere}/roles`)
        .set('Cookie', wardManager.cookie)
        .send({ roles: [] });
      expect(strip.status).toBe(403);
    });

    it('cannot place or manage anyone outside the department', async () => {
      for (const orgUnitId of [lab, null]) {
        const res = await addUser(wardManager.cookie, 'outside', {
          orgUnitId,
          roles: [],
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('outside_scope');
      }
      const outsider = await addUser(a.cookie, 'labperson', {
        orgUnitId: lab,
        roles: [],
      }).expect(201);
      const link = await http()
        .post(`/users/${outsider.body.user.id}/invite`)
        .set('Cookie', wardManager.cookie);
      expect(link.status).toBe(403);
      expect(link.body.code).toBe('outside_scope');
      const moved = await http()
        .patch(`/users/${colleague}`)
        .set('Cookie', wardManager.cookie)
        .send({ orgUnitId: lab });
      expect(moved.status).toBe(403);
      expect(moved.body.code).toBe('outside_scope');
    });

    it('cannot write roles, which belong to the whole hospital', async () => {
      const res = await http()
        .post('/roles')
        .set('Cookie', wardManager.cookie)
        .send({
          code: 'ward_made',
          name: { en: 'Ward made', ar: 'Ward made' },
          permissions: ['policies.view'],
        });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('missing_permission');
      await http()
        .patch(`/roles/${a.roles.policy_author ?? a.roles.reporter}`)
        .set('Cookie', wardManager.cookie)
        .send({ name: { en: 'Renamed' } })
        .expect(403);
      // Reading the list, to assign roles, stays open to them.
      await http().get('/roles').set('Cookie', wardManager.cookie).expect(200);
    });

    it('can still add a reporter for the ward and reset a ward colleague', async () => {
      const added = await addUser(wardManager.cookie, 'wardnew', {
        orgUnitId: ward,
        roles: [{ roleId: a.roles.reporter, orgUnitId: ward }],
      }).expect(201);
      expect(added.body.user).toMatchObject({
        orgUnitId: ward,
        orgUnit: {
          id: ward,
          type: 'department',
          name: { en: 'SCOPE-WARD' },
          active: true,
        },
        roles: [
          {
            code: 'reporter',
            orgUnitId: ward,
            orgUnit: {
              id: ward,
              type: 'department',
              name: { en: 'SCOPE-WARD' },
              active: true,
            },
          },
        ],
      });
      // The unit comes with its type wherever a user or a grant names it:
      // on the answer to creating, on one user, and in the list.
      const wardUnit = {
        id: ward,
        type: 'department',
        name: { en: 'SCOPE-WARD' },
        active: true,
      };
      const one = await http()
        .get(`/users/${added.body.user.id}`)
        .set('Cookie', a.cookie)
        .expect(200);
      const all = await http()
        .get('/users')
        .set('Cookie', a.cookie)
        .expect(200);
      const listed = all.body.find(
        (u: { id: string }) => u.id === added.body.user.id,
      );
      for (const user of [added.body.user, one.body, listed]) {
        expect(user.orgUnit).toEqual(wardUnit);
        expect(user.roles.map((r: { orgUnit: unknown }) => r.orgUnit)).toEqual([
          wardUnit,
        ]);
      }
      // A facility is told apart from a department the same way.
      const units = await http()
        .get('/org-units')
        .set('Cookie', a.cookie)
        .expect(200);
      const site = units.body.find((u: { code: string }) => u.code === 'SCOPE');
      const placed = await addUser(a.cookie, 'typed', {
        orgUnitId: site.id,
        roles: [
          { roleId: a.roles.reporter, orgUnitId: site.id },
          { roleId: a.roles.reporter, orgUnitId: null },
        ],
      }).expect(201);
      expect(placed.body.user.orgUnit).toEqual({
        id: site.id,
        type: 'facility',
        name: { en: 'SCOPE' },
        active: true,
      });
      expect(
        placed.body.user.roles
          .map((r: { orgUnit: { type: string } | null }) => r.orgUnit?.type)
          .sort(),
      ).toEqual(['facility', undefined]);

      const link = await http()
        .post(`/users/${colleague}/invite`)
        .set('Cookie', wardManager.cookie)
        .expect(201);
      expect(link.body.token).toBeTruthy();
      await http()
        .patch(`/users/${colleague}`)
        .set('Cookie', wardManager.cookie)
        .send({ jobTitle: 'Nurse' })
        .expect(200);
    });

    it('leaves a whole-organization administrator unaffected', async () => {
      const widened = await http()
        .put(`/users/${colleague}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [{ roleId: a.roles.reporter, orgUnitId: null }] })
        .expect(200);
      expect(widened.body.roles).toEqual([
        expect.objectContaining({ orgUnitId: null, orgUnit: null }),
      ]);
      await http()
        .post(`/users/${everywhere}/invite`)
        .set('Cookie', a.cookie)
        .expect(201);
      await http()
        .patch(`/users/${everywhere}`)
        .set('Cookie', a.cookie)
        .send({ orgUnitId: null })
        .expect(200);
    });

    it('shows the last sign-in as a day, and a unit switched off as such', async () => {
      const list = await http()
        .get('/users')
        .set('Cookie', a.cookie)
        .expect(200);
      const admin = list.body.find(
        (u: { email: string }) => u.email === a.adminEmail,
      );
      expect(admin.lastSignInAt).toBe(new Date().toISOString().slice(0, 10));
      expect(admin.orgUnit).toBeNull();
      const one = await http()
        .get(`/users/${wardManager.id}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(one.body.lastSignInAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const never = list.body.find(
        (u: { email: string }) => u.email === email('labperson'),
      );
      expect(never.lastSignInAt).toBeNull();

      await http()
        .patch(`/org-units/${lab}`)
        .set('Cookie', a.cookie)
        .send({ active: false })
        .expect(200);
      const after = await http()
        .get(`/users/${never.id}`)
        .set('Cookie', a.cookie)
        .expect(200);
      expect(after.body).toMatchObject({
        orgUnitId: lab,
        orgUnit: { id: lab, active: false },
      });
    });

    it('records only what an edit changed, and nothing for one that changed nothing', async () => {
      const owner = createDatabase(requireEnv('DATABASE_URL'));
      const log = async () =>
        (
          await owner.db.execute<{ changes: Record<string, unknown> }>(
            sql`select changes from audit_log where tenant_id = ${a.id} and entity_id = ${colleague} and action = 'user_updated' order by occurred_at`,
          )
        ).rows.map((r) => r.changes);
      const patch = (body: object) =>
        http()
          .patch(`/users/${colleague}`)
          .set('Cookie', a.cookie)
          .send(body)
          .expect(200);
      try {
        const before = (await log()).length;
        const current = await http()
          .get(`/users/${colleague}`)
          .set('Cookie', a.cookie)
          .expect(200);
        // The whole form, as the screen sends it, with nothing altered.
        const same = await patch({
          name: current.body.name,
          orgUnitId: current.body.orgUnitId,
          jobTitle: current.body.jobTitle,
          phone: current.body.phone,
          employeeNumber: current.body.employeeNumber,
        });
        expect(same.body.orgUnitId).toBe(ward);
        expect(await log()).toHaveLength(before);

        // One field alone leaves the rest, the unit included, where it was.
        const titled = await patch({ jobTitle: 'Senior nurse' });
        expect(titled.body).toMatchObject({ orgUnitId: ward });
        await patch({
          name: current.body.name,
          orgUnitId: null,
          jobTitle: 'Senior nurse',
          status: 'disabled',
        });
        expect((await log()).slice(before)).toEqual([
          { changed: ['jobTitle'] },
          {
            changed: ['orgUnitId', 'status'],
            orgUnitId: { from: ward, to: null },
            status: { from: 'invited', to: 'disabled' },
          },
        ]);
      } finally {
        await owner.pool.end();
      }
    });
  });

  describe('languages', () => {
    it('a client can work in French only, with no English or Arabic text', async () => {
      const slug = `${prefix}-fr`;
      const tenant = await http()
        .post('/platform/tenants')
        .set('Cookie', platform)
        .send({
          slug,
          name: { fr: 'Hôpital Sainte-Marie' },
          locales: ['fr'],
          defaultLocale: 'fr',
          accreditationStandard: 'JCI',
          signInMethod: 'password',
          dataRegion: null,
        })
        .expect(201);
      expect(tenant.body.name).toEqual({ fr: 'Hôpital Sainte-Marie' });

      const created = await http()
        .post(`/platform/tenants/${tenant.body.id}/administrators`)
        .set('Cookie', platform)
        .send({
          name: { fr: 'Élise Martin' },
          email: `elise-${run}@test.invalid`,
        })
        .expect(201);
      const link = { org: slug, token: created.body.invite.token };
      const info = await http()
        .post('/auth/invite/check')
        .send(link)
        .expect(200);
      expect(info.body).toMatchObject({
        name: { fr: 'Élise Martin' },
        organization: { fr: 'Hôpital Sainte-Marie' },
        defaultLocale: 'fr',
      });
      await http()
        .post('/auth/invite/accept')
        .send({ ...link, password })
        .expect(204);
      const cookie = cookieOf(
        await login(slug, `elise-${run}@test.invalid`, password).expect(200),
      );

      const me = await http().get('/auth/me').set('Cookie', cookie).expect(200);
      expect(me.body.tenant).toMatchObject({
        locales: ['fr'],
        defaultLocale: 'fr',
      });

      // The built-in roles arrive already named in French.
      const list = await http().get('/roles').set('Cookie', cookie).expect(200);
      const reporter = list.body.roles.find(
        (r: { code: string }) => r.code === 'reporter',
      );
      expect(reporter.name.fr).toBe('Déclarant');
      expect(reporter.description.fr).toBe(
        'Déclare les incidents et lit les politiques.',
      );

      // Text must be in the client's languages, and in its default language.
      const add = (name: object) =>
        http()
          .post('/users')
          .set('Cookie', cookie)
          .send({
            name,
            email: `u${Math.random().toString(36).slice(2)}-${run}@test.invalid`,
            roles: [],
          });
      await add({ fr: 'Jean Dupont' }).expect(201);
      const english = await add({ en: 'John Smith' });
      expect(english.status).toBe(400);
      expect(english.body.code).toBe('language_mismatch');
      await add({ fr: 'Jean', en: 'John' }).expect(400);
      await add({ de: 'Hans' }).expect(400);
      await add({}).expect(400);
    });

    it('a client can add a language later, and must keep its default among them', async () => {
      const setClient = (body: object) =>
        http()
          .patch(`/platform/tenants/${a.id}`)
          .set('Cookie', platform)
          .send(body);
      // The default language cannot be one the client does not use.
      await setClient({ defaultLocale: 'fr' }).expect(400);
      // Nor can a language be dropped while the client's name is written in it.
      await setClient({ locales: ['en'] }).expect(400);

      const widened = await setClient({ locales: ['en', 'ar', 'fr'] }).expect(
        200,
      );
      expect(widened.body.locales).toEqual(['en', 'ar', 'fr']);
      const named = await setClient({
        name: { en: 'Hospital a', ar: 'مستشفى a', fr: 'Hôpital a' },
      }).expect(200);
      expect(named.body.name.fr).toBe('Hôpital a');

      const staff = await http()
        .post('/users')
        .set('Cookie', a.cookie)
        .send({
          name: { en: 'Marie Curie', fr: 'Marie Curie', ar: 'ماري كوري' },
          email: `marie-${run}@test.invalid`,
          roles: [],
        })
        .expect(201);
      expect(Object.keys(staff.body.user.name).sort()).toEqual([
        'ar',
        'en',
        'fr',
      ]);
      await setClient({
        locales: ['en', 'ar'],
        name: { en: 'Hospital a', ar: 'مستشفى a' },
      }).expect(200);
    });
  });

  describe('hardening', () => {
    it('treats a malformed cookie as no session, not a server error', async () => {
      await http()
        .get('/auth/me')
        .set('Cookie', 'tl_session=%E0%A4%A')
        .expect(401);
      await http()
        .get('/platform/auth/me')
        .set('Cookie', 'tl_platform_session=%')
        .expect(401);
    });

    it('accepts JSON bodies only', async () => {
      await http()
        .post('/auth/login')
        .type('form')
        .send({ org: a.slug, email: a.adminEmail, password })
        .expect(415);
    });

    it('a link issued before a user was disabled stays dead after they are enabled', async () => {
      const staff = await createStaff('paused', 'reporter');
      const link = await http()
        .post(`/users/${staff.id}/invite`)
        .set('Cookie', a.cookie)
        .expect(201);
      const body = { org: a.slug, token: link.body.token };
      await http().post('/auth/invite/check').send(body).expect(200);
      await http()
        .patch(`/users/${staff.id}`)
        .set('Cookie', a.cookie)
        .send({ status: 'disabled' })
        .expect(200);
      await http()
        .patch(`/users/${staff.id}`)
        .set('Cookie', a.cookie)
        .send({ status: 'active' })
        .expect(200);
      await http().post('/auth/invite/check').send(body).expect(404);
    });

    it('a one-time link sets a password once, even when used twice at the same moment', async () => {
      const created = await http()
        .post('/users')
        .set('Cookie', a.cookie)
        .send({
          name: { en: 'Twice', ar: 'Twice' },
          email: `twice-${run}@test.invalid`,
          roles: [],
        })
        .expect(201);
      const body = { org: a.slug, token: created.body.invite.token, password };
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => http().post('/auth/invite/accept').send(body)),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        204, 404, 404, 404,
      ]);
    });

    it('stores the same role grant once', async () => {
      const grant = { roleId: a.roles.reporter, orgUnitId: null };
      const created = await http()
        .post('/users')
        .set('Cookie', a.cookie)
        .send({
          name: { en: 'Dup', ar: 'Dup' },
          email: `dup-${run}@test.invalid`,
          roles: [grant, grant],
        })
        .expect(201);
      expect(created.body.user.roles).toHaveLength(1);
    });

    it("records the caller's address, taken from the trusted proxy only", async () => {
      await http()
        .post('/auth/login')
        .set('X-Forwarded-For', '198.51.100.7, 203.0.113.9')
        .send({ org: a.slug, email: a.adminEmail, password })
        .expect(200);
      const owner = createDatabase(requireEnv('DATABASE_URL'));
      const { rows } = await owner.db.execute<{ ip_address: string }>(
        sql`select ip_address from audit_log where tenant_id = ${a.id} and action = 'sign_in' order by occurred_at desc limit 1`,
      );
      await owner.pool.end();
      // One trusted hop: the last address in the list, which the web app
      // wrote, not the first, which the caller could have made up.
      expect(rows[0].ip_address).toBe('203.0.113.9');
    });
  });

  describe('users', () => {
    it('refuses a duplicate email in one hospital, allows it in another', async () => {
      const email = `shared-${run}@test.invalid`;
      const body = { name: { en: 'Shared', ar: 'مشترك' }, email, roles: [] };
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
        .send({ name: { en: 'Hijacked' } })
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

    it('shuts out a suspended client, and needs a new sign-in when reactivated', async () => {
      await setClient(b.id, { status: 'suspended' }).expect(200);
      await http().get('/auth/me').set('Cookie', b.cookie).expect(401);
      await login(b.slug, b.adminEmail, password).expect(401);
      await setClient(b.id, { status: 'active' }).expect(200);
      // Reactivating does not revive the sessions that suspension ended.
      await http().get('/auth/me').set('Cookie', b.cookie).expect(401);
      b.cookie = cookieOf(
        await login(b.slug, b.adminEmail, password).expect(200),
      );
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
