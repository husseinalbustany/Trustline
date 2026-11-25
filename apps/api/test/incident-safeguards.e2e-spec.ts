import '../src/env.js';
import { createHash, randomBytes } from 'node:crypto';
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
import {
  FOLLOW_UP_ATTEMPTS_PER_HOUR,
  PUBLIC_REPORTS_PER_HOUR,
} from '../src/incidents/public-limits.js';
import { createPlatformAdmin } from '../src/platform/create-admin.js';
import { removeTestData } from './cleanup.js';

/**
 * The three safeguards of docs/specs/incident-safeguards-and-deadlines.md:
 * who sees the reporter, reporting without sign-in with its follow-up code,
 * and the second sign-off for a sentinel event.
 */
describe('incident safeguards', () => {
  const run = randomBytes(4).toString('hex');
  const prefix = `sg-${run}`;
  const staffEmail = `staff-sg-${run}@test.invalid`;
  const staffPassword = `platform-pass-${run}`;
  const password = `hospital-pass-${run}`;
  const year = new Date().getUTCFullYear();
  const CODE = /^([2-9A-HJKMNP-Z]{4}-){3}[2-9A-HJKMNP-Z]{4}$/;
  // The owner role: to build the org unit tree and to look at what was stored.
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  let app: INestApplication<App>;
  let platform: string;
  const http = () => request(app.getHttpServer());

  type Hospital = {
    id: string;
    slug: string;
    cookie: string;
    adminId: string;
    roles: Record<string, string>;
    categories: Record<string, string>;
  };
  type Staff = { id: string; email: string; name: string; cookie: string };
  type Reported = { id: string; reference: string };
  type Person = { id: string; name: Record<string, string> } | null;
  type Event = {
    id: string;
    kind: string;
    actor: Person;
    byReporter: boolean;
    fromStatus: string | null;
    toStatus: string | null;
    details: Record<string, unknown> | null;
  };
  type Comment = {
    id: string;
    author: Person;
    byReporter: boolean;
    body: string;
    visibility: string;
  };
  type Move = { to: string; noteRequired: boolean; action: string };

  let a: Hospital; // takes public reports
  let b: Hospital; // takes them too: another hospital entirely
  let off: Hospital; // has never switched public reporting on
  let suspended: Hospital; // switched it on, then was suspended

  let facility: string;
  let ward: string;
  let lab: string;
  let wardUnit: string;
  let closedUnit: string; // switched off
  let bUnit: string;

  let reporter: Staff; // may report, and nothing else
  let assignee: Staff; // the same, and has incidents assigned
  let manager: Staff; // department manager everywhere: sees all, not who reported
  let quality: Staff; // quality officer everywhere
  let quality2: Staff; // another
  let wardQuality: Staff; // quality officer for the ward department only
  let labQuality: Staff; // and for the laboratory only
  let triageOnly: Staff; // views and triages everywhere; no sign-off, no reporter
  let signOnly: Staff; // views and signs off everywhere; cannot triage

  const cookieOf = (res: request.Response) =>
    res.get('Set-Cookie')![0].split(';')[0];

  const login = (org: string, email: string) =>
    http().post('/auth/login').send({ org, email, password });

  async function createHospital(suffix: string): Promise<Hospital> {
    const slug = `${prefix}-${suffix}`;
    const adminEmail = `admin-sg-${suffix}-${run}@test.invalid`;
    const tenant = await http()
      .post('/platform/tenants')
      .set('Cookie', platform)
      .send({
        slug,
        name: { en: `Hospital ${suffix}` },
        accreditationStandard: 'JCI',
        locales: ['en'],
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
    tenantId: string,
    type: 'facility' | 'department' | 'unit',
    code: string,
    parentId: string | null,
    active = true,
  ) {
    const [unit] = await owner.db
      .insert(orgUnits)
      .values({
        tenantId,
        type,
        code,
        parentId,
        active,
        name: { en: `Unit ${code}` },
      })
      .returning({ id: orgUnits.id });
    return unit.id;
  }

  /** Adds a role of hospital A's own, with exactly these permissions. */
  async function createRole(code: string, permissions: string[]) {
    const role = await http()
      .post('/roles')
      .set('Cookie', a.cookie)
      .send({ code, name: { en: code }, permissions })
      .expect(201);
    a.roles[code] = role.body.id;
  }

  /** Creates a user in hospital A with one role, and signs them in. */
  async function createStaff(
    name: string,
    grant: { role: string; orgUnitId: string | null } | null,
  ): Promise<Staff> {
    const email = `${name}-sg-${run}@test.invalid`;
    const created = await http()
      .post('/users')
      .set('Cookie', a.cookie)
      .send({
        name: { en: `Person ${name}` },
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
    return {
      id: created.body.user.id as string,
      email,
      name: `Person ${name}`,
      cookie,
    };
  }

  /** What a report says, without the `anonymous` flag of the signed-in form. */
  const reportBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'incident',
    categoryId: a.categories.equipment,
    orgUnitId: ward,
    occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
    description: 'An infusion pump alarm did not sound.',
    harmLevel: 'none',
    ...overrides,
  });

  async function report(
    who: Staff,
    overrides: Record<string, unknown> = {},
  ): Promise<Reported & { followUpCode?: string }> {
    const res = await http()
      .post('/incidents')
      .set('Cookie', who.cookie)
      .send(reportBody({ anonymous: false, ...overrides }))
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
        ownerUnitId: ward,
        ...overrides,
      });

  const move = (
    cookie: string,
    id: string,
    to: string,
    note?: string,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post(`/incidents/${id}/status`)
      .set('Cookie', cookie)
      .send({ to, ...(note !== undefined && { note }), ...extra });

  const open = (cookie: string, id: string) =>
    http().get(`/incidents/${id}`).set('Cookie', cookie);

  const comment = (
    cookie: string,
    id: string,
    body: string,
    visibility: string,
  ) =>
    http()
      .post(`/incidents/${id}/comments`)
      .set('Cookie', cookie)
      .send({ body, visibility });

  // The limits on the public routes are counted per address, and every test
  // here runs against one API process. So each request that is not about the
  // limits comes from an address of its own.
  let addresses = 0;
  const freshAddress = () => {
    addresses += 1;
    return `198.51.${Math.floor(addresses / 250)}.${(addresses % 250) + 1}`;
  };
  /** A request from the internet: no session, and the address the proxy saw. */
  const publicPost = (path: string, body: object, address = freshAddress()) =>
    http().post(path).set('X-Forwarded-For', address).send(body);

  const reportPublicly = (
    slug: string,
    overrides: Record<string, unknown> = {},
    address?: string,
  ) => publicPost(`/public/reporting/${slug}`, reportBody(overrides), address);

  const followUp = (
    slug: string,
    reference: string,
    code: string,
    address?: string,
  ) => publicPost(`/public/follow-up/${slug}`, { reference, code }, address);

  const followUpComment = (
    slug: string,
    reference: string,
    code: string,
    body: string,
    address?: string,
  ) =>
    publicPost(
      `/public/follow-up/${slug}/comments`,
      { reference, code, body },
      address,
    );

  const setPublicReporting = (cookie: string, publicReporting: boolean) =>
    http()
      .put('/settings/reporting')
      .set('Cookie', cookie)
      .send({ publicReporting });

  /** A sentinel event in the ward, triaged: closing it needs two people. */
  async function sentinel(overrides: Record<string, unknown> = {}) {
    const reported = await report(reporter, { harmLevel: 'severe' });
    await triage(quality.cookie, reported.id, {
      harmLevel: 'severe',
      isSentinel: true,
      ...overrides,
    }).expect(200);
    return reported;
  }

  const PROPOSAL = `Proposed summary ${run}`;
  /** The same, with its closure asked for by `quality`. */
  async function awaitingSignOff(overrides: Record<string, unknown> = {}) {
    const reported = await sentinel(overrides);
    await move(
      quality.cookie,
      reported.id,
      'awaiting_sign_off',
      PROPOSAL,
    ).expect(200);
    return reported;
  }

  const stored = async (id: string) =>
    (
      await owner.db.execute<{
        status: string;
        reported_by: string | null;
        channel: string;
        follow_up_code_hash: string | null;
        closed_by: string | null;
        closed_at: string | null;
        closure_summary: string | null;
        closure_requested_by: string | null;
        closure_requested_at: string | null;
      }>(
        sql`select status, reported_by, channel, follow_up_code_hash, closed_by, closed_at, closure_summary, closure_requested_by, closure_requested_at from incidents where id = ${id}`,
      )
    ).rows[0];

  const idOf = async (tenantId: string, reference: string) =>
    (
      await owner.db.execute<{ id: string }>(
        sql`select id from incidents where tenant_id = ${tenantId} and reference = ${reference}`,
      )
    ).rows[0].id;

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
    off = await createHospital('off');
    suspended = await createHospital('gone');

    facility = await createUnit(a.id, 'facility', 'MAIN', null);
    ward = await createUnit(a.id, 'department', 'WARD', facility);
    lab = await createUnit(a.id, 'department', 'LAB', facility);
    wardUnit = await createUnit(a.id, 'unit', 'WARD-3', ward);
    closedUnit = await createUnit(a.id, 'department', 'OLD', facility, false);
    bUnit = await createUnit(b.id, 'facility', 'MAIN', null);
    await createUnit(off.id, 'facility', 'MAIN', null);
    await createUnit(suspended.id, 'facility', 'MAIN', null);

    await createRole('triage_only', ['incidents.view', 'incidents.triage']);
    await createRole('sign_only', ['incidents.view', 'incidents.sign_off']);

    const everywhere = (role: string) => ({ role, orgUnitId: null });
    reporter = await createStaff('nadia', everywhere('reporter'));
    assignee = await createStaff('assignee', everywhere('reporter'));
    manager = await createStaff('manager', everywhere('department_manager'));
    quality = await createStaff('quality', everywhere('quality_officer'));
    quality2 = await createStaff('quality2', everywhere('quality_officer'));
    wardQuality = await createStaff('ward-quality', {
      role: 'quality_officer',
      orgUnitId: ward,
    });
    labQuality = await createStaff('lab-quality', {
      role: 'quality_officer',
      orgUnitId: lab,
    });
    triageOnly = await createStaff('triage-only', everywhere('triage_only'));
    signOnly = await createStaff('sign-only', everywhere('sign_only'));

    await setPublicReporting(a.cookie, true).expect(200);
    await setPublicReporting(b.cookie, true).expect(200);
    await setPublicReporting(suspended.cookie, true).expect(200);
    await http()
      .patch(`/platform/tenants/${suspended.id}`)
      .set('Cookie', platform)
      .send({ status: 'suspended' })
      .expect(200);
  }, 180_000);

  afterAll(async () => {
    await removeTestData(prefix, staffEmail);
    await owner.pool.end();
    await app.close();
  });

  describe('the built-in roles', () => {
    it('give the two new rights to the administrator and the quality officer only', async () => {
      const res = await http()
        .get('/roles')
        .set('Cookie', a.cookie)
        .expect(200);
      expect(res.body.permissions).toEqual(
        expect.arrayContaining([
          'incidents.see_reporter',
          'incidents.sign_off',
        ]),
      );
      const held = Object.fromEntries(
        res.body.roles.map((r: { code: string; permissions: string[] }) => [
          r.code,
          r.permissions.filter((p) =>
            ['incidents.see_reporter', 'incidents.sign_off'].includes(p),
          ),
        ]),
      );
      expect(held.administrator.sort()).toEqual([
        'incidents.see_reporter',
        'incidents.sign_off',
      ]);
      expect(held.quality_officer.sort()).toEqual([
        'incidents.see_reporter',
        'incidents.sign_off',
      ]);
      expect(held.department_manager).toEqual([]);
      expect(held.reporter).toEqual([]);
    });

    it('scope the right to see the reporter like any other', async () => {
      const me = await http()
        .get('/auth/me')
        .set('Cookie', wardQuality.cookie)
        .expect(200);
      expect(me.body.scope['incidents.see_reporter']).toEqual(
        [ward, wardUnit].sort(),
      );
      expect(me.body.scope['incidents.sign_off']).toEqual(
        [ward, wardUnit].sort(),
      );
    });
  });

  describe('who sees the reporter', () => {
    let named: Reported;
    let anonymous: Reported & { followUpCode?: string };

    const outline = (body: {
      reporter: Person;
      reporterShown: boolean;
      channel: string | null;
      events: Event[];
      comments: Comment[];
      people: Record<string, unknown>;
    }) => ({
      fields: Object.keys(body).sort(),
      reporter: body.reporter,
      reporterShown: body.reporterShown,
      channel: body.channel,
      events: body.events.map((e) => [
        e.kind,
        e.actor ? 'someone' : null,
        e.byReporter,
        Object.keys(e).sort().join(),
      ]),
      comments: body.comments.map((c) => [
        c.author ? 'someone' : null,
        c.byReporter,
        c.visibility,
        Object.keys(c).sort().join(),
      ]),
      people: Object.keys(body.people).length,
    });

    beforeAll(async () => {
      // Two reports with the same life, one named and one anonymous.
      named = await report(reporter);
      anonymous = await report(reporter, { anonymous: true });
      for (const { id } of [named, anonymous]) {
        await triage(quality.cookie, id, { assignedTo: assignee.id }).expect(
          200,
        );
      }
      await comment(
        reporter.cookie,
        named.id,
        'One more detail.',
        'everyone',
      ).expect(201);
      await followUpComment(
        a.slug,
        anonymous.reference,
        anonymous.followUpCode!,
        'One more detail.',
      ).expect(201);
      for (const { id } of [named, anonymous]) {
        await comment(quality.cookie, id, 'Thank you.', 'everyone').expect(201);
      }
    });

    it('shows the quality office who reported, and when nobody is named', async () => {
      const res = await open(quality.cookie, named.id).expect(200);
      expect(res.body).toMatchObject({
        reporter: { id: reporter.id, name: { en: reporter.name } },
        reporterShown: true,
        channel: 'app',
      });
      const events = res.body.events as Event[];
      expect(events.map((e) => [e.kind, e.actor?.id, e.byReporter])).toEqual([
        ['reported', reporter.id, true],
        ['triaged', quality.id, false],
        ['assigned', quality.id, false],
        ['commented', reporter.id, true],
        ['commented', quality.id, false],
      ]);
      const comments = res.body.comments as Comment[];
      expect(comments.map((c) => [c.author?.id, c.byReporter])).toEqual([
        [reporter.id, true],
        [quality.id, false],
      ]);

      const other = await open(quality.cookie, anonymous.id).expect(200);
      // Allowed to see, and there is nobody to see: it was anonymous.
      expect(other.body).toMatchObject({
        reporter: null,
        reporterShown: true,
        channel: 'app',
      });
      expect(
        (other.body.events as Event[]).map((e) => [
          e.kind,
          e.actor?.id,
          e.byReporter,
        ]),
      ).toEqual([
        ['reported', undefined, true],
        ['triaged', quality.id, false],
        ['assigned', quality.id, false],
        ['commented', undefined, true],
        ['commented', quality.id, false],
      ]);
      expect(
        (other.body.comments as Comment[]).map((c) => [
          c.author?.id,
          c.byReporter,
        ]),
      ).toEqual([
        [undefined, true],
        [quality.id, false],
      ]);
    });

    it('does not tell a handler without the right, anywhere in the answer', async () => {
      const res = await open(manager.cookie, named.id).expect(200);
      expect(res.body).toMatchObject({
        access: 'full',
        reporter: null,
        reporterShown: false,
        channel: null,
      });
      const events = res.body.events as Event[];
      expect(events.map((e) => [e.kind, e.actor?.id, e.byReporter])).toEqual([
        ['reported', undefined, true],
        ['triaged', quality.id, false],
        ['assigned', quality.id, false],
        ['commented', undefined, true],
        ['commented', quality.id, false],
      ]);
      expect(events[0]).toEqual({
        id: expect.any(String),
        kind: 'reported',
        occurredAt: expect.any(String),
        actor: null,
        byReporter: true,
        fromStatus: null,
        toStatus: 'new',
        details: null,
      });
      const comments = res.body.comments as Comment[];
      expect(comments[0]).toEqual({
        id: expect.any(String),
        author: null,
        byReporter: true,
        body: 'One more detail.',
        visibility: 'everyone',
        createdAt: expect.any(String),
      });
      expect(comments[1]).toMatchObject({
        author: { id: quality.id },
        byReporter: false,
      });
      // Only the person it was assigned to is named among the people.
      expect(Object.keys(res.body.people)).toEqual([assignee.id]);
      // Not the id to compare with, not the name, in any field at all.
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(reporter.id);
      expect(body).not.toContain(reporter.name);
      expect(body).not.toContain(reporter.email);
    });

    it('makes a named report and an anonymous one look the same to that handler', async () => {
      const one = await open(manager.cookie, named.id).expect(200);
      const other = await open(manager.cookie, anonymous.id).expect(200);
      expect(outline(one.body)).toEqual(outline(other.body));
      expect(outline(one.body)).toMatchObject({
        reporter: null,
        reporterShown: false,
        channel: null,
      });
      // To the quality office they do differ: that is the point of the right.
      const seen = await open(quality.cookie, named.id).expect(200);
      const unseen = await open(quality.cookie, anonymous.id).expect(200);
      expect(outline(seen.body)).not.toEqual(outline(unseen.body));
    });

    it('does not tell them that a report came through the public link', async () => {
      const sent = await reportPublicly(a.slug).expect(201);
      const id = await idOf(a.id, sent.body.reference);
      const hidden = await open(manager.cookie, id).expect(200);
      expect(hidden.body).toMatchObject({
        reporter: null,
        reporterShown: false,
        channel: null,
      });
      expect(JSON.stringify(hidden.body)).not.toContain('public');
      const shown = await open(quality.cookie, id).expect(200);
      expect(shown.body).toMatchObject({
        reporter: null,
        reporterShown: true,
        channel: 'public',
      });
    });

    it('does not tell the person it is assigned to', async () => {
      const res = await open(assignee.cookie, named.id).expect(200);
      expect(res.body).toMatchObject({
        access: 'full',
        assignedTo: { id: assignee.id },
        reporter: null,
        reporterShown: false,
      });
      expect((res.body.events as Event[])[0]).toMatchObject({
        kind: 'reported',
        actor: null,
        byReporter: true,
      });
      expect(JSON.stringify(res.body)).not.toContain(reporter.id);
      expect(JSON.stringify(res.body)).not.toContain(reporter.name);
    });

    it('follows where the right was granted, not where the holder works', async () => {
      // Happened in the laboratory, handled there, assigned to someone whose
      // right to see reporters is for the ward.
      const { id } = await report(reporter, { orgUnitId: lab });
      await triage(quality.cookie, id, {
        ownerUnitId: lab,
        assignedTo: wardQuality.id,
      }).expect(200);
      const outside = await open(wardQuality.cookie, id).expect(200);
      expect(outside.body).toMatchObject({
        access: 'full',
        canTriage: false,
        reporter: null,
        reporterShown: false,
      });
      expect(JSON.stringify(outside.body)).not.toContain(reporter.id);
      // The laboratory's own quality officer is told.
      const inside = await open(labQuality.cookie, id).expect(200);
      expect(inside.body).toMatchObject({
        reporter: { id: reporter.id },
        reporterShown: true,
      });
      // Handed to the ward, it falls under the ward officer's right.
      await triage(quality.cookie, id, {
        ownerUnitId: ward,
        assignedTo: wardQuality.id,
      }).expect(200);
      const now = await open(wardQuality.cookie, id).expect(200);
      expect(now.body).toMatchObject({
        reporter: { id: reporter.id },
        reporterShown: true,
      });
    });

    it('leaves the reporter their own view', async () => {
      const res = await open(reporter.cookie, named.id).expect(200);
      expect(res.body).toMatchObject({
        access: 'reporter',
        reporter: { id: reporter.id, name: { en: reporter.name } },
        reporterShown: true,
        channel: 'app',
        assignedTo: null,
      });
      expect((res.body.events as Event[])[0]).toMatchObject({
        kind: 'reported',
        actor: { id: reporter.id },
        byReporter: true,
      });
      expect((res.body.comments as Comment[])[0]).toMatchObject({
        author: { id: reporter.id },
        byReporter: true,
      });
    });

    it('hides the reporter as reporter even when they also handle the incident', async () => {
      // A quality officer reports, then triages and comments on their own
      // report. What they did as a handler is under their name; that the
      // report and the comments are theirs is not said.
      const { id } = await report(quality2);
      await triage(quality2.cookie, id).expect(200);
      await comment(quality2.cookie, id, 'Seen it myself.', 'internal').expect(
        201,
      );
      const res = await open(manager.cookie, id).expect(200);
      expect(res.body).toMatchObject({ reporter: null, reporterShown: false });
      expect(
        (res.body.events as Event[]).map((e) => [
          e.kind,
          e.actor?.id,
          e.byReporter,
        ]),
      ).toEqual([
        ['reported', undefined, true],
        ['triaged', quality2.id, false],
        ['assigned', quality2.id, false],
        ['commented', undefined, true],
      ]);
      expect((res.body.comments as Comment[])[0]).toMatchObject({
        author: null,
        byReporter: true,
      });
    });

    it('hides it in the answers to a triage and to a change of status too', async () => {
      const { id } = await report(reporter);
      const triaged = await triage(triageOnly.cookie, id).expect(200);
      expect(triaged.body).toMatchObject({
        status: 'triaged',
        canTriage: true,
        reporter: null,
        reporterShown: false,
      });
      expect(JSON.stringify(triaged.body)).not.toContain(reporter.id);
      const moved = await move(triageOnly.cookie, id, 'in_progress').expect(
        200,
      );
      expect(moved.body).toMatchObject({
        reporter: null,
        reporterShown: false,
      });
      expect(JSON.stringify(moved.body)).not.toContain(reporter.id);
      const written = await comment(
        triageOnly.cookie,
        id,
        'Looking.',
        'everyone',
      ).expect(201);
      expect(Object.keys(written.body).sort()).toEqual([
        'createdAt',
        'id',
        'visibility',
      ]);
    });

    it('never carried the reporter in lists, summaries or the people to assign', async () => {
      const list = await http()
        .get('/incidents?pageSize=100')
        .set('Cookie', manager.cookie)
        .expect(200);
      expect(list.body.total).toBeGreaterThan(0);
      for (const item of list.body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'assignedToMe',
          'category',
          'descriptionExcerpt',
          'harmLevel',
          'id',
          'isSentinel',
          'occurredAt',
          'orgUnit',
          'ownerUnit',
          'reference',
          'reportedAt',
          'status',
          'type',
        ]);
      }
      expect(JSON.stringify(list.body)).not.toContain(reporter.id);
      const summary = await http()
        .get('/incidents/summary')
        .set('Cookie', manager.cookie)
        .expect(200);
      expect(Object.keys(summary.body).sort()).toEqual([
        'assignedToMe',
        'awaitingTriage',
        'closedLast30Days',
        'medianSecondsToReport',
        'open',
        'serious',
      ]);
      // Everyone active is listed for assigning, with nothing about reports.
      const people = await http()
        .get('/incidents/assignable-users')
        .set('Cookie', triageOnly.cookie)
        .expect(200);
      for (const person of people.body) {
        expect(Object.keys(person).sort()).toEqual(['id', 'name', 'orgUnitId']);
      }
    });

    it('offers no filter that would find the reports of one person', async () => {
      for (const query of [
        `reportedBy=${reporter.id}`,
        `reporter=${reporter.id}`,
        'channel=public',
        'anonymous=true',
      ]) {
        await http()
          .get(`/incidents?${query}`)
          .set('Cookie', manager.cookie)
          .expect(400);
      }
      // "Reported by me" is about the caller alone.
      const mine = await http()
        .get('/incidents?mine=true')
        .set('Cookie', manager.cookie)
        .expect(200);
      expect(mine.body).toEqual({ items: [], total: 0 });
    });
  });

  describe('the switch for reporting without sign-in', () => {
    const reporting = (cookie: string) =>
      http().get('/settings/reporting').set('Cookie', cookie);
    const changes = async (tenantId: string) =>
      (
        await owner.db.execute<{
          actor_id: string | null;
          entity_type: string;
          entity_id: string;
          changes: unknown;
        }>(
          sql`select actor_id, entity_type, entity_id, changes from audit_log where tenant_id = ${tenantId} and action = 'public_reporting_changed' order by occurred_at, id`,
        )
      ).rows;

    it('needs a session', async () => {
      await http().get('/settings/reporting').expect(401);
      await http()
        .put('/settings/reporting')
        .send({ publicReporting: true })
        .expect(401);
    });

    it('is off until the hospital switches it on, and says so', async () => {
      const res = await reporting(off.cookie).expect(200);
      expect(res.body).toEqual({ publicReporting: false, slug: off.slug });
      const me = await http().get('/auth/me').set('Cookie', off.cookie);
      expect(me.body.tenant.publicReporting).toBe(false);
      expect(await changes(off.id)).toEqual([]);
    });

    it('refuses anyone without the right to manage settings for the whole hospital', async () => {
      // An administrator of one department holds the right for it alone.
      const local = await createStaff('ward-admin', {
        role: 'administrator',
        orgUnitId: ward,
      });
      for (const who of [reporter, quality, manager, local]) {
        const read = await reporting(who.cookie).expect(403);
        expect(read.body.code).toBe('missing_permission');
        const write = await setPublicReporting(who.cookie, false).expect(403);
        expect(write.body.code).toBe('missing_permission');
      }
      expect((await reporting(a.cookie).expect(200)).body.publicReporting).toBe(
        true,
      );
    });

    it('refuses invalid input', async () => {
      for (const body of [
        {},
        { publicReporting: 'yes' },
        { publicReporting: null },
        { publicReporting: true, slug: b.slug },
        { publicReporting: true, tenantId: b.id },
      ]) {
        await http()
          .put('/settings/reporting')
          .set('Cookie', off.cookie)
          .send(body)
          .expect(400);
      }
      expect((await reporting(off.cookie)).body.publicReporting).toBe(false);
    });

    it("switches it for the caller's own hospital only, and records each real change", async () => {
      // Hospital A was switched on in the setup.
      expect(await changes(a.id)).toEqual([
        {
          actor_id: a.adminId,
          entity_type: 'tenant',
          entity_id: a.id,
          changes: { from: false, to: true },
        },
      ]);
      // Asking for what is already so changes and records nothing.
      const same = await setPublicReporting(a.cookie, true).expect(200);
      expect(same.body).toEqual({ publicReporting: true, slug: a.slug });
      expect(await changes(a.id)).toHaveLength(1);

      const turnedOff = await setPublicReporting(a.cookie, false).expect(200);
      expect(turnedOff.body).toEqual({ publicReporting: false, slug: a.slug });
      expect((await reporting(a.cookie)).body.publicReporting).toBe(false);
      const me = await http().get('/auth/me').set('Cookie', a.cookie);
      expect(me.body.tenant.publicReporting).toBe(false);
      await setPublicReporting(a.cookie, true).expect(200);
      expect((await changes(a.id)).map((r) => r.changes)).toEqual([
        { from: false, to: true },
        { from: true, to: false },
        { from: false, to: true },
      ]);

      // Nothing of this touched the others.
      expect((await reporting(off.cookie)).body.publicReporting).toBe(false);
      expect((await reporting(b.cookie)).body.publicReporting).toBe(true);
      const flags = await owner.db.execute<{ slug: string; on: boolean }>(
        sql`select slug, public_reporting as on from tenants where slug like ${`${prefix}-%`} order by slug`,
      );
      expect(flags.rows).toEqual([
        { slug: a.slug, on: true },
        { slug: b.slug, on: true },
        { slug: suspended.slug, on: true },
        { slug: off.slug, on: false },
      ]);
    });
  });

  describe('the public report form', () => {
    const form = (slug: string) => http().get(`/public/reporting/${slug}`);

    it('gives what the form needs, and nothing else about the hospital', async () => {
      const res = await form(a.slug).expect(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'categories',
        'defaultLocale',
        'locales',
        'name',
        'orgUnits',
      ]);
      expect(res.body).toMatchObject({
        name: { en: 'Hospital a' },
        locales: ['en'],
        defaultLocale: 'en',
      });
      const units = res.body.orgUnits as Record<string, unknown>[];
      for (const unit of units) {
        expect(Object.keys(unit).sort()).toEqual([
          'id',
          'name',
          'parentId',
          'type',
        ]);
      }
      // The ones in use, as a tree: not the one switched off.
      expect(units.map((u) => String(u.id)).sort()).toEqual(
        [facility, ward, lab, wardUnit].sort(),
      );
      expect(units.find((u) => u.id === wardUnit)).toEqual({
        id: wardUnit,
        parentId: ward,
        type: 'unit',
        name: { en: 'Unit WARD-3' },
      });
      const categories = res.body.categories as Record<string, unknown>[];
      expect(categories).toHaveLength(10);
      expect(Object.keys(categories[0]).sort()).toEqual(['code', 'id', 'name']);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(a.id);
      expect(body).not.toContain('@');
    });

    it('finds the hospital whatever the letter case of its identifier', async () => {
      await form(a.slug.toUpperCase()).expect(200);
    });

    it('answers the same 404 for no hospital, a suspended one, and one that has it off', async () => {
      const unknown = await form(`${prefix}-nowhere`).expect(404);
      const turnedOff = await form(off.slug).expect(404);
      const gone = await form(suspended.slug).expect(404);
      expect(turnedOff.body).toEqual(unknown.body);
      expect(gone.body).toEqual(unknown.body);
      expect(turnedOff.headers['content-length']).toBe(
        unknown.headers['content-length'],
      );
      for (const slug of [`${prefix}-nowhere`, off.slug, suspended.slug]) {
        const posted = await reportPublicly(slug).expect(404);
        expect(posted.body).toEqual(unknown.body);
        const opened = await followUp(slug, `INC-${year}-00001`, 'x').expect(
          404,
        );
        expect(opened.body).toEqual(unknown.body);
        const said = await followUpComment(
          slug,
          `INC-${year}-00001`,
          'x',
          'Hello',
        ).expect(404);
        expect(said.body).toEqual(unknown.body);
      }
      const none = await owner.db.execute(
        sql`select 1 from incidents where tenant_id in (${off.id}, ${suspended.id})`,
      );
      expect(none.rows).toHaveLength(0);
    });
  });

  describe('a report without sign-in', () => {
    const SENDER = '203.0.113.77';
    const DEVICE = `Device-${run}`;

    it('is taken, numbered, and answered with a reference and a follow-up code only', async () => {
      const res = await reportPublicly(a.slug, {
        description: '  A wet floor had no sign.  ',
        orgUnitId: wardUnit,
      }).expect(201);
      expect(Object.keys(res.body).sort()).toEqual([
        'followUpCode',
        'reference',
      ]);
      expect(res.body.reference).toMatch(new RegExp(`^INC-${year}-\\d{5}$`));
      expect(res.body.followUpCode).toMatch(CODE);

      const id = await idOf(a.id, res.body.reference);
      const seen = await open(quality.cookie, id).expect(200);
      expect(seen.body).toMatchObject({
        status: 'new',
        description: 'A wet floor had no sign.',
        orgUnit: { id: wardUnit },
        channel: 'public',
        reporter: null,
        reporterShown: true,
      });
    });

    it('stores the code as a hash, and nothing about who sent it', async () => {
      const res = await http()
        .post(`/public/reporting/${a.slug}`)
        .set('X-Forwarded-For', SENDER)
        .set('User-Agent', DEVICE)
        // Signed in while reporting through the public link: still nobody.
        .set('Cookie', reporter.cookie)
        .send(reportBody())
        .expect(201);
      const id = await idOf(a.id, res.body.reference);
      const row = await stored(id);
      expect(row).toMatchObject({ reported_by: null, channel: 'public' });
      const code = res.body.followUpCode as string;
      expect(row.follow_up_code_hash).toBe(
        createHash('sha256').update(code.replaceAll('-', '')).digest('hex'),
      );

      const events = await owner.db.execute(
        sql`select kind, actor_id, details from incident_events where incident_id = ${id}`,
      );
      expect(events.rows).toEqual([
        { kind: 'reported', actor_id: null, details: null },
      ]);
      const audit = await owner.db.execute(
        sql`select action, actor_id, ip_address, changes from audit_log where tenant_id = ${a.id} and entity_id = ${id}`,
      );
      // That a public report was received, and nothing more.
      expect(audit.rows).toEqual([
        {
          action: 'incident_reported',
          actor_id: null,
          ip_address: null,
          changes: {
            reference: res.body.reference,
            type: 'incident',
            anonymous: true,
            channel: 'public',
          },
        },
      ]);

      // Not the address, the device, the account or the code, in any column
      // of anything stored about this report.
      const kept = await owner.db.execute<{ row: string }>(
        sql`select to_jsonb(t)::text as row from incidents t where t.id = ${id}
            union all
            select to_jsonb(t)::text from incident_events t where t.incident_id = ${id}
            union all
            select to_jsonb(t)::text from audit_log t where t.entity_id = ${id}`,
      );
      expect(kept.rows).toHaveLength(3);
      const everything = kept.rows.map((r) => r.row).join('\n');
      for (const trace of [
        SENDER,
        DEVICE,
        reporter.id,
        code,
        code.replaceAll('-', ''),
      ]) {
        expect(everything).not.toContain(trace);
      }
      // Nor the address, the device or the code anywhere in the hospital's log.
      for (const trace of [SENDER, DEVICE, code, code.replaceAll('-', '')]) {
        const found = await owner.db.execute(
          sql`select 1 from audit_log t where t.tenant_id = ${a.id} and to_jsonb(t)::text like ${`%${trace}%`}`,
        );
        expect([trace, found.rows.length]).toEqual([trace, 0]);
      }
    });

    it('cannot be opened through the signed-in app by whoever sent it', async () => {
      const res = await http()
        .post(`/public/reporting/${a.slug}`)
        .set('X-Forwarded-For', freshAddress())
        .set('Cookie', reporter.cookie)
        .send(reportBody())
        .expect(201);
      const id = await idOf(a.id, res.body.reference);
      await open(reporter.cookie, id).expect(404);
    });

    it('applies the rules and the limits of a signed-in report', async () => {
      const refused = async (
        overrides: Record<string, unknown>,
        code?: string,
      ) => {
        const res = await reportPublicly(a.slug, overrides).expect(400);
        expect(res.body.code).toBe(code);
      };
      // A public report is always anonymous: it may not even say so.
      await refused({ anonymous: true });
      await refused({ anonymous: false });
      await refused({ reportedBy: reporter.id });
      await refused({ channel: 'app' });
      await refused({ description: '' });
      await refused({ description: 'x'.repeat(5001) });
      await refused({ immediateAction: 'x'.repeat(2001) });
      await refused({ type: 'accident' });
      await refused({ categoryId: 'not-an-id' });
      await refused({ patientName: 'nobody' });
      await refused({ categoryId: b.categories.equipment }, 'unknown_category');
      await refused({ orgUnitId: bUnit }, 'unknown_org_unit');
      await refused({ orgUnitId: closedUnit }, 'unknown_org_unit');
      await refused(
        { type: 'near_miss', harmLevel: 'mild' },
        'harm_not_applicable',
      );
      await refused(
        { occurredAt: new Date(Date.now() + 3_600_000).toISOString() },
        'occurred_in_future',
      );
      await refused(
        { occurredAt: '1899-12-31T23:59:59Z' },
        'occurred_too_long_ago',
      );
      await reportPublicly(a.slug, { description: 'x'.repeat(5000) }).expect(
        201,
      );
      // A form, not JSON: refused before it is read.
      await http()
        .post(`/public/reporting/${a.slug}`)
        .set('X-Forwarded-For', freshAddress())
        .type('form')
        .send('description=hello')
        .expect(415);
    });

    it('takes at most ten an hour from one address, whatever they contain', async () => {
      const address = freshAddress();
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        // Refused ones count too: the limit is on attempts.
        const res = await reportPublicly(
          a.slug,
          i % 2 ? {} : { description: '' },
          address,
        );
        expect(res.status).toBe(i % 2 ? 201 : 400);
      }
      const before = await owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from incidents where tenant_id = ${a.id}`,
      );
      const res = await reportPublicly(a.slug, {}, address).expect(429);
      expect(res.body).toEqual({ statusCode: 429, code: 'too_many_requests' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
      // Not by going to another hospital, real or not.
      await reportPublicly(b.slug, { orgUnitId: bUnit }, address).expect(429);
      await reportPublicly(`${prefix}-nowhere`, {}, address).expect(429);
      const after = await owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from incidents where tenant_id = ${a.id}`,
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
      // Someone else is not held up, and following up is counted apart.
      await reportPublicly(a.slug).expect(201);
      await followUp(a.slug, `INC-${year}-00001`, 'x', address).expect(404);
    });

    it('cannot be got around by writing the address of the route another way', async () => {
      const address = freshAddress();
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        await reportPublicly(a.slug, {}, address).expect(201);
      }
      const routed: string[] = [];
      for (const path of [
        `/PUBLIC/REPORTING/${a.slug}`,
        `/Public/Reporting/${a.slug}`,
        `/public/reporting/${a.slug}/`,
        `/public/reporting/${a.slug.toUpperCase()}`,
        `/public/reporting/${a.slug}?x=1`,
        `/public/reporting/${a.slug}/?x=1`,
        `//public/reporting/${a.slug}`,
        `/public//reporting/${a.slug}`,
        `/public/reporting//${a.slug}`,
        `/public/./reporting/${a.slug}`,
        `/%70ublic/reporting/${a.slug}`,
        `/public/reporting/${a.slug}%2F`,
      ]) {
        // From an address with nothing against it, to learn whether this
        // spelling reaches the route at all.
        const reached = await publicPost(path, reportBody());
        const limited = await publicPost(path, reportBody(), address);
        if (reached.status === 201) {
          routed.push(path);
          expect([path, limited.status]).toEqual([path, 429]);
        } else {
          // A spelling that leads nowhere is no way round either.
          expect([path, reached.status]).toEqual([path, 404]);
          expect([path, limited.status]).not.toEqual([path, 201]);
        }
      }
      // The spellings that do reach it include another case and a slash.
      expect(routed).toEqual(
        expect.arrayContaining([
          `/PUBLIC/REPORTING/${a.slug}`,
          `/public/reporting/${a.slug}/`,
          `/public/reporting/${a.slug.toUpperCase()}`,
        ]),
      );
    });

    it('counts the address the proxy saw, not one the sender claims', async () => {
      const real = freshAddress();
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        // A different invented address in front each time.
        await reportPublicly(a.slug, {}, `10.9.${i}.1, ${real}`).expect(201);
      }
      await reportPublicly(a.slug, {}, `10.9.99.1, ${real}`).expect(429);
      await reportPublicly(a.slug, {}, real).expect(429);
    });
  });

  describe('the follow-up code', () => {
    const INTERNAL = `internal-remark-${run}`;
    let mine: Reported & { followUpCode: string }; // through the public link
    let inApp: Reported & { followUpCode: string }; // signed in, anonymously
    let named: Reported;
    let theirs: { reference: string; followUpCode: string }; // hospital B's
    // What Nest answers for a plain NotFoundException, and nothing added.
    const NOT_FOUND = { statusCode: 404, message: 'Not Found' };

    beforeAll(async () => {
      const sent = await reportPublicly(a.slug).expect(201);
      mine = { ...sent.body, id: await idOf(a.id, sent.body.reference) };
      inApp = (await report(reporter, { anonymous: true })) as typeof inApp;
      named = await report(reporter);
      theirs = (
        await reportPublicly(b.slug, {
          categoryId: b.categories.equipment,
          orgUnitId: bUnit,
        }).expect(201)
      ).body;

      await triage(quality.cookie, mine.id, {
        assignedTo: assignee.id,
      }).expect(200);
      await comment(quality.cookie, mine.id, INTERNAL, 'internal').expect(201);
      await comment(
        quality.cookie,
        mine.id,
        'We are looking.',
        'everyone',
      ).expect(201);
    });

    it('comes with every anonymous report, and with no named one', async () => {
      expect(Object.keys(inApp).sort()).toEqual([
        'followUpCode',
        'id',
        'reference',
      ]);
      expect(inApp.followUpCode).toMatch(CODE);
      expect(inApp.followUpCode).not.toBe(mine.followUpCode);
      expect(Object.keys(named).sort()).toEqual(['id', 'reference']);
      expect((await stored(named.id)).follow_up_code_hash).toBeNull();
      expect((await stored(inApp.id)).follow_up_code_hash).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });

    it('opens the report as its reporter sees it', async () => {
      const res = await followUp(
        a.slug,
        mine.reference,
        mine.followUpCode,
      ).expect(200);
      expect(res.body).toMatchObject({
        id: mine.id,
        reference: mine.reference,
        status: 'triaged',
        access: 'reporter',
        canTriage: false,
        canRetriage: false,
        moves: [],
        reporter: null,
        reporterShown: true,
        channel: 'public',
        // The department is named, the person is not.
        ownerUnit: { id: ward },
        assignedTo: null,
        people: {},
      });
      expect((res.body.events as Event[]).map((e) => e.kind)).toEqual([
        'reported',
        'triaged',
        'commented',
      ]);
      expect((res.body.comments as Comment[]).map((c) => c.body)).toEqual([
        'We are looking.',
      ]);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(INTERNAL);
      expect(body).not.toContain(assignee.id);
      expect(body).not.toContain('internal');
      expect(body).not.toContain(mine.followUpCode);
      expect(body).not.toContain('followUpCode');

      // Field for field what a signed-in reporter gets for a report of theirs.
      const own = await open(reporter.cookie, named.id).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        Object.keys(own.body).sort(),
      );
    });

    it('is read without regard to letter case, hyphens or spaces', async () => {
      const bare = mine.followUpCode.replaceAll('-', '');
      for (const [reference, code] of [
        [mine.reference, mine.followUpCode.toLowerCase()],
        [mine.reference, bare],
        [
          mine.reference,
          ` ${bare.slice(0, 8)} ${bare.slice(8).toLowerCase()} `,
        ],
        [mine.reference.toLowerCase(), mine.followUpCode],
        [` ${mine.reference} `, mine.followUpCode],
      ]) {
        await followUp(a.slug, reference, code).expect(200);
      }
    });

    it('works for a report made anonymously while signed in, with or without a session', async () => {
      await followUp(a.slug, inApp.reference, inApp.followUpCode).expect(200);
      const res = await http()
        .post(`/public/follow-up/${a.slug}`)
        .set('X-Forwarded-For', freshAddress())
        .set('Cookie', reporter.cookie)
        .send({ reference: inApp.reference, code: inApp.followUpCode })
        .expect(200);
      expect(res.body).toMatchObject({ access: 'reporter', reporter: null });
      // Through the app itself it stays out of their reach.
      await open(reporter.cookie, inApp.id).expect(404);
    });

    it('answers every wrong pair with the same 404', async () => {
      const wrongCode = 'K7QM-2RXD-9FHT-WB3N';
      const tries: [string, string, string][] = [
        // A report that exists, with a code that is not its own.
        [a.slug, mine.reference, wrongCode],
        [a.slug, mine.reference, inApp.followUpCode],
        [a.slug, mine.reference, mine.followUpCode.slice(0, -1)],
        [a.slug, mine.reference, `${mine.followUpCode}2`],
        [a.slug, mine.reference, 'x'],
        // A reference that does not exist, with a code that does.
        [a.slug, `INC-${year}-99999`, mine.followUpCode],
        [a.slug, 'not-a-reference', mine.followUpCode],
        // A named report has no code at all.
        [a.slug, named.reference, mine.followUpCode],
        [a.slug, named.reference, ''.padEnd(16, '2')],
        // Another hospital's report, asked for here; and ours, asked there.
        [a.slug, theirs.reference, theirs.followUpCode],
        [b.slug, mine.reference, mine.followUpCode],
        // The right pair, where there is no hospital to ask.
        [`${prefix}-nowhere`, mine.reference, mine.followUpCode],
        [off.slug, mine.reference, mine.followUpCode],
        [suspended.slug, mine.reference, mine.followUpCode],
      ];
      for (const [slug, reference, code] of tries) {
        const res = await followUp(slug, reference, code);
        expect([slug, reference, code, res.status]).toEqual([
          slug,
          reference,
          code,
          404,
        ]);
        expect(res.body).toEqual(NOT_FOUND);
        expect(res.headers['retry-after']).toBeUndefined();
        const said = await followUpComment(slug, reference, code, 'Hello');
        expect(said.status).toBe(404);
        expect(said.body).toEqual(NOT_FOUND);
      }
      // And none of those attempts wrote anything.
      const comments = await owner.db.execute(
        sql`select 1 from incident_comments where body = 'Hello' and tenant_id in (${a.id}, ${b.id})`,
      );
      expect(comments.rows).toHaveLength(0);
      // The other hospital's own pair does work where it belongs.
      await followUp(b.slug, theirs.reference, theirs.followUpCode).expect(200);
    });

    it('refuses a request that is not a reference and a code', async () => {
      for (const body of [
        {},
        { reference: mine.reference },
        { code: mine.followUpCode },
        { reference: mine.reference, code: 12345 },
        { reference: ['x'], code: mine.followUpCode },
        { reference: mine.reference, code: 'x'.repeat(81) },
        { reference: 'x'.repeat(41), code: mine.followUpCode },
        { reference: mine.reference, code: mine.followUpCode, id: mine.id },
      ]) {
        await publicPost(`/public/follow-up/${a.slug}`, body).expect(400);
      }
    });

    it('stops working while the hospital has public reporting off, and works again after', async () => {
      await setPublicReporting(a.cookie, false).expect(200);
      try {
        await followUp(a.slug, mine.reference, mine.followUpCode).expect(404);
        await followUp(a.slug, inApp.reference, inApp.followUpCode).expect(404);
        await followUpComment(
          a.slug,
          mine.reference,
          mine.followUpCode,
          'Still there?',
        ).expect(404);
        // A code is still issued: it is good for when the switch is on.
        const later = await report(reporter, { anonymous: true });
        expect(later.followUpCode).toMatch(CODE);
        await setPublicReporting(a.cookie, true).expect(200);
        await followUp(a.slug, later.reference, later.followUpCode!).expect(
          200,
        );
      } finally {
        await setPublicReporting(a.cookie, true).expect(200);
      }
      await followUp(a.slug, mine.reference, mine.followUpCode).expect(200);
    });

    describe('a comment by the anonymous reporter', () => {
      const WORDS = `reporter-words-${run}`;
      const SENDER = '203.0.113.88';
      let written: { id: string; visibility: string; createdAt: string };

      beforeAll(async () => {
        const res = await http()
          .post(`/public/follow-up/${a.slug}/comments`)
          .set('X-Forwarded-For', SENDER)
          // Signed in while commenting with the code: it must not show.
          .set('Cookie', reporter.cookie)
          .send({
            reference: inApp.reference,
            code: inApp.followUpCode.toLowerCase(),
            body: `  ${WORDS}  `,
          })
          .expect(201);
        written = res.body;
      });

      it('is for everyone, and answered like any other comment', () => {
        expect(Object.keys(written).sort()).toEqual([
          'createdAt',
          'id',
          'visibility',
        ]);
        expect(written.visibility).toBe('everyone');
      });

      it('has no author, and nothing records who wrote it', async () => {
        const comments = await owner.db.execute(
          sql`select id, author_id, by_reporter, body, visibility from incident_comments where incident_id = ${inApp.id}`,
        );
        expect(comments.rows).toEqual([
          {
            id: written.id,
            author_id: null,
            by_reporter: true,
            body: WORDS,
            visibility: 'everyone',
          },
        ]);
        const events = await owner.db.execute(
          sql`select kind, actor_id, details, visible_to_reporter from incident_events where incident_id = ${inApp.id} order by occurred_at`,
        );
        expect(events.rows).toEqual([
          {
            kind: 'reported',
            actor_id: null,
            details: null,
            visible_to_reporter: true,
          },
          {
            kind: 'commented',
            actor_id: null,
            details: { commentId: written.id, visibility: 'everyone' },
            visible_to_reporter: true,
          },
        ]);
        const audit = await owner.db.execute(
          sql`select action, actor_id, ip_address, changes from audit_log where tenant_id = ${a.id} and entity_id = ${inApp.id} order by occurred_at, id`,
        );
        expect(audit.rows).toEqual([
          {
            action: 'incident_reported',
            actor_id: null,
            ip_address: null,
            changes: {
              reference: inApp.reference,
              type: 'incident',
              anonymous: true,
            },
          },
          {
            action: 'incident_commented',
            actor_id: null,
            ip_address: null,
            changes: {
              commentId: written.id,
              visibility: 'everyone',
              byReporter: true,
            },
          },
        ]);
        // Neither the account that was signed in, nor the address, nor the
        // words, anywhere in this hospital's log.
        for (const trace of [SENDER, WORDS]) {
          const found = await owner.db.execute(
            sql`select 1 from audit_log t where t.tenant_id = ${a.id} and to_jsonb(t)::text like ${`%${trace}%`}`,
          );
          expect([trace, found.rows.length]).toEqual([trace, 0]);
        }
        const linked = await owner.db.execute(
          sql`select 1 from audit_log
              where tenant_id = ${a.id}
                and (actor_id = ${reporter.id} or changes::text like ${`%${reporter.id}%`})
                and (entity_id = ${inApp.id}
                     or changes::text like ${`%${inApp.id}%`}
                     or changes::text like ${`%${inApp.reference}%`})`,
        );
        expect(linked.rows).toHaveLength(0);
      });

      it('reaches the handlers as written by the reporter, and the reporter sees it too', async () => {
        for (const who of [quality, manager]) {
          const res = await open(who.cookie, inApp.id).expect(200);
          expect(res.body.comments).toEqual([
            {
              id: written.id,
              author: null,
              byReporter: true,
              body: WORDS,
              visibility: 'everyone',
              createdAt: written.createdAt,
            },
          ]);
          expect((res.body.events as Event[]).at(-1)).toMatchObject({
            kind: 'commented',
            actor: null,
            byReporter: true,
          });
        }
        const back = await followUp(
          a.slug,
          inApp.reference,
          inApp.followUpCode,
        ).expect(200);
        expect((back.body.comments as Comment[]).map((c) => c.body)).toEqual([
          WORDS,
        ]);
      });

      it('refuses an invalid one, and cannot be made internal', async () => {
        const pair = { reference: inApp.reference, code: inApp.followUpCode };
        for (const body of [
          { ...pair },
          { ...pair, body: '' },
          { ...pair, body: '   ' },
          { ...pair, body: 'x'.repeat(2001) },
          { ...pair, body: 'Hello', visibility: 'internal' },
          { ...pair, body: 'Hello', visibility: 'everyone' },
          { ...pair, body: 'Hello', authorId: quality.id },
        ]) {
          await publicPost(`/public/follow-up/${a.slug}/comments`, body).expect(
            400,
          );
        }
        const count = await owner.db.execute(
          sql`select 1 from incident_comments where incident_id = ${inApp.id}`,
        );
        expect(count.rows).toHaveLength(1);
      });
    });

    it('allows thirty attempts an hour from one address, opening and commenting together', async () => {
      const address = freshAddress();
      for (let i = 0; i < FOLLOW_UP_ATTEMPTS_PER_HOUR; i++) {
        // Wrong codes, and now and then a comment or a malformed request.
        const res =
          i % 10 === 9
            ? await followUpComment(
                a.slug,
                mine.reference,
                'wrong',
                'Hi',
                address,
              )
            : i % 10 === 8
              ? await publicPost(`/public/follow-up/${a.slug}`, {}, address)
              : await followUp(a.slug, mine.reference, `wrong-${i}`, address);
        expect(res.status).toBe(i % 10 === 8 ? 400 : 404);
      }
      // Even the right code is now refused, on either route, however spelt.
      const res = await followUp(
        a.slug,
        mine.reference,
        mine.followUpCode,
        address,
      ).expect(429);
      expect(res.body).toEqual({ statusCode: 429, code: 'too_many_requests' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      await followUpComment(
        a.slug,
        mine.reference,
        mine.followUpCode,
        'Let me in',
        address,
      ).expect(429);
      const pair = { reference: mine.reference, code: mine.followUpCode };
      for (const path of [
        `/PUBLIC/FOLLOW-UP/${a.slug}`,
        `/public/follow-up/${a.slug}/`,
        `/public/follow-up/${a.slug.toUpperCase()}`,
        `/public/follow-up/${b.slug}`,
        `/Public/Follow-Up/${a.slug}/Comments/`,
      ]) {
        const reached = await publicPost(path, { ...pair, body: 'Variant' });
        expect([path, reached.status]).not.toEqual([path, 429]);
        const limited = await publicPost(
          path,
          { ...pair, body: 'Variant' },
          address,
        );
        expect([path, limited.status]).toEqual([path, 429]);
      }
      const letIn = await owner.db.execute(
        sql`select 1 from incident_comments where incident_id = ${mine.id} and body = 'Let me in'`,
      );
      expect(letIn.rows).toHaveLength(0);
      // Reporting is counted apart, and so is everyone else.
      await reportPublicly(a.slug, {}, address).expect(201);
      await followUp(a.slug, mine.reference, mine.followUpCode).expect(200);
    });
  });

  describe('closing a sentinel event', () => {
    const movesOf = async (who: Staff, id: string) =>
      (await open(who.cookie, id).expect(200)).body.moves as Move[];

    it('is asked for instead of done, for a sentinel event and for a death', async () => {
      const flagged = await sentinel();
      const fatal = await report(reporter, { harmLevel: 'death' });
      await triage(quality.cookie, fatal.id, { harmLevel: 'death' }).expect(
        200,
      );
      for (const { id } of [flagged, fatal]) {
        const res = await open(quality.cookie, id).expect(200);
        expect(res.body.needsSignOff).toBe(true);
        expect(res.body.moves).toEqual([
          { to: 'in_progress', noteRequired: false, action: 'start' },
          {
            to: 'awaiting_sign_off',
            noteRequired: true,
            action: 'request_sign_off',
          },
        ]);
        const direct = await move(quality.cookie, id, 'closed', 'Done').expect(
          409,
        );
        expect(direct.body.code).toBe('sign_off_required');
        expect((await stored(id)).status).toBe('triaged');
      }
      // The same once work has started.
      await move(quality.cookie, flagged.id, 'in_progress').expect(200);
      expect(await movesOf(quality, flagged.id)).toEqual([
        {
          to: 'awaiting_sign_off',
          noteRequired: true,
          action: 'request_sign_off',
        },
      ]);
      await move(quality.cookie, flagged.id, 'closed', 'Done').expect(409);
    });

    it('needs the proposed closure summary, and records who asked and when', async () => {
      const { id } = await sentinel();
      for (const note of [undefined, '', '   ']) {
        const res = await move(
          quality.cookie,
          id,
          'awaiting_sign_off',
          note,
        ).expect(400);
        expect(res.body.code).toBe('note_required');
      }
      const before = Date.now();
      const res = await move(
        quality.cookie,
        id,
        'awaiting_sign_off',
        `  ${PROPOSAL}  `,
      ).expect(200);
      expect(res.body).toMatchObject({
        status: 'awaiting_sign_off',
        closureSummary: PROPOSAL,
        closedAt: null,
        closureRequestedBy: { id: quality.id, name: { en: quality.name } },
        canRetriage: false,
        needsSignOff: true,
      });
      expect(Date.parse(res.body.closureRequestedAt)).toBeGreaterThanOrEqual(
        before - 1000,
      );
      expect((res.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'sign_off_requested',
        actor: { id: quality.id },
        fromStatus: 'triaged',
        toStatus: 'awaiting_sign_off',
        details: { note: PROPOSAL },
      });
      expect(await stored(id)).toMatchObject({
        status: 'awaiting_sign_off',
        closure_requested_by: quality.id,
        closure_summary: PROPOSAL,
        closed_by: null,
        closed_at: null,
      });
    });

    it('is not offered, and is refused, for an incident that does not need it', async () => {
      const { id } = await report(reporter);
      await triage(quality.cookie, id).expect(200);
      const res = await open(quality.cookie, id).expect(200);
      expect(res.body.needsSignOff).toBe(false);
      expect(res.body.moves).toEqual([
        { to: 'in_progress', noteRequired: false, action: 'start' },
        { to: 'closed', noteRequired: true, action: 'close' },
      ]);
      const refused = await move(
        quality.cookie,
        id,
        'awaiting_sign_off',
        'Please',
      ).expect(409);
      expect(refused.body.code).toBe('invalid_transition');
      // It closes as it always did.
      const closed = await move(quality.cookie, id, 'closed', 'Done.').expect(
        200,
      );
      expect(closed.body).toMatchObject({
        status: 'closed',
        closureRequestedBy: null,
        closureRequestedAt: null,
      });
      expect((await stored(id)).closed_by).toBe(quality.id);
    });

    it('tells each person what they may do while it waits', async () => {
      const { id } = await awaitingSignOff();
      const secondPerson = [
        { to: 'closed', noteRequired: false, action: 'sign_off' },
        { to: 'in_progress', noteRequired: true, action: 'send_back' },
      ];
      const withdraw = [
        { to: 'in_progress', noteRequired: true, action: 'withdraw' },
      ];
      expect(await movesOf(quality, id)).toEqual(withdraw);
      expect(await movesOf(quality2, id)).toEqual(secondPerson);
      expect(await movesOf(wardQuality, id)).toEqual(secondPerson);
      expect(await movesOf(signOnly, id)).toEqual(secondPerson);
      expect(await movesOf(triageOnly, id)).toEqual(withdraw);
      expect(await movesOf(manager, id)).toEqual([]);
      expect(await movesOf(reporter, id)).toEqual([]);
      const full = await open(manager.cookie, id).expect(200);
      expect(full.body).toMatchObject({
        closureRequestedBy: { id: quality.id },
        canRetriage: false,
      });
    });

    it('cannot be signed off by the person who asked, whatever they send', async () => {
      const { id } = await awaitingSignOff();
      const refused = await move(quality.cookie, id, 'closed').expect(403);
      expect(refused.body.code).toBe('same_person');
      await move(quality.cookie, id, 'closed', 'Signing my own').expect(403);
      // Naming someone else as the requester, or as the signer, is not read.
      for (const extra of [
        { requestedBy: quality2.id },
        { closureRequestedBy: quality2.id },
        { signedBy: quality2.id },
        { actorId: quality2.id },
      ]) {
        await move(quality.cookie, id, 'closed', 'Done', extra).expect(400);
      }
      expect(await stored(id)).toMatchObject({
        status: 'awaiting_sign_off',
        closure_requested_by: quality.id,
        closed_by: null,
      });
    });

    it('cannot be signed off without the right to', async () => {
      const { id } = await awaitingSignOff();
      for (const who of [triageOnly, manager, reporter]) {
        const res = await move(who.cookie, id, 'closed', 'Fine').expect(403);
        expect(res.body).toMatchObject({
          code: 'missing_permission',
          permission: 'incidents.sign_off',
        });
      }
      // Someone with no say cannot send it back either.
      for (const who of [manager, reporter]) {
        const res = await move(who.cookie, id, 'in_progress', 'No').expect(403);
        expect(res.body.code).toBe('missing_permission');
      }
      // The right held for another department does not reach it: not seen.
      await move(labQuality.cookie, id, 'closed').expect(404);
      await move(b.cookie, id, 'closed').expect(404);
      await http()
        .post(`/incidents/${id}/status`)
        .send({ to: 'closed' })
        .expect(401);
      expect((await stored(id)).status).toBe('awaiting_sign_off');
    });

    it('is closed when a second person signs it off', async () => {
      const { id } = await awaitingSignOff();
      const res = await move(quality2.cookie, id, 'closed').expect(200);
      expect(res.body).toMatchObject({
        status: 'closed',
        // The summary that was proposed, now the one it was closed with.
        closureSummary: PROPOSAL,
        closureRequestedBy: { id: quality.id },
        moves: [{ to: 'in_progress', noteRequired: true, action: 'reopen' }],
      });
      expect(res.body.closedAt).toBeTruthy();
      expect((res.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'signed_off',
        actor: { id: quality2.id },
        fromStatus: 'awaiting_sign_off',
        toStatus: 'closed',
        details: null,
      });
      expect(await stored(id)).toMatchObject({
        status: 'closed',
        closed_by: quality2.id,
        closure_requested_by: quality.id,
      });

      // With a note, it is on the timeline.
      const other = await awaitingSignOff();
      const noted = await move(
        wardQuality.cookie,
        other.id,
        'closed',
        'Reviewed with the ward.',
      ).expect(200);
      expect((noted.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'signed_off',
        actor: { id: wardQuality.id },
        details: { note: 'Reviewed with the ward.' },
      });
    });

    it('can be signed off by someone who holds that right and not the right to triage', async () => {
      const { id } = await sentinel();
      // Before a request there is nothing for them to decide.
      const early = await move(
        signOnly.cookie,
        id,
        'awaiting_sign_off',
        PROPOSAL,
      ).expect(403);
      expect(early.body).toMatchObject({
        code: 'missing_permission',
        permission: 'incidents.triage',
      });
      await triage(signOnly.cookie, id).expect(403);
      await move(quality.cookie, id, 'awaiting_sign_off', PROPOSAL).expect(200);
      const res = await move(signOnly.cookie, id, 'closed').expect(200);
      expect(res.body).toMatchObject({
        status: 'closed',
        canTriage: false,
        moves: [],
      });
      expect((await stored(id)).closed_by).toBe(signOnly.id);
    });

    it('can be sent back with a reason, which the reporter is not shown', async () => {
      const REASON = `not-yet-${run}`;
      const { id } = await awaitingSignOff();
      for (const note of [undefined, '  ']) {
        const res = await move(quality2.cookie, id, 'in_progress', note).expect(
          400,
        );
        expect(res.body.code).toBe('note_required');
      }
      const res = await move(quality2.cookie, id, 'in_progress', REASON).expect(
        200,
      );
      expect(res.body).toMatchObject({
        status: 'in_progress',
        closureSummary: null,
        closureRequestedBy: null,
        closureRequestedAt: null,
        canRetriage: true,
      });
      expect((res.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'sent_back',
        actor: { id: quality2.id },
        fromStatus: 'awaiting_sign_off',
        toStatus: 'in_progress',
        details: { note: REASON },
      });
      expect(await stored(id)).toMatchObject({
        status: 'in_progress',
        closure_summary: null,
        closure_requested_by: null,
        closure_requested_at: null,
        closed_by: null,
      });

      // The reporter is told it happened, not why.
      const theirs = await open(reporter.cookie, id).expect(200);
      const events = theirs.body.events as Event[];
      expect(events.map((e) => e.kind)).toEqual([
        'reported',
        'triaged',
        'sign_off_requested',
        'sent_back',
      ]);
      expect(events.at(-1)).toMatchObject({ kind: 'sent_back', details: null });
      // What was proposed, they were shown.
      expect(events.at(-2)).toMatchObject({ details: { note: PROPOSAL } });
      expect(JSON.stringify(theirs.body)).not.toContain(REASON);
      expect(theirs.body).toMatchObject({
        closureRequestedBy: null,
        closureRequestedAt: null,
      });
    });

    it('checks the second person against whoever asked last', async () => {
      const { id } = await awaitingSignOff();
      await move(quality2.cookie, id, 'in_progress', 'Needs more.').expect(200);
      // Now the other one asks. The first asker is free to sign; the new
      // asker is not.
      await move(
        quality2.cookie,
        id,
        'awaiting_sign_off',
        'Second try.',
      ).expect(200);
      expect((await stored(id)).closure_requested_by).toBe(quality2.id);
      const own = await move(quality2.cookie, id, 'closed').expect(403);
      expect(own.body.code).toBe('same_person');
      const res = await move(quality.cookie, id, 'closed').expect(200);
      expect(res.body).toMatchObject({
        status: 'closed',
        closureSummary: 'Second try.',
        closureRequestedBy: { id: quality2.id },
      });
      expect((await stored(id)).closed_by).toBe(quality.id);
    });

    it('can be withdrawn by whoever asked, or by a triager who cannot sign', async () => {
      const first = await awaitingSignOff();
      const none = await move(quality.cookie, first.id, 'in_progress').expect(
        400,
      );
      expect(none.body.code).toBe('note_required');
      const res = await move(
        quality.cookie,
        first.id,
        'in_progress',
        'Asked too early.',
      ).expect(200);
      expect(res.body).toMatchObject({
        status: 'in_progress',
        closureSummary: null,
        closureRequestedBy: null,
      });
      // Not a decision by a second person: a plain change, marked as such.
      expect((res.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'status_changed',
        actor: { id: quality.id },
        fromStatus: 'awaiting_sign_off',
        toStatus: 'in_progress',
        details: { note: 'Asked too early.', withdrawn: true },
      });

      const second = await awaitingSignOff();
      const other = await move(
        triageOnly.cookie,
        second.id,
        'in_progress',
        'Still being worked on.',
      ).expect(200);
      expect((other.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'status_changed',
        actor: { id: triageOnly.id },
        details: { withdrawn: true },
      });
    });

    it('lets whoever asked withdraw even after losing the right to triage', async () => {
      const leaver = await createStaff('leaver', {
        role: 'quality_officer',
        orgUnitId: null,
      });
      const { id } = await sentinel();
      await move(leaver.cookie, id, 'awaiting_sign_off', PROPOSAL).expect(200);
      await http()
        .put(`/users/${leaver.id}/roles`)
        .set('Cookie', a.cookie)
        .send({
          roles: [{ roleId: a.roles.department_manager, orgUnitId: null }],
        })
        .expect(200);
      const seen = await open(leaver.cookie, id).expect(200);
      expect(seen.body).toMatchObject({ canTriage: false });
      expect(seen.body.moves).toEqual([
        { to: 'in_progress', noteRequired: true, action: 'withdraw' },
      ]);
      // Their own request, so not theirs to sign off or do anything else to.
      await move(leaver.cookie, id, 'closed').expect(403);
      await move(leaver.cookie, id, 'in_progress', 'I have moved on.').expect(
        200,
      );
      // With the request gone they are a viewer like any other.
      const after = await move(leaver.cookie, id, 'closed', 'Done').expect(403);
      expect(after.body).toMatchObject({
        code: 'missing_permission',
        permission: 'incidents.triage',
      });
    });

    it('cannot be triaged while it waits', async () => {
      const { id } = await awaitingSignOff();
      for (const who of [quality, quality2]) {
        const res = await triage(who.cookie, id, {
          harmLevel: 'mild',
          isSentinel: false,
        }).expect(409);
        expect(res.body.code).toBe('invalid_transition');
      }
      expect((await open(quality.cookie, id)).body).toMatchObject({
        status: 'awaiting_sign_off',
        isSentinel: true,
        canRetriage: false,
      });
      // No other way out of waiting either.
      for (const to of ['new', 'triaged', 'rejected', 'awaiting_sign_off']) {
        const res = await move(quality2.cookie, id, to, 'A reason').expect(409);
        expect(res.body.code).toBe('invalid_transition');
      }
    });

    it('stops needing sign-off only through triage, with its trace', async () => {
      const { id } = await sentinel();
      await triage(quality.cookie, id, {
        harmLevel: 'severe',
        isSentinel: false,
      }).expect(200);
      const res = await move(
        quality.cookie,
        id,
        'closed',
        'Not sentinel.',
      ).expect(200);
      expect(res.body.status).toBe('closed');
      expect(
        (res.body.events as Event[]).filter((e) => e.kind === 'triaged').at(-1),
      ).toMatchObject({ details: { isSentinel: { from: true, to: false } } });
    });

    it('refuses a decision made on an out-of-date screen, and one of two at once', async () => {
      const { id } = await awaitingSignOff();
      const seen = (await open(quality2.cookie, id)).body.revision as number;
      const stale = await move(quality2.cookie, id, 'closed', undefined, {
        revision: seen - 1,
      }).expect(409);
      expect(stale.body.code).toBe('stale_incident');
      const [signed, sentBack] = await Promise.all([
        move(quality2.cookie, id, 'closed', undefined, { revision: seen }),
        move(a.cookie, id, 'in_progress', 'Not yet', { revision: seen }),
      ]);
      expect([signed.status, sentBack.status].sort((x, y) => x - y)).toEqual([
        200, 409,
      ]);
    });

    it('counts as open while it waits, and can be listed by its status', async () => {
      const summary = async () =>
        (
          await http()
            .get('/incidents/summary')
            .set('Cookie', quality.cookie)
            .expect(200)
        ).body as { open: number; serious: number; closedLast30Days: number };
      const waiting = async () =>
        (
          await http()
            .get('/incidents?status=awaiting_sign_off&pageSize=100')
            .set('Cookie', quality.cookie)
            .expect(200)
        ).body as { total: number; items: { id: string; status: string }[] };

      const start = await summary();
      const { id } = await sentinel();
      expect(await summary()).toMatchObject({
        open: start.open + 1,
        serious: start.serious + 1,
      });
      await move(quality.cookie, id, 'awaiting_sign_off', PROPOSAL).expect(200);
      // Still open, still serious, not yet closed.
      expect(await summary()).toEqual({
        ...start,
        open: start.open + 1,
        serious: start.serious + 1,
      });
      const list = await waiting();
      expect(list.items.map((i) => i.id)).toContain(id);
      expect(list.items.every((i) => i.status === 'awaiting_sign_off')).toBe(
        true,
      );
      await move(quality2.cookie, id, 'closed').expect(200);
      expect(await summary()).toEqual({
        ...start,
        closedLast30Days: start.closedLast30Days + 1,
      });
      expect((await waiting()).items.map((i) => i.id)).not.toContain(id);
    });

    it('starts afresh when a signed-off incident is reopened', async () => {
      const { id } = await awaitingSignOff();
      await move(quality2.cookie, id, 'closed').expect(200);
      const res = await move(
        quality.cookie,
        id,
        'in_progress',
        'Happened again.',
      ).expect(200);
      expect(res.body).toMatchObject({
        status: 'in_progress',
        closedAt: null,
        closureSummary: null,
        closureRequestedBy: null,
        closureRequestedAt: null,
      });
      expect(await stored(id)).toMatchObject({
        closed_by: null,
        closure_requested_by: null,
      });
      // Closing it again takes two people again.
      await move(quality.cookie, id, 'closed', 'Done').expect(409);
    });

    it('shows the reporter each step, and records each without its words', async () => {
      const NOTE = `signing-note-${run}`;
      const { id } = await awaitingSignOff();
      await move(quality2.cookie, id, 'closed', NOTE).expect(200);
      const theirs = await open(reporter.cookie, id).expect(200);
      expect(theirs.body).toMatchObject({
        access: 'reporter',
        status: 'closed',
        closureSummary: PROPOSAL,
        closureRequestedBy: null,
      });
      expect((theirs.body.events as Event[]).map((e) => e.kind)).toEqual([
        'reported',
        'triaged',
        'sign_off_requested',
        'signed_off',
      ]);

      const audit = await owner.db.execute<{
        actor_id: string;
        changes: unknown;
      }>(
        sql`select actor_id, changes from audit_log where tenant_id = ${a.id} and entity_id = ${id} and action = 'incident_status_changed' order by occurred_at, id`,
      );
      expect(audit.rows).toEqual([
        {
          actor_id: quality.id,
          changes: {
            from: 'triaged',
            to: 'awaiting_sign_off',
            action: 'request_sign_off',
          },
        },
        {
          actor_id: quality2.id,
          changes: {
            from: 'awaiting_sign_off',
            to: 'closed',
            action: 'sign_off',
          },
        },
      ]);
      for (const words of [NOTE, PROPOSAL]) {
        const leaked = await owner.db.execute(
          sql`select 1 from audit_log where tenant_id = ${a.id} and changes::text like ${`%${words}%`}`,
        );
        expect([words, leaked.rows.length]).toEqual([words, 0]);
      }
    });

    it('writes nothing for a refused move', async () => {
      const { id } = await awaitingSignOff();
      const count = async () =>
        (
          await owner.db.execute<{ n: number }>(
            sql`select (select count(*) from audit_log where entity_id = ${id})::int + (select count(*) from incident_events where incident_id = ${id})::int as n`,
          )
        ).rows[0].n;
      const before = await count();
      const revision = (await open(quality.cookie, id)).body.revision;
      await move(quality.cookie, id, 'closed').expect(403);
      await move(triageOnly.cookie, id, 'closed').expect(403);
      await move(quality2.cookie, id, 'in_progress').expect(400);
      await move(quality2.cookie, id, 'rejected', 'No').expect(409);
      await triage(quality2.cookie, id).expect(409);
      expect(await count()).toBe(before);
      expect((await open(quality.cookie, id)).body.revision).toBe(revision);
    });
  });
});
