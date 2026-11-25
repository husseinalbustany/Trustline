import '../src/env.js';
import { createHash, randomBytes } from 'node:crypto';
import { INestApplication, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { createDatabase } from '../src/database/client.js';
import { orgUnits } from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';
import { AuthService } from '../src/identity/auth.service.js';
import { IncidentsService } from '../src/incidents/incidents.service.js';
import {
  heldFor,
  REFUSAL_STEP_MS,
} from '../src/incidents/public.controller.js';
import {
  BUSY_RETRY_SECONDS,
  FOLLOW_UP_ATTEMPTS_PER_HOUR,
  FOLLOW_UP_COMMENTS_PER_INCIDENT_PER_DAY,
  PUBLIC_FORM_READS_PER_HOUR,
  PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR,
  PUBLIC_REPORTS_PER_HOUR,
  PublicLimits,
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
  type Move = {
    to: string;
    noteRequired: boolean;
    revisionRequired: boolean;
    kind: string;
  };

  let a: Hospital; // takes public reports
  let b: Hospital; // takes them too: another hospital entirely
  let off: Hospital; // has never switched public reporting on
  let suspended: Hospital; // switched it on, then was suspended
  let lim: Hospital; // takes public reports: for the limits per address
  let cap: Hospital; // and for the ceiling per hospital

  let facility: string;
  let ward: string;
  let lab: string;
  let wardUnit: string;
  let closedUnit: string; // switched off
  let bUnit: string;
  let offUnit: string;
  let limUnit: string;
  let capUnit: string;
  /** The code of a report the suspended hospital took before it was. */
  let goneCode: string;

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
  // here calls from the same one. So each test starts with the counts
  // cleared (see `beforeEach`), as after a restart of the API. No request
  // claims an address of its own unless the address is what the test is
  // about: then `address` is what the proxy in front of the web app would
  // have written in the forwarding header.
  const publicPost = (path: string, body: object, address?: string) => {
    const req = http().post(path);
    if (address !== undefined) void req.set('X-Forwarded-For', address);
    return req.send(body);
  };

  const reportPublicly = (
    slug: string,
    overrides: Record<string, unknown> = {},
    address?: string,
  ) => publicPost(`/public/reporting/${slug}`, reportBody(overrides), address);

  const followUp = (slug: string, code: string, address?: string) =>
    publicPost(`/public/follow-up/${slug}`, { code }, address);

  const followUpComment = (
    slug: string,
    code: string,
    body: string,
    address?: string,
  ) =>
    publicPost(`/public/follow-up/${slug}/comments`, { code, body }, address);

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

  /** What is stored for a follow-up code. */
  const hashOf = (code: string) =>
    createHash('sha256').update(code.replaceAll('-', '')).digest('hex');

  /**
   * The incident a public report became. Its sender is told neither its id
   * nor its number, so the test looks it up as the owner, by the code.
   */
  const byCode = async (tenantId: string, code: string) =>
    (
      await owner.db.execute<{ id: string; reference: string }>(
        sql`select id, reference from incidents where tenant_id = ${tenantId} and follow_up_code_hash = ${hashOf(code)}`,
      )
    ).rows[0];

  /**
   * Signs off a closure that is waiting, as someone who read the incident
   * first: a signature says which revision it is on. Expects `status`.
   */
  const signOff = async (
    status: number,
    cookie: string,
    id: string,
    note?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const read = await owner.db.execute<{ revision: number }>(
      sql`select revision from incidents where id = ${id}`,
    );
    return move(cookie, id, 'closed', note, {
      revision: read.rows[0].revision,
      ...extra,
    }).expect(status);
  };

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
    lim = await createHospital('lim');
    cap = await createHospital('cap');

    facility = await createUnit(a.id, 'facility', 'MAIN', null);
    ward = await createUnit(a.id, 'department', 'WARD', facility);
    lab = await createUnit(a.id, 'department', 'LAB', facility);
    wardUnit = await createUnit(a.id, 'unit', 'WARD-3', ward);
    closedUnit = await createUnit(a.id, 'department', 'OLD', facility, false);
    bUnit = await createUnit(b.id, 'facility', 'MAIN', null);
    offUnit = await createUnit(off.id, 'facility', 'MAIN', null);
    const goneUnit = await createUnit(suspended.id, 'facility', 'MAIN', null);
    limUnit = await createUnit(lim.id, 'facility', 'MAIN', null);
    capUnit = await createUnit(cap.id, 'facility', 'MAIN', null);

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
    await setPublicReporting(lim.cookie, true).expect(200);
    await setPublicReporting(cap.cookie, true).expect(200);
    goneCode = (
      await reportPublicly(suspended.slug, {
        categoryId: suspended.categories.equipment,
        orgUnitId: goneUnit,
      }).expect(201)
    ).body.followUpCode;
    await http()
      .patch(`/platform/tenants/${suspended.id}`)
      .set('Cookie', platform)
      .send({ status: 'suspended' })
      .expect(200);
  }, 180_000);

  // Every test starts with nothing counted against its address.
  beforeEach(() => app.get(PublicLimits, { strict: false }).forget());

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
        byStaff: false,
        fromStatus: null,
        toStatus: 'new',
        details: null,
      });
      const comments = res.body.comments as Comment[];
      expect(comments[0]).toEqual({
        id: expect.any(String),
        author: null,
        byReporter: true,
        byStaff: false,
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
      const { id } = await byCode(a.id, sent.body.followUpCode);
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

    describe('a reporter who also handles the incident', () => {
      // What a reader who is not told the reporter can compare: who is
      // named where, and what is marked as the reporter's.
      const told = (body: { events: Event[]; comments: Comment[] }) => ({
        events: body.events.map((e) => [
          e.kind,
          e.actor?.id ?? null,
          e.byReporter,
        ]),
        comments: body.comments.map((c) => [
          c.body,
          c.visibility,
          c.author?.id ?? null,
          c.byReporter,
        ]),
      });
      const capacityOf = async (id: string) =>
        (
          await owner.db.execute<{
            body: string;
            author_id: string | null;
            by_reporter: boolean;
            as_handler: boolean;
          }>(
            sql`select body, author_id, by_reporter, as_handler from incident_comments where incident_id = ${id} order by created_at`,
          )
        ).rows;

      it('comments under their own name, so their report looks like an anonymous one', async () => {
        // The same life twice: a quality officer triages and comments on a
        // report in the ward. Once the report is their own, by name; once it
        // was made anonymously.
        const live = async (anonymous: boolean) => {
          const { id } = await report(quality2, { anonymous });
          await triage(quality2.cookie, id).expect(200);
          await comment(quality2.cookie, id, 'Seen it.', 'internal').expect(
            201,
          );
          await comment(quality2.cookie, id, 'Thank you.', 'everyone').expect(
            201,
          );
          return id;
        };
        const own = await live(false);
        const nobodys = await live(true);

        const one = await open(manager.cookie, own).expect(200);
        const other = await open(manager.cookie, nobodys).expect(200);
        expect(one.body).toMatchObject({
          reporter: null,
          reporterShown: false,
        });
        // Nothing tells the two apart: not who is named, not what is marked.
        expect(told(one.body)).toEqual(told(other.body));
        expect(outline(one.body)).toEqual(outline(other.body));
        expect(told(one.body)).toEqual({
          events: [
            ['reported', null, true],
            ['triaged', quality2.id, false],
            ['assigned', quality2.id, false],
            ['commented', quality2.id, false],
            ['commented', quality2.id, false],
          ],
          comments: [
            ['Seen it.', 'internal', quality2.id, false],
            ['Thank you.', 'everyone', quality2.id, false],
          ],
        });
        // Decided when written, and stored: as a handler, under their name.
        expect(await capacityOf(own)).toEqual([
          {
            body: 'Seen it.',
            author_id: quality2.id,
            by_reporter: false,
            as_handler: true,
          },
          {
            body: 'Thank you.',
            author_id: quality2.id,
            by_reporter: false,
            as_handler: true,
          },
        ]);
        // The quality office is told who reported, as ever, on the report.
        const seen = await open(quality.cookie, own).expect(200);
        expect(seen.body).toMatchObject({
          reporter: { id: quality2.id },
          reporterShown: true,
        });
      });

      it('cannot be found by ruling out the handlers whose comments carry a name', async () => {
        // A small ward: three people handle its incidents. One of them
        // reported this one. Before, their comments were marked "the
        // reporter" and everyone else's carried a name: whoever was never
        // named was the reporter.
        const handlers = [wardQuality, quality, quality2];
        const live = async (by: Staff) => {
          const { id } = await report(by);
          await triage(quality.cookie, id).expect(200);
          for (const who of handlers) {
            await comment(
              who.cookie,
              id,
              `From ${who.name}.`,
              'internal',
            ).expect(201);
            await comment(who.cookie, id, 'Noted.', 'everyone').expect(201);
          }
          return id;
        };
        // Reported by one of the three; and by someone who is none of them
        // and never says a word.
        const byHandler = await live(wardQuality);
        const byOutsider = await live(reporter);

        const one = await open(manager.cookie, byHandler).expect(200);
        const other = await open(manager.cookie, byOutsider).expect(200);
        // Every handler is named on every comment of theirs, the one who
        // reported included: nobody is left over.
        const authors = (one.body.comments as Comment[]).map(
          (c) => c.author?.id,
        );
        expect(authors).toEqual(handlers.flatMap((h) => [h.id, h.id]));
        expect((one.body.comments as Comment[]).some((c) => c.byReporter)).toBe(
          false,
        );
        // And the answer is the same as when none of them reported.
        expect(told(one.body)).toEqual(told(other.body));
        expect(outline(one.body)).toEqual(outline(other.body));
        // Nothing else in it says so either.
        expect(one.body).toMatchObject({
          reporter: null,
          reporterShown: false,
          channel: null,
        });
        expect(Object.keys(one.body).sort()).toEqual(
          Object.keys(other.body).sort(),
        );
      });

      it('is marked as the reporter only for what they wrote as nothing more', async () => {
        // Reports, sees only their own report, and comments on it.
        const { id } = await report(assignee);
        await comment(
          assignee.cookie,
          id,
          'I forgot to say.',
          'everyone',
        ).expect(201);
        // Then is given the incident to handle, and comments again.
        await triage(quality.cookie, id, { assignedTo: assignee.id }).expect(
          200,
        );
        await comment(assignee.cookie, id, 'On it.', 'everyone').expect(201);
        await comment(assignee.cookie, id, 'Parts ordered.', 'internal').expect(
          201,
        );
        expect(await capacityOf(id)).toEqual([
          {
            body: 'I forgot to say.',
            author_id: assignee.id,
            by_reporter: true,
            as_handler: false,
          },
          {
            body: 'On it.',
            author_id: assignee.id,
            by_reporter: false,
            as_handler: true,
          },
          {
            body: 'Parts ordered.',
            author_id: assignee.id,
            by_reporter: false,
            as_handler: true,
          },
        ]);
        const res = await open(manager.cookie, id).expect(200);
        expect(told(res.body).comments).toEqual([
          ['I forgot to say.', 'everyone', null, true],
          ['On it.', 'everyone', assignee.id, false],
          ['Parts ordered.', 'internal', assignee.id, false],
        ]);
        expect(
          (res.body.events as Event[])
            .filter((e) => e.kind === 'commented')
            .map((e) => [e.actor?.id ?? null, e.byReporter]),
        ).toEqual([
          [null, true],
          [assignee.id, false],
          [assignee.id, false],
        ]);
        // The quality office sees the name on all three.
        const seen = await open(quality.cookie, id).expect(200);
        expect(told(seen.body).comments.map((c) => c[2])).toEqual([
          assignee.id,
          assignee.id,
          assignee.id,
        ]);
      });

      it("reads a comment stored before this was recorded as the reporter's only where it can have been", async () => {
        // As an earlier release stored them: by the reporter's account, with
        // nothing said about the capacity each was written in.
        const { id } = await report(quality2);
        await triage(quality.cookie, id).expect(200);
        const before = async (
          body: string,
          visibility: 'everyone' | 'internal',
          byReporter = false,
        ) => {
          const old = await owner.db.execute<{ id: string }>(
            sql`insert into incident_comments (tenant_id, incident_id, author_id, body, visibility, by_reporter)
                values (${a.id}, ${id}, ${quality2.id}, ${body}, ${visibility}::incident_comment_visibility, ${byReporter})
                returning id`,
          );
          await owner.db.execute(
            sql`insert into incident_events (tenant_id, incident_id, kind, actor_id, details, visible_to_reporter)
                values (${a.id}, ${id}, 'commented', ${quality2.id}, ${JSON.stringify({ commentId: old.rows[0].id, visibility })}::jsonb, ${visibility === 'everyone'})`,
          );
        };
        await before('For all, from before.', 'everyone');
        await before('Among us, from before.', 'internal');
        // And as the first backfill marked every comment of a reporter,
        // internal ones too, should one ever be stored so again.
        await before('Among us, marked.', 'internal', true);
        const res = await open(manager.cookie, id).expect(200);
        expect(told(res.body).comments).toEqual([
          // It can have been written as nothing more than the reporter: no
          // name appears where none did before.
          ['For all, from before.', 'everyone', null, true],
          // Only someone handling the incident could write these. Marked
          // "the reporter", they would tell this reader that the report was
          // a named one, made by a colleague with full access to it.
          ['Among us, from before.', 'internal', quality2.id, false],
          ['Among us, marked.', 'internal', quality2.id, false],
        ]);
        expect(
          (res.body.events as Event[])
            .filter((e) => e.kind === 'commented')
            .map((e) => [e.actor?.id ?? null, e.byReporter]),
        ).toEqual([
          [null, true],
          [quality2.id, false],
          [quality2.id, false],
        ]);
        // The same incident, had it been reported by nobody known: the
        // internal comments read exactly alike.
        const anonymous = await report(quality2, { anonymous: true });
        await triage(quality.cookie, anonymous.id).expect(200);
        await comment(
          quality2.cookie,
          anonymous.id,
          'Among us, from before.',
          'internal',
        ).expect(201);
        const other = await open(manager.cookie, anonymous.id).expect(200);
        expect(told(other.body).comments).toEqual([
          ['Among us, from before.', 'internal', quality2.id, false],
        ]);
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
        'last30Days',
        'medianSecondsToReport',
        'open',
        'overdue',
        'serious',
        'triagedOnTime',
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
        { slug: cap.slug, on: true },
        { slug: suspended.slug, on: true },
        { slug: lim.slug, on: true },
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
        'timeZone',
      ]);
      expect(res.body).toMatchObject({
        name: { en: 'Hospital a' },
        locales: ['en'],
        defaultLocale: 'en',
        timeZone: 'UTC',
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

    it("tells the form the hospital's own clock, as Trustline staff have set it", async () => {
      const set = (timeZone: string) =>
        http()
          .patch(`/platform/tenants/${b.id}`)
          .set('Cookie', platform)
          .send({ timeZone })
          .expect(200);
      await set('Asia/Beirut');
      try {
        expect((await form(b.slug).expect(200)).body.timeZone).toBe(
          'Asia/Beirut',
        );
      } finally {
        await set('UTC');
      }
      expect((await form(b.slug).expect(200)).body.timeZone).toBe('UTC');
    });

    it('is opened at most sixty times an hour from one address, whichever hospital is asked for', async () => {
      const from = (slug: string, address: string) =>
        form(slug).set('X-Forwarded-For', address);
      const address = '203.0.113.200';
      for (let i = 0; i < PUBLIC_FORM_READS_PER_HOUR; i++) {
        // Every attempt counts, whether or not there is a form to show.
        const slug = i % 20 === 19 ? `${prefix}-nowhere-${i}` : a.slug;
        const res = await from(slug, address);
        expect([i, res.status]).toEqual([i, i % 20 === 19 ? 404 : 200]);
      }
      const res = await from(a.slug, address).expect(429);
      expect(res.body).toEqual({ statusCode: 429, code: 'too_many_requests' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
      // Not by asking for another hospital, real or not, or spelling the
      // route another way: a list of names cannot be gone through.
      await from(b.slug, address).expect(429);
      await from(`${prefix}-nowhere`, address).expect(429);
      await from(off.slug, address).expect(429);
      await http()
        .get(`/PUBLIC/Reporting/${a.slug.toUpperCase()}/`)
        .set('X-Forwarded-For', address)
        .expect(429);
      // Someone else opens it as before, and the same address can still
      // send a report and follow one up: those are counted apart.
      await from(a.slug, '203.0.113.201').expect(200);
      await reportPublicly(a.slug, {}, address).expect(201);
      await followUp(a.slug, 'x', address).expect(404);
    });

    it('is refused on the same step of time whatever the reason, and shown at once', async () => {
      const limits = app.get(PublicLimits, { strict: false });
      const timed = async (send: () => request.Test) => {
        limits.forget();
        const began = performance.now();
        const res = await send();
        return { status: res.status, ms: performance.now() - began };
      };
      for (const slug of [
        `${prefix}-nowhere`,
        off.slug,
        suspended.slug,
        '%00',
        'x'.repeat(41),
      ]) {
        for (const send of [() => form(slug), () => reportPublicly(slug)]) {
          const { status, ms } = await timed(send);
          expect([slug, status]).toEqual([slug, 404]);
          // (A timer may fire a millisecond early.)
          expect(ms).toBeGreaterThanOrEqual(REFUSAL_STEP_MS - 2);
          expect(ms).toBeLessThan(REFUSAL_STEP_MS + 250);
        }
      }
      // A form that is there is shown as soon as it is read.
      const fast = [];
      for (let i = 0; i < 5; i++) {
        const { status, ms } = await timed(() => form(a.slug));
        expect(status).toBe(200);
        fast.push(ms);
      }
      expect(Math.min(...fast)).toBeLessThan(REFUSAL_STEP_MS - 10);
    });

    it('holds a refusal to the next step when the work took longer than one', async () => {
      // To the next multiple of the step, and a whole step at the least.
      expect(heldFor(0)).toBe(REFUSAL_STEP_MS);
      expect(heldFor(10)).toBe(REFUSAL_STEP_MS - 10);
      expect(heldFor(REFUSAL_STEP_MS - 0.5)).toBe(0.5);
      expect(heldFor(REFUSAL_STEP_MS)).toBe(0);
      expect(heldFor(REFUSAL_STEP_MS + 1)).toBe(REFUSAL_STEP_MS - 1);
      expect(heldFor(2.4 * REFUSAL_STEP_MS)).toBeCloseTo(0.6 * REFUSAL_STEP_MS);
      expect(heldFor(7 * REFUSAL_STEP_MS + 20)).toBe(REFUSAL_STEP_MS - 20);
      for (let elapsed = 0; elapsed < 1000; elapsed += 7.3) {
        const wait = heldFor(elapsed);
        expect(wait).toBeGreaterThanOrEqual(0);
        expect(wait).toBeLessThanOrEqual(REFUSAL_STEP_MS);
        expect((elapsed + wait) % REFUSAL_STEP_MS).toBeCloseTo(0, 6);
      }

      // A server so busy that looking the hospital up takes longer than a
      // step: the refusal is not sent when the work happens to end, as it
      // was before, but on the step after.
      const SLOW = 1.4 * REFUSAL_STEP_MS;
      const slow = <T>(answer: () => T) =>
        new Promise<T>((done, failed) =>
          setTimeout(() => {
            try {
              done(answer());
            } catch (error) {
              failed(error as Error);
            }
          }, SLOW),
        );
      const limits = app.get(PublicLimits, { strict: false });
      const timed = async (send: () => request.Test) => {
        limits.forget();
        const began = performance.now();
        const res = await send();
        return { status: res.status, ms: performance.now() - began };
      };
      const auth = app.get(AuthService, { strict: false });
      const incidents = app.get(IncidentsService, { strict: false });
      for (const send of [
        () => form(`${prefix}-nowhere`),
        () => reportPublicly(`${prefix}-nowhere`),
        () => followUp(`${prefix}-nowhere`, 'K7QM-2RXD-9FHT-WB3N'),
      ]) {
        const lookup = vi
          .spyOn(auth, 'findTenant')
          .mockImplementationOnce(() => slow(() => null));
        try {
          const { status, ms } = await timed(send);
          expect(status).toBe(404);
          expect(lookup).toHaveBeenCalledTimes(1);
          expect(ms).toBeGreaterThanOrEqual(2 * REFUSAL_STEP_MS - 2);
          expect(ms).toBeLessThan(2 * REFUSAL_STEP_MS + 250);
        } finally {
          lookup.mockRestore();
        }
      }
      // The same when it is the look for the code that is slow.
      for (const send of [
        () => followUp(a.slug, 'K7QM-2RXD-9FHT-WB3N'),
        () => followUpComment(a.slug, 'K7QM-2RXD-9FHT-WB3N', 'Hello'),
      ]) {
        const refuse = () =>
          slow<never>(() => {
            throw new NotFoundException();
          });
        const spies = [
          vi.spyOn(incidents, 'followUp').mockImplementationOnce(refuse),
          vi.spyOn(incidents, 'followUpComment').mockImplementationOnce(refuse),
        ];
        try {
          const { status, ms } = await timed(send);
          expect(status).toBe(404);
          expect(ms).toBeGreaterThanOrEqual(2 * REFUSAL_STEP_MS - 2);
          expect(ms).toBeLessThan(2 * REFUSAL_STEP_MS + 250);
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
      }
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
      const before = await owner.db.execute(
        sql`select 1 from incidents where tenant_id in (${off.id}, ${suspended.id})`,
      );
      for (const slug of [`${prefix}-nowhere`, off.slug, suspended.slug]) {
        const posted = await reportPublicly(slug).expect(404);
        expect(posted.body).toEqual(unknown.body);
      }
      const after = await owner.db.execute(
        sql`select 1 from incidents where tenant_id in (${off.id}, ${suspended.id})`,
      );
      expect(after.rows).toHaveLength(before.rows.length);
    });

    it('takes text that could not be an identifier for no hospital, not for an error', async () => {
      const unknown = await form(`${prefix}-nowhere`).expect(404);
      for (const slug of [
        '%00',
        `${a.slug}%00`,
        `%00${a.slug}`,
        `${a.slug}%0A`,
        `${a.slug}%20or%201=1`,
        `${a.slug}'--`,
        'x'.repeat(200),
        '%F0%9F%8F%A5',
      ]) {
        const res = await form(slug);
        expect([slug, res.status]).toEqual([slug, 404]);
        expect(res.body).toEqual(unknown.body);
        const posted = await reportPublicly(slug);
        expect([slug, posted.status]).toEqual([slug, 404]);
        const opened = await followUp(slug, 'x');
        expect([slug, opened.status]).toEqual([slug, 404]);
        expect(opened.body).toEqual(unknown.body);
        const said = await followUpComment(slug, 'x', 'Hello');
        expect([slug, said.status]).toEqual([slug, 404]);
      }
    });
  });

  describe('a report without sign-in', () => {
    const SENDER = '203.0.113.77';
    const DEVICE = `Device-${run}`;

    it('is taken and numbered, and answered with a follow-up code and nothing else', async () => {
      const res = await reportPublicly(a.slug, {
        description: '  A wet floor had no sign.  ',
        orgUnitId: wardUnit,
      }).expect(201);
      // No incident number: the numbers run in one series, and one of them
      // would tell the sender how many incidents the hospital has had.
      expect(Object.keys(res.body)).toEqual(['followUpCode']);
      expect(res.body.followUpCode).toMatch(CODE);
      expect(JSON.stringify(res.body)).not.toContain('INC-');
      expect(JSON.stringify(res.headers)).not.toContain('INC-');

      // It has its number all the same, for the people handling it.
      const { id, reference } = await byCode(a.id, res.body.followUpCode);
      expect(reference).toMatch(new RegExp(`^INC-${year}-\\d{5}$`));
      const seen = await open(quality.cookie, id).expect(200);
      expect(seen.body).toMatchObject({
        id,
        reference,
        status: 'new',
        description: 'A wet floor had no sign.',
        orgUnit: { id: wardUnit },
        channel: 'public',
        reporter: null,
        reporterShown: true,
      });
    });

    it('tells the sender nothing that counts the reports before theirs', async () => {
      const first = await reportPublicly(a.slug).expect(201);
      await report(reporter);
      await report(reporter);
      const second = await reportPublicly(a.slug).expect(201);
      const numbers = [
        (await byCode(a.id, first.body.followUpCode)).reference,
        (await byCode(a.id, second.body.followUpCode)).reference,
      ].map((r) => Number(r.slice(-5)));
      // Three apart in the hospital's series: nothing either sender was
      // given says so, in what they got back or in what they can open.
      expect(numbers[1] - numbers[0]).toBe(3);
      for (const sent of [first, second]) {
        const view = await followUp(a.slug, sent.body.followUpCode).expect(200);
        const everything = JSON.stringify([sent.body, view.body]);
        expect(everything).not.toContain('INC-');
        for (const number of numbers) {
          expect(everything).not.toContain(String(number).padStart(5, '0'));
        }
      }
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
      const code = res.body.followUpCode as string;
      const { id, reference } = await byCode(a.id, code);
      const row = await stored(id);
      expect(row).toMatchObject({ reported_by: null, channel: 'public' });
      expect(row.follow_up_code_hash).toBe(hashOf(code));

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
            reference,
            type: 'incident',
            anonymous: true,
            channel: 'public',
          },
        },
      ]);

      // Not the address, the device, the account or the code, in any column
      // of anything stored about this report, its notifications included.
      const kept = await owner.db.execute<{ row: string }>(
        sql`select to_jsonb(t)::text as row from incidents t where t.id = ${id}
            union all
            select to_jsonb(t)::text from incident_events t where t.incident_id = ${id}
            union all
            select to_jsonb(t)::text from audit_log t where t.entity_id = ${id}
            union all
            select to_jsonb(t)::text from notifications t where t.incident_id = ${id}`,
      );
      expect(kept.rows.length).toBeGreaterThan(3);
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
        .set('Cookie', reporter.cookie)
        .send(reportBody())
        .expect(201);
      const { id } = await byCode(a.id, res.body.followUpCode);
      await open(reporter.cookie, id).expect(404);
    });

    it('applies the rules and the limits of a signed-in report', async () => {
      const limits = app.get(PublicLimits, { strict: false });
      const refused = async (
        overrides: Record<string, unknown>,
        code?: string,
      ) => {
        // Every attempt counts against the address; this test is not about
        // that.
        limits.forget();
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
      limits.forget();
      await reportPublicly(a.slug, { description: 'x'.repeat(5000) }).expect(
        201,
      );
      // A form, not JSON: refused before it is read.
      await http()
        .post(`/public/reporting/${a.slug}`)
        .type('form')
        .send('description=hello')
        .expect(415);
    });

    it('refuses control characters in what is written, and keeps line breaks', async () => {
      const limits = app.get(PublicLimits, { strict: false });
      for (const character of [
        '\u0000',
        '\u0001',
        '\u0008',
        '\u001b',
        '\u007f',
      ]) {
        for (const field of ['description', 'immediateAction']) {
          limits.forget();
          const res = await reportPublicly(a.slug, {
            [field]: `before${character}after`,
          });
          expect([field, character.charCodeAt(0), res.status]).toEqual([
            field,
            character.charCodeAt(0),
            400,
          ]);
        }
      }
      limits.forget();
      const WORDS = 'First line.\nSecond line.\r\n\tIndented.';
      const kept = await reportPublicly(a.slug, { description: WORDS }).expect(
        201,
      );
      const view = await followUp(a.slug, kept.body.followUpCode).expect(200);
      expect(view.body.description).toBe(WORDS);
      // The same for a member of staff signed in.
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send(reportBody({ anonymous: false, description: 'a\u0000b' }))
        .expect(400);
    });
  });

  describe('the limits on the public routes', () => {
    // In every test here the header is what a proxy in front of the web app
    // would have written, unless the test says the sender wrote it.
    const countOf = async (tenantId: string) =>
      (
        await owner.db.execute<{ n: number }>(
          sql`select count(*)::int as n from incidents where tenant_id = ${tenantId}`,
        )
      ).rows[0].n;
    // These tests are about the limit per address, and between them send
    // the hospital more than its ceiling for an hour. So each starts as if
    // the hour had moved on: what the hospital took before is two hours old.
    beforeEach(async () => {
      await owner.db.execute(
        sql`update incidents set reported_at = reported_at - interval '2 hours' where tenant_id = ${lim.id} and channel = 'public'`,
      );
    });

    const toLim = (overrides: Record<string, unknown>, address?: string) =>
      reportPublicly(
        lim.slug,
        {
          categoryId: lim.categories.equipment,
          orgUnitId: limUnit,
          ...overrides,
        },
        address,
      );

    it('takes at most ten reports an hour from one address, whatever they contain', async () => {
      const address = '203.0.113.10';
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        // Refused ones count too: the limit is on attempts.
        const res = await toLim(i % 2 ? {} : { description: '' }, address);
        expect(res.status).toBe(i % 2 ? 201 : 400);
      }
      const before = await countOf(lim.id);
      const res = await toLim({}, address).expect(429);
      expect(res.body).toEqual({ statusCode: 429, code: 'too_many_requests' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
      // Not by going to another hospital, real or not.
      await reportPublicly(b.slug, { orgUnitId: bUnit }, address).expect(429);
      await reportPublicly(`${prefix}-nowhere`, {}, address).expect(429);
      expect(await countOf(lim.id)).toBe(before);
      // Someone else is not held up, and following up is counted apart.
      await toLim({}, '203.0.113.11').expect(201);
      await followUp(lim.slug, 'x', address).expect(404);
    });

    it('cannot be got around by writing the address of the route another way', async () => {
      const address = '203.0.113.20';
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        await toLim({}, address).expect(201);
      }
      const body = reportBody({
        categoryId: lim.categories.equipment,
        orgUnitId: limUnit,
      });
      const routed: string[] = [];
      const paths = [
        `/PUBLIC/REPORTING/${lim.slug}`,
        `/Public/Reporting/${lim.slug}`,
        `/public/reporting/${lim.slug}/`,
        `/public/reporting/${lim.slug.toUpperCase()}`,
        `/public/reporting/${lim.slug}?x=1`,
        `/public/reporting/${lim.slug}/?x=1`,
        `//public/reporting/${lim.slug}`,
        `/public//reporting/${lim.slug}`,
        `/public/reporting//${lim.slug}`,
        `/public/./reporting/${lim.slug}`,
        `/%70ublic/reporting/${lim.slug}`,
        `/public/reporting/${lim.slug}%2F`,
      ];
      for (const [i, path] of paths.entries()) {
        // From an address with nothing against it, to learn whether this
        // spelling reaches the route at all.
        const reached = await publicPost(path, body, `203.0.113.${100 + i}`);
        const limited = await publicPost(path, body, address);
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
          `/PUBLIC/REPORTING/${lim.slug}`,
          `/public/reporting/${lim.slug}/`,
          `/public/reporting/${lim.slug.toUpperCase()}`,
        ]),
      );
    });

    it('counts the address the proxy wrote last, not one the sender put in front of it', async () => {
      // A proxy that adds the real address after whatever the sender sent.
      const real = '203.0.113.30';
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        // A different invented address in front each time.
        await toLim({}, `10.9.${i}.1, ${real}`).expect(201);
      }
      await toLim({}, `10.9.99.1, ${real}`).expect(429);
      await toLim({}, real).expect(429);
      await toLim({}, `${real}, 10.9.99.1, ${real}`).expect(429);
    });

    it('counts every caller as one when no address is passed on', async () => {
      // No header at all: the API sees only who connected to it, which
      // behind the web app is the web app. Everyone shares one allowance.
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        await toLim({}).expect(201);
      }
      const before = await countOf(lim.id);
      const res = await toLim({}).expect(429);
      expect(res.body).toEqual({ statusCode: 429, code: 'too_many_requests' });
      // Whoever comes next without one is refused with them.
      await reportPublicly(b.slug, { orgUnitId: bUnit }).expect(429);
      expect(await countOf(lim.id)).toBe(before);
      // A caller whose address was passed on is counted on their own.
      await toLim({}, '203.0.113.40').expect(201);
    });

    it('counts everything that is not an IP address as one caller', async () => {
      // What a sender can write in the header when nothing in front of the
      // web app replaces it: none of it becomes a caller of its own.
      const invented = [
        'not-an-address',
        'localhost',
        'example.invalid',
        '203.0.113',
        '999.1.1.1',
        '203.0.113.9:8080',
        '[2001:db8::1]',
        "'; drop table incidents; --",
        '<script>alert(1)</script>',
        `caller-${run}`,
      ];
      expect(invented).toHaveLength(PUBLIC_REPORTS_PER_HOUR);
      for (const value of invented) {
        const res = await toLim({}, value);
        expect([value, res.status]).toEqual([value, 201]);
      }
      // Ten different values, one allowance: the eleventh is refused, and so
      // is any other value that is not an address.
      await toLim({}, 'yet-another-name').expect(429);
      await toLim({}, `fresh-${run}`).expect(429);
      // A real address is someone else.
      await toLim({}, '203.0.113.50').expect(201);
    });

    it('counts a whole IPv6 /56 as one caller: what one home connection is handed', async () => {
      // Ten reports, each from another of the 256 networks of 64 bits that
      // one subscriber's /56 holds, and from another address in it.
      const inPrefix = (n: number) =>
        `2001:db8:5:${(0xab00 + n).toString(16)}::${(n + 1).toString(16)}`;
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        const res = await toLim({}, inPrefix(i * 20));
        expect([inPrefix(i * 20), res.status]).toEqual([inPrefix(i * 20), 201]);
      }
      // The eleventh, from yet another of them, and from the last one.
      await toLim({}, inPrefix(7)).expect(429);
      await toLim({}, '2001:db8:5:abff:ffff:ffff:ffff:ffff').expect(429);
      await toLim({}, '2001:0DB8:0005:AB00::1').expect(429);
      // The neighbouring /56 is somebody else.
      await toLim({}, '2001:db8:5:ac00::1').expect(201);
      await toLim({}, '2001:db8:5:aaff::1').expect(201);
    });

    it('does not wait when another report to the same hospital is being stored, and keeps nobody else waiting', async () => {
      const audited = async () =>
        (
          await owner.db.execute(
            sql`select 1 from audit_log where tenant_id = ${lim.id} and action = 'public_reporting_limit_reached'`,
          )
        ).rows.length;
      const [before, auditedBefore] = [await countOf(lim.id), await audited()];
      // Someone is storing a public report to this hospital, and is slow
      // about it: they hold its turn.
      const holder = await owner.pool.connect();
      try {
        await holder.query('begin');
        await holder.query(
          `select pg_advisory_xact_lock(hashtext('trustline.public_reports'), hashtext($1::text))`,
          [lim.id],
        );
        const began = Date.now();
        const res = await toLim({}, '203.0.113.150').expect(429);
        expect(res.body).toEqual({
          statusCode: 429,
          code: 'too_many_requests',
        });
        // Try again in a moment, not in an hour.
        expect(res.headers['retry-after']).toBe(String(BUSY_RETRY_SECONDS));
        // Many at once: each is answered, none stands in a queue holding a
        // database connection (the pool has ten for every hospital).
        const burst = await Promise.all(
          Array.from({ length: 25 }, (_, i) => toLim({}, `203.0.114.${i + 1}`)),
        );
        expect(burst.map((r) => r.status)).toEqual(Array(25).fill(429));
        expect(Date.now() - began).toBeLessThan(4_000);

        // A report that would be refused for what it says is refused for
        // that, without asking for the turn: sending such reports cannot
        // keep the form shut.
        const wrong = await toLim(
          { categoryId: b.categories.equipment },
          '203.0.113.151',
        ).expect(400);
        expect(wrong.body.code).toBe('unknown_category');
        const nowhere = await toLim(
          { orgUnitId: bUnit },
          '203.0.113.151',
        ).expect(400);
        expect(nowhere.body.code).toBe('unknown_org_unit');
        await toLim(
          { type: 'near_miss', harmLevel: 'mild' },
          '203.0.113.151',
        ).expect(400);

        // Everything else goes on: another hospital's form, this
        // hospital's own staff, its form's page, a follow-up.
        await reportPublicly(
          b.slug,
          { categoryId: b.categories.equipment, orgUnitId: bUnit },
          '203.0.113.152',
        ).expect(201);
        await http()
          .post('/incidents')
          .set('Cookie', lim.cookie)
          .send(
            reportBody({
              anonymous: false,
              categoryId: lim.categories.equipment,
              orgUnitId: limUnit,
            }),
          )
          .expect(201);
        await http().get(`/public/reporting/${lim.slug}`).expect(200);
        await followUp(lim.slug, 'x', '203.0.113.152').expect(404);
        // Nothing was stored for those turned away, and being busy is not
        // the ceiling: nothing says the form was shut.
        expect(await countOf(lim.id)).toBe(before + 1);
        expect(await audited()).toBe(auditedBefore);
      } finally {
        await holder.query('rollback');
        holder.release();
      }
      // The turn is free again: the next report is taken.
      await toLim({}, '203.0.113.150').expect(201);
    }, 30_000);

    it('counts a very long value as that same caller, and keeps none of it', async () => {
      const limits = app.get(PublicLimits, { strict: false }) as unknown as {
        limiters: Record<string, { attempts: Map<string, number[]> }>;
      };
      const before = await countOf(lim.id);
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
        // Eight thousand characters, different every time.
        const res = await toLim({}, `${i}${'a'.repeat(8_000)}`);
        expect(res.status).toBe(201);
      }
      await toLim({}, `x${'b'.repeat(8_000)}`).expect(429);
      // The same when the long value is dressed up as an address.
      await toLim({}, `${'0'.repeat(8_000)}::1`).expect(429);
      expect(await countOf(lim.id)).toBe(before + PUBLIC_REPORTS_PER_HOUR);
      // One key was stored for all of it, a few characters long.
      const keys = [...limits.limiters.report.attempts.keys()];
      expect(keys).toEqual(['unknown']);
    });

    it('ignores the header altogether when told the API is reached directly', async () => {
      // TRUST_PROXY_HOPS=0: no proxy is trusted, so what a sender writes in
      // the header counts for nothing and they are who connected.
      const previous = process.env.TRUST_PROXY_HOPS;
      process.env.TRUST_PROXY_HOPS = '0';
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const direct = moduleRef.createNestApplication();
      try {
        setupApp(direct);
        await direct.init();
        const post = (address: string) =>
          request(direct.getHttpServer() as App)
            .post(`/public/reporting/${lim.slug}`)
            .set('X-Forwarded-For', address)
            .send(
              reportBody({
                categoryId: lim.categories.equipment,
                orgUnitId: limUnit,
              }),
            );
        for (let i = 0; i < PUBLIC_REPORTS_PER_HOUR; i++) {
          // A new address claimed every time.
          await post(`198.51.100.${i + 1}`).expect(201);
        }
        await post('198.51.100.200').expect(429);
      } finally {
        if (previous === undefined) delete process.env.TRUST_PROXY_HOPS;
        else process.env.TRUST_PROXY_HOPS = previous;
        await direct.close();
      }
    });

    it('takes at most sixty public reports an hour for one hospital, whatever addresses are claimed', async () => {
      // The case the limit per address cannot stop: nothing in front of the
      // web app replaces the header, so a sender claims a new address with
      // every request and each one gets a fresh allowance.
      const toCap = (address: string) =>
        reportPublicly(
          cap.slug,
          { categoryId: cap.categories.equipment, orgUnitId: capUnit },
          address,
        );
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR; i++) {
        const res = await toCap(
          `198.51.${Math.floor(i / 200)}.${(i % 200) + 1}`,
        );
        expect([i, res.status]).toEqual([i, 201]);
      }
      expect(await countOf(cap.id)).toBe(PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR);
      // Up to here nothing said the form was shut: it was not.
      const shut = async () =>
        (
          await owner.db.execute<{
            actor_id: string | null;
            ip_address: string | null;
            entity_type: string | null;
            entity_id: string | null;
            changes: unknown;
          }>(
            sql`select actor_id, ip_address, entity_type, entity_id, changes from audit_log
                where tenant_id = ${cap.id} and action = 'public_reporting_limit_reached' order by occurred_at, id`,
          )
        ).rows;
      expect(await shut()).toEqual([]);
      const warned: string[] = [];
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((message) => {
          warned.push(String(message));
        });
      onTestFinished(() => warn.mockRestore());
      const aboutCap = () => warned.filter((line) => line.includes(cap.id));
      // The hospital has had its hour's worth. Refused like any other limit,
      // from addresses never seen before and from none at all.
      for (const address of ['198.51.77.1', '2001:db8:7::1', undefined]) {
        const res = await reportPublicly(
          cap.slug,
          { categoryId: cap.categories.equipment, orgUnitId: capUnit },
          address,
        ).expect(429);
        expect(res.body).toEqual({
          statusCode: 429,
          code: 'too_many_requests',
        });
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
      }
      // Many at once do not slip through together either.
      const burst = await Promise.all(
        Array.from({ length: 8 }, (_, i) => toCap(`198.51.88.${i + 1}`)),
      );
      expect(burst.map((r) => r.status)).toEqual(Array(8).fill(429));
      expect(await countOf(cap.id)).toBe(PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR);

      // Eleven were turned away. The hospital's audit log says once that its
      // form stopped taking reports, for its quality office to see: no
      // actor, and nothing of any sender.
      const ENTRY = {
        actor_id: null,
        ip_address: null,
        entity_type: 'tenant',
        entity_id: cap.id,
        changes: {
          limit: PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR,
          perMinutes: 60,
        },
      };
      expect(await shut()).toEqual([ENTRY]);
      // And the server's log says it once, with the hospital's id, for
      // whoever runs the server.
      expect(aboutCap()).toHaveLength(1);
      expect(aboutCap()[0]).toContain('Public reporting limit reached');
      for (const line of warned) {
        expect(line).not.toMatch(/198\.51\.|2001:db8/);
        expect(line).not.toContain('infusion pump');
      }
      const everything = await owner.db.execute<{ row: string }>(
        sql`select to_jsonb(t)::text as row from audit_log t where t.tenant_id = ${cap.id}`,
      );
      for (const { row } of everything.rows) {
        expect(row).not.toMatch(/198\.51\.|2001:db8/);
      }
      expect(
        (
          await owner.db.execute(
            sql`select 1 from audit_log where tenant_id = ${cap.id} and action = 'incident_reported'`,
          )
        ).rows,
      ).toHaveLength(PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR);

      // Other hospitals take reports as before, and so does this one's
      // staff: the ceiling is on the public form only.
      await reportPublicly(
        lim.slug,
        { categoryId: lim.categories.equipment, orgUnitId: limUnit },
        '198.51.99.1',
      ).expect(201);
      await http()
        .post('/incidents')
        .set('Cookie', cap.cookie)
        .send(
          reportBody({
            anonymous: true,
            categoryId: cap.categories.equipment,
            orgUnitId: capUnit,
          }),
        )
        .expect(201);
      // Following up is not reporting.
      const [any] = (
        await owner.db.execute<{ id: string }>(
          sql`select id from incidents where tenant_id = ${cap.id} and channel = 'public' limit 1`,
        )
      ).rows;
      expect(any).toBeDefined();
      await followUp(cap.slug, 'x', '198.51.99.2').expect(404);

      // When the hour has moved on past the oldest of them, there is room
      // for exactly as many again.
      await owner.db.execute(
        sql`update incidents set reported_at = reported_at - interval '61 minutes'
            where id in (select id from incidents where tenant_id = ${cap.id} and channel = 'public' order by reported_at limit 2)`,
      );
      await toCap('198.51.99.3').expect(201);
      await toCap('198.51.99.4').expect(201);
      await toCap('198.51.99.5').expect(429);
      // Shut again within the hour of the entry: it is not said twice.
      expect(await shut()).toEqual([ENTRY]);
      expect(aboutCap()).toHaveLength(1);
      // An hour after it was said, and still shut: said again, once.
      await owner.db.execute(
        sql`update audit_log set occurred_at = occurred_at - interval '61 minutes'
            where tenant_id = ${cap.id} and action = 'public_reporting_limit_reached'`,
      );
      await toCap('198.51.99.6').expect(429);
      await toCap('198.51.99.7').expect(429);
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => toCap(`198.51.98.${i + 1}`)),
      );
      expect(await shut()).toEqual([ENTRY, ENTRY]);
      expect(aboutCap()).toHaveLength(2);
    }, 60_000);

    it('allows thirty follow-up attempts an hour from one address, opening and commenting together', async () => {
      const sent = await toLim({}, '203.0.113.70').expect(201);
      const code = sent.body.followUpCode as string;
      const { id } = await byCode(lim.id, code);
      const address = '203.0.113.71';
      for (let i = 0; i < FOLLOW_UP_ATTEMPTS_PER_HOUR; i++) {
        // Wrong codes, and now and then a comment or a malformed request.
        const res =
          i % 10 === 9
            ? await followUpComment(lim.slug, 'wrong', 'Hi', address)
            : i % 10 === 8
              ? await publicPost(`/public/follow-up/${lim.slug}`, {}, address)
              : await followUp(lim.slug, `wrong-${i}`, address);
        expect(res.status).toBe(i % 10 === 8 ? 400 : 404);
      }
      // Even the right code is now refused, on either route, however spelt.
      const res = await followUp(lim.slug, code, address).expect(429);
      expect(res.body).toEqual({ statusCode: 429, code: 'too_many_requests' });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      await followUpComment(lim.slug, code, 'Let me in', address).expect(429);
      for (const [i, path] of [
        `/PUBLIC/FOLLOW-UP/${lim.slug}`,
        `/public/follow-up/${lim.slug}/`,
        `/public/follow-up/${lim.slug.toUpperCase()}`,
        `/public/follow-up/${b.slug}`,
        `/Public/Follow-Up/${lim.slug}/Comments/`,
      ].entries()) {
        const reached = await publicPost(
          path,
          { code, body: 'Variant' },
          `203.0.113.${80 + i}`,
        );
        expect([path, reached.status]).not.toEqual([path, 429]);
        const limited = await publicPost(
          path,
          { code, body: 'Variant' },
          address,
        );
        expect([path, limited.status]).toEqual([path, 429]);
      }
      const letIn = await owner.db.execute(
        sql`select 1 from incident_comments where incident_id = ${id} and body = 'Let me in'`,
      );
      expect(letIn.rows).toHaveLength(0);
      // Reporting is counted apart, and so is everyone else.
      await toLim({}, address).expect(201);
      await followUp(lim.slug, code, '203.0.113.72').expect(200);
    });
  });

  describe('the follow-up code', () => {
    const INTERNAL = `internal-remark-${run}`;
    let mine: Reported & { followUpCode: string }; // through the public link
    let inApp: Reported & { followUpCode: string }; // signed in, anonymously
    let named: Reported;
    let theirs: { followUpCode: string }; // hospital B's
    let elsewhere: Reported & { followUpCode: string }; // in the hospital that has the public form off
    // What Nest answers for a plain NotFoundException, and nothing added.
    const NOT_FOUND = { statusCode: 404, message: 'Not Found' };

    beforeAll(async () => {
      const sent = await reportPublicly(a.slug).expect(201);
      mine = {
        followUpCode: sent.body.followUpCode,
        ...(await byCode(a.id, sent.body.followUpCode)),
      };
      inApp = (await report(reporter, { anonymous: true })) as typeof inApp;
      named = await report(reporter);
      theirs = (
        await reportPublicly(b.slug, {
          categoryId: b.categories.equipment,
          orgUnitId: bUnit,
        }).expect(201)
      ).body;
      // A member of staff reporting anonymously where the public form was
      // never opened.
      elsewhere = (
        await http()
          .post('/incidents')
          .set('Cookie', off.cookie)
          .send(
            reportBody({
              anonymous: true,
              categoryId: off.categories.equipment,
              orgUnitId: offUnit,
            }),
          )
          .expect(201)
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
      // Staff who report anonymously keep getting the reference with it.
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

    it('opens the report as its reporter sees it, by the code alone', async () => {
      const res = await followUp(a.slug, mine.followUpCode).expect(200);
      expect(res.body).toMatchObject({
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
        // Deadlines are for the people handling it.
        triageDueAt: null,
        closeDueAt: null,
        overdue: null,
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

      // What a signed-in reporter gets for a report of theirs, field for
      // field, without the incident's id and its number, and with what the
      // page needs to say whose report form this is.
      const own = await open(reporter.cookie, named.id).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          ...Object.keys(own.body).filter(
            (key) => key !== 'id' && key !== 'reference',
          ),
          'hospital',
        ].sort(),
      );
      expect(res.body.hospital).toEqual({
        name: { en: 'Hospital a' },
        locales: ['en'],
        defaultLocale: 'en',
      });
      expect(own.body).toMatchObject({
        id: named.id,
        reference: named.reference,
      });
      expect(res.body).not.toHaveProperty('id');
      expect(res.body).not.toHaveProperty('reference');
      expect(body).not.toContain(mine.id);
      expect(body).not.toContain(mine.reference);
      expect(body).not.toContain('INC-');
    });

    it('is read without regard to letter case, hyphens or spaces', async () => {
      const bare = mine.followUpCode.replaceAll('-', '');
      for (const code of [
        mine.followUpCode.toLowerCase(),
        bare,
        ` ${bare.slice(0, 8)} ${bare.slice(8).toLowerCase()} `,
        `--${mine.followUpCode}--`,
      ]) {
        await followUp(a.slug, code).expect(200);
      }
    });

    it('is read whatever came with it when it was pasted, without costing an attempt', async () => {
      const code = mine.followUpCode;
      const groups = code.split('-');
      // Built from their numbers: none of these can be seen in a file.
      const mark = (...points: number[]) => String.fromCodePoint(...points);
      const RLM = mark(0x200f);
      const LRM = mark(0x200e);
      const pasted = {
        'between right-to-left marks': `${RLM}${code}${RLM}`,
        'between left-to-right marks': `${LRM}${code}${LRM}`,
        'isolated, as a right-to-left page shows it': `${mark(0x2068)}${code}${mark(0x2069)}`,
        'after an Arabic letter mark': `${mark(0x061c)}${code}`,
        'with non-breaking spaces for hyphens': groups.join(mark(0x00a0)),
        'with a zero-width space after each group': groups.join(mark(0x200b)),
        'with dots': groups.join('.'),
        'with long dashes': groups.join(mark(0x2014)),
        'in quotation marks': `${mark(0x201c)}${code}${mark(0x201d)}`,
        'with the punctuation that stood around it': `: ${code}.`,
      };
      // All of them from one address, which has thirty attempts an hour: a
      // refusal would have cost one and shown as a 404.
      for (const [how, typed] of Object.entries(pasted)) {
        const res = await followUp(a.slug, typed, '203.0.113.60');
        expect([how, res.status]).toEqual([how, 200]);
      }
      const said = await followUpComment(
        a.slug,
        `${RLM}${code.toLowerCase()}${RLM}`,
        'Pasted from my notes.',
        '203.0.113.60',
      ).expect(201);
      expect((said.body.comments as Comment[]).at(-1)?.body).toBe(
        'Pasted from my notes.',
      );
      // What is not the code stays not the code, marks or no marks.
      await followUp(a.slug, `${RLM}${code.slice(0, -1)}${RLM}`).expect(404);
      await followUp(a.slug, `${RLM}${RLM}`).expect(404);
    });

    it('works for a report made anonymously while signed in, with or without a session', async () => {
      await followUp(a.slug, inApp.followUpCode).expect(200);
      const res = await http()
        .post(`/public/follow-up/${a.slug}`)
        .set('Cookie', reporter.cookie)
        .send({ code: inApp.followUpCode })
        .expect(200);
      expect(res.body).toMatchObject({ access: 'reporter', reporter: null });
      // Through the app itself it stays out of their reach.
      await open(reporter.cookie, inApp.id).expect(404);
    });

    it('works whether or not the hospital takes reports without sign-in', async () => {
      // Where the public form was never opened: the form is 404, the code
      // that a member of staff was given works.
      await http().get(`/public/reporting/${off.slug}`).expect(404);
      const view = await followUp(off.slug, elsewhere.followUpCode).expect(200);
      expect(view.body).toMatchObject({ access: 'reporter', status: 'new' });
      // The page can say which hospital it is, though its form is closed.
      expect(view.body.hospital).toEqual({
        name: { en: 'Hospital off' },
        locales: ['en'],
        defaultLocale: 'en',
      });
      const said = await followUpComment(
        off.slug,
        elsewhere.followUpCode,
        'Is anyone looking at this?',
      ).expect(201);
      expect((said.body.comments as Comment[]).at(-1)).toMatchObject({
        body: 'Is anyone looking at this?',
        visibility: 'everyone',
        byReporter: true,
      });
      const handler = await http()
        .get(`/incidents/${elsewhere.id}`)
        .set('Cookie', off.cookie)
        .expect(200);
      expect((handler.body.comments as Comment[]).at(-1)).toMatchObject({
        body: 'Is anyone looking at this?',
        author: null,
        byReporter: true,
      });

      // And where it was open and is switched off again.
      await setPublicReporting(a.cookie, false).expect(200);
      try {
        await http().get(`/public/reporting/${a.slug}`).expect(404);
        await reportPublicly(a.slug).expect(404);
        await followUp(a.slug, mine.followUpCode).expect(200);
        await followUp(a.slug, inApp.followUpCode).expect(200);
        await followUpComment(a.slug, mine.followUpCode, 'Still there?').expect(
          201,
        );
        const later = await report(reporter, { anonymous: true });
        await followUp(a.slug, later.followUpCode!).expect(200);
      } finally {
        await setPublicReporting(a.cookie, true).expect(200);
      }
      await followUp(a.slug, mine.followUpCode).expect(200);
    });

    it('answers every wrong code with the same 404, wherever it is asked', async () => {
      const wrongCode = 'K7QM-2RXD-9FHT-WB3N';
      const tries: [string, string][] = [
        // Codes that are nobody's.
        [a.slug, wrongCode],
        [a.slug, mine.followUpCode.slice(0, -1)],
        [a.slug, `${mine.followUpCode}2`],
        [a.slug, 'x'],
        [a.slug, ''.padEnd(16, '2')],
        // What is known of a report without being its code.
        [a.slug, mine.reference],
        [a.slug, named.reference],
        [a.slug, mine.id],
        [a.slug, hashOf(mine.followUpCode)],
        // Another hospital's code, asked for here; and ours, asked there.
        [a.slug, theirs.followUpCode],
        [a.slug, elsewhere.followUpCode],
        [b.slug, mine.followUpCode],
        [off.slug, mine.followUpCode],
        // The right code, where there is no hospital to ask: one that does
        // not exist, and one that is suspended.
        [`${prefix}-nowhere`, mine.followUpCode],
        [suspended.slug, mine.followUpCode],
        [suspended.slug, goneCode],
      ];
      const limits = app.get(PublicLimits, { strict: false });
      for (const [slug, code] of tries) {
        limits.forget();
        const res = await followUp(slug, code);
        expect([slug, code, res.status]).toEqual([slug, code, 404]);
        // Nothing of any hospital: not its name, not that there is one.
        expect(res.body).toEqual(NOT_FOUND);
        expect(JSON.stringify(res.body)).not.toContain('Hospital');
        expect(res.headers['retry-after']).toBeUndefined();
        const said = await followUpComment(slug, code, 'Hello');
        expect(said.status).toBe(404);
        expect(said.body).toEqual(NOT_FOUND);
        expect(said.headers['content-length']).toBe(
          res.headers['content-length'],
        );
      }
      // And none of those attempts wrote anything.
      const comments = await owner.db.execute(
        sql`select 1 from incident_comments where body = 'Hello' and tenant_id in (${a.id}, ${b.id}, ${off.id}, ${suspended.id})`,
      );
      expect(comments.rows).toHaveLength(0);
      // The other hospital's own code does work where it belongs.
      await followUp(b.slug, theirs.followUpCode).expect(200);
      // The suspended hospital's code really was one.
      expect((await byCode(suspended.id, goneCode)).id).toBeTruthy();
    });

    it('takes as long to refuse whatever the reason, and no longer to accept', async () => {
      const limits = app.get(PublicLimits, { strict: false });
      const timed = async (slug: string, code: string, route = '') => {
        limits.forget();
        const began = performance.now();
        const res = await publicPost(`/public/follow-up/${slug}${route}`, {
          code,
          ...(route && { body: 'Hello' }),
        });
        return { status: res.status, ms: performance.now() - began };
      };
      const refusals: [string, string][] = [
        [a.slug, 'K7QM-2RXD-9FHT-WB3N'],
        [a.slug, theirs.followUpCode],
        [off.slug, mine.followUpCode],
        [`${prefix}-nowhere`, mine.followUpCode],
        [suspended.slug, goneCode],
        ['%00', mine.followUpCode],
      ];
      for (const route of ['', '/comments']) {
        for (const [slug, code] of refusals) {
          const { status, ms } = await timed(slug, code, route);
          expect([slug, status]).toEqual([slug, 404]);
          // Held to the same floor, which is far more than the work takes:
          // how long that was no longer shows. (A timer may fire a
          // millisecond early.)
          expect(ms).toBeGreaterThanOrEqual(REFUSAL_STEP_MS - 2);
          expect(ms).toBeLessThan(REFUSAL_STEP_MS + 250);
        }
      }
      // The right code is answered as soon as it is read: nothing to hide.
      const fast = [];
      for (let i = 0; i < 5; i++) {
        const { status, ms } = await timed(a.slug, mine.followUpCode);
        expect(status).toBe(200);
        fast.push(ms);
      }
      expect(Math.min(...fast)).toBeLessThan(REFUSAL_STEP_MS - 10);
    });

    it('refuses a request that is not a code, before anything is looked up', async () => {
      const limits = app.get(PublicLimits, { strict: false });
      for (const body of [
        {},
        { code: '' },
        { code: 12345 },
        { code: ['x'] },
        { code: null },
        { code: 'x'.repeat(81) },
        // The reference is no longer part of it, right or wrong.
        { reference: mine.reference, code: mine.followUpCode },
        { code: mine.followUpCode, id: mine.id },
        // Control characters, in a code that would otherwise be right.
        { code: `${mine.followUpCode}\u0000` },
        { code: `\u0000${mine.followUpCode}` },
        { code: mine.followUpCode.replace('-', '\u0001') },
        { code: `${mine.followUpCode}\u001b[2J` },
        { code: `${mine.followUpCode}\u007f` },
      ]) {
        limits.forget();
        const res = await publicPost(`/public/follow-up/${a.slug}`, body);
        expect([JSON.stringify(body), res.status]).toEqual([
          JSON.stringify(body),
          400,
        ]);
        expect(res.body).toEqual({ statusCode: 400, message: 'Bad Request' });
        await publicPost(`/public/follow-up/${a.slug}/comments`, {
          ...body,
          body: 'Hello',
        }).expect(400);
        // The same where there is no hospital: it says nothing about one.
        await publicPost(`/public/follow-up/${prefix}-nowhere`, body).expect(
          400,
        );
      }
    });

    it('gives a reader with a code no name or id of anyone working at the hospital', async () => {
      // A sentinel event through the public link, with as many people having
      // acted on it as there are ways to act.
      const sent = await reportPublicly(a.slug, {
        harmLevel: 'severe',
      }).expect(201);
      const code = sent.body.followUpCode as string;
      const { id, reference } = await byCode(a.id, code);
      await triage(quality.cookie, id, {
        harmLevel: 'severe',
        isSentinel: true,
        assignedTo: assignee.id,
      }).expect(200);
      await triage(wardQuality.cookie, id, {
        harmLevel: 'severe',
        isSentinel: true,
        ownerUnitId: lab,
        assignedTo: manager.id,
      }).expect(200);
      await move(triageOnly.cookie, id, 'in_progress').expect(200);
      for (const who of [quality, manager, assignee, a]) {
        await comment(who.cookie, id, 'A word to you.', 'everyone').expect(
          who === assignee ? 404 : 201,
        );
      }
      await comment(quality2.cookie, id, 'Among us.', 'internal').expect(201);
      await followUpComment(a.slug, code, 'Thank you.').expect(201);
      await move(quality.cookie, id, 'awaiting_sign_off', PROPOSAL).expect(200);
      await move(quality2.cookie, id, 'in_progress', 'Not yet.', {
        kind: 'send_back',
      }).expect(200);
      await move(quality2.cookie, id, 'awaiting_sign_off', PROPOSAL).expect(
        200,
      );
      await move(quality.cookie, id, 'in_progress', 'One more thing.', {
        kind: 'withdraw',
      }).expect(200);
      await move(labQuality.cookie, id, 'awaiting_sign_off', PROPOSAL).expect(
        200,
      );
      await signOff(200, signOnly.cookie, id, 'Agreed.');
      await move(a.cookie, id, 'in_progress', 'It happened again.').expect(200);

      const res = await followUp(a.slug, code).expect(200);
      const body = JSON.stringify(res.body);
      // Every member of staff the hospital has, whether or not they touched
      // this incident: no id and no name, anywhere in the answer.
      const everyone = await owner.db.execute<{
        id: string;
        name: Record<string, string>;
        email: string;
      }>(sql`select id, name, email from users where tenant_id = ${a.id}`);
      expect(everyone.rows.length).toBeGreaterThanOrEqual(10);
      for (const person of everyone.rows) {
        expect([person.email, body.includes(person.id)]).toEqual([
          person.email,
          false,
        ]);
        expect([person.email, body.includes(person.email)]).toEqual([
          person.email,
          false,
        ]);
        for (const name of Object.values(person.name)) {
          expect([name, body.includes(name)]).toEqual([name, false]);
        }
      }
      expect(body).not.toContain('Person ');
      expect(body).not.toContain('@test.invalid');
      // Nor the incident's own id and number.
      expect(body).not.toContain(id);
      expect(body).not.toContain(reference);
      expect(res.body.people).toEqual({});
      expect(res.body).toMatchObject({
        assignedTo: null,
        closureRequestedBy: null,
        closureRequestedAt: null,
        reporter: null,
      });

      // What staff did is there, marked as theirs and carrying nobody.
      const events = res.body.events as (Event & { byStaff: boolean })[];
      expect(events.map((e) => e.kind)).toEqual([
        'reported',
        'triaged',
        'triaged',
        'status_changed',
        'commented',
        'commented',
        'commented',
        'commented',
        'sign_off_requested',
        'sent_back',
        'sign_off_requested',
        'status_changed',
        'sign_off_requested',
        'signed_off',
        'reopened',
      ]);
      for (const event of events) {
        expect([event.kind, event.actor]).toEqual([event.kind, null]);
        expect(event.byStaff).toBe(!event.byReporter);
      }
      // Theirs: the report, and the one comment written with the code.
      expect(events.filter((e) => e.byReporter).map((e) => e.kind)).toEqual([
        'reported',
        'commented',
      ]);
      const comments = res.body.comments as (Comment & { byStaff: boolean })[];
      expect(
        comments.map((c) => [c.body, c.author, c.byReporter, c.byStaff]),
      ).toEqual([
        ['A word to you.', null, false, true],
        ['A word to you.', null, false, true],
        ['A word to you.', null, false, true],
        ['Thank you.', null, true, false],
      ]);

      // Signed in, everyone is named as before, staff and reporter marked
      // the same way.
      const handler = await open(quality.cookie, id).expect(200);
      const named = handler.body.events as (Event & { byStaff: boolean })[];
      for (const event of named) {
        expect(event.byStaff).toBe(!event.byReporter);
        expect([event.kind, event.actor !== null]).toEqual([
          event.kind,
          event.byStaff,
        ]);
      }
      expect(Object.keys(handler.body.people).sort()).toEqual(
        [assignee.id, manager.id].sort(),
      );
    });

    describe('a comment by the anonymous reporter', () => {
      const WORDS = `reporter-words-${run}`;
      const SENDER = '203.0.113.88';
      let answer: request.Response;
      let written: { id: string; visibility: string; createdAt: string };

      beforeAll(async () => {
        answer = await http()
          .post(`/public/follow-up/${a.slug}/comments`)
          .set('X-Forwarded-For', SENDER)
          // Signed in while commenting with the code: it must not show.
          .set('Cookie', reporter.cookie)
          .send({
            code: inApp.followUpCode.toLowerCase(),
            body: `  ${WORDS}  `,
          })
          .expect(201);
        written = (answer.body.comments as (typeof written)[]).at(-1)!;
      });

      it('is for everyone, and answered with the report as it now reads', async () => {
        // The same as opening the report with the code straight after, so
        // the page need not spend a second attempt on reading it again.
        const read = await followUp(a.slug, inApp.followUpCode).expect(200);
        expect(answer.body).toEqual(read.body);
        expect(answer.body.comments).toEqual([
          {
            id: expect.any(String),
            author: null,
            byReporter: true,
            byStaff: false,
            body: WORDS,
            visibility: 'everyone',
            createdAt: expect.any(String),
          },
        ]);
        expect((answer.body.events as Event[]).at(-1)).toMatchObject({
          kind: 'commented',
          actor: null,
          byReporter: true,
        });
        expect(answer.body).toMatchObject({
          access: 'reporter',
          hospital: {
            name: { en: 'Hospital a' },
            locales: ['en'],
            defaultLocale: 'en',
          },
        });
        expect(answer.body).not.toHaveProperty('id');
        expect(answer.body).not.toHaveProperty('reference');
        const body = JSON.stringify(answer.body);
        expect(body).not.toContain(inApp.id);
        expect(body).not.toContain(inApp.reference);
        expect(body).not.toContain(reporter.id);
      });

      it('costs one attempt at the code, not two', async () => {
        // An incident takes ten comments by code in a day, so the thirty
        // attempts an address has in an hour are spent on three reports.
        const codes: string[] = [];
        for (let i = 0; i < 4; i++) {
          const sent = await reportPublicly(a.slug).expect(201);
          codes.push(sent.body.followUpCode as string);
        }
        const address = '203.0.113.90';
        const perIncident = FOLLOW_UP_COMMENTS_PER_INCIDENT_PER_DAY;
        expect(FOLLOW_UP_ATTEMPTS_PER_HOUR).toBe(3 * perIncident);
        // Thirty comments, each answered with the report: thirty attempts.
        for (let i = 0; i < FOLLOW_UP_ATTEMPTS_PER_HOUR; i++) {
          const res = await followUpComment(
            a.slug,
            codes[Math.floor(i / perIncident)],
            `Word ${i}`,
            address,
          );
          expect(res.status).toBe(201);
          expect(res.body.comments).toHaveLength((i % perIncident) + 1);
        }
        // The next one is to a report that has had no comment at all: it is
        // the address that has had its hour's worth.
        const res = await followUpComment(
          a.slug,
          codes[3],
          'One too many',
          address,
        ).expect(429);
        expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
        await followUp(a.slug, codes[3], address).expect(429);
        await followUpComment(
          a.slug,
          codes[3],
          'From elsewhere',
          '203.0.113.91',
        ).expect(201);
      });

      it('has no author, and nothing records who wrote it', async () => {
        const comments = await owner.db.execute(
          sql`select id, author_id, by_reporter, as_handler, body, visibility from incident_comments where incident_id = ${inApp.id}`,
        );
        expect(comments.rows).toEqual([
          {
            id: written.id,
            author_id: null,
            by_reporter: true,
            as_handler: false,
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
        // Nobody was notified of it as the reporter, and no notification
        // about this report is addressed to the account that was signed in.
        const told = await owner.db.execute(
          sql`select 1 from notifications where incident_id = ${inApp.id} and user_id = ${reporter.id}`,
        );
        expect(told.rows).toHaveLength(0);
      });

      it('reaches the handlers as written by the reporter, and the reporter sees it too', async () => {
        for (const who of [quality, manager]) {
          const res = await open(who.cookie, inApp.id).expect(200);
          expect(res.body.comments).toEqual([
            {
              id: written.id,
              author: null,
              byReporter: true,
              byStaff: false,
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
        const back = await followUp(a.slug, inApp.followUpCode).expect(200);
        expect((back.body.comments as Comment[]).map((c) => c.body)).toEqual([
          WORDS,
        ]);
      });

      it('refuses an invalid one, and cannot be made internal', async () => {
        const limits = app.get(PublicLimits, { strict: false });
        const given = { code: inApp.followUpCode };
        for (const body of [
          { ...given },
          { ...given, body: '' },
          { ...given, body: '   ' },
          { ...given, body: 'x'.repeat(2001) },
          { ...given, body: 'Hel\u0000lo' },
          { ...given, body: 'Hel\u0007lo' },
          { ...given, body: 'Hello', visibility: 'internal' },
          { ...given, body: 'Hello', visibility: 'everyone' },
          { ...given, body: 'Hello', authorId: quality.id },
          { ...given, body: 'Hello', reference: inApp.reference },
        ]) {
          limits.forget();
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

    describe('how much a code may write, and until when', () => {
      const fresh = async () => {
        const sent = await reportPublicly(a.slug).expect(201);
        const code = sent.body.followUpCode as string;
        return { code, ...(await byCode(a.id, code)) };
      };
      const written = async (id: string) =>
        (
          await owner.db.execute<{ comments: number; events: number }>(
            sql`select
                  (select count(*)::int from incident_comments where incident_id = ${id}) as comments,
                  (select count(*)::int from incident_events where incident_id = ${id} and kind = 'commented') as events`,
          )
        ).rows[0];
      const TOO_MANY = { statusCode: 429, code: 'too_many_requests' };
      const DAY_SECONDS = 86_400;

      it('takes ten comments by code on one incident in a day, whatever addresses they come from', async () => {
        const { code, id } = await fresh();
        for (let i = 0; i < FOLLOW_UP_COMMENTS_PER_INCIDENT_PER_DAY; i++) {
          // Each from an address never seen before: the limit per address
          // has nothing against any of them.
          const res = await followUpComment(
            a.slug,
            code,
            `Word ${i}`,
            `203.0.115.${i + 1}`,
          );
          expect([i, res.status]).toEqual([i, 201]);
        }
        const res = await followUpComment(
          a.slug,
          code,
          'One too many',
          '203.0.115.100',
        ).expect(429);
        expect(res.body).toEqual(TOO_MANY);
        // Until the oldest of the ten is a day old: most of a day from now.
        const wait = Number(res.headers['retry-after']);
        expect(wait).toBeGreaterThan(DAY_SECONDS - 300);
        expect(wait).toBeLessThanOrEqual(DAY_SECONDS);
        // Not by writing the code another way, nor by sending at once.
        await followUpComment(
          a.slug,
          ` ${code.toLowerCase().replaceAll('-', '')} `,
          'Another way',
          '203.0.115.101',
        ).expect(429);
        const burst = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            followUpComment(a.slug, code, 'At once', `203.0.115.${110 + i}`),
          ),
        );
        expect(burst.map((r) => r.status)).toEqual(Array(6).fill(429));
        // Nothing of what was refused is kept, anywhere.
        expect(await written(id)).toEqual({ comments: 10, events: 10 });
        const kept = await owner.db.execute(
          sql`select 1 from audit_log where tenant_id = ${a.id} and entity_id = ${id} and action = 'incident_commented'`,
        );
        expect(kept.rows).toHaveLength(10);

        // The code still reads the report, comments and all.
        const read = await followUp(a.slug, code, '203.0.115.120').expect(200);
        expect(read.body.comments).toHaveLength(10);
        // Another report is not held up by this one's.
        const other = await fresh();
        await followUpComment(a.slug, other.code, 'Mine is new.').expect(201);
        // Nor is the hospital's own staff, whose comments are not counted.
        await triage(quality.cookie, id).expect(200);
        for (let i = 0; i < 3; i++) {
          await comment(quality.cookie, id, `Read ${i}.`, 'everyone').expect(
            201,
          );
        }
        await followUpComment(a.slug, code, 'Still one too many').expect(429);

        // When the oldest of the ten is a day old there is room for one
        // more, and for one only.
        await owner.db.execute(
          sql`update incident_comments set created_at = created_at - interval '24 hours 1 minute'
              where id = (select id from incident_comments where incident_id = ${id} and author_id is null order by created_at limit 1)`,
        );
        await followUpComment(a.slug, code, 'A day later.').expect(201);
        const again = await followUpComment(a.slug, code, 'And again.').expect(
          429,
        );
        expect(again.body).toEqual(TOO_MANY);
        expect(await written(id)).toEqual({ comments: 14, events: 14 });
      });

      it('cannot be overrun by sending the last ones at once', async () => {
        const { code, id } = await fresh();
        for (let i = 0; i < FOLLOW_UP_COMMENTS_PER_INCIDENT_PER_DAY - 2; i++) {
          await followUpComment(a.slug, code, `Word ${i}`).expect(201);
        }
        // Room for two, and eight arrive together from eight addresses.
        const burst = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            followUpComment(
              a.slug,
              code,
              `Together ${i}`,
              `203.0.116.${i + 1}`,
            ),
          ),
        );
        expect(burst.map((r) => r.status).sort((x, y) => x - y)).toEqual([
          201, 201, 429, 429, 429, 429, 429, 429,
        ]);
        expect(await written(id)).toEqual({
          comments: FOLLOW_UP_COMMENTS_PER_INCIDENT_PER_DAY,
          events: FOLLOW_UP_COMMENTS_PER_INCIDENT_PER_DAY,
        });
      });

      it('takes no comment by code once the incident has ended, still reads it, and takes them again when it is reopened', async () => {
        const { code, id } = await fresh();
        const say = (body: string) => followUpComment(a.slug, code, body);
        // While anyone is still working on it: yes, at every stage.
        await say('While new.').expect(201);
        await triage(quality.cookie, id).expect(200);
        await say('While triaged.').expect(201);
        await move(quality.cookie, id, 'in_progress').expect(200);
        await say('While in progress.').expect(201);
        await move(quality.cookie, id, 'closed', 'Done.').expect(200);

        const ended = await say('After it was closed.').expect(409);
        expect(ended.body.code).toBe('incident_ended');
        expect(ended.headers['retry-after']).toBeUndefined();
        // Said to whoever holds the code, and to nobody else: a wrong code
        // on the same incident's hospital is the 404 it always was.
        const wrong = await followUpComment(
          a.slug,
          'K7QM-2RXD-9FHT-WB3N',
          'After it was closed.',
        ).expect(404);
        expect(wrong.body).toEqual(NOT_FOUND);
        // Nothing was stored, and nobody was told of anything.
        expect(await written(id)).toEqual({ comments: 3, events: 3 });
        const body = await owner.db.execute(
          sql`select 1 from incident_comments where incident_id = ${id} and body = 'After it was closed.'`,
        );
        expect(body.rows).toHaveLength(0);
        // The code still reads the report, its ending included.
        const read = await followUp(a.slug, code).expect(200);
        expect(read.body).toMatchObject({
          status: 'closed',
          access: 'reporter',
        });
        expect(read.body.comments).toHaveLength(3);
        // Staff who are signed in may still write on it.
        await comment(quality.cookie, id, 'Filed.', 'everyone').expect(201);

        // Reopened: somebody is working on it again, and the reporter may
        // write again.
        await move(
          quality.cookie,
          id,
          'in_progress',
          'It happened again.',
        ).expect(200);
        const back = await say('Thank you for looking again.').expect(201);
        expect((back.body.comments as Comment[]).at(-1)).toMatchObject({
          body: 'Thank you for looking again.',
          byReporter: true,
        });

        // The same for a report that was not taken forward.
        const aside = await fresh();
        await move(
          quality.cookie,
          aside.id,
          'rejected',
          'Not an incident.',
        ).expect(200);
        const refused = await followUpComment(
          a.slug,
          aside.code,
          'But it was.',
        ).expect(409);
        expect(refused.body.code).toBe('incident_ended');
        expect(
          (await followUp(a.slug, aside.code).expect(200)).body.status,
        ).toBe('rejected');
        await move(
          quality.cookie,
          aside.id,
          'in_progress',
          'Looked again.',
        ).expect(200);
        await followUpComment(a.slug, aside.code, 'Thank you.').expect(201);
      });

      it('still takes them while a closure awaits its second signature', async () => {
        const sent = await reportPublicly(a.slug, {
          harmLevel: 'death',
        }).expect(201);
        const code = sent.body.followUpCode as string;
        const { id } = await byCode(a.id, code);
        await triage(quality.cookie, id, { harmLevel: 'death' }).expect(200);
        await move(quality.cookie, id, 'awaiting_sign_off', PROPOSAL).expect(
          200,
        );
        // Not closed yet: one more person has to agree.
        await followUpComment(a.slug, code, 'One thing more.').expect(201);
        await signOff(200, quality2.cookie, id);
        const res = await followUpComment(a.slug, code, 'Too late.').expect(
          409,
        );
        expect(res.body.code).toBe('incident_ended');
      });

      it('answers both refusals at once: they come only with a right code, which has nothing left to hide', async () => {
        const limits = app.get(PublicLimits, { strict: false });
        const { code, id } = await fresh();
        await move(quality.cookie, id, 'rejected', 'Not an incident.').expect(
          200,
        );
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
          limits.forget();
          const began = performance.now();
          await followUpComment(a.slug, code, 'Hello?').expect(409);
          times.push(performance.now() - began);
        }
        // Not held to the step a "not found" is held to.
        expect(Math.min(...times)).toBeLessThan(REFUSAL_STEP_MS - 10);
      });
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
          {
            to: 'in_progress',
            noteRequired: false,
            revisionRequired: false,
            kind: 'start',
          },
          {
            to: 'awaiting_sign_off',
            noteRequired: true,
            revisionRequired: false,
            kind: 'request_sign_off',
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
          revisionRequired: false,
          kind: 'request_sign_off',
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
        {
          to: 'closed',
          noteRequired: false,
          revisionRequired: true,
          kind: 'sign_off',
        },
        {
          to: 'in_progress',
          noteRequired: true,
          revisionRequired: false,
          kind: 'send_back',
        },
      ];
      const withdraw = [
        {
          to: 'in_progress',
          noteRequired: true,
          revisionRequired: false,
          kind: 'withdraw',
        },
      ];
      expect(await movesOf(quality, id)).toEqual(withdraw);
      // A second person who may also triage has two ways back to "in
      // progress", told apart by their kind.
      expect(await movesOf(quality2, id)).toEqual([
        ...secondPerson,
        ...withdraw,
      ]);
      expect(await movesOf(wardQuality, id)).toEqual([
        ...secondPerson,
        ...withdraw,
      ]);
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
      const res = await signOff(200, quality2.cookie, id);
      expect(res.body).toMatchObject({
        status: 'closed',
        // The summary that was proposed, now the one it was closed with.
        closureSummary: PROPOSAL,
        closureRequestedBy: { id: quality.id },
        moves: [
          {
            to: 'in_progress',
            noteRequired: true,
            revisionRequired: false,
            kind: 'reopen',
          },
        ],
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
      const noted = await signOff(
        200,
        wardQuality.cookie,
        other.id,
        'Reviewed with the ward.',
      );
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
      const res = await signOff(200, signOnly.cookie, id);
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
      const sendBack = { kind: 'send_back' };
      for (const note of [undefined, '  ']) {
        const res = await move(
          quality2.cookie,
          id,
          'in_progress',
          note,
          sendBack,
        ).expect(400);
        expect(res.body.code).toBe('note_required');
      }
      const res = await move(
        quality2.cookie,
        id,
        'in_progress',
        REASON,
        sendBack,
      ).expect(200);
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
      await move(quality2.cookie, id, 'in_progress', 'Needs more.', {
        kind: 'send_back',
      }).expect(200);
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
      const res = await signOff(200, quality.cookie, id);
      expect(res.body).toMatchObject({
        status: 'closed',
        closureSummary: 'Second try.',
        closureRequestedBy: { id: quality2.id },
      });
      expect((await stored(id)).closed_by).toBe(quality.id);
    });

    it('can be withdrawn by whoever asked, or by anyone who may triage it', async () => {
      const withdraw = { kind: 'withdraw' };
      const first = await awaitingSignOff();
      const none = await move(
        quality.cookie,
        first.id,
        'in_progress',
        undefined,
        withdraw,
      ).expect(400);
      expect(none.body.code).toBe('note_required');
      const res = await move(
        quality.cookie,
        first.id,
        'in_progress',
        'Asked too early.',
        withdraw,
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
        withdraw,
      ).expect(200);
      expect((other.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'status_changed',
        actor: { id: triageOnly.id },
        details: { withdrawn: true },
      });

      // Someone who could have sent it back may also just take it back:
      // what they send decides which it is.
      const third = await awaitingSignOff();
      const taken = await move(
        quality2.cookie,
        third.id,
        'in_progress',
        'Wrong incident.',
        withdraw,
      ).expect(200);
      expect((taken.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'status_changed',
        actor: { id: quality2.id },
        details: { note: 'Wrong incident.', withdrawn: true },
      });

      // The reporter learns that the request was taken back, not what was
      // said: like the reason for sending one back, that is between the
      // people handling it. Other notes they are shown stay as they were.
      const theirs = await open(reporter.cookie, third.id).expect(200);
      expect(theirs.body.access).toBe('reporter');
      expect((theirs.body.events as Event[]).at(-1)).toEqual(
        expect.objectContaining({
          kind: 'status_changed',
          fromStatus: 'awaiting_sign_off',
          toStatus: 'in_progress',
          details: { withdrawn: true },
        }),
      );
      expect(JSON.stringify(theirs.body)).not.toContain('Wrong incident.');
      expect(
        (theirs.body.events as Event[]).find(
          (e) => e.kind === 'sign_off_requested',
        ),
      ).toMatchObject({ details: { note: PROPOSAL } });
      // A handler without the right to triage still reads it.
      const handler = await open(manager.cookie, third.id).expect(200);
      expect((handler.body.events as Event[]).at(-1)).toMatchObject({
        details: { note: 'Wrong incident.', withdrawn: true },
      });

      // Not someone who may sign off but not triage, and did not ask.
      const fourth = await awaitingSignOff();
      const refused = await move(
        signOnly.cookie,
        fourth.id,
        'in_progress',
        'Not mine to take back.',
        withdraw,
      ).expect(403);
      expect(refused.body).toMatchObject({
        code: 'missing_permission',
        permission: 'incidents.triage',
      });
      expect((await stored(fourth.id)).status).toBe('awaiting_sign_off');
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
        {
          to: 'in_progress',
          noteRequired: true,
          revisionRequired: false,
          kind: 'withdraw',
        },
      ]);
      // Their own request, so not theirs to sign off or do anything else to.
      await move(leaver.cookie, id, 'closed').expect(403);
      await move(leaver.cookie, id, 'in_progress', 'I have moved on.', {
        kind: 'withdraw',
      }).expect(200);
      // With the request gone they are a viewer like any other.
      const after = await move(leaver.cookie, id, 'closed', 'Done').expect(403);
      expect(after.body).toMatchObject({
        code: 'missing_permission',
        permission: 'incidents.triage',
      });
    });

    it('has to be told which way back is meant, and checks the kind of any move', async () => {
      const { id } = await awaitingSignOff();
      // Two moves lead from waiting to "in progress": nobody may leave it
      // to the API to guess, whichever of the two they could make.
      for (const who of [quality, quality2, triageOnly, signOnly]) {
        const res = await move(who.cookie, id, 'in_progress', 'Back').expect(
          400,
        );
        expect(res.body.code).toBe('kind_required');
      }
      // Each kind is open only to those the move is for.
      const own = await move(quality.cookie, id, 'in_progress', 'Back', {
        kind: 'send_back',
      }).expect(403);
      expect(own.body.code).toBe('same_person');
      const without = await move(triageOnly.cookie, id, 'in_progress', 'Back', {
        kind: 'send_back',
      }).expect(403);
      expect(without.body).toMatchObject({
        code: 'missing_permission',
        permission: 'incidents.sign_off',
      });
      // A kind that does not lead there from here, or is no kind at all.
      for (const kind of ['reopen', 'start', 'sign_off', 'close']) {
        const res = await move(quality2.cookie, id, 'in_progress', 'Back', {
          kind,
        }).expect(409);
        expect(res.body.code).toBe('invalid_transition');
      }
      for (const kind of ['sent_back', 'SEND_BACK', '', null, 7]) {
        await move(quality2.cookie, id, 'in_progress', 'Back', { kind }).expect(
          400,
        );
      }
      const wrong = await move(quality2.cookie, id, 'closed', undefined, {
        kind: 'close',
      }).expect(409);
      expect(wrong.body.code).toBe('invalid_transition');
      expect((await stored(id)).status).toBe('awaiting_sign_off');
      // Where one move leads there, the kind may be left out or be right.
      await signOff(200, quality2.cookie, id, undefined, {
        kind: 'sign_off',
      });

      const plain = await report(reporter);
      await triage(quality.cookie, plain.id).expect(200);
      const stale = await move(
        quality.cookie,
        plain.id,
        'in_progress',
        'Again',
        {
          kind: 'reopen',
        },
      ).expect(409);
      expect(stale.body.code).toBe('invalid_transition');
      await move(quality.cookie, plain.id, 'in_progress', undefined, {
        kind: 'start',
      }).expect(200);
      await move(quality.cookie, plain.id, 'closed', 'Done.', {
        kind: 'close',
      }).expect(200);
      const reopened = await move(
        quality.cookie,
        plain.id,
        'in_progress',
        'Again',
        {
          kind: 'reopen',
        },
      ).expect(200);
      expect((reopened.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'reopened',
      });
    });

    it('offers only moves it accepts back, by the kind and status it names', async () => {
      // Every move offered to anyone, at every point of a sentinel event's
      // life, sent back exactly as it was offered.
      const followed = new Set<string>();
      const follow = async (who: Staff, id: string, kind: string) => {
        const offered = await movesOf(who, id);
        const chosen = offered.find((m) => m.kind === kind);
        expect([kind, offered.map((m) => m.kind)]).toEqual([
          kind,
          expect.arrayContaining([kind]),
        ]);
        // A kind names one move among those offered.
        expect(new Set(offered.map((m) => m.kind)).size).toBe(offered.length);
        // Sent with the revision exactly where the offer says it is needed.
        const read = await open(who.cookie, id).expect(200);
        const res = await move(who.cookie, id, chosen!.to, 'A reason.', {
          kind: chosen!.kind,
          ...(chosen!.revisionRequired && { revision: read.body.revision }),
        }).expect(200);
        expect(res.body.status).toBe(chosen!.to);
        followed.add(kind);
      };
      const { id } = await sentinel();
      await follow(quality, id, 'start');
      await follow(quality, id, 'request_sign_off');
      await follow(quality2, id, 'send_back');
      await follow(quality2, id, 'request_sign_off');
      await follow(quality2, id, 'withdraw');
      await follow(quality, id, 'request_sign_off');
      await follow(signOnly, id, 'sign_off');
      await follow(quality, id, 'reopen');
      const other = await report(reporter);
      await follow(quality, other.id, 'reject');
      await follow(quality, other.id, 'reopen');
      await follow(quality, other.id, 'close');
      expect([...followed].sort()).toEqual([
        'close',
        'reject',
        'reopen',
        'request_sign_off',
        'send_back',
        'sign_off',
        'start',
        'withdraw',
      ]);
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

    it('goes on needing sign-off once it has, whatever triage calls it afterwards', async () => {
      // One person with the right to triage must not be able to close a
      // sentinel event alone by first calling it something else.
      const { id } = await sentinel();
      const lowered = await triage(quality.cookie, id, {
        harmLevel: 'severe',
        isSentinel: false,
      }).expect(200);
      // The change itself is allowed, and leaves its trace.
      expect(lowered.body).toMatchObject({
        harmLevel: 'severe',
        isSentinel: false,
        needsSignOff: true,
      });
      expect(
        (lowered.body.events as Event[])
          .filter((e) => e.kind === 'triaged')
          .at(-1),
      ).toMatchObject({ details: { isSentinel: { from: true, to: false } } });
      // Closing it outright is not offered and is refused, whatever is sent.
      expect((await movesOf(quality, id)).map((m) => m.kind)).toEqual([
        'start',
        'request_sign_off',
      ]);
      for (const extra of [{}, { kind: 'close' }]) {
        const direct = await move(
          quality.cookie,
          id,
          'closed',
          'Not sentinel.',
          extra,
        ).expect(409);
        expect(direct.body.code).toBe('sign_off_required');
      }
      expect((await stored(id)).status).toBe('triaged');
      // Lowered all the way, by someone else, and after work has started:
      // still the same.
      await triage(quality2.cookie, id, {
        harmLevel: 'none',
        isSentinel: false,
      }).expect(200);
      await move(quality2.cookie, id, 'in_progress').expect(200);
      await move(quality2.cookie, id, 'closed', 'Minor after all.').expect(409);
      const kept = await owner.db.execute<{ sign_off_needed: boolean }>(
        sql`select sign_off_needed from incidents where id = ${id}`,
      );
      expect(kept.rows[0].sign_off_needed).toBe(true);

      // Withdrawing a request, lowering it and closing is the same path.
      const waiting = await awaitingSignOff();
      await move(quality.cookie, waiting.id, 'in_progress', 'Not ready', {
        kind: 'withdraw',
      }).expect(200);
      await triage(quality.cookie, waiting.id, {
        harmLevel: 'mild',
        isSentinel: false,
      }).expect(200);
      const alone = await move(
        quality.cookie,
        waiting.id,
        'closed',
        'Done.',
      ).expect(409);
      expect(alone.body.code).toBe('sign_off_required');

      // It closes the way it always had to: one asks, another signs.
      await move(quality.cookie, id, 'awaiting_sign_off', PROPOSAL).expect(200);
      await signOff(403, quality.cookie, id);
      const closed = await signOff(200, quality2.cookie, id);
      expect(closed.body.status).toBe('closed');
    });

    it('needs it from the report on when a death is reported, and after reopening', async () => {
      const fatal = await report(reporter, { harmLevel: 'death' });
      const stored = async () =>
        (
          await owner.db.execute<{ sign_off_needed: boolean }>(
            sql`select sign_off_needed from incidents where id = ${fatal.id}`,
          )
        ).rows[0].sign_off_needed;
      expect(await stored()).toBe(true);
      // Triaged down to a milder harm level at the very first triage.
      await triage(quality.cookie, fatal.id, { harmLevel: 'mild' }).expect(200);
      expect(await stored()).toBe(true);
      const res = await move(
        quality.cookie,
        fatal.id,
        'closed',
        'Done.',
      ).expect(409);
      expect(res.body.code).toBe('sign_off_required');
      // An ordinary report never needs it, and is not given it by a triage
      // that leaves it ordinary.
      const plain = await report(reporter, { harmLevel: 'severe' });
      await triage(quality.cookie, plain.id, { harmLevel: 'severe' }).expect(
        200,
      );
      const row = await owner.db.execute<{ sign_off_needed: boolean }>(
        sql`select sign_off_needed from incidents where id = ${plain.id}`,
      );
      expect(row.rows[0].sign_off_needed).toBe(false);
      await move(quality.cookie, plain.id, 'closed', 'Done.').expect(200);
    });

    it('goes on needing it whatever is written to the record, by an older release or by hand', async () => {
      const flagOf = async (id: string) =>
        (
          await owner.db.execute<{ sign_off_needed: boolean }>(
            sql`select sign_off_needed from incidents where id = ${id}`,
          )
        ).rows[0].sign_off_needed;
      const { id } = await sentinel();
      // Cleared by hand, as the owner of the table: it does not clear.
      await owner.db.execute(
        sql`update incidents set sign_off_needed = false where id = ${id}`,
      );
      expect(await flagOf(id)).toBe(true);
      expect((await open(quality.cookie, id)).body.needsSignOff).toBe(true);
      await move(quality.cookie, id, 'closed', 'Done.').expect(409);
      // Called something else by a release that knows nothing of the flag,
      // which writes the incident and leaves the flag out, or clears it.
      await owner.db.execute(
        sql`update incidents set is_sentinel = false, harm_level = 'mild', sign_off_needed = false, revision = revision + 1 where id = ${id}`,
      );
      expect(await flagOf(id)).toBe(true);
      const read = await open(quality.cookie, id).expect(200);
      expect(read.body).toMatchObject({
        isSentinel: false,
        harmLevel: 'mild',
        needsSignOff: true,
      });
      expect((read.body.moves as Move[]).map((m) => m.kind)).toEqual([
        'start',
        'request_sign_off',
      ]);
      const res = await move(quality.cookie, id, 'closed', 'Done.').expect(409);
      expect(res.body.code).toBe('sign_off_required');

      // Made a sentinel event by such a release, on a report that was none:
      // the flag is raised although nothing set it.
      const plain = await report(reporter, { harmLevel: 'severe' });
      expect(await flagOf(plain.id)).toBe(false);
      await owner.db.execute(
        sql`update incidents set is_sentinel = true, status = 'triaged', revision = revision + 1 where id = ${plain.id}`,
      );
      await owner.db.execute(
        sql`update incidents set is_sentinel = false, revision = revision + 1 where id = ${plain.id}`,
      );
      expect(await flagOf(plain.id)).toBe(true);
      const alone = await move(
        quality.cookie,
        plain.id,
        'closed',
        'Done.',
      ).expect(409);
      expect(alone.body.code).toBe('sign_off_required');
    });

    it('is signed on the revision the signer read, and not without one', async () => {
      const { id } = await awaitingSignOff();
      const read = await open(quality2.cookie, id).expect(200);
      expect(
        (read.body.moves as Move[]).find((m) => m.kind === 'sign_off'),
      ).toMatchObject({ revisionRequired: true });
      // Without saying what they read: refused, with or without the kind.
      for (const extra of [{}, { kind: 'sign_off' }]) {
        const blind = await move(
          quality2.cookie,
          id,
          'closed',
          'Fine.',
          extra,
        ).expect(400);
        expect(blind.body.code).toBe('revision_required');
      }
      expect((await stored(id)).status).toBe('awaiting_sign_off');
      // The summary is withdrawn and another proposed after they read it.
      await move(quality.cookie, id, 'in_progress', 'Wrong summary', {
        kind: 'withdraw',
      }).expect(200);
      await move(
        quality.cookie,
        id,
        'awaiting_sign_off',
        'Another summary altogether.',
      ).expect(200);
      // Their signature was on the first: it does not close the second.
      const late = await move(quality2.cookie, id, 'closed', undefined, {
        revision: read.body.revision,
      }).expect(409);
      expect(late.body.code).toBe('stale_incident');
      expect(await stored(id)).toMatchObject({
        status: 'awaiting_sign_off',
        closure_summary: 'Another summary altogether.',
        closed_by: null,
      });
      // Someone with no right to sign learns nothing new from leaving it out.
      const outsider = await move(triageOnly.cookie, id, 'closed').expect(403);
      expect(outsider.body.code).toBe('missing_permission');
      // No other move asks for it.
      await move(quality2.cookie, id, 'in_progress', 'Not yet.', {
        kind: 'send_back',
      }).expect(200);
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
        move(a.cookie, id, 'in_progress', 'Not yet', {
          revision: seen,
          kind: 'send_back',
        }),
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
      await signOff(200, quality2.cookie, id);
      expect(await summary()).toEqual({
        ...start,
        closedLast30Days: start.closedLast30Days + 1,
      });
      expect((await waiting()).items.map((i) => i.id)).not.toContain(id);
    });

    it('starts afresh when a signed-off incident is reopened', async () => {
      const { id } = await awaitingSignOff();
      await signOff(200, quality2.cookie, id);
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
      await signOff(200, quality2.cookie, id, NOTE);
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
            kind: 'request_sign_off',
          },
        },
        {
          actor_id: quality2.id,
          changes: {
            from: 'awaiting_sign_off',
            to: 'closed',
            kind: 'sign_off',
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
      await move(quality2.cookie, id, 'in_progress', undefined, {
        kind: 'send_back',
      }).expect(400);
      await move(quality2.cookie, id, 'rejected', 'No').expect(409);
      await triage(quality2.cookie, id).expect(409);
      expect(await count()).toBe(before);
      expect((await open(quality.cookie, id)).body.revision).toBe(revision);
    });
  });
});
