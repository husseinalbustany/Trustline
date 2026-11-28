import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { auditLog } from '../src/database/schema.js';
import { dayOf, shiftDay } from '../src/i18n/time-zones.js';
import { monthOf } from '../src/reports/snapshots.service.js';
import { testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

/**
 * The incident breakdowns of the Reports API (docs/specs/reports-and-
 * measures.md, step 5): the reports of a period by month, type, harm level,
 * category, unit and channel, and their CSV, behind the page's scope, the
 * incident reach, and the reporter rule for how reports arrived.
 */
describe('incident breakdowns', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  let a: Hospital;
  let b: Hospital;
  let facility: string;
  let dept: string;
  let ward: string;
  let other: string;
  let bUnit: string;
  let quality: Staff;
  let reporter: Staff;
  let manager: Staff; // department manager of `dept`: no reporters
  let authority: Staff; // reports.view, no incident permission
  let staffOnly: Staff; // reporter: no reports.view
  let thisMonth: string;
  let lastMonth: string;
  let period: string;
  const http = () => bench.http();
  const get = (cookie: string, url: string) => http().get(url).set('Cookie', cookie);
  type Row = { key: string; count: number; share: number | null; runningShare?: number | null; partial?: boolean; name?: Record<string, string>; code?: string; here?: boolean };
  type Answer = { unitId: string | null; total: number; median: number | null; currentMonth: string; rows: Row[] };
  const breakdown = async (cookie: string, query: string) =>
    (await get(cookie, `/reports/incidents?${period}&${query}`).expect(200)).body as Answer;
  const report = async (at: string, extra: Record<string, unknown> = {}) =>
    (
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send({
          type: 'incident',
          categoryId: a.categories.equipment,
          orgUnitId: at,
          occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
          description: 'A bed rail would not lock.',
          harmLevel: 'none',
          anonymous: false,
          ...extra,
        })
        .expect(201)
    ).body as { id: string };

  beforeAll(async () => {
    bench = await testBench('brk', run);
    a = await bench.createHospital('a');
    b = await bench.createHospital('b');
    facility = await bench.createUnit(a, 'facility', 'F', null);
    dept = await bench.createUnit(a, 'department', 'D', facility);
    ward = await bench.createUnit(a, 'unit', 'W', dept);
    other = await bench.createUnit(a, 'department', 'O', facility);
    bUnit = await bench.createUnit(b, 'department', 'B', null);
    quality = await bench.createStaff(a, 'quality', { role: 'quality_officer', orgUnitId: null });
    reporter = await bench.createStaff(a, 'reporter', { role: 'reporter', orgUnitId: null });
    manager = await bench.createStaff(a, 'manager', { role: 'department_manager', orgUnitId: dept });
    authority = await bench.createStaff(a, 'authority', { role: 'approving_authority', orgUnitId: null });
    staffOnly = reporter;
    const zone = (await get(a.cookie, '/auth/me').expect(200)).body.tenant.timeZone as string;
    thisMonth = monthOf(dayOf(new Date(), zone)).slice(0, 7);
    lastMonth = monthOf(shiftDay(`${thisMonth}-01`, -1)).slice(0, 7);
    period = `from=${lastMonth}&to=${thisMonth}`;

    // Ward (in dept): three; dept itself: one; other: two. One last month.
    const old = await report(ward, { harmLevel: 'moderate', categoryId: a.categories.fall });
    await bench.owner.db.execute(sql`update incidents set reported_at = ${`${lastMonth}-15T12:00:00Z`}::timestamptz where id = ${old.id}`);
    await report(ward, { type: 'near_miss', harmLevel: 'none', categoryId: a.categories.fall });
    await report(ward, { anonymous: true, harmLevel: 'mild' });
    await report(dept, { type: 'hazard', categoryId: a.categories.other });
    await report(other, { harmLevel: 'severe' });
    await report(other, {});
    // Another hospital's report, never counted here.
    await http()
      .post('/incidents')
      .set('Cookie', b.cookie)
      .send({
        type: 'incident',
        categoryId: b.categories.equipment,
        orgUnitId: bUnit,
        occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
        description: 'A door would not close.',
        harmLevel: 'none',
        anonymous: false,
      })
      .expect(201);
  }, 120_000);

  afterAll(() => bench.close());

  describe('who may ask', () => {
    it('needs a session', async () => {
      await http().get(`/reports/incidents?${period}&by=type`).expect(401);
      await http().get(`/reports/exports/incidents?${period}&by=type`).expect(401);
    });

    it('needs reports.view, and the incident reach over the scope', async () => {
      const none = await get(staffOnly.cookie, `/reports/incidents?${period}&by=type`).expect(403);
      expect(none.body).toMatchObject({ code: 'missing_permission', permission: 'reports.view' });
      // The Approving authority reads reports, but sees no incidents.
      const noIncidents = await get(authority.cookie, `/reports/incidents?${period}&by=type`).expect(403);
      expect(noIncidents.body).toMatchObject({ code: 'missing_permission', permission: 'incidents.view' });
      await get(authority.cookie, `/reports/exports/incidents?${period}&by=type`).expect(403);
      // A department manager: not the organization.
      await get(manager.cookie, `/reports/incidents?${period}&by=type`).expect(403);
    });

    it('tells how reports arrived only to those told reporters', async () => {
      const refused = await get(manager.cookie, `/reports/incidents?${period}&by=channel&unitId=${dept}`).expect(403);
      expect(refused.body).toMatchObject({ code: 'missing_permission', permission: 'incidents.see_reporter' });
      await get(manager.cookie, `/reports/exports/incidents?${period}&by=channel&unitId=${dept}`).expect(403);
      const told = await breakdown(quality.cookie, 'by=channel');
      expect(told.rows).toEqual([
        { key: 'public', count: 0, share: 0 },
        { key: 'anonymous', count: 1, share: 16.7 },
        { key: 'named', count: 5, share: 83.3 },
      ]);
    });

    it('answers a unit out of reach, or of another hospital, as not there', async () => {
      await get(manager.cookie, `/reports/incidents?${period}&by=type&unitId=${other}`).expect(404);
      await get(quality.cookie, `/reports/incidents?${period}&by=type&unitId=${bUnit}`).expect(404);
      await get(quality.cookie, `/reports/exports/incidents?${period}&by=type&unitId=${bUnit}`).expect(404);
    });

    it('refuses input it does not know', async () => {
      for (const query of [
        `${period}&by=reporter`,
        `${period}`,
        `from=${thisMonth}&to=${lastMonth}&by=type`,
        `from=1999-01&to=${thisMonth}&by=type`,
        `${period}&by=type&type=accident`,
        `${period}&by=type&harmLevel=fatal`,
        `${period}&by=type&unitId=not-a-unit`,
        `${period}&by=type&extra=1`,
      ]) {
        await get(quality.cookie, `/reports/incidents?${query}`).expect(400);
      }
      await get(quality.cookie, `/reports/exports/incidents?${period}&by=type&locale=de`).expect(400);
      const tenant = (await get(a.cookie, '/auth/me').expect(200)).body.tenant as { locales: string[] };
      if (!tenant.locales.includes('fr')) {
        const lacking = await get(quality.cookie, `/reports/exports/incidents?${period}&by=type&locale=fr`).expect(400);
        expect(lacking.body).toMatchObject({ code: 'language_mismatch' });
      }
    });
  });

  describe('the figures', () => {
    it('counts by month, with the median of the whole months', async () => {
      const answer = await breakdown(quality.cookie, 'by=month');
      expect(answer.total).toBe(6);
      expect(answer.rows).toEqual([
        { key: lastMonth, count: 1, share: 16.7, partial: false },
        { key: thisMonth, count: 5, share: 83.3, partial: true },
      ]);
      expect(answer.median).toBe(1);
      expect(answer.currentMonth).toBe(thisMonth);
    });

    it('counts by type and by harm level, every level shown', async () => {
      const types = await breakdown(quality.cookie, 'by=type');
      expect(types.rows.map((r) => [r.key, r.count])).toEqual([['incident', 4], ['near_miss', 1], ['hazard', 1]]);
      const harm = await breakdown(quality.cookie, 'by=harm');
      expect(harm.rows.map((r) => [r.key, r.count])).toEqual([['none', 3], ['mild', 1], ['moderate', 1], ['severe', 1], ['death', 0]]);
    });

    it('counts by category, most first, with the running share', async () => {
      const answer = await breakdown(quality.cookie, 'by=category');
      expect(answer.rows.map((r) => [r.code, r.count, r.share, r.runningShare])).toEqual([
        ['equipment', 3, 50, 50],
        ['fall', 2, 33.3, 83.3],
        ['other', 1, 16.7, 100],
      ]);
      expect(answer.rows[0].name).toHaveProperty('en');
    });

    it('counts by unit: each beneath the scope with what lies under it, and the unit itself', async () => {
      const top = await breakdown(quality.cookie, 'by=unit');
      expect(top.rows.map((r) => [r.key, r.count])).toEqual([[facility, 6]]);
      const inFacility = await breakdown(quality.cookie, `by=unit&unitId=${facility}`);
      expect(inFacility.rows.map((r) => [r.key, r.count, r.here ?? false])).toEqual([
        [dept, 4, false],
        [other, 2, false],
        [facility, 0, true],
      ]);
      const inDept = await breakdown(manager.cookie, `by=unit&unitId=${dept}`);
      expect(inDept.rows.map((r) => [r.key, r.count, r.here ?? false])).toEqual([
        [ward, 3, false],
        [dept, 1, true],
      ]);
    });

    it('keeps to the filters, the unit and the period', async () => {
      const filtered = await breakdown(quality.cookie, 'by=category&type=incident&harmLevel=none');
      expect(filtered.total).toBe(1);
      expect(filtered.rows.map((r) => [r.code, r.count])).toEqual([['equipment', 1]]);
      const ward_ = await breakdown(manager.cookie, `by=type&unitId=${ward}`);
      expect(ward_.total).toBe(3);
      const thisOnly = (await get(quality.cookie, `/reports/incidents?from=${thisMonth}&to=${thisMonth}&by=type`).expect(200)).body as Answer;
      expect(thisOnly.total).toBe(5);
      // Another hospital sees only its own.
      const theirs = (await get(b.cookie, `/reports/incidents?${period}&by=type`).expect(200)).body as Answer;
      expect(theirs.total).toBe(1);
    });
  });

  describe('the CSV', () => {
    it('writes the breakdown in the language asked for, and audits it (a language the client lacks is refused)', async () => {
      // The client works in English and Arabic from here on.
      await bench.owner.db.execute(sql`update tenants set locales = array['en', 'ar'] where id = ${a.id}`);
      const res = await get(quality.cookie, `/reports/exports/incidents?${period}&by=harm&unitId=${dept}&locale=ar`).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(/incidents-by-harm-\d{4}-\d{2}-\d{2}\.csv/);
      expect(res.headers['cache-control']).toBe('no-store');
      const lines = (res.text as string).replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toContain('"مستوى الضرر"');
      expect(lines).toHaveLength(6);
      expect(lines[1]).toContain('"بلا ضرر"');
      expect(lines[1]).toContain('"الكل"');
      const [entry] = await bench.owner.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'incident_figures_exported')))
        .orderBy(desc(auditLog.occurredAt))
        .limit(1);
      expect(entry).toMatchObject({ actorId: quality.id, changes: { locale: 'ar', rows: 5, filters: { by: 'harm', unitId: dept } } });
    });

    it('names the unit itself and the units beneath it, in the client language', async () => {
      const res = await get(quality.cookie, `/reports/exports/incidents?${period}&by=unit&unitId=${dept}`).expect(200);
      const lines = (res.text as string).replace(/^﻿/, '').trim().split('\r\n');
      expect(lines).toHaveLength(3);
      expect(lines[2]).toMatch(/itself|نفسها|التابعة|rattachées/);
    });
  });
});
