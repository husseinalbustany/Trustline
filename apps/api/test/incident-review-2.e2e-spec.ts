import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { canonicalTimeZone } from '../src/i18n/time-zones.js';
import { DeadlineCheck } from '../src/incidents/deadline-check.service.js';
import { PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR } from '../src/incidents/public-limits.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * What the second quality review of incident reporting had fixed in the API
 * (Q-A1 to Q-A8), and three points left open by the third security review:
 * setting aside after triage, a public sender's own grade, the channel and
 * category filters, how many others could sign off, who is told of a
 * handover, a sentinel flag and a public form held shut, whether a
 * notification is serious, a new deadline on reopening, the database check
 * on a hospital's time zone, the audit of deadlines the check fills in, and
 * a harm level changed back and forth.
 */
describe('incident reporting after the second quality review', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  let check: DeadlineCheck;

  let h: Hospital; // takes public reports; on Riyadh's clock
  let other: Hospital; // another hospital entirely

  let facility: string;
  let ward: string; // a department
  let wardUnit: string; // a unit of the ward
  let lab: string; // another department
  let otherUnit: string;

  let reporter: Staff; // may report, nothing else
  let assignee: Staff; // the same; is assigned incidents
  let quality: Staff; // quality officer for the whole hospital
  let quality2: Staff; // another
  let wardQuality: Staff; // quality officer for the ward only
  let wardManager: Staff; // department manager for the ward
  let labManager: Staff; // department manager for the laboratory
  let signer: Staff; // views and signs off everywhere, cannot triage
  let mixed: Staff; // views everywhere; sees reporters for the ward only
  let otherQuality: Staff; // quality officer of the other hospital

  const names = new Map<string, string>();

  const reportBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'incident',
    categoryId: h.categories.equipment,
    orgUnitId: wardUnit,
    occurredAt: new Date(Date.now() - HOUR).toISOString(),
    description: 'A bed rail would not lock.',
    harmLevel: 'none',
    ...overrides,
  });
  const report = async (who: Staff, overrides: Record<string, unknown> = {}) =>
    (
      await http()
        .post('/incidents')
        .set('Cookie', who.cookie)
        .send(reportBody({ anonymous: false, ...overrides }))
        .expect(201)
    ).body as { id: string; reference: string; followUpCode?: string };

  let address = 0;
  /** A report through the public link, each from an address of its own. */
  const reportPublicly = (
    slug: string,
    overrides: Record<string, unknown> = {},
  ) =>
    http()
      .post(`/public/reporting/${slug}`)
      .set('X-Forwarded-For', `203.0.113.${(address++ % 250) + 1}`)
      .send(reportBody(overrides));
  /** The incident a public report made, found by its follow-up code. */
  const publicReport = async (overrides: Record<string, unknown> = {}) => {
    const res = await reportPublicly(h.slug, overrides).expect(201);
    const { followUpCode } = res.body as { followUpCode: string };
    const [row] = (
      await bench.owner.db.execute<{ id: string; reference: string }>(
        sql`select id, reference from incidents
            where tenant_id = ${h.id} and channel = 'public'
            order by created_at desc limit 1`,
      )
    ).rows;
    return { ...row, followUpCode };
  };

  const triage = (who: Staff, id: string, body: Record<string, unknown> = {}) =>
    http()
      .post(`/incidents/${id}/triage`)
      .set('Cookie', who.cookie)
      .send({
        harmLevel: 'none',
        isSentinel: false,
        ownerUnitId: ward,
        assignedTo: null,
        ...body,
      });
  const move = (
    who: Staff,
    id: string,
    to: string,
    note?: string,
    extra: Record<string, unknown> = {},
  ) =>
    http()
      .post(`/incidents/${id}/status`)
      .set('Cookie', who.cookie)
      .send({ to, ...(note !== undefined && { note }), ...extra });
  const open = (who: Staff, id: string) =>
    http().get(`/incidents/${id}`).set('Cookie', who.cookie);
  const list = async (who: Staff, query: string) =>
    (
      await http()
        .get(`/incidents?pageSize=100&${query}`)
        .set('Cookie', who.cookie)
        .expect(200)
    ).body as {
      items: { id: string; channel: string | null; access: string }[];
      total: number;
    };

  const flagOf = async (id: string) =>
    (
      await bench.owner.db.execute<{ sign_off_needed: boolean }>(
        sql`select sign_off_needed from incidents where id = ${id}`,
      )
    ).rows[0].sign_off_needed;

  /** Who was told what about an incident: `kind` to the names, sorted. */
  const told = async (incidentId: string) => {
    const rows = (
      await bench.owner.db.execute<{ user_id: string; kind: string }>(
        sql`select user_id, kind from notifications where incident_id = ${incidentId}`,
      )
    ).rows;
    const byKind: Record<string, string[]> = {};
    for (const row of rows) {
      (byKind[row.kind] ??= []).push(names.get(row.user_id) ?? row.user_id);
    }
    for (const people of Object.values(byKind)) people.sort();
    return byKind;
  };
  const dataOf = async (incidentId: string, kind: string) =>
    (
      await bench.owner.db.execute<{ data: Record<string, unknown> }>(
        sql`select data from notifications where incident_id = ${incidentId} and kind = ${kind}`,
      )
    ).rows.map((r) => r.data);
  const clear = (incidentId: string) =>
    bench.owner.db.execute(
      sql`delete from notifications where incident_id = ${incidentId}`,
    );
  const sorted = (...people: Staff[]) => people.map((p) => p.name).sort();

  beforeAll(async () => {
    bench = await testBench('qr2', run);
    check = bench.app.get(DeadlineCheck, { strict: false });
    h = await bench.createHospital('h', { timeZone: 'Asia/Riyadh' });
    other = await bench.createHospital('other');
    names.set(h.adminId, 'Admin h');
    facility = await bench.createUnit(h, 'facility', 'MAIN', null);
    ward = await bench.createUnit(h, 'department', 'WARD', facility);
    wardUnit = await bench.createUnit(h, 'unit', 'WARD-1', ward);
    lab = await bench.createUnit(h, 'department', 'LAB', facility);
    otherUnit = await bench.createUnit(other, 'facility', 'MAIN', null);

    await bench.createRole(h, 'signer', [
      'incidents.view',
      'incidents.sign_off',
    ]);
    await bench.createRole(h, 'reporter_seer', [
      'incidents.view',
      'incidents.see_reporter',
    ]);
    const person = async (
      name: string,
      role: string,
      orgUnitId: string | null,
      hospital = h,
    ) => {
      const staff = await bench.createStaff(hospital, name, {
        role,
        orgUnitId,
      });
      names.set(staff.id, staff.name);
      return staff;
    };
    reporter = await person('reporter', 'reporter', null);
    assignee = await person('assignee', 'reporter', null);
    quality = await person('quality', 'quality_officer', null);
    quality2 = await person('quality2', 'quality_officer', null);
    wardQuality = await person('wardquality', 'quality_officer', ward);
    wardManager = await person('wardmanager', 'department_manager', ward);
    labManager = await person('labmanager', 'department_manager', lab);
    signer = await person('signer', 'signer', null);
    mixed = await person('mixed', 'department_manager', null);
    // And told who reported for the ward only.
    await http()
      .put(`/users/${mixed.id}/roles`)
      .set('Cookie', h.cookie)
      .send({
        roles: [
          { roleId: h.roles.department_manager, orgUnitId: null },
          { roleId: h.roles.reporter_seer, orgUnitId: ward },
        ],
      })
      .expect(200);
    mixed.cookie = bench.cookieOf(
      await bench.login(h.slug, mixed.email).expect(200),
    );
    otherQuality = await person('otherquality', 'quality_officer', null, other);
    await http()
      .put('/settings/reporting')
      .set('Cookie', h.cookie)
      .send({ publicReporting: true })
      .expect(200);
  }, 120_000);

  afterAll(async () => {
    await bench?.close();
  });

  describe('not taking a report forward after triage (Q-A1)', () => {
    it('is allowed from triaged for what is not serious, with a reason, and recorded', async () => {
      const { id } = await report(reporter, { harmLevel: 'mild' });
      await triage(quality, id, { harmLevel: 'mild' }).expect(200);
      const before = await open(quality, id).expect(200);
      expect(before.body.moves).toContainEqual({
        to: 'rejected',
        noteRequired: true,
        revisionRequired: false,
        kind: 'reject',
      });
      const refused = await move(quality, id, 'rejected').expect(400);
      expect(refused.body.code).toBe('note_required');
      const res = await move(quality, id, 'rejected', 'A duplicate.').expect(
        200,
      );
      expect(res.body).toMatchObject({
        status: 'rejected',
        rejectionReason: 'A duplicate.',
      });
      expect(res.body.events.at(-1)).toMatchObject({
        kind: 'rejected',
        fromStatus: 'triaged',
        toStatus: 'rejected',
        details: { note: 'A duplicate.' },
      });
      const audit = await bench.owner.db.execute<{ changes: unknown }>(
        sql`select changes from audit_log where entity_id = ${id} and action = 'incident_status_changed'`,
      );
      expect(audit.rows.map((r) => r.changes)).toEqual([
        { from: 'triaged', to: 'rejected', kind: 'reject' },
      ]);
      // Its reporter is told it was not taken forward, as from "new".
      expect(await told(id)).toMatchObject({
        status_changed: sorted(reporter),
      });
    });

    it('is refused for a serious report, once work has started, and to whoever may not triage it', async () => {
      const severe = await report(reporter, { harmLevel: 'severe' });
      await triage(quality, severe.id, { harmLevel: 'severe' }).expect(200);
      const offered = await open(quality, severe.id).expect(200);
      expect(
        (offered.body.moves as { kind: string }[]).map((m) => m.kind),
      ).not.toContain('reject');
      const serious = await move(
        quality,
        severe.id,
        'rejected',
        'Not ours.',
      ).expect(409);
      expect(serious.body.code).toBe('serious_cannot_be_rejected');

      const started = await report(reporter);
      await triage(quality, started.id).expect(200);
      await move(quality, started.id, 'in_progress').expect(200);
      const late = await move(
        quality,
        started.id,
        'rejected',
        'Not ours.',
      ).expect(409);
      expect(late.body.code).toBe('invalid_transition');

      const plain = await report(reporter);
      await triage(quality, plain.id).expect(200);
      // Their own report: they see it, and may not decide on it.
      const theirs = await move(reporter, plain.id, 'rejected', 'Mine.').expect(
        403,
      );
      expect(theirs.body).toMatchObject({ code: 'missing_permission' });
      await move(otherQuality, plain.id, 'rejected', 'Not ours.').expect(404);
      await http()
        .post(`/incidents/${plain.id}/status`)
        .send({ to: 'rejected', note: 'No.' })
        .expect(401);
      expect((await open(quality, plain.id).expect(200)).body.status).toBe(
        'triaged',
      );
    });
  });

  describe("a public sender's own grade (Q-A4)", () => {
    it('does not start the two-person rule until a triager confirms a death', async () => {
      const sent = await publicReport({ harmLevel: 'death' });
      expect(await flagOf(sent.id)).toBe(false);
      const read = await open(quality, sent.id).expect(200);
      expect(read.body).toMatchObject({
        harmLevel: 'death',
        needsSignOff: false,
        signOff: null,
        channel: 'public',
      });
      // A release that knows nothing of this, or a hand, touching the row
      // does not raise it either: the database keeps the same rule.
      await bench.owner.db.execute(
        sql`update incidents set updated_at = now(), revision = revision + 1 where id = ${sent.id}`,
      );
      expect(await flagOf(sent.id)).toBe(false);
      // Confirmed at triage: from then on it takes two people, for good.
      await triage(quality, sent.id, { harmLevel: 'death' }).expect(200);
      expect(await flagOf(sent.id)).toBe(true);
      const confirmed = await open(quality, sent.id).expect(200);
      expect(confirmed.body.needsSignOff).toBe(true);
      await bench.owner.db.execute(
        sql`update incidents set sign_off_needed = false, harm_level = 'mild' where id = ${sent.id}`,
      );
      expect(await flagOf(sent.id)).toBe(true);
    });

    it('leaves a death the triager corrects to one person, who may close it or set it aside', async () => {
      const slip = await publicReport({ harmLevel: 'death' });
      await triage(quality, slip.id, { harmLevel: 'mild' }).expect(200);
      expect(await flagOf(slip.id)).toBe(false);
      const read = await open(quality, slip.id).expect(200);
      expect(read.body.needsSignOff).toBe(false);
      expect(
        (read.body.moves as { kind: string }[]).map((m) => m.kind),
      ).toEqual(['start', 'close', 'reject']);
      await move(quality, slip.id, 'rejected', 'A test of the form.').expect(
        200,
      );

      const other = await publicReport({ harmLevel: 'death' });
      await triage(quality, other.id, { harmLevel: 'none' }).expect(200);
      await move(quality, other.id, 'closed', 'Nobody was hurt.').expect(200);
    });

    it('starts it when a triager makes a public report a sentinel event', async () => {
      const sent = await publicReport({ harmLevel: 'severe' });
      expect(await flagOf(sent.id)).toBe(false);
      await triage(quality, sent.id, {
        harmLevel: 'severe',
        isSentinel: true,
      }).expect(200);
      expect(await flagOf(sent.id)).toBe(true);
    });

    it('changes nothing for a death reported by a member of staff who is signed in', async () => {
      const staff = await report(reporter, { harmLevel: 'death' });
      expect(await flagOf(staff.id)).toBe(true);
      await triage(quality, staff.id, { harmLevel: 'mild' }).expect(200);
      expect(await flagOf(staff.id)).toBe(true);
      expect(
        (await open(quality, staff.id).expect(200)).body.needsSignOff,
      ).toBe(true);
      // And it cannot be set aside by one person once it needed two.
      const res = await move(quality, staff.id, 'rejected', 'No.').expect(409);
      expect(res.body.code).toBe('serious_cannot_be_rejected');
    });
  });

  describe('the channel filter (Q-A5)', () => {
    let wardPublic: string;
    let labPublic: string;
    let wardApp: string;
    let otherPublic: string;

    beforeAll(async () => {
      wardPublic = (await publicReport()).id;
      labPublic = (await publicReport({ orgUnitId: lab })).id;
      wardApp = (await report(reporter)).id;
      await http()
        .put('/settings/reporting')
        .set('Cookie', other.cookie)
        .send({ publicReporting: true })
        .expect(200);
      await http()
        .post(`/public/reporting/${other.slug}`)
        .set('X-Forwarded-For', '198.51.100.9')
        .send(
          reportBody({
            categoryId: other.categories.equipment,
            orgUnitId: otherUnit,
          }),
        )
        .expect(201);
      otherPublic = (
        await bench.owner.db.execute<{ id: string }>(
          sql`select id from incidents where tenant_id = ${other.id}`,
        )
      ).rows[0].id;
    });

    it('finds the reports that came through the public link, or did not, for the quality office', async () => {
      const pub = await list(quality, 'channel=public');
      const ids = pub.items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([wardPublic, labPublic]));
      expect(ids).not.toContain(wardApp);
      expect(ids).not.toContain(otherPublic);
      expect(pub.items.every((i) => i.channel === 'public')).toBe(true);
      expect(pub.total).toBe(pub.items.length);
      const app = await list(quality, 'channel=app');
      expect(app.items.map((i) => i.id)).toContain(wardApp);
      expect(app.items.map((i) => i.id)).not.toContain(wardPublic);
      expect(app.items.every((i) => i.channel === 'app')).toBe(true);
    });

    it('finds only reports whose reporter the caller is told of, and tells nothing about the others', async () => {
      // Sees the laboratory's report, and is not told who made it there.
      expect((await list(mixed, '')).items.map((i) => i.id)).toContain(
        labPublic,
      );
      const pub = await list(mixed, 'channel=public');
      expect(pub.items.map((i) => i.id)).toContain(wardPublic);
      expect(pub.items.map((i) => i.id)).not.toContain(labPublic);
      // Under neither value: nothing to tell a public report from another.
      const app = await list(mixed, 'channel=app');
      expect(app.items.map((i) => i.id)).not.toContain(labPublic);
      const all = await list(mixed, '');
      const byId = new Map(all.items.map((i) => [i.id, i]));
      expect(byId.get(labPublic)!.channel).toBeNull();
      expect(byId.get(wardPublic)!.channel).toBe('public');
      expect(
        (await open(mixed, labPublic).expect(200)).body.channel,
      ).toBeNull();
    });

    it('is refused to anyone without the right to see who reported, and when it is not a channel', async () => {
      const res = await http()
        .get('/incidents?channel=public')
        .set('Cookie', wardManager.cookie)
        .expect(403);
      expect(res.body).toMatchObject({
        code: 'missing_permission',
        permission: 'incidents.see_reporter',
      });
      await http()
        .get('/incidents?channel=public')
        .set('Cookie', reporter.cookie)
        .expect(403);
      for (const value of ['email', 'PUBLIC', 'public,app']) {
        await http()
          .get(`/incidents?channel=${value}`)
          .set('Cookie', quality.cookie)
          .expect(400);
      }
      await http().get('/incidents?channel=public').expect(401);
    });
  });

  describe('the category filter (Q-A8)', () => {
    it('finds the reports of one category, and nothing for one of another hospital', async () => {
      const fall = await report(reporter, { categoryId: h.categories.fall });
      const pump = await report(reporter);
      const found = await list(quality, `categoryId=${h.categories.fall}`);
      expect(found.items.map((i) => i.id)).toContain(fall.id);
      expect(found.items.map((i) => i.id)).not.toContain(pump.id);
      expect(found.total).toBe(found.items.length);
      // Within what the caller sees: the reporter finds their own.
      const theirs = await list(
        reporter,
        `categoryId=${h.categories.fall}&mine=true`,
      );
      expect(theirs.items.map((i) => i.id)).toEqual([fall.id]);
      expect(
        await list(quality, `categoryId=${other.categories.fall}`),
      ).toEqual({ items: [], total: 0 });
      await http()
        .get('/incidents?categoryId=fall')
        .set('Cookie', quality.cookie)
        .expect(400);
      await http()
        .get(`/incidents?categoryId=${h.categories.fall}`)
        .expect(401);
    });
  });

  describe('how much of each listed incident the caller sees', () => {
    it('is said on each item as the detail says it', async () => {
      const mine = await report(reporter);
      const theirs = await list(reporter, 'mine=true');
      expect(theirs.items.find((i) => i.id === mine.id)).toMatchObject({
        access: 'reporter',
        channel: 'app',
      });
      expect(
        (await list(quality, '')).items.find((i) => i.id === mine.id),
      ).toMatchObject({ access: 'full' });
      await triage(quality, mine.id, { assignedTo: assignee.id }).expect(200);
      expect(
        (await list(assignee, '')).items.find((i) => i.id === mine.id),
      ).toMatchObject({ access: 'full', channel: null });
      expect((await open(assignee, mine.id).expect(200)).body.access).toBe(
        'full',
      );
    });
  });

  describe('who else could sign off (Q-A6)', () => {
    it('is counted for those handling the incident: active, able to see it, and not the one who asks', async () => {
      const { id } = await report(reporter, { harmLevel: 'severe' });
      await triage(quality, id, {
        harmLevel: 'severe',
        isSentinel: true,
      }).expect(200);
      // Besides the reader, who would be the one to ask: the hospital's
      // administrator, the second quality officer, the ward's (it happened
      // in a unit of the ward) and the one who only signs.
      expect((await open(quality, id).expect(200)).body.signOff).toEqual({
        others: 4,
      });
      // A reader who cannot sign: everyone who can.
      expect((await open(wardManager, id).expect(200)).body.signOff).toEqual({
        others: 5,
      });
      await move(quality, id, 'awaiting_sign_off', 'Done.').expect(200);
      // Asked: all but the one who asked, whoever reads it.
      for (const who of [quality, signer, wardManager]) {
        expect((await open(who, id).expect(200)).body.signOff).toEqual({
          others: 4,
        });
      }
      // Nothing of it to the reporter, who sees it only as such.
      expect((await open(reporter, id).expect(200)).body.signOff).toBeNull();
      // An incident that needs no second signature says nothing of one.
      const plain = await report(reporter);
      expect(
        (await open(quality, plain.id).expect(200)).body.signOff,
      ).toBeNull();
    });

    it('leaves out those who do not cover it and those switched off, down to nobody', async () => {
      const { id } = await report(reporter, {
        harmLevel: 'death',
        orgUnitId: lab,
      });
      // Not the ward's quality officer: the laboratory is not theirs.
      expect((await open(quality, id).expect(200)).body.signOff).toEqual({
        others: 3,
      });
      const solo = await bench.createHospital('solo');
      const soloUnit = await bench.createUnit(solo, 'facility', 'MAIN', null);
      const officer = await bench.createStaff(solo, 'soloofficer', {
        role: 'quality_officer',
        orgUnitId: null,
      });
      const made = await http()
        .post('/incidents')
        .set('Cookie', solo.cookie)
        .send(
          reportBody({
            categoryId: solo.categories.equipment,
            orgUnitId: soloUnit,
            harmLevel: 'death',
            anonymous: false,
          }),
        )
        .expect(201);
      const read = (cookie: string) =>
        http().get(`/incidents/${made.body.id}`).set('Cookie', cookie);
      expect((await read(solo.cookie).expect(200)).body.signOff).toEqual({
        others: 1,
      });
      await http()
        .patch(`/users/${officer.id}`)
        .set('Cookie', solo.cookie)
        .send({ status: 'disabled' })
        .expect(200);
      // The administrator alone: nobody else could give the signature.
      expect((await read(solo.cookie).expect(200)).body.signOff).toEqual({
        others: 0,
      });
    });

    it('announces a closing deadline passed while awaiting sign-off to those who may sign it off', async () => {
      const { id } = await report(reporter, { harmLevel: 'severe' });
      await triage(quality, id, {
        harmLevel: 'severe',
        isSentinel: true,
        assignedTo: assignee.id,
      }).expect(200);
      await move(quality, id, 'awaiting_sign_off', 'Done.').expect(200);
      await clear(id);
      const [{ due }] = (
        await bench.owner.db.execute<{ due: Date }>(
          sql`select close_due_at as due from incidents where id = ${id}`,
        )
      ).rows;
      await check.run(new Date(new Date(due).getTime() + HOUR), [h.id]);
      // The assignee, everyone who triages for the whole hospital (the one
      // who asked among them), and the others who may sign it off: the
      // ward's quality officer and the one who only signs.
      expect((await told(id)).overdue).toEqual(
        sorted(assignee, quality, quality2, wardQuality, signer)
          .concat('Admin h')
          .sort(),
      );
      // Before the request, a missed deadline does not go to the signers.
      const before = await report(reporter, { harmLevel: 'severe' });
      await triage(quality, before.id, {
        harmLevel: 'severe',
        isSentinel: true,
        assignedTo: assignee.id,
      }).expect(200);
      await clear(before.id);
      await check.run(new Date(new Date(due).getTime() + 2 * HOUR), [h.id]);
      expect((await told(before.id)).overdue).toEqual(
        sorted(assignee, quality, quality2).concat('Admin h').sort(),
      );
    });
  });

  describe('notifications (Q-A7)', () => {
    it('tell the managers of the department an incident is handed to, who could not see it before', async () => {
      const { id } = await report(reporter);
      await clear(id);
      await triage(quality, id, { ownerUnitId: lab }).expect(200);
      // The laboratory's manager is brought to it. The ward's could see it
      // all along (it happened in their unit), and is not told.
      expect(await told(id)).toEqual({
        incident_handed_over: sorted(labManager),
      });
      await open(labManager, id).expect(200);
      expect(await dataOf(id, 'incident_handed_over')).toEqual([
        { reference: expect.any(String), serious: false },
      ]);
      // Back to the ward: nobody is new to it.
      await clear(id);
      await triage(quality, id, { ownerUnitId: ward }).expect(200);
      expect(await told(id)).toEqual({});
    });

    it('tell those who may sign off and those who triage everywhere when an incident is made a sentinel event, once', async () => {
      const { id, reference } = await report(reporter, {
        harmLevel: 'severe',
      });
      await triage(quality, id, { harmLevel: 'severe' }).expect(200);
      await clear(id);
      await triage(quality, id, {
        harmLevel: 'severe',
        isSentinel: true,
        assignedTo: assignee.id,
      }).expect(200);
      // Not the one who made it so. The assignee is told of the assignment,
      // which is another event.
      expect(await told(id)).toEqual({
        sentinel_flagged: sorted(quality2, wardQuality, signer)
          .concat('Admin h')
          .sort(),
        incident_assigned: sorted(assignee),
      });
      expect(await dataOf(id, 'sentinel_flagged')).toEqual(
        Array(4).fill({ reference, serious: true }),
      );
      // Corrected again with the flag still set: not told again.
      await clear(id);
      await triage(quality2, id, {
        harmLevel: 'death',
        isSentinel: true,
        assignedTo: assignee.id,
      }).expect(200);
      expect(await told(id)).toEqual({});
    });

    it('say in every one whether the incident is serious', async () => {
      const plain = await report(reporter);
      const grave = await report(reporter, { harmLevel: 'severe' });
      expect(await dataOf(plain.id, 'incident_reported')).not.toHaveLength(0);
      for (const data of await dataOf(plain.id, 'incident_reported')) {
        expect(data).toEqual({ reference: plain.reference, serious: false });
      }
      for (const data of await dataOf(grave.id, 'incident_reported')) {
        expect(data).toEqual({ reference: grave.reference, serious: true });
      }
      const all = await bench.owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from notifications
            where tenant_id = ${h.id} and jsonb_typeof(data -> 'serious') is distinct from 'boolean'`,
      );
      expect(all.rows[0].n).toBe(0);
    });

    describe('when the public form is held shut', () => {
      let cap: Hospital;
      let capUnit: string;
      let capQuality: Staff; // triages everywhere
      let capWard: Staff; // quality officer for one unit only
      let capSettings: Staff; // manages settings, nothing else
      let capReporter: Staff;

      beforeAll(async () => {
        cap = await bench.createHospital('cap');
        names.set(cap.adminId, 'Admin cap');
        capUnit = await bench.createUnit(cap, 'facility', 'MAIN', null);
        await bench.createRole(cap, 'settings_only', ['settings.manage']);
        const person = async (
          name: string,
          role: string,
          orgUnitId: string | null,
        ) => {
          const staff = await bench.createStaff(cap, name, {
            role,
            orgUnitId,
          });
          names.set(staff.id, staff.name);
          return staff;
        };
        capQuality = await person('capquality', 'quality_officer', null);
        capWard = await person('capward', 'quality_officer', capUnit);
        capSettings = await person('capsettings', 'settings_only', null);
        capReporter = await person('capreporter', 'reporter', null);
        await http()
          .put('/settings/reporting')
          .set('Cookie', cap.cookie)
          .send({ publicReporting: true })
          .expect(200);
        // The hour's worth of public reports, already taken.
        await bench.owner.db.execute(
          sql`insert into incidents (tenant_id, reference, type, category_id, org_unit_id, occurred_at, description, harm_level, channel, reported_at)
              select ${cap.id}, 'INC-1999-' || lpad(n::text, 5, '0'), 'incident', ${cap.categories.equipment}, ${capUnit}, now(), 'Filler.', 'none', 'public', now() - interval '10 minutes'
              from generate_series(1, ${PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR}) n`,
        );
      });

      const paused = async () =>
        (
          await bench.owner.db.execute<{
            user_id: string;
            incident_id: string | null;
            data: unknown;
          }>(
            sql`select user_id, incident_id, data from notifications where tenant_id = ${cap.id} and kind = 'public_form_paused'`,
          )
        ).rows;

      it('tells those who may switch it and those who triage everywhere, once an hour, about no incident', async () => {
        const send = () =>
          http()
            .post(`/public/reporting/${cap.slug}`)
            .set('X-Forwarded-For', `192.0.2.${(address++ % 250) + 1}`)
            .send(
              reportBody({
                categoryId: cap.categories.equipment,
                orgUnitId: capUnit,
              }),
            );
        await send().expect(429);
        const rows = await paused();
        expect(
          rows.map((r) => names.get(r.user_id) ?? r.user_id).sort(),
        ).toEqual(sorted(capQuality, capSettings).concat('Admin cap').sort());
        for (const row of rows) {
          expect(row.incident_id).toBeNull();
          expect(row.data).toEqual({
            limit: PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR,
            serious: false,
          });
        }
        // Turned away again within the hour: nobody is told twice.
        await send().expect(429);
        await send().expect(429);
        expect(await paused()).toHaveLength(3);
        // Not the officer for one unit, not the reporter.
        const ids = rows.map((r) => r.user_id);
        expect(ids).not.toContain(capWard.id);
        expect(ids).not.toContain(capReporter.id);
      });

      it('is read in the bell like any other, with no incident to open', async () => {
        const inbox = await http()
          .get('/notifications')
          .set('Cookie', capQuality.cookie)
          .expect(200);
        const item = inbox.body.items.find(
          (n: { kind: string }) => n.kind === 'public_form_paused',
        );
        expect(item).toEqual({
          id: expect.any(String),
          kind: 'public_form_paused',
          createdAt: expect.any(String),
          readAt: null,
          incident: null,
          // About a controlled document: none.
          document: null,
          // About a person (`data.personId`): none.
          person: null,
          // About a risk or an action of the risks module: none.
          risk: null,
          action: null,
          data: { limit: PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR, serious: false },
        });
        const count = await http()
          .get('/notifications/count')
          .set('Cookie', capQuality.cookie)
          .expect(200);
        expect(count.body.unread).toBeGreaterThan(0);
        await http()
          .post(`/notifications/${item.id}/read`)
          .set('Cookie', capQuality.cookie)
          .expect(200);
        // Nobody else's to mark.
        await http()
          .post(`/notifications/${item.id}/read`)
          .set('Cookie', capSettings.cookie)
          .expect(404);
        expect(
          (
            await http()
              .get('/notifications?unread=true')
              .set('Cookie', capReporter.cookie)
              .expect(200)
          ).body.items.some(
            (n: { kind: string }) => n.kind === 'public_form_paused',
          ),
        ).toBe(false);
      });

      it('cannot be written about an incident, nor any other kind without one', async () => {
        await expect(
          bench.owner.db.execute(
            sql`insert into notifications (tenant_id, user_id, kind, data) values (${cap.id}, ${capQuality.id}, 'overdue', '{}')`,
          ),
        ).rejects.toThrow();
      });
    });
  });

  describe('reopening (Q-A3)', () => {
    it('gives a new deadline counted from the reopening, keeps the old one on the timeline and in the audit, and counts a regrading from it', async () => {
      const { id } = await report(reporter);
      await triage(quality, id).expect(200);
      // Reported forty days ago; closed late.
      await bench.owner.db.execute(
        sql`update incidents set reported_at = reported_at - interval '40 days',
              triage_due_at = triage_due_at - interval '40 days',
              close_due_at = close_due_at - interval '40 days'
            where id = ${id}`,
      );
      expect((await open(quality, id).expect(200)).body.overdue).toBe(
        'closure',
      );
      const old = (await open(quality, id).expect(200)).body.closeDueAt;
      await move(quality, id, 'closed', 'Done.').expect(200);
      const reopenedAt = Date.now();
      const res = await move(quality, id, 'in_progress', 'Back.').expect(200);
      expect(res.body.overdue).toBeNull();
      const due = Date.parse(res.body.closeDueAt);
      expect(due - reopenedAt).toBeGreaterThan(30 * DAY - 5000);
      expect(due - reopenedAt).toBeLessThan(30 * DAY + 5000);
      expect(res.body.events.at(-1)).toMatchObject({
        kind: 'reopened',
        details: {
          note: 'Back.',
          closeDueAt: { from: old, to: res.body.closeDueAt },
        },
      });
      const audit = await bench.owner.db.execute<{ changes: unknown }>(
        sql`select changes from audit_log where entity_id = ${id} and action = 'incident_status_changed' order by occurred_at desc limit 1`,
      );
      expect(audit.rows[0].changes).toEqual({
        from: 'closed',
        to: 'in_progress',
        kind: 'reopen',
        closeDueAt: { from: old, to: res.body.closeDueAt },
      });
      // Graded severe now: 45 days, from the reopening, not from the report.
      const regraded = await triage(quality, id, {
        harmLevel: 'severe',
      }).expect(200);
      const severeDue = Date.parse(regraded.body.closeDueAt);
      expect(severeDue - reopenedAt).toBeGreaterThan(45 * DAY - 5000);
      expect(severeDue - reopenedAt).toBeLessThan(45 * DAY + 5000);
      // Its reporter learns that it was reopened, and why, not by when.
      const theirs = await open(reporter, id).expect(200);
      expect(
        theirs.body.events.find((e: { kind: string }) => e.kind === 'reopened')
          .details,
      ).toEqual({ note: 'Back.' });
      expect(theirs.body.closeDueAt).toBeNull();
    });
  });

  describe('announcing a closing deadline as the harm level changes', () => {
    const regrade = (id: string, harmLevel: string) =>
      triage(quality, id, { harmLevel, assignedTo: assignee.id }).expect(200);
    const aged = async (days: number) => {
      const { id } = await report(reporter);
      await triage(quality, id, { assignedTo: assignee.id }).expect(200);
      await bench.owner.db.execute(
        sql`update incidents set
              reported_at = reported_at - make_interval(days => ${days}),
              triage_due_at = triage_due_at - make_interval(days => ${days}),
              close_due_at = close_due_at - make_interval(days => ${days})
            where id = ${id}`,
      );
      await clear(id);
      return id;
    };
    const now = () => check.run(new Date(), [h.id]);

    it('does not repeat "due soon" when it is moved between two deadlines still to come', async () => {
      // Twenty-five days of thirty gone: in its last quarter.
      const id = await aged(25);
      await now();
      expect(await told(id)).toEqual({ due_soon: sorted(assignee) });
      await clear(id);
      // Forty-five days, then thirty again, then forty-five, then thirty:
      // nothing new to say.
      for (const harmLevel of ['severe', 'none', 'severe', 'none', 'mild']) {
        await regrade(id, harmLevel);
        await now();
      }
      expect(await told(id)).toEqual({});
      // A later deadline in its own last quarter is another deadline: said
      // once, however often it is moved there and back afterwards.
      await regrade(id, 'severe');
      await clear(id);
      const [{ reported }] = (
        await bench.owner.db.execute<{ reported: Date }>(
          sql`select reported_at as reported from incidents where id = ${id}`,
        )
      ).rows;
      const intoLastQuarter = new Date(new Date(reported).getTime() + 34 * DAY);
      await check.run(intoLastQuarter, [h.id]);
      expect(await told(id)).toEqual({ due_soon: sorted(assignee) });
      await clear(id);
      for (const harmLevel of ['none', 'severe', 'mild', 'severe']) {
        await regrade(id, harmLevel);
        await now();
      }
      await check.run(intoLastQuarter, [h.id]);
      expect(await told(id)).toEqual({});
    });

    it('does not repeat "overdue" when it is moved to a deadline still to come and back', async () => {
      const id = await aged(35);
      await now();
      expect(await told(id)).toEqual({
        overdue: sorted(assignee, quality, quality2).concat('Admin h').sort(),
      });
      await clear(id);
      for (const harmLevel of ['severe', 'none', 'severe', 'mild']) {
        await regrade(id, harmLevel);
        await now();
      }
      // Moved to forty-five days it was in its last quarter: said once.
      expect(await told(id)).toEqual({ due_soon: sorted(assignee) });
      expect((await open(quality, id).expect(200)).body.overdue).toBe(
        'closure',
      );
    });
  });

  describe('the deadlines the check fills in', () => {
    it('are audited, as given by nobody, in the same step', async () => {
      const { id } = await report(reporter, { harmLevel: 'moderate' });
      await bench.owner.db.execute(
        sql`update incidents set triage_due_at = null, close_due_at = null where id = ${id}`,
      );
      const result = await check.run(new Date(), [h.id]);
      expect(result.filled).toBe(1);
      const [row] = (
        await bench.owner.db.execute<{
          triage_due_at: Date;
          close_due_at: Date;
        }>(
          sql`select triage_due_at, close_due_at from incidents where id = ${id}`,
        )
      ).rows;
      const audit = await bench.owner.db.execute<{
        actor_id: string | null;
        entity_type: string;
        changes: unknown;
      }>(
        sql`select actor_id, entity_type, changes from audit_log where entity_id = ${id} and action = 'incident_deadlines_filled'`,
      );
      expect(audit.rows).toEqual([
        {
          actor_id: null,
          entity_type: 'incident',
          changes: {
            triageDueAt: {
              from: null,
              to: new Date(row.triage_due_at).toISOString(),
            },
            closeDueAt: {
              from: null,
              to: new Date(row.close_due_at).toISOString(),
            },
          },
        },
      ]);
      // Only what was missing is filled, and audited.
      await bench.owner.db.execute(
        sql`update incidents set close_due_at = null where id = ${id}`,
      );
      await check.run(new Date(), [h.id]);
      const again = await bench.owner.db.execute<{ changes: object }>(
        sql`select changes from audit_log where entity_id = ${id} and action = 'incident_deadlines_filled' order by occurred_at`,
      );
      expect(again.rows).toHaveLength(2);
      expect(Object.keys(again.rows[1].changes)).toEqual(['closeDueAt']);
    });
  });

  describe("a hospital's time zone in the database", () => {
    const setZone = (zone: string) =>
      bench.owner.db.execute(
        sql`update tenants set time_zone = ${zone} where id = ${other.id}`,
      );
    afterAll(async () => {
      await setZone('UTC');
    });

    it('takes every name the API stores', async () => {
      const names = [
        'UTC',
        ...Intl.supportedValuesOf('timeZone').filter(
          (zone) => canonicalTimeZone(zone) === zone,
        ),
        // Kept as written where the runtime knows it as another spelling.
        'Asia/Kolkata',
      ];
      expect(names.length).toBeGreaterThan(300);
      for (const zone of names) await setZone(zone);
    });

    it('refuses an offset, an abbreviation, the Etc area and anything else', async () => {
      for (const zone of [
        '',
        '+03:00',
        'GMT+3',
        'EST',
        'Etc/GMT+3',
        'Etc/UTC',
        'utc',
        'asia/riyadh',
        'Asia/Riyadh\n',
        'Asia/Riyadh; drop table tenants',
        'Asia//Riyadh',
      ]) {
        await expect(setZone(zone)).rejects.toThrow();
      }
    });
  });

  describe('the follow-up view', () => {
    it("carries the hospital's clock with its name and languages", async () => {
      const { followUpCode } = await publicReport();
      const res = await http()
        .post(`/public/follow-up/${h.slug}`)
        .set('X-Forwarded-For', '198.51.100.20')
        .send({ code: followUpCode })
        .expect(200);
      expect(res.body.hospital).toEqual({
        name: { en: 'Hospital h' },
        locales: ['en'],
        defaultLocale: 'en',
        timeZone: 'Asia/Riyadh',
      });
      const said = await http()
        .post(`/public/follow-up/${h.slug}/comments`)
        .set('X-Forwarded-For', '198.51.100.20')
        .send({ code: followUpCode, body: 'Any news?' })
        .expect(201);
      expect(said.body.hospital.timeZone).toBe('Asia/Riyadh');
      // A wrong code still says nothing of the hospital.
      const wrong = await http()
        .post(`/public/follow-up/${h.slug}`)
        .set('X-Forwarded-For', '198.51.100.20')
        .send({ code: 'K7QM-2RXD-9FHT-WB3N' })
        .expect(404);
      expect(JSON.stringify(wrong.body)).not.toContain('Riyadh');
    });
  });
});
