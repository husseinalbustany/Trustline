import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { DeadlineCheck } from '../src/incidents/deadline-check.service.js';
import {
  PublicLimits,
  PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR,
} from '../src/incidents/public-limits.js';
import { REFUSAL_STEP_MS } from '../src/incidents/public.controller.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Move = { to: string; kind: string; noteRequired: boolean };
type Event = {
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  details: Record<string, unknown> | null;
};

/**
 * Two points the browser regression of incident reporting left for a
 * decision:
 *
 * - The public form says it is paused before anyone writes a report:
 *   `paused` and `retryAfterSeconds` on `GET /public/reporting/:slug`, from
 *   the same count as the report's own 429, and nothing more than it says.
 * - A report set aside is reopened to where it was set aside from: to `new`,
 *   to be triaged with a triage deadline counted from the reopening, if
 *   nobody had triaged it; to `triaged` if someone had. Reopening a closed
 *   incident is unchanged.
 */
describe('reopening a set-aside report, and a paused public form', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  let check: DeadlineCheck;

  let h: Hospital; // takes public reports
  let other: Hospital; // another hospital entirely
  let ward: string;
  let wardUnit: string;
  let lab: string;
  let otherUnit: string;

  let reporter: Staff; // may report, nothing else
  let quality: Staff; // quality officer for the whole hospital
  let quality2: Staff; // another
  let otherQuality: Staff; // quality officer of the other hospital

  const reportBody = (
    hospital: Hospital,
    unit: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    type: 'incident',
    categoryId: hospital.categories.equipment,
    orgUnitId: unit,
    occurredAt: new Date(Date.now() - HOUR).toISOString(),
    description: 'A bed rail would not lock.',
    harmLevel: 'none',
    ...overrides,
  });
  const report = async (
    who: Staff,
    overrides: Record<string, unknown> = {},
    hospital = h,
    unit = wardUnit,
  ) =>
    (
      await http()
        .post('/incidents')
        .set('Cookie', who.cookie)
        .send(reportBody(hospital, unit, { anonymous: false, ...overrides }))
        .expect(201)
    ).body as { id: string; reference: string };

  let address = 0;
  const reportPublicly = (
    hospital: Hospital,
    unit: string,
    overrides: Record<string, unknown> = {},
  ) =>
    http()
      .post(`/public/reporting/${hospital.slug}`)
      .set(
        'X-Forwarded-For',
        `198.51.${Math.floor(address / 200) % 200}.${(address++ % 200) + 1}`,
      )
      .send(reportBody(hospital, unit, overrides));

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
    who: Staff | null,
    id: string,
    to: string,
    note?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const req = http().post(`/incidents/${id}/status`);
    if (who) req.set('Cookie', who.cookie);
    return req.send({ to, ...(note !== undefined && { note }), ...extra });
  };
  const open = (who: Staff, id: string) =>
    http().get(`/incidents/${id}`).set('Cookie', who.cookie);
  const summary = async (who: Staff) =>
    (
      await http()
        .get('/incidents/summary')
        .set('Cookie', who.cookie)
        .expect(200)
    ).body as {
      open: number;
      awaitingTriage: number;
      overdue: number;
      triagedOnTime: number | null;
    };
  /** What is stored of an incident, its times as ISO strings. */
  const stored = async (id: string) => {
    const [row] = (
      await bench.owner.db.execute<{
        status: string;
        triage_due_at: string;
        triage_due_from: string | null;
        first_triage_due_at: string | null;
        first_triaged_at: string | null;
        triage_due_soon_at: string | null;
        triage_overdue_at: string | null;
        sign_off_needed: boolean;
      }>(
        sql`select status, triage_due_at, triage_due_from, first_triage_due_at, first_triaged_at,
                   triage_due_soon_at, triage_overdue_at, sign_off_needed
            from incidents where id = ${id}`,
      )
    ).rows;
    const iso = (at: string | null) => at && new Date(at).toISOString();
    return {
      ...row,
      triage_due_at: iso(row.triage_due_at)!,
      triage_due_from: iso(row.triage_due_from),
      first_triage_due_at: iso(row.first_triage_due_at),
      first_triaged_at: iso(row.first_triaged_at),
      triage_due_soon_at: iso(row.triage_due_soon_at),
      triage_overdue_at: iso(row.triage_overdue_at),
    };
  };
  const lastAudit = async (id: string) =>
    (
      await bench.owner.db.execute<{
        actor_id: string | null;
        changes: Record<string, unknown>;
      }>(
        sql`select actor_id, changes from audit_log
            where entity_id = ${id} and action = 'incident_status_changed'
            order by occurred_at desc, id desc limit 1`,
      )
    ).rows[0];
  const toldOf = async (id: string, kind: string) =>
    (
      await bench.owner.db.execute<{ user_id: string; data: unknown }>(
        sql`select user_id, data from notifications where incident_id = ${id} and kind = ${kind}`,
      )
    ).rows;

  beforeAll(async () => {
    bench = await testBench('rop', run);
    check = bench.app.get(DeadlineCheck, { strict: false });
    h = await bench.createHospital('h');
    other = await bench.createHospital('other');
    const facility = await bench.createUnit(h, 'facility', 'MAIN', null);
    ward = await bench.createUnit(h, 'department', 'WARD', facility);
    wardUnit = await bench.createUnit(h, 'unit', 'WARD-1', ward);
    lab = await bench.createUnit(h, 'department', 'LAB', facility);
    otherUnit = await bench.createUnit(other, 'facility', 'MAIN', null);
    reporter = await bench.createStaff(h, 'reporter', {
      role: 'reporter',
      orgUnitId: null,
    });
    quality = await bench.createStaff(h, 'quality', {
      role: 'quality_officer',
      orgUnitId: null,
    });
    quality2 = await bench.createStaff(h, 'quality2', {
      role: 'quality_officer',
      orgUnitId: null,
    });
    otherQuality = await bench.createStaff(other, 'otherquality', {
      role: 'quality_officer',
      orgUnitId: null,
    });
    for (const hospital of [h, other]) {
      await http()
        .put('/settings/reporting')
        .set('Cookie', hospital.cookie)
        .send({ publicReporting: true })
        .expect(200);
    }
  }, 120_000);

  // Every test starts with nothing counted against its address.
  beforeEach(() => bench.app.get(PublicLimits, { strict: false }).forget());

  afterAll(async () => {
    await bench?.close();
  });

  describe('reopening a report set aside before triage', () => {
    it('is refused without a session, without the right to triage, and for another hospital', async () => {
      const { id } = await report(reporter);
      await move(quality, id, 'rejected', 'Not an incident.').expect(200);
      await move(null, id, 'new', 'Again.').expect(401);
      // Their own report: they see it, and have no say over its status.
      const theirs = await move(reporter, id, 'new', 'Again.').expect(403);
      expect(theirs.body).toMatchObject({
        code: 'missing_permission',
        permission: 'incidents.triage',
      });
      // It exists, in another hospital: not found, as if it did not.
      const elsewhere = await move(otherQuality, id, 'new', 'Again.').expect(
        404,
      );
      expect(elsewhere.body.code).toBeUndefined();
      expect((await stored(id)).status).toBe('rejected');
    });

    it('needs a note, a status it can go to, and nothing unknown', async () => {
      const { id } = await report(reporter);
      await move(quality, id, 'rejected', 'Not an incident.').expect(200);
      for (const note of [undefined, '', '   ']) {
        const res = await move(quality, id, 'new', note).expect(400);
        expect(res.body.code).toBe('note_required');
      }
      await move(quality, id, 'renewed', 'Again.').expect(400);
      await move(quality, id, 'new', 'Again.', { ownerUnitId: ward }).expect(
        400,
      );
      // Not straight on to work, and not to "triaged" with no triage
      // behind it: the screen that offers those is out of date.
      for (const to of ['in_progress', 'triaged']) {
        const res = await move(quality, id, to, 'Again.', {
          kind: 'reopen',
        }).expect(409);
        expect(res.body.code).toBe('invalid_transition');
      }
      expect((await stored(id)).status).toBe('rejected');
    });

    it('goes back to new, to be triaged by a deadline counted from the reopening, the old one kept on the timeline', async () => {
      const { id } = await report(reporter, { harmLevel: 'mild' });
      const before = (await open(quality, id).expect(200)).body;
      const aside = await move(quality, id, 'rejected', 'Duplicate.').expect(
        200,
      );
      expect(aside.body.moves).toEqual([
        {
          to: 'new',
          kind: 'reopen',
          noteRequired: true,
          revisionRequired: false,
        },
      ]);
      const setAsideAt = (await stored(id)).first_triaged_at;
      expect(setAsideAt).not.toBeNull();

      const reopenedAt = Date.now();
      const res = await move(quality, id, 'new', 'Not a duplicate.').expect(
        200,
      );
      expect(res.body).toMatchObject({
        status: 'new',
        ownerUnit: null,
        assignedTo: null,
        rejectionReason: null,
        overdue: null,
      });
      // Seventy-two hours to triage a mild harm, from now.
      const triageDue = Date.parse(res.body.triageDueAt);
      expect(triageDue - reopenedAt).toBeGreaterThan(72 * HOUR - 5000);
      expect(triageDue - reopenedAt).toBeLessThan(72 * HOUR + 5000);
      const closeDue = Date.parse(res.body.closeDueAt);
      expect(closeDue - reopenedAt).toBeGreaterThan(30 * DAY - 5000);
      expect(closeDue - reopenedAt).toBeLessThan(30 * DAY + 5000);
      // Triaged, or set aside again, like any new report; nothing else.
      expect(
        (res.body.moves as Move[]).map((m) => `${m.kind}>${m.to}`),
      ).toEqual(['reject>rejected']);
      expect(res.body.canRetriage).toBe(true);

      const deadlines = {
        triageDueAt: { from: before.triageDueAt, to: res.body.triageDueAt },
        closeDueAt: { from: before.closeDueAt, to: res.body.closeDueAt },
      };
      expect((res.body.events as Event[]).at(-1)).toMatchObject({
        kind: 'reopened',
        fromStatus: 'rejected',
        toStatus: 'new',
        details: { note: 'Not a duplicate.', ...deadlines },
      });
      // Audited in the same change, with both deadlines, from and to.
      const audit = await lastAudit(id);
      expect(audit).toEqual({
        actor_id: quality.id,
        changes: { from: 'rejected', to: 'new', kind: 'reopen', ...deadlines },
      });
      const row = await stored(id);
      expect(row.triage_due_from).not.toBeNull();
      // The setting aside stays its first decision, under its first deadline.
      expect(row.first_triaged_at).toEqual(setAsideAt);
      expect(row.first_triage_due_at).toBe(before.triageDueAt);

      // Its reporter learns that it was reopened, and why, not by when.
      const theirs = await open(reporter, id).expect(200);
      expect(
        (theirs.body.events as Event[]).find((e) => e.kind === 'reopened')!
          .details,
      ).toEqual({ note: 'Not a duplicate.' });
      expect(theirs.body.triageDueAt).toBeNull();
      // And is told, as when a closed incident is reopened.
      const toReporter = (await toldOf(id, 'status_changed')).filter(
        (n) => n.user_id === reporter.id,
      );
      expect(
        toReporter.map((n) => (n.data as { change: string }).change).sort(),
      ).toEqual(['rejected', 'reopened']);

      // Triaged now like any new report: a handling department, and on.
      const triaged = await triage(quality, id).expect(200);
      expect(triaged.body).toMatchObject({
        status: 'triaged',
        ownerUnit: { id: ward },
      });
      expect((await stored(id)).first_triaged_at).toEqual(setAsideAt);
    });

    it('goes back to new however often it is set aside, and keeps the first deadline for "triaged on time"', async () => {
      const { id } = await report(reporter);
      const first = (await open(quality, id).expect(200)).body.triageDueAt;
      await move(quality, id, 'rejected', 'No.').expect(200);
      await move(quality, id, 'new', 'Yes.').expect(200);
      await move(quality, id, 'rejected', 'No after all.').expect(200);
      const again = await move(quality, id, 'new', 'Yes after all.').expect(
        200,
      );
      expect(again.body.status).toBe('new');
      expect((await stored(id)).first_triage_due_at).toBe(first);
    });

    it('is counted, announced and judged as a report waiting for triage, its first decision judged by its first deadline', async () => {
      // A hospital of its own, so the summary holds only what is made here.
      const s = await bench.createHospital('sum');
      const sUnit = await bench.createUnit(s, 'facility', 'MAIN', null);
      const officer = await bench.createStaff(s, 'officer', {
        role: 'quality_officer',
        orgUnitId: null,
      });
      const r = (overrides: Record<string, unknown> = {}) =>
        report(officer, overrides, s, sUnit);

      // Late: set aside a day after its deadline.
      const late = await r();
      await bench.owner.db.execute(
        sql`update incidents set reported_at = reported_at - interval '4 days',
              triage_due_at = triage_due_at - interval '4 days',
              close_due_at = close_due_at - interval '4 days'
            where id = ${late.id}`,
      );
      expect((await summary(officer)).overdue).toBe(1);
      await move(officer, late.id, 'rejected', 'Duplicate.').expect(200);
      // On time: set aside at once.
      const timely = await r();
      await move(officer, timely.id, 'rejected', 'Duplicate.').expect(200);
      expect(await summary(officer)).toMatchObject({
        open: 0,
        awaitingTriage: 0,
        overdue: 0,
        triagedOnTime: 50,
      });

      // Both reopened: two reports waiting for triage again, neither late
      // for its new deadline. The share triaged on time is still that of
      // their first decisions: reopening does not excuse the late one.
      await move(officer, late.id, 'new', 'Not a duplicate.').expect(200);
      await move(officer, timely.id, 'new', 'Not a duplicate.').expect(200);
      expect(await summary(officer)).toMatchObject({
        open: 2,
        awaitingTriage: 2,
        overdue: 0,
        triagedOnTime: 50,
      });
      // Triaged at once after the reopening: still not on time, the first
      // time; and the timely one stays timely, whatever happens next.
      await triage(officer, late.id, { ownerUnitId: sUnit }).expect(200);
      expect((await summary(officer)).triagedOnTime).toBe(50);

      // The timely one now misses its new deadline: overdue for triage, in
      // the summary, the detail and the list, and still on time for its
      // first decision.
      await bench.owner.db.execute(
        sql`update incidents set triage_due_at = now() - interval '1 hour' where id = ${timely.id}`,
      );
      expect(await summary(officer)).toMatchObject({
        open: 2,
        awaitingTriage: 1,
        overdue: 1,
        triagedOnTime: 50,
      });
      expect((await open(officer, timely.id).expect(200)).body.overdue).toBe(
        'triage',
      );
      const overdue = await http()
        .get('/incidents?overdue=true')
        .set('Cookie', officer.cookie)
        .expect(200);
      expect(overdue.body.items.map((i: { id: string }) => i.id)).toEqual([
        timely.id,
      ]);
      const byDeadline = await http()
        .get('/incidents?sort=due')
        .set('Cookie', officer.cookie)
        .expect(200);
      expect(byDeadline.body.items[0].id).toBe(timely.id);
    });

    it('has its new triage deadline announced in its turn, even where the old one was', async () => {
      const { id } = await report(reporter);
      // Reported ten days ago and never triaged: announced as overdue.
      await bench.owner.db.execute(
        sql`update incidents set reported_at = reported_at - interval '10 days',
              triage_due_at = triage_due_at - interval '10 days',
              close_due_at = close_due_at - interval '10 days'
            where id = ${id}`,
      );
      await check.run(new Date(), [h.id]);
      expect(await toldOf(id, 'overdue')).not.toEqual([]);
      expect((await stored(id)).triage_overdue_at).not.toBeNull();
      await bench.owner.db.execute(
        sql`delete from notifications where incident_id = ${id}`,
      );

      await move(quality, id, 'rejected', 'Not an incident.').expect(200);
      const reopened = await move(quality, id, 'new', 'It was.').expect(200);
      const row = await stored(id);
      expect(row.triage_due_soon_at).toBeNull();
      expect(row.triage_overdue_at).toBeNull();
      const due = Date.parse(reopened.body.triageDueAt);
      const from = Date.parse(row.triage_due_from!);
      // Its last quarter counts from the reopening, not from the report ten
      // days back: seventy-two hours allowed, so "due soon" eighteen hours
      // before, not three days and more.
      await check.run(new Date(due - 19 * HOUR), [h.id]);
      expect(await toldOf(id, 'due_soon')).toEqual([]);
      await check.run(new Date(from + (due - from) * 0.75 + 1000), [h.id]);
      const soon = await toldOf(id, 'due_soon');
      expect(soon.length).toBeGreaterThan(0);
      for (const n of soon) {
        expect(n.data).toMatchObject({ deadline: 'triage' });
      }
      await check.run(new Date(due + HOUR), [h.id]);
      const late = await toldOf(id, 'overdue');
      expect(late.length).toBeGreaterThan(0);
      // Once for this deadline.
      await check.run(new Date(due + 2 * HOUR), [h.id]);
      await check.run(new Date(due - 17 * HOUR), [h.id]);
      expect(await toldOf(id, 'overdue')).toHaveLength(late.length);
      expect(await toldOf(id, 'due_soon')).toHaveLength(soon.length);
    });

    it('still needs a second person to close once triage makes it a sentinel event, and cannot then be set aside', async () => {
      // A report through the public link, set aside, reopened, then graded.
      const sent = await reportPublicly(h, wardUnit, {
        harmLevel: 'mild',
      }).expect(201);
      const [{ id }] = (
        await bench.owner.db.execute<{ id: string }>(
          sql`select id from incidents where tenant_id = ${h.id} and channel = 'public'
              order by created_at desc limit 1`,
        )
      ).rows;
      expect(sent.body).toEqual({ followUpCode: expect.any(String) });
      await move(quality, id, 'rejected', 'Not an incident.').expect(200);
      await move(quality, id, 'new', 'It was.').expect(200);
      expect((await stored(id)).sign_off_needed).toBe(false);
      await triage(quality, id, {
        harmLevel: 'severe',
        isSentinel: true,
      }).expect(200);
      expect((await stored(id)).sign_off_needed).toBe(true);
      // Called something milder: it still takes two.
      const lowered = await triage(quality, id, {
        harmLevel: 'none',
        isSentinel: false,
      }).expect(200);
      const kinds = (lowered.body.moves as Move[]).map((m) => m.kind);
      expect(kinds).toContain('request_sign_off');
      expect(kinds).not.toContain('close');
      expect(kinds).not.toContain('reject');
      const refused = await move(quality, id, 'rejected', 'No.').expect(409);
      expect(refused.body.code).toBe('serious_cannot_be_rejected');
      await move(quality, id, 'closed', 'Done.').expect(409);
      const asked = await move(
        quality,
        id,
        'awaiting_sign_off',
        'Done.',
      ).expect(200);
      await move(quality2, id, 'closed', 'Agreed.', {
        revision: asked.body.revision,
      }).expect(200);
    });
  });

  describe('reopening a report set aside after triage', () => {
    it('goes back to triaged, keeping its triage, with a new closing deadline and the triage deadline it had', async () => {
      const { id } = await report(reporter);
      await triage(quality, id, {
        ownerUnitId: lab,
        assignedTo: quality2.id,
        harmLevel: 'mild',
      }).expect(200);
      const before = (await open(quality, id).expect(200)).body;
      const firstTriagedAt = (await stored(id)).first_triaged_at;
      await move(quality, id, 'rejected', 'A duplicate.').expect(200);
      const waiting = (await summary(quality)).awaitingTriage;

      await move(quality, id, 'new', 'Again.').expect(409);
      await move(quality, id, 'in_progress', 'Again.').expect(409);
      const reopenedAt = Date.now();
      const res = await move(quality, id, 'triaged', 'Not a duplicate.').expect(
        200,
      );
      expect(res.body).toMatchObject({
        status: 'triaged',
        harmLevel: 'mild',
        ownerUnit: { id: lab },
        assignedTo: { id: quality2.id },
        triagedAt: before.triagedAt,
        triageDueAt: before.triageDueAt,
        rejectionReason: null,
        overdue: null,
      });
      const closeDue = Date.parse(res.body.closeDueAt);
      expect(closeDue - reopenedAt).toBeGreaterThan(30 * DAY - 5000);
      expect(closeDue - reopenedAt).toBeLessThan(30 * DAY + 5000);
      expect(
        (res.body.moves as Move[]).map((m) => `${m.kind}>${m.to}`).sort(),
      ).toEqual(['close>closed', 'reject>rejected', 'start>in_progress']);
      const deadlines = {
        closeDueAt: { from: before.closeDueAt, to: res.body.closeDueAt },
      };
      expect((res.body.events as Event[]).at(-1)).toEqual(
        expect.objectContaining({
          kind: 'reopened',
          fromStatus: 'rejected',
          toStatus: 'triaged',
          details: { note: 'Not a duplicate.', ...deadlines },
        }),
      );
      expect(await lastAudit(id)).toEqual({
        actor_id: quality.id,
        changes: {
          from: 'rejected',
          to: 'triaged',
          kind: 'reopen',
          ...deadlines,
        },
      });
      // Not waiting for triage: it was triaged, and that stands.
      expect((await summary(quality)).awaitingTriage).toBe(waiting);
      const row = await stored(id);
      expect(row.first_triaged_at).toEqual(firstTriagedAt);
      expect(row.first_triage_due_at).toBeNull();
      expect(row.triage_due_from).toBeNull();
      // Its assignee is told it is open again.
      expect(await toldOf(id, 'status_changed')).toEqual(
        expect.arrayContaining([
          {
            user_id: quality2.id,
            data: expect.objectContaining({ change: 'reopened' }),
          },
        ]),
      );
    });

    it('also when it went back to new once and was triaged then', async () => {
      const { id } = await report(reporter);
      await move(quality, id, 'rejected', 'No.').expect(200);
      await move(quality, id, 'new', 'Yes.').expect(200);
      await triage(quality, id).expect(200);
      await move(quality, id, 'rejected', 'No after all.').expect(200);
      const res = await move(quality, id, 'triaged', 'Yes after all.').expect(
        200,
      );
      expect(res.body).toMatchObject({
        status: 'triaged',
        ownerUnit: { id: ward },
      });
    });
  });

  it('reopens a closed incident to in progress, as before', async () => {
    const { id } = await report(reporter);
    await triage(quality, id).expect(200);
    const closed = await move(quality, id, 'closed', 'Done.').expect(200);
    expect(
      (closed.body.moves as Move[]).map((m) => `${m.kind}>${m.to}`),
    ).toEqual(['reopen>in_progress']);
    for (const to of ['new', 'triaged']) {
      await move(quality, id, to, 'Again.').expect(409);
    }
    const res = await move(quality, id, 'in_progress', 'Again.').expect(200);
    expect(res.body.status).toBe('in_progress');
    expect(
      (res.body.events as Event[]).at(-1)?.details?.triageDueAt,
    ).toBeUndefined();
  });

  describe('the public form while the hourly ceiling is reached', () => {
    let full: Hospital;
    let fullUnit: string;
    const form = (slug: string) =>
      http()
        .get(`/public/reporting/${slug}`)
        .set('X-Forwarded-For', '203.0.113.77');
    const audited = async () =>
      (
        await bench.owner.db.execute(
          sql`select 1 from audit_log where tenant_id = ${full.id} and action = 'public_reporting_limit_reached'`,
        )
      ).rows.length;

    beforeAll(async () => {
      full = await bench.createHospital('full');
      fullUnit = await bench.createUnit(full, 'facility', 'MAIN', null);
      await http()
        .put('/settings/reporting')
        .set('Cookie', full.cookie)
        .send({ publicReporting: true })
        .expect(200);
      // The hour's worth, sent through the form, each from an address of
      // its own.
      for (let i = 0; i < PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR; i++) {
        await reportPublicly(full, fullUnit).expect(201);
      }
    }, 120_000);

    it('says it is paused, and until when, in whole seconds, the same as the refusal of a report', async () => {
      // All of them fifty minutes old: room again in ten minutes.
      await bench.owner.db.execute(
        sql`update incidents set reported_at = now() - interval '50 minutes'
            where tenant_id = ${full.id} and channel = 'public'`,
      );
      const page = (await form(full.slug).expect(200)).body;
      expect(page.paused).toBe(true);
      expect(Number.isInteger(page.retryAfterSeconds)).toBe(true);
      expect(page.retryAfterSeconds).toBeGreaterThanOrEqual(598);
      expect(page.retryAfterSeconds).toBeLessThanOrEqual(600);
      // The form is still all there, for the page to keep what is typed.
      expect(page.orgUnits).toHaveLength(1);
      expect(page.categories.length).toBeGreaterThan(0);
      // Reading it is not a refusal: nothing audited, nobody told.
      expect(await audited()).toBe(0);
      const refused = await reportPublicly(full, fullUnit).expect(429);
      expect(
        Math.abs(
          Number(refused.headers['retry-after']) - page.retryAfterSeconds,
        ),
      ).toBeLessThanOrEqual(1);
      expect(await audited()).toBe(1);
      // Other hospitals are not paused by this one.
      expect((await form(h.slug).expect(200)).body).toMatchObject({
        paused: false,
        retryAfterSeconds: null,
      });
    });

    it('is open again, and says so, once the oldest of the hour is an hour old', async () => {
      await bench.owner.db.execute(
        sql`update incidents set reported_at = now() - interval '61 minutes'
            where id = (select id from incidents where tenant_id = ${full.id} and channel = 'public'
                        order by reported_at, id limit 1)`,
      );
      expect((await form(full.slug).expect(200)).body).toMatchObject({
        paused: false,
        retryAfterSeconds: null,
      });
      await reportPublicly(full, fullUnit).expect(201);
      expect((await form(full.slug).expect(200)).body.paused).toBe(true);
    });

    it('answers the same 404, on the same step of time, when the form is off, the hospital suspended or not there', async () => {
      // Its hour still full, the form switched off: nothing of the pause.
      expect((await form(full.slug).expect(200)).body.paused).toBe(true);
      await http()
        .put('/settings/reporting')
        .set('Cookie', full.cookie)
        .send({ publicReporting: false })
        .expect(200);
      const gone = await bench.createHospital('gone');
      await http()
        .put('/settings/reporting')
        .set('Cookie', gone.cookie)
        .send({ publicReporting: true })
        .expect(200);
      await http()
        .patch(`/platform/tenants/${gone.id}`)
        .set('Cookie', bench.platform)
        .send({ status: 'suspended' })
        .expect(200);
      try {
        const answers = [];
        for (const slug of [full.slug, gone.slug, `${bench.prefix}-nowhere`]) {
          bench.app.get(PublicLimits, { strict: false }).forget();
          const began = performance.now();
          const res = await form(slug).expect(404);
          const ms = performance.now() - began;
          // (A timer may fire a millisecond early.)
          expect(ms).toBeGreaterThanOrEqual(REFUSAL_STEP_MS - 2);
          expect(ms).toBeLessThan(REFUSAL_STEP_MS + 250);
          expect(res.headers['retry-after']).toBeUndefined();
          answers.push(res.body);
        }
        expect(answers[0]).toEqual(answers[1]);
        expect(answers[0]).toEqual(answers[2]);
        expect(answers[0]).toEqual({ statusCode: 404, message: 'Not Found' });
      } finally {
        await http()
          .put('/settings/reporting')
          .set('Cookie', full.cookie)
          .send({ publicReporting: true })
          .expect(200);
      }
    });
  });

  it('keeps reports of another hospital apart', async () => {
    // Its own report, set aside and reopened by its own officer; ours
    // cannot touch it.
    const { id } = await report(otherQuality, {}, other, otherUnit);
    await move(otherQuality, id, 'rejected', 'No.').expect(200);
    await move(quality, id, 'new', 'Yes.').expect(404);
    const res = await move(otherQuality, id, 'new', 'Yes.').expect(200);
    expect(res.body.status).toBe('new');
  });
});
