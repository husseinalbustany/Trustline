import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray, like, sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { createDatabase } from '../src/database/client.js';
import {
  orgUnits,
  platformAdmins,
  platformAuditLog,
  tenants,
} from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';
import { createPlatformAdmin } from '../src/platform/create-admin.js';
import { MAX_FAILED_ATTEMPTS } from '../src/platform/platform-auth.service.js';

describe('admin portal API', () => {
  const run = randomBytes(4).toString('hex');
  const email = `admin-${run}@test.invalid`;
  const password = `correct-horse-${run}`;
  const slug = `test-${run}`;
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  let app: INestApplication<App>;
  let cookie: string;

  const client = {
    slug,
    nameEn: 'Test Hospital',
    nameAr: 'مستشفى الاختبار',
    accreditationStandard: 'JCI',
    defaultLocale: 'en',
    plan: 'professional',
    signInMethod: 'both',
    dataRegion: null,
  };

  const login = (pw: string) =>
    request(app.getHttpServer())
      .post('/platform/auth/login')
      .send({ email, password: pw });

  beforeAll(async () => {
    await createPlatformAdmin({ email, name: 'Test Admin', password });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    const { db, pool } = owner;
    const admins = db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, email));
    await db
      .delete(platformAuditLog)
      .where(inArray(platformAuditLog.adminId, admins));
    await db.delete(tenants).where(like(tenants.slug, `${slug}%`));
    await db.delete(platformAdmins).where(eq(platformAdmins.email, email));
    await pool.end();
    await app.close();
  });

  it('refuses every client route without a session', async () => {
    const http = request(app.getHttpServer());
    await http.get('/platform/tenants').expect(401);
    await http.post('/platform/tenants').send(client).expect(401);
    await http.get('/platform/auth/me').expect(401);
  });

  it('refuses a wrong password and an unknown email the same way', async () => {
    const wrong = await login('not-the-password');
    const unknown = await request(app.getHttpServer())
      .post('/platform/auth/login')
      .send({ email: 'nobody@test.invalid', password });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('signs in and sets a session cookie scripts cannot read', async () => {
    const res = await login(password).expect(200);
    expect(res.body).toEqual({
      id: expect.any(String),
      email,
      name: 'Test Admin',
    });
    const [setCookie] = res.get('Set-Cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    cookie = setCookie.split(';')[0];
    await request(app.getHttpServer())
      .get('/platform/auth/me')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('lists all clients', async () => {
    const res = await request(app.getHttpServer())
      .get('/platform/tenants')
      .set('Cookie', cookie)
      .expect(200);
    const slugs = res.body.map((t: { slug: string }) => t.slug);
    expect(slugs).toEqual(expect.arrayContaining(['demo-jci', 'demo-cbahi']));
  });

  let clientId: string;

  it('creates a client and records who did it', async () => {
    const res = await request(app.getHttpServer())
      .post('/platform/tenants')
      .set('Cookie', cookie)
      .send(client)
      .expect(201);
    expect(res.body).toMatchObject({ ...client, status: 'active' });
    clientId = res.body.id;

    const detail = await request(app.getHttpServer())
      .get(`/platform/tenants/${clientId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(detail.body.activity).toMatchObject([
      { action: 'client_created', adminName: 'Test Admin' },
    ]);
  });

  it('refuses a duplicate slug and invalid input', async () => {
    const http = () =>
      request(app.getHttpServer())
        .post('/platform/tenants')
        .set('Cookie', cookie);
    const dup = await http().send(client).expect(409);
    expect(dup.body.code).toBe('slug_taken');
    await http()
      .send({ ...client, slug: 'Not A Slug' })
      .expect(400);
    await http()
      .send({ ...client, slug: `${slug}-2`, plan: 'free' })
      .expect(400);
    await http()
      .send({ ...client, slug: `${slug}-3`, id: clientId })
      .expect(400);
  });

  it('suspends a client, and does not let the slug change', async () => {
    const http = () =>
      request(app.getHttpServer())
        .patch(`/platform/tenants/${clientId}`)
        .set('Cookie', cookie);
    const res = await http().send({ status: 'suspended' }).expect(200);
    expect(res.body.status).toBe('suspended');
    await http().send({ slug: 'renamed' }).expect(400);
  });

  it('ends the session on sign-out', async () => {
    await request(app.getHttpServer())
      .post('/platform/auth/logout')
      .set('Cookie', cookie)
      .expect(204);
    await request(app.getHttpServer())
      .get('/platform/tenants')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('locks the account after repeated wrong passwords', async () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      await login('wrong-password').expect(401);
    }
    await login(password).expect(401);
  }, 30_000);

  describe('database roles', () => {
    const platform = createDatabase(requireEnv('PLATFORM_DATABASE_URL'));
    const tenantApp = createDatabase(requireEnv('APP_DATABASE_URL'));
    afterAll(() => Promise.all([platform.pool.end(), tenantApp.pool.end()]));

    it('keeps the admin portal out of hospital data', async () => {
      await expect(platform.db.select().from(orgUnits)).rejects.toThrow();
    });

    it('keeps the hospital-facing role out of platform tables', async () => {
      await expect(
        tenantApp.db.select().from(platformAdmins),
      ).rejects.toThrow();
      await expect(
        tenantApp.db.update(tenants).set({ status: 'suspended' }),
      ).rejects.toThrow();
    });

    it('cannot create admins or rewrite the audit log from the API', async () => {
      await expect(
        platform.db.insert(platformAdmins).values({
          email: `intruder-${run}@test.invalid`,
          name: 'Intruder',
          passwordHash: 'x',
        }),
      ).rejects.toThrow();
      await expect(platform.db.delete(platformAuditLog)).rejects.toThrow();
      await expect(
        platform.db.update(platformAuditLog).set({ action: 'edited' }),
      ).rejects.toThrow();
      const { rows } = await platform.db.execute<{ bypass: boolean }>(
        sql`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`,
      );
      expect(rows[0].bypass).toBe(false);
    });
  });
});
