import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createDatabase } from '../src/database/client.js';
import { auditLog, measureSnapshots, users } from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { requireEnv } from '../src/env.js';
import { dayOf, shiftDay, startOfDay } from '../src/i18n/time-zones.js';
import { MeasureSnapshotCheck } from '../src/reports/measure-snapshot.check.js';
import { monthOf, nextMonth } from '../src/reports/snapshots.service.js';
import { testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

/**
 * Reports and measures (docs/specs/reports-and-measures.md, steps 1 to 3):
 * one definition per measure, the month-end snapshots with their backfill,
 * provisional and final figures and corrections, and the Reports API with
 * its scope.
 */
describe('reports and measures', () => {
  const run = randomBytes(4).toString('hex');
  const password = `hospital-pass-${run}`;
  let bench: TestBench;
  let check: MeasureSnapshotCheck;
  let a: Hospital;
  let b: Hospital;
  let facility: string;
  let dept: string;
  let ward: string;
  let other: string;
  let quality: Staff;
  let reporter: Staff;
  let manager: Staff; // department manager of `dept`
  let analyst: Staff; // reports and incidents for the whole organization, no reporters
  let zone: string;
  let today: string;
  let thisMonth: string;
  let lastMonth: string;
  const http = () => bench.http();
  const get = (cookie: string, url: string) => http().get(url).set('Cookie', cookie);
  const months = (from: string, to: string) => `from=${from.slice(0, 7)}&to=${to.slice(0, 7)}`;
  type Series = {
    unitId: string | null;
    measures: {
      code: string;
      target: number | null;
      targetSource: string | null;
      months: { month: string; value: number | null; numerator: number | null; denominator: number | null; status: string; method: string; revision: number; target: number | null; met: boolean | null; details: Record<string, unknown> }[];
      current: { value: number | null; numerator: number | null; denominator: number | null; details: Record<string, unknown> };
    }[];
  };
  const measuresOf = async (cookie: string, query: string) =>
    (await get(cookie, `/reports/measures?${query}`).expect(200)).body as Series;
  const report = async (who: Staff, at: string, extra: Record<string, unknown> = {}, h: Hospital = a) =>
    (
      await http()
        .post('/incidents')
        .set('Cookie', who.cookie)
        .send({
          type: 'incident',
          categoryId: h.categories.equipment,
          orgUnitId: at,
          occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
          description: 'A bed rail would not lock.',
          harmLevel: 'none',
          anonymous: false,
          startedAt: new Date(Date.now() - 45_000).toISOString(),
          ...extra,
        })
        .expect(201)
    ).body as { id: string; reference: string };
  const startModule = (h: Hospital, module: string, day: string) =>
    bench.owner.db.execute(sql`
      insert into module_starts (tenant_id, module, started_on) values (${h.id}, ${module}, ${day}::date)
      on conflict (tenant_id, module) do update set started_on = excluded.started_on`);
  /** Moves an incident into a past moment, as if reported then. */
  const backdate = (id: string, at: Date, triage: 'on_time' | 'late' | 'pending') =>
    bench.owner.db.execute(sql`
      update incidents set reported_at = ${at}, report_started_at = ${new Date(at.getTime() - 30_000)},
        triage_due_at = ${triage === 'pending' ? new Date(Date.now() + 86_400_000) : new Date(at.getTime() + 86_400_000)},
        first_triage_due_at = null,
        first_triaged_at = ${triage === 'on_time' ? new Date(at.getTime() + 3_600_000) : triage === 'late' ? new Date(at.getTime() + 2 * 86_400_000) : null},
        status = ${triage === 'pending' ? 'new' : 'triaged'}
      where id = ${id}`);
  const rowsOf = (h: Hospital, measure: string, month: string, unit: string | null) =>
    bench.owner.db
      .select()
      .from(measureSnapshots)
      .where(
        and(
          eq(measureSnapshots.tenantId, h.id),
          eq(measureSnapshots.measure, measure),
          eq(measureSnapshots.month, month),
          unit === null ? sql`${measureSnapshots.orgUnitId} is null` : eq(measureSnapshots.orgUnitId, unit),
        ),
      )
      .orderBy(asc(measureSnapshots.revision));

  beforeAll(async () => {
    bench = await testBench('rpt', run);
    check = bench.app.get(MeasureSnapshotCheck);
    a = await bench.createHospital('a');
    b = await bench.createHospital('b');
    facility = await bench.createUnit(a, 'facility', 'F', null);
    dept = await bench.createUnit(a, 'department', 'D', facility);
    ward = await bench.createUnit(a, 'unit', 'W', dept);
    other = await bench.createUnit(a, 'department', 'O', facility);
    // The structure was there before the months the tests take.
    await bench.owner.db.execute(sql`update org_units set created_at = now() - interval '200 days' where tenant_id = ${a.id}`);
    quality = await bench.createStaff(a, 'quality', { role: 'quality_officer', orgUnitId: null });
    reporter = await bench.createStaff(a, 'reporter', { role: 'reporter', orgUnitId: null });
    manager = await bench.createStaff(a, 'manager', { role: 'department_manager', orgUnitId: dept });
    await bench.createRole(a, 'analyst', ['reports.view', 'incidents.view']);
    analyst = await bench.createStaff(a, 'analyst', { role: 'analyst', orgUnitId: null });
    zone = (await get(a.cookie, '/auth/me').expect(200)).body.tenant.timeZone;
    today = dayOf(new Date(), zone);
    thisMonth = monthOf(today);
    lastMonth = monthOf(shiftDay(thisMonth, -1));
  }, 90_000);

  afterAll(() => bench.close());

  describe('one definition per measure', () => {
    it('gives the dashboard and the month so far the same figures, from the same definitions', async () => {
      const h = await bench.createHospital('live');
      const unit = await bench.createUnit(h, 'department', 'L', null);
      const hReporter = await bench.createStaff(h, 'lreporter', { role: 'reporter', orgUnitId: null });
      for (let i = 0; i < 3; i++) await report(hReporter, unit, {}, h);
      const dashboard = (await get(h.cookie, '/incidents/summary').expect(200)).body;
      const live = await measuresOf(h.cookie, months(thisMonth, thisMonth));
      const current = (code: string) => live.measures.find((m) => m.code === code)!.current;
      expect(current('incidents.time_to_report').value).toBe(dashboard.medianSecondsToReport);
      expect(current('incidents.triaged_on_time').value).toBe(dashboard.triagedOnTime);
      expect(current('incidents.reported').value).toBe(3);
      const documents = (await get(h.cookie, '/policies/summary').expect(200)).body;
      expect(current('policies.past_review')).toMatchObject({ numerator: documents.pastReview.count, denominator: documents.pastReview.of });
    }, 30_000);
  });

  describe('the month-end snapshots', () => {
    let pending: { id: string };

    beforeAll(async () => {
      const mid = new Date(startOfDay(shiftDay(lastMonth, 14), zone).getTime() + 3_600_000);
      const onTime = await report(reporter, ward);
      const late = await report(reporter, ward);
      pending = await report(reporter, other);
      await backdate(onTime.id, mid, 'on_time');
      await backdate(late.id, mid, 'late');
      await backdate(pending.id, mid, 'pending');
      await startModule(a, 'incidents', shiftDay(lastMonth, -20));
      await startModule(a, 'policies', shiftDay(lastMonth, -20));
    });

    it('takes every month since the module started, for the organization and every unit, once', async () => {
      const first = await check.run(new Date(), [a.id]);
      expect(first.months).toBeGreaterThanOrEqual(2);
      const before = monthOf(shiftDay(lastMonth, -1));
      // The month before last: taken, reconstructed, with nothing in it.
      const [earlier] = await rowsOf(a, 'incidents.reported', before, null);
      expect(earlier).toMatchObject({ value: 0, method: 'reconstructed', revision: 1, status: 'final' });
      // Last month: the three reports, where they happened and above.
      const [org] = await rowsOf(a, 'incidents.reported', lastMonth, null);
      expect(org).toMatchObject({ value: 3, revision: 1, definitionVersion: 1, unitBasis: 'occurred_in' });
      expect(['snapshot', 'reconstructed']).toContain(org.method);
      expect((await rowsOf(a, 'incidents.reported', lastMonth, ward))[0]).toMatchObject({ value: 2, unitPath: [facility, dept, ward] });
      expect((await rowsOf(a, 'incidents.reported', lastMonth, dept))[0]).toMatchObject({ value: 2 });
      expect((await rowsOf(a, 'incidents.reported', lastMonth, facility))[0]).toMatchObject({ value: 3 });
      expect((await rowsOf(a, 'incidents.reported', lastMonth, other))[0]).toMatchObject({ value: 1 });
      // The share decided on time, and the median time to report.
      expect((await rowsOf(a, 'incidents.triaged_on_time', lastMonth, ward))[0]).toMatchObject({ value: 50, numerator: 1, denominator: 2, status: 'final' });
      expect((await rowsOf(a, 'incidents.time_to_report', lastMonth, null))[0]).toMatchObject({ value: 30, numerator: 3, denominator: 3 });
      // Once: a second run takes nothing.
      expect(await check.run(new Date(), [a.id])).toMatchObject({ months: 0 });
      const taken = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'measures_snapshot_taken')));
      expect(taken.map((t) => t.changes)).toEqual(
        expect.arrayContaining([expect.objectContaining({ month: lastMonth, module: 'incidents', rows: expect.any(Number) })]),
      );
    });

    it('keeps the triage provisional until every report is decided or past its deadline, then adds a final revision', async () => {
      const [provisional] = await rowsOf(a, 'incidents.triaged_on_time', lastMonth, null);
      expect(provisional).toMatchObject({ status: 'provisional', numerator: 1, denominator: 2, details: { pending: 1 } });
      expect(await check.run(new Date(), [a.id])).toMatchObject({ finals: 0 });
      // Decided after the month ended, still within its deadline: on time.
      await bench.owner.db.execute(sql`update incidents set first_triaged_at = now(), status = 'triaged' where id = ${pending.id}`);
      expect((await check.run(new Date(), [a.id])).finals).toBeGreaterThan(0);
      const revisions = await rowsOf(a, 'incidents.triaged_on_time', lastMonth, null);
      expect(revisions.map((r) => [r.revision, r.status])).toEqual([[1, 'provisional'], [2, 'final']]);
      expect(revisions[1]).toMatchObject({ numerator: 2, denominator: 3, value: 67 });
    });

    it('is never changed by the application, nor by anyone in place', async () => {
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      const tenantDb = new TenantDb(app.db);
      try {
        await expect(tenantDb.withTenant(a.id, (tx) => tx.update(measureSnapshots).set({ value: 100 }))).rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(tenantDb.withTenant(a.id, (tx) => tx.delete(measureSnapshots))).rejects.toMatchObject({ cause: { code: '42501' } });
      } finally {
        await app.pool.end();
      }
      await expect(
        bench.owner.db.update(measureSnapshots).set({ value: 100 }).where(eq(measureSnapshots.tenantId, a.id)),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });

    it('works out the end of a month from history: a review made late, a person who left since', async () => {
      const h = await bench.createHospital('history');
      const hFacility = await bench.createUnit(h, 'facility', 'HF', null);
      const hDept = await bench.createUnit(h, 'department', 'HD', hFacility);
      await bench.owner.db.execute(sql`update org_units set created_at = now() - interval '200 days' where tenant_id = ${h.id}`);
      const importer = await bench.createStaff(h, 'himporter', { role: 'quality_officer', orgUnitId: null });
      const owner = await bench.createStaff(h, 'howner', { role: 'quality_officer', orgUnitId: hDept });
      const leaver = await bench.createStaff(h, 'hleaver', { role: 'reporter', orgUnitId: hDept });
      // Their own unit, where their acknowledgements count.
      for (const id of [owner.id, leaver.id]) {
        await http().patch(`/users/${id}`).set('Cookie', h.cookie).send({ orgUnitId: hDept }).expect(200);
      }
      const types = Object.fromEntries((await get(h.cookie, '/policies/types').expect(200)).body.map((t: { code: string; id: string }) => [t.code, t.id]));
      const categories = Object.fromEntries((await get(h.cookie, '/policies/categories').expect(200)).body.map((c: { code: string; id: string }) => [c.code, c.id]));
      const imported = (
        await http()
          .post('/policies/documents/import')
          .set('Cookie', importer.cookie)
          .send({
            password,
            typeId: types.procedure,
            categoryId: categories.SAF,
            title: { en: 'Handling a spill' },
            ownerId: owner.id,
            ownerUnitId: hDept,
            approvedOn: shiftDay(today, -300),
            approvedBy: 'Head of Operations',
            originalKeptAt: { en: 'Quality office' },
            nextReviewOn: shiftDay(today, 300),
            acknowledgementRequired: true,
            content: { en: { purpose: 'To make a spill safe.', steps: '1. Mark the area.' } },
          })
          .expect(201)
      ).body as { id: string; published: { id: string } };
      // As it stood last month: in force since before it, its review due
      // in it (reviewed late, this month), everyone asked and due in it,
      // the leaver among them, who left this month.
      const longAgo = startOfDay(shiftDay(lastMonth, -40), zone);
      await bench.owner.db.execute(sql`update document_versions set published_at = ${longAgo} where id = ${imported.published.id}`);
      await bench.owner.db.execute(sql`update users set created_at = ${longAgo} where tenant_id = ${h.id}`);
      await bench.owner.db.execute(sql`update document_acknowledgements set due_on = ${shiftDay(lastMonth, 10)}::date where version_id = ${imported.published.id}`);
      await bench.owner.db.insert(auditLog).values({
        tenantId: h.id,
        actorId: owner.id,
        action: 'document_reviewed',
        entityType: 'document',
        entityId: imported.id,
        changes: { outcome: 'no_change', nextReviewOn: shiftDay(lastMonth, 4) },
        occurredAt: new Date(longAgo.getTime() + 86_400_000),
      });
      await http().patch(`/users/${leaver.id}`).set('Cookie', h.cookie).send({ status: 'disabled' }).expect(200);
      const asked = await bench.owner.db.execute<{ n: number }>(sql`select count(*)::int as n from document_acknowledgements where version_id = ${imported.published.id}`);
      await startModule(h, 'policies', shiftDay(lastMonth, -20));
      await startModule(h, 'incidents', shiftDay(lastMonth, -20));
      await check.run(new Date(), [h.id]);
      const [past] = await rowsOf(h, 'policies.past_review', lastMonth, null);
      const [acks] = await rowsOf(h, 'policies.acknowledged', lastMonth, null);
      if (past.method === 'reconstructed') {
        expect(past).toMatchObject({ numerator: 1, denominator: 1, value: 100 });
        // The leaver counted: active when the month ended.
        expect(acks).toMatchObject({ numerator: 0, denominator: asked.rows[0].n, value: 0 });
        expect((await rowsOf(h, 'policies.acknowledged', lastMonth, hDept))[0]).toMatchObject({ denominator: 2 });
      } else {
        // Taken within six hours of the month's end: as the records stand.
        expect(past.method).toBe('snapshot');
      }
      // Today, as the records stand: reviewed, and the leaver gone.
      const live = await measuresOf(h.cookie, months(thisMonth, thisMonth));
      expect(live.measures.find((m) => m.code === 'policies.past_review')!.current).toMatchObject({ numerator: 0, denominator: 1 });
    }, 30_000);
  });

  describe('the Reports API', () => {
    it('is refused without a session, without reports.view, and for bad input', async () => {
      await http().get(`/reports/measures?${months(lastMonth, lastMonth)}`).expect(401);
      expect((await get(reporter.cookie, `/reports/measures?${months(lastMonth, lastMonth)}`).expect(403)).body).toMatchObject({ code: 'missing_permission', permission: 'reports.view' });
      for (const query of [
        '',
        'from=2026-13&to=2026-12',
        `${months(thisMonth, lastMonth)}`,
        'from=2010-01&to=2026-11',
        // Years before 2000 (security review 16, L7).
        'from=0000-01&to=0000-01',
        'from=1999-12&to=2000-01',
        `${months(lastMonth, lastMonth)}&measures=nothing.here`,
        `${months(lastMonth, lastMonth)}&other=1`,
      ]) {
        await get(a.cookie, `/reports/measures?${query}`).expect(400);
      }
    });

    it('scopes a department manager to their units, and answers another unit as if it were not there', async () => {
      expect((await get(manager.cookie, `/reports/measures?${months(lastMonth, lastMonth)}`).expect(403)).body).toMatchObject({ code: 'missing_permission' });
      const mine = await measuresOf(manager.cookie, `${months(lastMonth, lastMonth)}&unitId=${dept}`);
      const reportedHere = mine.measures.find((m) => m.code === 'incidents.reported')!;
      expect(reportedHere.months).toEqual([expect.objectContaining({ month: lastMonth.slice(0, 7), value: 2 })]);
      // The organization's baseline is no unit's target, and not theirs to
      // read (security review 16, M2).
      expect(reportedHere).toMatchObject({ target: null, targetSource: null });
      expect(reportedHere.months[0]).toMatchObject({ target: null, targetSource: null, met: null });
      await get(manager.cookie, `/reports/measures?${months(lastMonth, lastMonth)}&unitId=${ward}`).expect(200);
      await get(manager.cookie, `/reports/measures?${months(lastMonth, lastMonth)}&unitId=${other}`).expect(404);
      await get(manager.cookie, `/reports/measures?${months(lastMonth, lastMonth)}&unitId=${facility}`).expect(404);
      const [theirUnit] = (await bench.owner.db.execute<{ id: string }>(sql`select id from org_units where tenant_id = ${b.id} limit 1`)).rows;
      await get(a.cookie, `/reports/measures?${months(lastMonth, lastMonth)}&unitId=${theirUnit?.id ?? b.id}`).expect(404);
    });

    it('tells how reports arrived only to those told reporters, and gives no figures of a module the client lacks', async () => {
      const told = await measuresOf(a.cookie, months(lastMonth, lastMonth));
      expect(told.measures.find((m) => m.code === 'incidents.reported')!.months[0].details).toHaveProperty('channel');
      const untold = await measuresOf(analyst.cookie, months(lastMonth, lastMonth));
      const reported = untold.measures.find((m) => m.code === 'incidents.reported')!;
      expect(reported.months[0].details).not.toHaveProperty('channel');
      expect(reported.current.details).not.toHaveProperty('channel');
      // The analyst sees no document figures: no full sight of documents.
      expect(untold.measures.map((m) => m.code)).toEqual(['incidents.time_to_report', 'incidents.reported', 'incidents.triaged_on_time']);
      const c = await bench.createHospital('nomodule');
      const plan = (
        await http()
          .post('/platform/plans')
          .set('Cookie', bench.platform)
          .send({
            code: `${bench.prefix}-docs`,
            name: { en: 'Documents', ar: 'وثائق', fr: 'Documents' },
            modules: ['policies'],
            limits: { users: null, sites: null, storageMb: null, aiCreditsPerMonth: null },
            extras: { sso: false, publicReporting: false, clinicalAiSuggestions: false },
          })
          .expect(201)
      ).body as { id: string };
      await http().patch(`/platform/tenants/${c.id}/subscription`).set('Cookie', bench.platform).send({ planId: plan.id }).expect(200);
      const off = await measuresOf(c.cookie, months(lastMonth, lastMonth));
      expect(off.measures.map((m) => m.code)).toEqual(['policies.past_review', 'policies.acknowledged']);
    });

    it('gives the Approving authority the document measures only', async () => {
      const authority = await bench.createStaff(a, 'authority', { role: 'approving_authority', orgUnitId: null });
      const seen = await measuresOf(authority.cookie, months(lastMonth, lastMonth));
      expect(seen.measures.map((m) => m.code)).toEqual(['policies.past_review', 'policies.acknowledged']);
      await http().post('/reports/measures/corrections').set('Cookie', authority.cookie)
        .send({ month: lastMonth.slice(0, 7), measures: ['policies.past_review'], reason: 'Not theirs to correct.' })
        .expect(403);
      // No figure of the organization's reports through the settings
      // (security review 16, M2).
      const settings = (await get(authority.cookie, '/reports/settings').expect(200)).body;
      expect(settings).toMatchObject({ baseline: null, firstMonthsBaseline: null, reportedTarget: null });
    });

    it('corrects a month only by recomputing it, with a reason, for the whole organization’s reports.manage', async () => {
      const body = { month: lastMonth.slice(0, 7), measures: ['incidents.reported'], reason: 'Two reports were entered against the wrong ward.' };
      await http().post('/reports/measures/corrections').send(body).expect(401);
      expect((await http().post('/reports/measures/corrections').set('Cookie', analyst.cookie).send(body).expect(403)).body).toMatchObject({ code: 'missing_permission', permission: 'reports.manage' });
      await http().post('/reports/measures/corrections').set('Cookie', quality.cookie).send({ ...body, reason: '' }).expect(400);
      await http().post('/reports/measures/corrections').set('Cookie', quality.cookie).send({ ...body, value: 4 }).expect(400);
      expect((await http().post('/reports/measures/corrections').set('Cookie', quality.cookie).send({ ...body, month: '2001-01' }).expect(409)).body).toEqual({ code: 'no_snapshot' });
      // The ward's reports were the other department's: moved, then corrected.
      const moved = await bench.owner.db.execute<{ id: string }>(sql`select id from incidents where tenant_id = ${a.id} and org_unit_id = ${ward} and reported_at < ${startOfDay(thisMonth, zone)}`);
      await bench.owner.db.execute(sql`update incidents set org_unit_id = ${other} where id = any(${sql.raw(`array[${moved.rows.map((r) => `'${r.id}'`).join(',')}]::uuid[]`)})`);
      const corrected = (await http().post('/reports/measures/corrections').set('Cookie', quality.cookie).send(body).expect(201)).body;
      expect(corrected.revisions).toEqual(
        expect.arrayContaining([
          { measure: 'incidents.reported', unitId: ward, revision: 2, from: expect.objectContaining({ value: 2 }), to: expect.objectContaining({ value: 0 }) },
          { measure: 'incidents.reported', unitId: other, revision: 2, from: expect.objectContaining({ value: 1 }), to: expect.objectContaining({ value: 3 }) },
        ]),
      );
      const history = (await get(a.cookie, `/reports/measures/incidents.reported/history?month=${lastMonth.slice(0, 7)}&unitId=${ward}`).expect(200)).body;
      expect(history.revisions.map((r: { revision: number; method: string; reason: string | null; value: number }) => [r.revision, r.method, r.value])).toEqual([
        [1, expect.stringMatching(/snapshot|reconstructed/), 2],
        [2, 'corrected', 0],
      ]);
      expect(history.revisions[1]).toMatchObject({ reason: body.reason, requestedBy: { id: quality.id } });
      // For a unit, the reason is for those who read the whole
      // organization only (security review 16, L4).
      const unitHistory = (await get(manager.cookie, `/reports/measures/incidents.reported/history?month=${lastMonth.slice(0, 7)}&unitId=${dept}`).expect(200)).body;
      expect(unitHistory.revisions.map((r: { method: string; value: number; reason: string | null }) => [r.method, r.value, r.reason])).toEqual([
        [expect.stringMatching(/snapshot|reconstructed/), 2, null],
        ['corrected', 0, null],
      ]);
      // One correction at a time per client (L1, L6): another waits its turn.
      const held = await bench.owner.pool.connect();
      try {
        await held.query('begin');
        await held.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`trustline.measures.${a.id}.correct`]);
        expect((await http().post('/reports/measures/corrections').set('Cookie', quality.cookie).send(body).expect(409)).body).toEqual({ code: 'correction_in_progress' });
      } finally {
        await held.query('rollback');
        held.release();
      }
      // The series shows the latest revision.
      const series = await measuresOf(a.cookie, `${months(lastMonth, lastMonth)}&unitId=${ward}`);
      expect(series.measures.find((m) => m.code === 'incidents.reported')!.months[0]).toMatchObject({ value: 0, method: 'corrected', revision: 2 });
      const [audited] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'measure_correction_requested')));
      expect(audited.changes).toMatchObject({ month: body.month, measures: ['incidents.reported'], reason: body.reason });
      await get(a.cookie, `/reports/measures/nothing.here/history?month=${lastMonth.slice(0, 7)}`).expect(404);
    });

    it('works a month out again on the structure it was taken on, and hides how reports arrived where units moved since', async () => {
      // One report back on the ward, then the ward moved to the other
      // department.
      const [one] = (await bench.owner.db.execute<{ id: string }>(sql`select id from incidents where tenant_id = ${a.id} and org_unit_id = ${other} and status = 'triaged' and reported_at < ${startOfDay(thisMonth, zone)} limit 1`)).rows;
      await bench.owner.db.execute(sql`update incidents set org_unit_id = ${ward} where id = ${one.id}`);
      await bench.owner.db.execute(sql`update org_units set parent_id = ${other} where id = ${ward}`);
      try {
        const body = { month: lastMonth.slice(0, 7), measures: ['incidents.reported'], reason: 'One report was on the ward after all.' };
        const { revisions } = (await http().post('/reports/measures/corrections').set('Cookie', quality.cookie).send(body).expect(201)).body;
        const to = (unit: string) => revisions.find((r: { unitId: string }) => r.unitId === unit).to.value;
        // As the structure was: the ward in its department of then.
        expect([to(ward), to(dept), to(other), to(facility)]).toEqual([1, 1, 2, 3]);
        const channelOf = async (unit: string) =>
          (await measuresOf(a.cookie, `${months(lastMonth, lastMonth)}&unitId=${unit}&measures=incidents.reported`)).measures[0].months[0].details;
        // Both departments changed since: how reports arrived is not told
        // for them (L5); for the facility and the ward, as before.
        expect(await channelOf(dept)).not.toHaveProperty('channel');
        expect(await channelOf(other)).not.toHaveProperty('channel');
        expect(await channelOf(facility)).toHaveProperty('channel');
        expect(await channelOf(ward)).toHaveProperty('channel');
      } finally {
        await bench.owner.db.execute(sql`update org_units set parent_id = ${dept} where id = ${ward}`);
      }
    });

    it('takes the client’s own targets and baseline, audited, and each month keeps the target it was taken under', async () => {
      await http().get('/reports/settings').expect(401);
      await get(reporter.cookie, '/reports/settings').expect(403);
      const settings = (await get(analyst.cookie, '/reports/settings').expect(200)).body;
      expect(settings).toMatchObject({ revision: 0, baseline: null });
      expect(settings.targets.find((t: { code: string }) => t.code === 'incidents.triaged_on_time')).toMatchObject({ business: 95, client: null, effective: 95 });
      const change = { targets: { 'incidents.triaged_on_time': 90 }, baseline: { monthlyAverage: 2, note: { en: 'Paper register, 2025' } }, revision: 0 };
      expect((await http().patch('/reports/settings').set('Cookie', analyst.cookie).send(change).expect(403)).body).toMatchObject({ permission: 'reports.manage' });
      for (const bad of [
        { ...change, targets: { 'incidents.triaged_on_time': 101 } },
        { ...change, targets: { 'incidents.reported': 5 } },
        { ...change, baseline: { monthlyAverage: -1, note: { en: 'x' } } },
        { ...change, baseline: { monthlyAverage: 2, note: { fr: 'Registre' } } },
        { revision: 0 },
      ]) {
        await http().patch('/reports/settings').set('Cookie', quality.cookie).send(bad).expect(400);
      }
      const saved = (await http().patch('/reports/settings').set('Cookie', quality.cookie).send(change).expect(200)).body;
      expect(saved).toMatchObject({ revision: 1, baseline: { monthlyAverage: 2 }, reportedTarget: { value: 2, source: 'baseline' } });
      await http().patch('/reports/settings').set('Cookie', quality.cookie).send(change).expect(409);
      const series = await measuresOf(a.cookie, months(lastMonth, lastMonth));
      const triage = series.measures.find((m) => m.code === 'incidents.triaged_on_time')!;
      expect(triage).toMatchObject({ target: 90, targetSource: 'client' });
      // Last month keeps the target it was taken under, even corrected
      // after the change (security review 16, M1).
      expect(triage.months[0]).toMatchObject({ target: 95 });
      await http()
        .post('/reports/measures/corrections')
        .set('Cookie', quality.cookie)
        .send({ month: lastMonth.slice(0, 7), measures: ['incidents.triaged_on_time'], reason: 'A decision was recorded on the wrong report.' })
        .expect(201);
      const after = (await measuresOf(a.cookie, months(lastMonth, lastMonth))).measures.find((m) => m.code === 'incidents.triaged_on_time')!;
      expect(after.months[0]).toMatchObject({ method: 'corrected', target: 95, targetSource: 'business' });
      const [audited] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'report_settings_changed')));
      expect(audited.changes).toMatchObject({ targets: { 'incidents.triaged_on_time': { from: null, to: 90 } }, baseline: { from: null } });
    });

    it('gives the months as a CSV file in the client’s language, audited', async () => {
      await get(reporter.cookie, `/reports/exports/measures?${months(lastMonth, lastMonth)}`).expect(403);
      expect((await get(a.cookie, `/reports/exports/measures?${months(lastMonth, lastMonth)}&locale=fr`).expect(400)).body).toEqual({ code: 'language_mismatch' });
      const res = await get(a.cookie, `/reports/exports/measures?${months(lastMonth, lastMonth)}&unitId=${dept}`).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe(`"Month","Unit","Place in the structure","Measure","Value","Counted","Out of","Target","Target met","Status","How it was taken","Revision","As at (${zone})","Definition version"`);
      expect(lines.find((l) => l.includes('"Reports submitted"'))).toContain('"Unit D"');
      const [audited] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'measures_exported')));
      expect(audited.changes).toMatchObject({ locale: 'en', rows: lines.length - 1, filters: { unitId: dept } });
      expect(nextMonth(lastMonth)).toBe(thisMonth);
      const [someone] = await bench.owner.db.select({ id: users.id }).from(users).where(eq(users.tenantId, a.id)).limit(1);
      expect(someone).toBeDefined();
    });
  });
});
