import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestMethod, type ExecutionContext } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { and, eq, sql } from 'drizzle-orm';
import type { Test } from 'supertest';
import { createDatabase } from '../src/database/client.js';
import {
  auditLog,
  incidents,
  notifications,
  plans,
  platformAuditLog,
  subscriptions,
  tenants,
} from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { requireEnv } from '../src/env.js';
import type { AuthService } from '../src/identity/auth.service.js';
import { SessionGuard } from '../src/identity/session.guard.js';
import { DeadlineCheck } from '../src/incidents/deadline-check.service.js';
import { IncidentsModule } from '../src/incidents/incidents.module.js';
import { NotificationsController } from '../src/incidents/notifications.controller.js';
import { PublicLimits } from '../src/incidents/public-limits.js';
import { REFUSAL_STEP_MS } from '../src/incidents/public.controller.js';
import { declaredModule } from '../src/subscriptions/module.decorator.js';
import { MODULES } from '../src/subscriptions/modules.js';
import { applyToOwnRows, startsWith } from './support/migration.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const HOUR = 3_600_000;
const NO_LIMITS = {
  users: null,
  sites: null,
  storageMb: null,
  aiCreditsPerMonth: null,
};
const NO_EXTRAS = {
  sso: false,
  publicReporting: false,
  clinicalAiSuggestions: false,
};

type Route = {
  controller: string;
  module: string | undefined;
  signedIn: boolean;
  method: string;
  path: string;
};

/** Every route the application serves, from what its controllers declare. */
function routesOf(bench: TestBench): Route[] {
  const routes: Route[] = [];
  for (const module of bench.app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as unknown as {
        name: string;
        prototype: Record<string, unknown>;
      };
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
      const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ??
        []) as unknown[];
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (method === undefined) continue;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
          []) as unknown[];
        routes.push({
          controller: controller.name,
          module: declaredModule(controller),
          signedIn: [...guards, ...handlerGuards].includes(SessionGuard),
          method: RequestMethod[method],
          path: `/${[base, path].filter((p) => p && p !== '/').join('/')}`,
        });
      }
    }
  }
  return routes;
}

/**
 * Modules, plans, subscriptions and limits (docs/specs/modules-and-
 * subscriptions.md, steps 1 to 3): a module that is off answers as if it
 * did not exist and deletes nothing; a subscription's status and limits
 * hold on every route; plans and subscriptions are Trustline's to manage,
 * audited; and every client that existed before plans keeps everything.
 */
describe('modules and subscriptions', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  const p = () => bench.platform;
  let prefix: string;
  let check: DeadlineCheck;
  let limits: PublicLimits;

  let docs: { id: string; code: string };
  let inc: { id: string; code: string };

  // Has incidents throughout.
  let on: Hospital;
  let onUnit: string;
  let onCode: string;
  // Loses incidents, and gets them back.
  let off: Hospital;
  let offUnit: string;
  let offReporter: Staff;
  let offQuality: Staff;
  let offIncident: string;
  let offCode: string;

  const plan = (code: string, body: Record<string, unknown> = {}) =>
    http()
      .post('/platform/plans')
      .set('Cookie', p())
      .send({
        code: `${prefix}-${code}`,
        name: { en: `Plan ${code}`, ar: `خطة ${code}`, fr: `Offre ${code}` },
        modules: [],
        limits: NO_LIMITS,
        extras: NO_EXTRAS,
        ...body,
      });
  const subscription = (h: { id: string }) =>
    http().get(`/platform/tenants/${h.id}/subscription`).set('Cookie', p());
  const setSubscription = (h: { id: string }, body: Record<string, unknown>) =>
    http()
      .patch(`/platform/tenants/${h.id}/subscription`)
      .set('Cookie', p())
      .send(body);
  const me = (cookie: string) => http().get('/auth/me').set('Cookie', cookie);
  const reportBody = (h: Hospital, unit: string, extra = {}) => ({
    type: 'incident',
    categoryId: h.categories.equipment,
    orgUnitId: unit,
    occurredAt: new Date(Date.now() - HOUR).toISOString(),
    description: 'A bed rail would not lock.',
    harmLevel: 'none',
    ...extra,
  });
  let address = 0;
  const fromSomewhere = () => `198.51.100.${(address++ % 250) + 1}`;
  const switchPublicReporting = (h: Hospital) =>
    http()
      .put('/settings/reporting')
      .set('Cookie', h.cookie)
      .send({ publicReporting: true })
      .expect(200);

  beforeAll(async () => {
    bench = await testBench('ms', run);
    prefix = bench.prefix;
    check = bench.app.get(DeadlineCheck, { strict: false });
    limits = bench.app.get(PublicLimits, { strict: false });

    docs = (await plan('docs', { modules: ['policies'] }).expect(201)).body;
    inc = (await plan('inc', { modules: ['incidents'] }).expect(201)).body;

    on = await bench.createHospital('on');
    onUnit = await bench.createUnit(on, 'facility', 'MAIN', null);
    await switchPublicReporting(on);
    onCode = (
      await http()
        .post('/incidents')
        .set('Cookie', on.cookie)
        .send(reportBody(on, onUnit, { anonymous: true }))
        .expect(201)
    ).body.followUpCode;

    off = await bench.createHospital('off');
    offUnit = await bench.createUnit(off, 'facility', 'MAIN', null);
    await switchPublicReporting(off);
    offReporter = await bench.createStaff(off, 'offreporter', {
      role: 'reporter',
      orgUnitId: null,
    });
    offQuality = await bench.createStaff(off, 'offquality', {
      role: 'quality_officer',
      orgUnitId: null,
    });
    // A report the quality officer is told of, and an anonymous one with a
    // follow-up code, both made while the hospital has incidents.
    offIncident = (
      await http()
        .post('/incidents')
        .set('Cookie', offReporter.cookie)
        .send(reportBody(off, offUnit, { anonymous: false }))
        .expect(201)
    ).body.id;
    offCode = (
      await http()
        .post('/incidents')
        .set('Cookie', offReporter.cookie)
        .send(reportBody(off, offUnit, { anonymous: true }))
        .expect(201)
    ).body.followUpCode;
    // Then the hospital moves to a plan without incidents.
    await setSubscription(off, { planId: docs.id }).expect(200);
  }, 60_000);

  afterAll(() => bench.close());

  describe('where the module of a route is declared', () => {
    it('is declared by every controller the application serves', () => {
      const undeclared = routesOf(bench)
        .filter((r) => r.module === undefined)
        .map((r) => `${r.controller} ${r.method} ${r.path}`);
      expect(undeclared).toEqual([]);
    });

    it('is incidents for every controller of the incidents module, notifications apart', () => {
      const container = bench.app.get(ModulesContainer);
      const module = [...container.values()].find(
        (m) => m.metatype === IncidentsModule,
      )!;
      const declared = Object.fromEntries(
        [...module.controllers.values()].map((w) => [
          (w.metatype as { name: string }).name,
          declaredModule(w.metatype as object),
        ]),
      );
      // Notifications are core: every module will notify. What a module
      // that is off notified is left out of them (tested below).
      expect(declared[NotificationsController.name]).toBe('core');
      delete declared[NotificationsController.name];
      expect(Object.keys(declared).length).toBeGreaterThanOrEqual(4);
      for (const [name, value] of Object.entries(declared)) {
        expect(`${name}: ${value}`).toBe(`${name}: incidents`);
      }
    });

    it('refuses a signed-in route whose controller declares none, before anything else', async () => {
      class Undeclared {}
      const handler = () => undefined;
      const resolveSession = vi.fn();
      const auth = { resolve: resolveSession } as unknown as AuthService;
      const guard = new SessionGuard(auth, new Reflector());
      const context = {
        getHandler: () => handler,
        getClass: () => Undeclared,
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      } as unknown as ExecutionContext;
      await expect(guard.canActivate(context)).rejects.toThrow(
        /declares no module/,
      );
      expect(resolveSession).not.toHaveBeenCalled();
    });
  });

  describe('a client without incidents', () => {
    it('is told of no incidents module and no incidents permission, and its roles keep them', async () => {
      const { body } = await me(off.cookie).expect(200);
      expect(body.tenant.modules).toEqual(['policies']);
      expect(body.tenant.subscription).toEqual({
        status: 'active',
        notice: null,
      });
      expect(body.permissions).toContain('users.manage');
      expect(body.permissions).toContain('policies.view');
      expect(
        body.permissions.filter((x: string) => x.startsWith('incidents.')),
      ).toEqual([]);
      expect(
        Object.keys(body.scope).filter((x) => x.startsWith('incidents.')),
      ).toEqual([]);
      const roles = await http()
        .get('/roles')
        .set('Cookie', off.cookie)
        .expect(200);
      const administrator = roles.body.roles.find(
        (r: { code: string }) => r.code === 'administrator',
      );
      expect(administrator.permissions).toContain('incidents.triage');
      // A client with incidents is told of them.
      const full = await me(on.cookie).expect(200);
      expect(full.body.tenant.modules).toEqual([...MODULES]);
      expect(full.body.permissions).toContain('incidents.triage');
    });

    it('answers every signed-in incidents route exactly as a route that does not exist', async () => {
      const unknown = await http()
        .get(`/no-such-route-${run}`)
        .set('Cookie', off.cookie)
        .expect(404);
      expect(unknown.body).toEqual({
        message: `Cannot GET /no-such-route-${run}`,
        error: 'Not Found',
        statusCode: 404,
      });
      const walked = routesOf(bench).filter(
        (r) => r.module === 'incidents' && r.signedIn,
      );
      // Every route of incident-categories, incidents and settings.
      expect(walked.length).toBeGreaterThanOrEqual(13);
      for (const route of walked) {
        const url = route.path.replace(':id', randomUUID());
        const send = (cookie: string) =>
          http()
            [route.method.toLowerCase() as 'get'](url)
            .set('Cookie', cookie)
            .send({});
        const res = await send(off.cookie);
        expect({
          route: `${route.method} ${url}`,
          status: res.status,
          body: res.body,
        }).toEqual({
          route: `${route.method} ${url}`,
          status: 404,
          body: {
            message: `Cannot ${route.method} ${url}`,
            error: 'Not Found',
            statusCode: 404,
          },
        });
        // The same route is there for a client with incidents.
        const there = await send(on.cookie);
        expect(String(there.body?.message ?? '')).not.toMatch(/^Cannot /);
      }
      // Without a session the answer is 401 as before: whose client it is
      // cannot be known.
      await http().get('/incidents').expect(401);
    }, 60_000);

    it('answers the public routes as for a hospital that does not exist, on the same step of time', async () => {
      const walked = routesOf(bench).filter(
        (r) => r.module === 'incidents' && !r.signedIn,
      );
      expect(walked.length).toBe(4);
      for (const route of walked) {
        const bodyFor = (h: Hospital, unit: string, code: string) =>
          route.path.endsWith('comments')
            ? { code, body: 'Anything new?' }
            : route.path.includes('follow-up')
              ? { code }
              : reportBody(h, unit);
        const call = async (
          slug: string,
          body = bodyFor(off, offUnit, offCode),
        ) => {
          limits.forget();
          const began = performance.now();
          const res = await http()
            [route.method.toLowerCase() as 'get'](
              route.path.replace(':slug', slug),
            )
            .set('X-Forwarded-For', fromSomewhere())
            .send(body);
          return {
            status: res.status,
            body: res.body,
            ms: performance.now() - began,
          };
        };
        const nowhere = await call(`${prefix}-nowhere`);
        const without = await call(off.slug);
        expect(without.status).toBe(404);
        expect(without.body).toEqual(nowhere.body);
        expect(without.ms).toBeGreaterThanOrEqual(REFUSAL_STEP_MS - 2);
        // And it is there for a hospital that has incidents.
        const there = await call(on.slug, bodyFor(on, onUnit, onCode));
        expect(`${route.method} ${route.path}: ${there.status}`).not.toMatch(
          /: 404$/,
        );
      }
    }, 30_000);

    it('is shown none of the notifications it had, and none is deleted', async () => {
      const stored = await bench.owner.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, off.id),
            eq(notifications.userId, offQuality.id),
          ),
        );
      expect(stored.length).toBeGreaterThan(0);
      const list = await http()
        .get('/notifications')
        .set('Cookie', offQuality.cookie)
        .expect(200);
      expect(list.body).toEqual({ items: [], total: 0 });
      const count = await http()
        .get('/notifications/count')
        .set('Cookie', offQuality.cookie)
        .expect(200);
      expect(count.body).toEqual({ unread: 0 });
      const marked = await http()
        .post('/notifications/read-all')
        .set('Cookie', offQuality.cookie)
        .expect(200);
      expect(marked.body).toEqual({ marked: 0 });
      await http()
        .post(`/notifications/${stored[0].id}/read`)
        .set('Cookie', offQuality.cookie)
        .expect(404);
    });

    it('is left alone by the deadline check, which announces when it has incidents again', async () => {
      // The triage deadline of the report has passed.
      await bench.owner.db
        .update(incidents)
        .set({
          reportedAt: new Date(Date.now() - 3 * HOUR),
          triageDueAt: new Date(Date.now() - HOUR),
        })
        .where(eq(incidents.id, offIncident));
      const hospital = { id: off.id, timeZone: 'UTC' };
      expect(await check.checkHospital(hospital, new Date())).toBe(0);
      const [still] = await bench.owner.db
        .select({ at: incidents.triageOverdueAt })
        .from(incidents)
        .where(eq(incidents.id, offIncident));
      expect(still.at).toBeNull();
      const result = await check.run(new Date(), [off.id]);
      expect(result.notified).toBe(0);

      // Back on, as an add-on: everything is where it was.
      const changed = await setSubscription(off, {
        addOnModules: ['incidents'],
      }).expect(200);
      expect(changed.body.effective.modules).toEqual(['incidents', 'policies']);
      expect((await me(off.cookie).expect(200)).body.tenant.modules).toEqual([
        'incidents',
        'policies',
      ]);
      await http()
        .get(`/incidents/${offIncident}`)
        .set('Cookie', offQuality.cookie)
        .expect(200);
      const list = await http()
        .get('/notifications')
        .set('Cookie', offQuality.cookie)
        .expect(200);
      expect(list.body.total).toBeGreaterThan(0);
      expect(await check.checkHospital(hospital, new Date())).toBeGreaterThan(
        0,
      );
      limits.forget();
      await http()
        .post(`/public/follow-up/${off.slug}`)
        .set('X-Forwarded-For', fromSomewhere())
        .send({ code: offCode })
        .expect(200);
      // Off again, for the tests below.
      await setSubscription(off, { addOnModules: [] }).expect(200);
    }, 30_000);

    it("records in the client's own audit log what was switched on and off, and who did it", async () => {
      const entries = await bench.owner.db
        .select({ changes: auditLog.changes, actorId: auditLog.actorId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, off.id),
            eq(auditLog.action, 'subscription_changed'),
          ),
        )
        .orderBy(auditLog.occurredAt);
      expect(entries.length).toBeGreaterThanOrEqual(3);
      expect(entries[0].actorId).toBeNull();
      expect(entries[0].changes).toMatchObject({
        plan: { from: 'everything', to: docs.code },
        modules: {
          on: [],
          off: MODULES.filter((m) => m !== 'policies'),
        },
        platformAdminEmail: expect.stringContaining('@test.invalid'),
      });
      expect(entries[1].changes).toMatchObject({
        modules: { on: ['incidents'], off: [] },
      });
      const platform = await bench.owner.db
        .select({ details: platformAuditLog.details })
        .from(platformAuditLog)
        .where(
          and(
            eq(platformAuditLog.targetTenantId, off.id),
            eq(platformAuditLog.action, 'subscription_updated'),
          ),
        );
      expect(platform.length).toBeGreaterThanOrEqual(3);
      expect(platform[0].details).toMatchObject({
        changes: { planId: { to: docs.id } },
      });
    });
  });

  describe('what each module needs', () => {
    it('refuses investigations without incidents', async () => {
      const res = await setSubscription(off, {
        addOnModules: ['investigations'],
      }).expect(400);
      expect(res.body).toEqual({
        code: 'module_dependency_missing',
        module: 'investigations',
        requiresAnyOf: ['incidents'],
      });
      await plan('inv', { modules: ['investigations'] }).expect(400);
    });

    it('refuses the AI assistant alone', async () => {
      const res = await plan('ai', { modules: ['ai_assistant'] }).expect(400);
      expect(res.body).toEqual({
        code: 'module_dependency_missing',
        module: 'ai_assistant',
        requiresAnyOf: MODULES.filter((m) => m !== 'ai_assistant'),
      });
      await plan('ai2', { modules: ['ai_assistant', 'training'] }).expect(201);
    });

    it('takes investigations with incidents, and keeps a plan from taking incidents from under them', async () => {
      const h = await bench.createHospital('dep');
      const res = await setSubscription(h, {
        planId: inc.id,
        addOnModules: ['investigations'],
      }).expect(200);
      expect(res.body.effective.modules).toEqual([
        'incidents',
        'investigations',
      ]);
      const refused = await http()
        .patch(`/platform/plans/${inc.id}`)
        .set('Cookie', p())
        .send({ modules: ['policies'] })
        .expect(400);
      expect(refused.body).toEqual({
        code: 'module_dependency_missing',
        module: 'investigations',
        requiresAnyOf: ['incidents'],
        tenantId: h.id,
      });
      const [stored] = await bench.owner.db
        .select({ modules: plans.modules })
        .from(plans)
        .where(eq(plans.id, inc.id));
      expect(stored.modules).toEqual(['incidents']);
    }, 30_000);
  });

  describe('the status of a subscription', () => {
    let h: Hospital;
    let unit: string;
    let reporter: Staff;

    beforeAll(async () => {
      h = await bench.createHospital('status');
      unit = await bench.createUnit(h, 'facility', 'MAIN', null);
      await switchPublicReporting(h);
      reporter = await bench.createStaff(h, 'streporter', {
        role: 'reporter',
        orgUnitId: null,
      });
    }, 30_000);

    it('past due: everything works, and only administrators are told', async () => {
      await setSubscription(h, { status: 'past_due' }).expect(200);
      expect((await me(h.cookie).expect(200)).body.tenant.subscription).toEqual(
        {
          status: 'past_due',
          notice: 'past_due',
        },
      );
      expect(
        (await me(reporter.cookie).expect(200)).body.tenant.subscription,
      ).toEqual({
        status: 'past_due',
        notice: null,
      });
      await http()
        .post('/org-units')
        .set('Cookie', h.cookie)
        .send({
          type: 'department',
          code: 'PD',
          name: { en: 'Past due' },
          parentId: unit,
        })
        .expect(201);
    });

    it('suspended: reading and reporting stay open, every other write is refused', async () => {
      const incident = (
        await http()
          .post('/incidents')
          .set('Cookie', reporter.cookie)
          .send(reportBody(h, unit, { anonymous: false }))
          .expect(201)
      ).body.id;
      const spare = bench.cookieOf(
        await bench.login(h.slug, reporter.email).expect(200),
      );
      await setSubscription(h, { status: 'suspended' }).expect(200);

      for (const cookie of [h.cookie, reporter.cookie]) {
        expect((await me(cookie).expect(200)).body.tenant.subscription).toEqual(
          {
            status: 'suspended',
            notice: 'suspended',
          },
        );
      }
      const refused = { code: 'subscription_suspended' };
      const writes = [
        http()
          .post('/org-units')
          .set('Cookie', h.cookie)
          .send({
            type: 'department',
            code: 'SU',
            name: { en: 'Suspended' },
            parentId: unit,
          }),
        http()
          .patch(`/users/${reporter.id}`)
          .set('Cookie', h.cookie)
          .send({ jobTitle: 'Nurse' }),
        http()
          .post('/users')
          .set('Cookie', h.cookie)
          .send({
            name: { en: 'New' },
            email: `new-${run}@test.invalid`,
            roles: [],
          }),
        http()
          .post('/roles')
          .set('Cookie', h.cookie)
          .send({ code: 'x', name: { en: 'x' }, permissions: [] }),
        http()
          .put('/settings/reporting')
          .set('Cookie', h.cookie)
          .send({ publicReporting: false }),
        http()
          .post(`/incidents/${incident}/comments`)
          .set('Cookie', reporter.cookie)
          .send({ body: 'More', visibility: 'everyone' }),
        http()
          .post(`/incidents/${incident}/triage`)
          .set('Cookie', h.cookie)
          .send({}),
      ];
      for (const write of writes) {
        const res = await write;
        expect(res.status).toBe(403);
        expect(res.body).toEqual(refused);
      }
      // Reading.
      await http().get('/incidents').set('Cookie', h.cookie).expect(200);
      await http()
        .get(`/incidents/${incident}`)
        .set('Cookie', reporter.cookie)
        .expect(200);
      await http().get('/users').set('Cookie', h.cookie).expect(200);
      const shown = await http()
        .get('/settings/subscription')
        .set('Cookie', h.cookie)
        .expect(200);
      expect(shown.body.status).toBe('suspended');
      // Reporting, signed in and through the public link.
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(reportBody(h, unit, { anonymous: false }))
        .expect(201);
      limits.forget();
      const code = (
        await http()
          .post(`/public/reporting/${h.slug}`)
          .set('X-Forwarded-For', fromSomewhere())
          .send(reportBody(h, unit))
          .expect(201)
      ).body.followUpCode;
      await http()
        .post(`/public/follow-up/${h.slug}/comments`)
        .set('X-Forwarded-For', fromSomewhere())
        .send({ code, body: 'One more thing' })
        .expect(201);
      // What changes nothing of the client's records.
      await http()
        .post('/notifications/read-all')
        .set('Cookie', h.cookie)
        .expect(200);
      await http().post('/auth/logout').set('Cookie', spare).expect(204);
      // Signing in.
      await bench.login(h.slug, reporter.email).expect(200);
    }, 30_000);

    it('cancelled: nobody signs in, sessions end, the public routes are gone', async () => {
      await setSubscription(h, { status: 'cancelled' }).expect(200);
      await me(h.cookie).expect(401);
      await bench.login(h.slug, reporter.email).expect(401);
      limits.forget();
      await http()
        .get(`/public/reporting/${h.slug}`)
        .set('X-Forwarded-For', fromSomewhere())
        .expect(404);
      const admin = await http()
        .post(`/platform/tenants/${h.id}/administrators`)
        .set('Cookie', p())
        .send({ name: { en: 'Another' }, email: `another-${run}@test.invalid` })
        .expect(409);
      expect(admin.body).toEqual({ code: 'subscription_cancelled' });
      expect(await check.run(new Date(), [h.id])).toMatchObject({
        notified: 0,
        failed: 0,
      });

      // Active again: signing in works, the old sessions stay ended.
      await setSubscription(h, { status: 'active' }).expect(200);
      await me(h.cookie).expect(401);
      const fresh = bench.cookieOf(
        await bench.login(h.slug, reporter.email).expect(200),
      );
      await me(fresh).expect(200);
    });

    it("combines with the client's own status: a suspended client is closed whatever its subscription says", async () => {
      await setSubscription(h, { status: 'past_due' }).expect(200);
      await http()
        .patch(`/platform/tenants/${h.id}`)
        .set('Cookie', p())
        .send({ status: 'suspended' })
        .expect(200);
      await bench.login(h.slug, reporter.email).expect(401);
      await http()
        .patch(`/platform/tenants/${h.id}`)
        .set('Cookie', p())
        .send({ status: 'active' })
        .expect(200);
      await bench.login(h.slug, reporter.email).expect(200);
      await setSubscription(h, { status: 'active' }).expect(200);
    });

    it('a trial has an end, and no date comes before the start', async () => {
      const res = await setSubscription(h, { status: 'trial' }).expect(400);
      expect(res.body).toEqual({ code: 'trial_end_required' });
      const ok = await setSubscription(h, {
        status: 'trial',
        startsOn: '2026-11-01',
        trialEndsOn: '2026-12-31',
      }).expect(200);
      expect(ok.body).toMatchObject({
        status: 'trial',
        trialEndsOn: '2026-12-31',
      });
      expect(
        (await setSubscription(h, { renewsOn: '2026-10-01' }).expect(400)).body,
      ).toEqual({
        code: 'invalid_dates',
      });
      await setSubscription(h, { status: 'active' }).expect(200);
      await setSubscription(h, { status: 'paused' }).expect(400);
      await setSubscription(h, { startsOn: '1 November' }).expect(400);
      await setSubscription(h, {}).expect(400);
      await setSubscription(h, { status: 'active', price: 1 }).expect(400);
    });
  });

  describe('limits', () => {
    let h: Hospital;

    const used = async () =>
      (
        await http()
          .get('/settings/subscription')
          .set('Cookie', h.cookie)
          .expect(200)
      ).body.limits;
    const addUser = (name: string) =>
      http()
        .post('/users')
        .set('Cookie', h.cookie)
        .send({
          name: { en: name },
          email: `${name}-${run}@test.invalid`,
          roles: [],
        });
    const addFacility = (code: string) =>
      http()
        .post('/org-units')
        .set('Cookie', h.cookie)
        .send({ type: 'facility', code, name: { en: code }, parentId: null });

    beforeAll(async () => {
      h = await bench.createHospital('limits');
    }, 30_000);

    it('named users: none beyond the limit, a disabled account holds no place, nobody already there is affected', async () => {
      // The administrator is the one named user.
      expect((await used()).users).toEqual({ max: null, used: 1 });
      await setSubscription(h, { limitOverrides: { users: 2 } }).expect(200);
      const first = await bench.createStaff(h, 'limfirst', null);
      const refused = await addUser('limsecond').expect(409);
      expect(refused.body).toEqual({
        code: 'limit_reached',
        limit: 'users',
        max: 2,
      });
      // An invited user counts as well as an active one.
      expect((await used()).users).toEqual({ max: 2, used: 2 });

      await http()
        .patch(`/users/${first.id}`)
        .set('Cookie', h.cookie)
        .send({ status: 'disabled' })
        .expect(200);
      expect((await used()).users.used).toBe(1);
      const second = await addUser('limsecond').expect(201);
      const back = await http()
        .patch(`/users/${first.id}`)
        .set('Cookie', h.cookie)
        .send({ status: 'active' })
        .expect(409);
      expect(back.body).toEqual({
        code: 'limit_reached',
        limit: 'users',
        max: 2,
      });

      // Lowered below what there is: everyone there stays.
      await setSubscription(h, { limitOverrides: { users: 1 } }).expect(200);
      await me(h.cookie).expect(200);
      await http()
        .patch(`/users/${second.body.user.id}`)
        .set('Cookie', h.cookie)
        .send({ jobTitle: 'Pharmacist' })
        .expect(200);
      await bench
        .login(h.slug, `admin-ms-limits-${run}@test.invalid`)
        .expect(200);
      expect((await addUser('limthird').expect(409)).body.max).toBe(1);
    }, 30_000);

    it('named users: two requests for the last place, one gets it', async () => {
      const { used: now } = (await used()).users;
      await setSubscription(h, { limitOverrides: { users: now + 1 } }).expect(
        200,
      );
      const answers = await Promise.all([
        addUser('racea'),
        addUser('raceb'),
        addUser('racec'),
      ]);
      expect(answers.map((a) => a.status).sort((a, b) => a - b)).toEqual([
        201, 409, 409,
      ]);
      expect((await used()).users).toEqual({ max: now + 1, used: now + 1 });
    }, 30_000);

    it('sites: facilities switched on, no more than the limit, two at once cannot both take the last', async () => {
      await setSubscription(h, { limitOverrides: { sites: 1 } }).expect(200);
      const main = (await addFacility('SITE-A').expect(201)).body.id;
      const refused = await addFacility('SITE-B').expect(409);
      expect(refused.body).toEqual({
        code: 'limit_reached',
        limit: 'sites',
        max: 1,
      });
      // A department is not a site.
      await http()
        .post('/org-units')
        .set('Cookie', h.cookie)
        .send({
          type: 'department',
          code: 'SITE-A-QM',
          name: { en: 'QM' },
          parentId: main,
        })
        .expect(201);
      expect((await used()).sites).toEqual({ max: 1, used: 1 });

      // Switched off, it frees its place; switched on again, it needs one.
      const spare = (await addFacility('SITE-C').expect(409)).body;
      expect(spare.code).toBe('limit_reached');
      await setSubscription(h, { limitOverrides: { sites: 2 } }).expect(200);
      const second = (await addFacility('SITE-C').expect(201)).body.id;
      await http()
        .patch(`/org-units/${second}`)
        .set('Cookie', h.cookie)
        .send({ active: false })
        .expect(200);
      await addFacility('SITE-D').expect(201);
      const reopened = await http()
        .patch(`/org-units/${second}`)
        .set('Cookie', h.cookie)
        .send({ active: true })
        .expect(409);
      expect(reopened.body).toEqual({
        code: 'limit_reached',
        limit: 'sites',
        max: 2,
      });

      await setSubscription(h, { limitOverrides: { sites: 3 } }).expect(200);
      const answers = await Promise.all([
        addFacility('SITE-E'),
        addFacility('SITE-F'),
      ]);
      expect(answers.map((a) => a.status).sort((a, b) => a - b)).toEqual([
        201, 409,
      ]);
      expect((await used()).sites).toEqual({ max: 3, used: 3 });
    }, 30_000);

    it('stores storage and AI credits as limits, without enforcing them yet', async () => {
      const res = await setSubscription(h, {
        limitOverrides: {
          users: null,
          sites: null,
          storageMb: 0,
          aiCreditsPerMonth: 0,
        },
      }).expect(200);
      expect(res.body.effective.limits).toEqual({
        users: null,
        sites: null,
        storageMb: 0,
        aiCreditsPerMonth: 0,
      });
      await addUser('limlast').expect(201);
      await setSubscription(h, { limitOverrides: { users: -1 } }).expect(400);
      await setSubscription(h, { limitOverrides: { seats: 3 } }).expect(400);
    });
  });

  describe('plans', () => {
    it('are for Trustline staff only', async () => {
      const id = randomUUID();
      for (const cookie of [undefined, on.cookie]) {
        const as = (r: Test) => (cookie ? r.set('Cookie', cookie) : r);
        await as(http().get('/platform/plans')).expect(401);
        await as(http().post('/platform/plans')).send({}).expect(401);
        await as(http().get(`/platform/plans/${docs.id}`)).expect(401);
        await as(http().patch(`/platform/plans/${docs.id}`))
          .send({})
          .expect(401);
        await as(http().get(`/platform/tenants/${on.id}/subscription`)).expect(
          401,
        );
        await as(http().patch(`/platform/tenants/${on.id}/subscription`))
          .send({})
          .expect(401);
        await as(http().get(`/platform/tenants/${id}/subscription`)).expect(
          401,
        );
      }
    });

    it('are listed, read, created and edited, each change audited', async () => {
      const created = await plan('edit', {
        description: { en: 'One', ar: 'واحد', fr: 'Un' },
        modules: ['training', 'policies'],
        limits: { ...NO_LIMITS, users: 10 },
        prices: [
          {
            currency: 'SAR',
            amountMinor: 120000,
            term: 'yearly',
            basis: 'per_user',
          },
        ],
        position: 5,
      }).expect(201);
      expect(created.body).toMatchObject({
        code: `${prefix}-edit`,
        modules: ['policies', 'training'],
        limits: { users: 10, sites: null },
        active: true,
        position: 5,
        subscribers: 0,
      });
      const id = created.body.id as string;
      const list = await http()
        .get('/platform/plans')
        .set('Cookie', p())
        .expect(200);
      const listed = list.body.find((x: { id: string }) => x.id === id);
      expect(listed).toMatchObject({ code: `${prefix}-edit`, subscribers: 0 });
      expect(
        list.body.find((x: { code: string }) => x.code === docs.code)
          .subscribers,
      ).toBe(1);

      const edited = await http()
        .patch(`/platform/plans/${id}`)
        .set('Cookie', p())
        .send({ limits: { ...NO_LIMITS, users: 20 }, active: false })
        .expect(200);
      expect(edited.body).toMatchObject({
        limits: { users: 20 },
        active: false,
      });
      const read = await http()
        .get(`/platform/plans/${id}`)
        .set('Cookie', p())
        .expect(200);
      expect(read.body).toEqual(edited.body);

      const audit = await bench.owner.db
        .select({
          action: platformAuditLog.action,
          details: platformAuditLog.details,
        })
        .from(platformAuditLog)
        .where(sql`${platformAuditLog.details} ->> 'planId' = ${id}`)
        .orderBy(platformAuditLog.createdAt);
      expect(audit.map((a) => a.action)).toEqual([
        'plan_created',
        'plan_updated',
      ]);
      expect(audit[1].details).toMatchObject({
        changes: {
          limits: { from: { users: 10 }, to: { users: 20 } },
          active: { from: true, to: false },
        },
      });
    });

    it('refuse what is not a plan', async () => {
      await plan('bad1', { modules: ['core'] }).expect(400);
      await plan('bad2', { limits: { users: 1 } }).expect(400);
      await plan('bad3', { extras: { sso: true } }).expect(400);
      await plan('bad4', { price: 3 }).expect(400);
      await plan('Bad Code').expect(400);
      const lang = await plan('bad5', { name: { en: 'English only' } }).expect(
        400,
      );
      expect(lang.body).toEqual({ code: 'language_mismatch' });
      const taken = await plan('docs', { modules: ['policies'] }).expect(409);
      expect(taken.body).toEqual({ code: 'code_taken' });
      await http()
        .get(`/platform/plans/${randomUUID()}`)
        .set('Cookie', p())
        .expect(404);
      await http()
        .get('/platform/plans/not-an-id')
        .set('Cookie', p())
        .expect(404);
      await http()
        .patch(`/platform/plans/${randomUUID()}`)
        .set('Cookie', p())
        .send({ position: 1 })
        .expect(404);
      await http()
        .patch(`/platform/plans/${docs.id}`)
        .set('Cookie', p())
        .send({})
        .expect(400);
      await http()
        .patch(`/platform/plans/${docs.id}`)
        .set('Cookie', p())
        .send({ code: 'renamed' })
        .expect(400);
    });

    it('are retired, never deleted: a retired plan keeps its clients and takes no new one', async () => {
      const retiring = (
        await plan('retiring', { modules: ['incidents'] }).expect(201)
      ).body;
      const h = await bench.createHospital('retire', { planId: retiring.id });
      expect((await subscription(h).expect(200)).body).toMatchObject({
        plan: { id: retiring.id, active: true },
        status: 'active',
        effective: { modules: ['incidents'] },
        usage: { users: 1, sites: 0 },
      });
      await http()
        .patch(`/platform/plans/${retiring.id}`)
        .set('Cookie', p())
        .send({ active: false })
        .expect(200);
      await http()
        .delete(`/platform/plans/${retiring.id}`)
        .set('Cookie', p())
        .expect(404);
      // Its client keeps it, and may change anything else.
      await setSubscription(h, { note: 'Renewal call in March' }).expect(200);
      const moved = await setSubscription(on, { planId: retiring.id }).expect(
        400,
      );
      expect(moved.body).toEqual({ code: 'plan_retired' });
      const unknown = await setSubscription(on, {
        planId: randomUUID(),
      }).expect(400);
      expect(unknown.body).toEqual({ code: 'unknown_plan' });
      const create = (planId: string, suffix: string) =>
        http()
          .post('/platform/tenants')
          .set('Cookie', p())
          .send({
            slug: `${prefix}-${suffix}`,
            name: { en: 'Never made' },
            accreditationStandard: 'JCI',
            locales: ['en'],
            defaultLocale: 'en',
            signInMethod: 'password',
            dataRegion: null,
            planId,
          });
      expect((await create(retiring.id, 'never1').expect(400)).body).toEqual({
        code: 'plan_retired',
      });
      expect((await create(randomUUID(), 'never2').expect(400)).body).toEqual({
        code: 'unknown_plan',
      });
      const [none] = await bench.owner.db
        .select({ n: sql<number>`count(*)::int` })
        .from(tenants)
        .where(sql`starts_with(${tenants.slug}, ${`${prefix}-never`})`);
      expect(none.n).toBe(0);

      // The list of clients and a client's page show the subscription.
      const listed = await http()
        .get('/platform/tenants')
        .set('Cookie', p())
        .expect(200);
      expect(
        listed.body.find((t: { id: string }) => t.id === h.id).subscription,
      ).toEqual({
        status: 'active',
        plan: { id: retiring.id, code: retiring.code, name: retiring.name },
      });
      const page = await http()
        .get(`/platform/tenants/${h.id}`)
        .set('Cookie', p())
        .expect(200);
      expect(page.body.subscription.plan.code).toBe(retiring.code);
    }, 30_000);

    it('tells each client on a plan, in its own audit log, what an edit of the plan changed for it', async () => {
      const shared = (
        await plan('shared', { modules: ['incidents'] }).expect(201)
      ).body;
      const h = await bench.createHospital('shared', { planId: shared.id });
      await http()
        .patch(`/platform/plans/${shared.id}`)
        .set('Cookie', p())
        .send({
          modules: ['incidents', 'policies'],
          limits: { ...NO_LIMITS, sites: 4 },
        })
        .expect(200);
      const [entry] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, h.id),
            eq(auditLog.action, 'subscription_changed'),
          ),
        );
      expect(entry.changes).toMatchObject({
        modules: { on: ['policies'], off: [] },
        limits: { sites: { from: null, to: 4 } },
        planUpdated: shared.code,
      });
      expect((await me(h.cookie).expect(200)).body.tenant.modules).toEqual([
        'incidents',
        'policies',
      ]);
    }, 30_000);

    it('a subscription of a client that does not exist is not found', async () => {
      await subscription({ id: randomUUID() }).expect(404);
      await subscription({ id: 'not-an-id' }).expect(404);
      await setSubscription({ id: randomUUID() }, { status: 'active' }).expect(
        404,
      );
    });
  });

  describe('what a client is shown of its subscription', () => {
    it('is for the settings managers of the whole organization', async () => {
      await http().get('/settings/subscription').expect(401);
      const reporter = await bench.createStaff(on, 'onreporter', {
        role: 'reporter',
        orgUnitId: null,
      });
      const res = await http()
        .get('/settings/subscription')
        .set('Cookie', reporter.cookie)
        .expect(403);
      expect(res.body).toEqual({
        code: 'missing_permission',
        permission: 'settings.manage',
      });
    }, 30_000);

    it('holds the plan, the modules on and off, the limits with what is used, the status and dates, and nothing commercial', async () => {
      await setSubscription(off, {
        renewsOn: '2027-11-01',
        note: 'Trustline only',
        limitOverrides: { users: 50 },
      }).expect(200);
      const { body } = await http()
        .get('/settings/subscription')
        .set('Cookie', off.cookie)
        .expect(200);
      expect(body).toEqual({
        plan: {
          code: docs.code,
          name: { en: 'Plan docs', ar: 'خطة docs', fr: 'Offre docs' },
        },
        status: 'active',
        startsOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        renewsOn: '2027-11-01',
        trialEndsOn: null,
        modules: MODULES.map((code) => ({
          code,
          enabled: code === 'policies',
          from: code === 'policies' ? 'plan' : null,
        })),
        limits: {
          users: { max: 50, used: 3 },
          sites: { max: null, used: 1 },
          storageMb: { max: null, used: null },
          aiCreditsPerMonth: { max: null, used: null },
        },
      });
      // A client with incidents is told of it the same way.
      await http()
        .get('/settings/subscription')
        .set('Cookie', on.cookie)
        .expect(200);
    });
  });

  describe('in the database', () => {
    const app = createDatabase(requireEnv('APP_DATABASE_URL'));
    const platform = createDatabase(requireEnv('PLATFORM_DATABASE_URL'));
    const tenantDb = new TenantDb(app.db);
    afterAll(() => Promise.all([app.pool.end(), platform.pool.end()]));

    it("lets the application read its own client's entitlements, never a price or the note, and write none", async () => {
      const own = await tenantDb.withTenant(on.id, (tx) =>
        tx.select({ status: subscriptions.status }).from(subscriptions),
      );
      expect(own).toEqual([{ status: 'active' }]);
      const theirs = await tenantDb.withTenant(on.id, (tx) =>
        tx
          .select({ status: subscriptions.status })
          .from(subscriptions)
          .where(eq(subscriptions.tenantId, off.id)),
      );
      expect(theirs).toEqual([]);
      const denied = { cause: { code: '42501' } };
      await expect(
        tenantDb.withTenant(on.id, (tx) =>
          tx.select({ note: subscriptions.note }).from(subscriptions),
        ),
      ).rejects.toMatchObject(denied);
      await expect(
        app.db.select({ prices: plans.prices }).from(plans),
      ).rejects.toMatchObject(denied);
      await expect(
        tenantDb.withTenant(on.id, (tx) =>
          tx.update(subscriptions).set({ status: 'active' }),
        ),
      ).rejects.toMatchObject(denied);
      await expect(
        app.db.update(plans).set({ active: true }).where(eq(plans.id, docs.id)),
      ).rejects.toMatchObject(denied);
    });

    it("lets the admin portal add to a client's audit log, never read it", async () => {
      await expect(
        platform.db.select().from(auditLog).limit(1),
      ).rejects.toMatchObject({
        cause: { code: '42501' },
      });
      await expect(platform.db.delete(plans)).rejects.toMatchObject({
        cause: { code: '42501' },
      });
    });
  });

  describe('the clients that existed before plans', () => {
    const statements = readFileSync(
      resolve(
        import.meta.dirname,
        '../drizzle/0033_subscriptions_grants_and_existing_clients.sql',
      ),
      'utf8',
    )
      .split('--> statement-breakpoint')
      // The data it moves, without its grants: a grant would hold the
      // tables against every other test file until this one rolls back.
      .filter((s) => !/^\s*GRANT/m.test(s.replace(/--.*$/gm, '')));

    it('all have a subscription', async () => {
      const { rows } = await bench.owner.db.execute(
        sql`select t.slug from tenants t where not exists (select from subscriptions s where s.tenant_id = t.id)`,
      );
      expect(rows).toEqual([]);
    });

    it('are each given an active subscription on a plan with every module and no limit', async () => {
      const rollback = new Error('rollback');
      let found: unknown;
      await expect(
        bench.owner.db.transaction(async (tx) => {
          const [legacy] = await tx
            .insert(tenants)
            .values({
              slug: `${prefix}-legacy`,
              name: { en: 'Before plans' },
              accreditationStandard: 'JCI',
              timeZone: 'Asia/Riyadh',
              createdAt: new Date('2026-03-01T22:30:00Z'),
            })
            .returning({ id: tenants.id });
          // On this run's clients only: see applyToOwnRows.
          await applyToOwnRows(tx, statements, {
            tenants: startsWith('slug', prefix),
          });
          const [row] = await tx
            .select({
              status: subscriptions.status,
              startsOn: subscriptions.startsOn,
              addOnModules: subscriptions.addOnModules,
              code: plans.code,
              modules: plans.modules,
              limits: plans.limits,
              extras: plans.extras,
              active: plans.active,
            })
            .from(subscriptions)
            .innerJoin(plans, eq(plans.id, subscriptions.planId))
            .where(eq(subscriptions.tenantId, legacy.id));
          // Clients made through the API this run kept the plan they were on.
          const [kept] = await tx
            .select({ planId: subscriptions.planId })
            .from(subscriptions)
            .where(eq(subscriptions.tenantId, off.id));
          found = { ...row, keptDocs: kept.planId === docs.id };
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(found).toEqual({
        status: 'active',
        // The day it was created, in its own time zone.
        startsOn: '2026-03-02',
        addOnModules: [],
        code: 'everything',
        // Every module there is: a new module in the code needs this plan
        // given it by a migration, or the clients on it lose nothing but
        // also never get it.
        modules: [...MODULES],
        limits: NO_LIMITS,
        extras: {
          sso: true,
          publicReporting: true,
          clinicalAiSuggestions: false,
        },
        active: true,
        keptDocs: true,
      });
    });
  });
});
