import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  DEFAULT_RESPONSE_RULES,
  HARM_LEVELS,
} from '../src/incidents/response-rules.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Section 4 of docs/specs/incident-safeguards-and-deadlines.md: a hospital's
 * response rules, the two deadlines of an incident, what counts as overdue,
 * and the hospital's own day.
 */
describe('incident deadlines', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();

  let a: Hospital; // keeps the default time zone, UTC
  let b: Hospital; // another hospital
  let riyadh: Hospital; // three hours ahead of UTC all year
  let beirut: Hospital; // two or three hours ahead, by the season

  let ward: string;
  let lab: string;
  let bUnit: string;
  let riyadhUnit: string;
  let beirutUnit: string;

  let reporter: Staff; // may report, and nothing else
  let nurse: Staff; // the same; gets incidents assigned
  let manager: Staff; // department manager everywhere: sees all, triages nothing
  let quality: Staff; // quality officer everywhere
  let wardQuality: Staff; // quality officer for the ward only
  let settingsWard: Staff; // may manage settings, but for the ward only

  type Rule = {
    harmLevel: string;
    triageWithinHours: number;
    closeWithinDays: number;
  };
  type Item = {
    id: string;
    status: string;
    triageDueAt: string | null;
    closeDueAt: string | null;
    overdue: 'triage' | 'closure' | null;
  };
  type Summary = {
    open: number;
    overdue: number;
    triagedOnTime: number | null;
    closedLast30Days: number;
    last30Days: { from: string; to: string };
  };

  const STARTING: Rule[] = HARM_LEVELS.map((harmLevel) => ({
    harmLevel,
    ...DEFAULT_RESPONSE_RULES[harmLevel],
  }));

  const reportIn = async (
    hospital: Hospital,
    cookie: string,
    orgUnitId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const res = await http()
      .post('/incidents')
      .set('Cookie', cookie)
      .send({
        type: 'incident',
        categoryId: hospital.categories.equipment,
        orgUnitId,
        occurredAt: new Date(Date.now() - HOUR).toISOString(),
        description: 'A monitor lost its signal.',
        harmLevel: 'none',
        anonymous: false,
        ...overrides,
      })
      .expect(201);
    return res.body as { id: string; reference: string };
  };
  const report = (who: Staff, overrides: Record<string, unknown> = {}) =>
    reportIn(a, who.cookie, ward, overrides);

  const triage = (
    cookie: string,
    id: string,
    overrides: Record<string, unknown> = {},
  ) =>
    http()
      .post(`/incidents/${id}/triage`)
      .set('Cookie', cookie)
      .send({
        harmLevel: 'none',
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

  const listOf = async (cookie: string, query = '') => {
    const res = await http()
      .get(`/incidents?pageSize=100${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body as { total: number; items: Item[] };
  };

  const summaryOf = async (cookie: string) =>
    (await http().get('/incidents/summary').set('Cookie', cookie).expect(200))
      .body as Summary;

  const rulesOf = (cookie: string) =>
    http().get('/settings/response-rules').set('Cookie', cookie);
  const setRules = (cookie: string, rules: unknown) =>
    http()
      .put('/settings/response-rules')
      .set('Cookie', cookie)
      .send({ rules });
  /** The starting rules with some of them changed. */
  const rulesWith = (changes: Record<string, Partial<Rule>>): Rule[] =>
    STARTING.map((rule) => ({ ...rule, ...changes[rule.harmLevel] }));

  const stored = async (id: string) => {
    const moment = (column: string) =>
      sql.raw(
        `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${column}`,
      );
    const [row] = (
      await bench.owner.db.execute<{
        status: string;
        reported_at: string;
        triage_due_at: string | null;
        close_due_at: string | null;
        first_triaged_at: string | null;
      }>(
        sql`select status, ${moment('reported_at')}, ${moment('triage_due_at')}, ${moment('close_due_at')}, ${moment('first_triaged_at')} from incidents where id = ${id}`,
      )
    ).rows;
    const date = (value: string | null) => (value ? new Date(value) : null);
    return {
      status: row.status,
      reported_at: new Date(row.reported_at),
      triage_due_at: date(row.triage_due_at),
      close_due_at: date(row.close_due_at),
      first_triaged_at: date(row.first_triaged_at),
    };
  };

  /**
   * Moves an incident's past: as if it had been reported, and each of its
   * deadlines had fallen, that much longer ago.
   */
  const age = (id: string, ms: number) =>
    bench.owner.db.execute(
      sql`update incidents set
            reported_at = reported_at - make_interval(secs => ${ms / 1000}),
            triage_due_at = triage_due_at - make_interval(secs => ${ms / 1000}),
            close_due_at = close_due_at - make_interval(secs => ${ms / 1000}),
            first_triaged_at = first_triaged_at - make_interval(secs => ${ms / 1000}),
            triaged_at = triaged_at - make_interval(secs => ${ms / 1000})
          where id = ${id}`,
    );

  beforeAll(async () => {
    bench = await testBench('dl', run);
    a = await bench.createHospital('a');
    b = await bench.createHospital('b');
    riyadh = await bench.createHospital('riyadh', { timeZone: 'Asia/Riyadh' });
    beirut = await bench.createHospital('beirut', { timeZone: 'Asia/Beirut' });

    const facility = await bench.createUnit(a, 'facility', 'MAIN', null);
    ward = await bench.createUnit(a, 'department', 'WARD', facility);
    lab = await bench.createUnit(a, 'department', 'LAB', facility);
    bUnit = await bench.createUnit(b, 'facility', 'MAIN', null);
    riyadhUnit = await bench.createUnit(riyadh, 'facility', 'MAIN', null);
    beirutUnit = await bench.createUnit(beirut, 'facility', 'MAIN', null);

    await bench.createRole(a, 'settings_only', ['settings.manage']);
    const everywhere = (role: string) => ({ role, orgUnitId: null });
    reporter = await bench.createStaff(a, 'reporter', everywhere('reporter'));
    nurse = await bench.createStaff(a, 'nurse', everywhere('reporter'));
    manager = await bench.createStaff(
      a,
      'manager',
      everywhere('department_manager'),
    );
    quality = await bench.createStaff(
      a,
      'quality',
      everywhere('quality_officer'),
    );
    wardQuality = await bench.createStaff(a, 'ward-quality', {
      role: 'quality_officer',
      orgUnitId: ward,
    });
    settingsWard = await bench.createStaff(a, 'settings-ward', {
      role: 'settings_only',
      orgUnitId: ward,
    });
  }, 180_000);

  afterAll(() => bench.close());

  describe('the response rules', () => {
    it('exist for a hospital from the moment it is created, with the starting values', async () => {
      // Read from the table: created with the hospital, not on first use.
      const fresh = await http()
        .post('/platform/tenants')
        .set('Cookie', bench.platform)
        .send({
          slug: `${bench.prefix}-fresh`,
          name: { en: 'Fresh' },
          accreditationStandard: 'JCI',
          locales: ['en'],
          defaultLocale: 'en',
          signInMethod: 'password',
          dataRegion: null,
        })
        .expect(201);
      const rows = await bench.owner.db.execute(
        sql`select harm_level, triage_within_hours, close_within_days from incident_response_rules where tenant_id = ${fresh.body.id} order by harm_level`,
      );
      expect(rows.rows).toEqual([
        { harm_level: 'none', triage_within_hours: 72, close_within_days: 30 },
        { harm_level: 'mild', triage_within_hours: 72, close_within_days: 30 },
        {
          harm_level: 'moderate',
          triage_within_hours: 48,
          close_within_days: 30,
        },
        {
          harm_level: 'severe',
          triage_within_hours: 24,
          close_within_days: 45,
        },
        { harm_level: 'death', triage_within_hours: 24, close_within_days: 45 },
      ]);
      // Every hospital there is has all five, the demo ones included.
      const short = await bench.owner.db.execute(
        sql`select t.slug from tenants t
            left join incident_response_rules r on r.tenant_id = t.id
            where t.slug like ${`${bench.prefix}-%`} or t.slug like 'demo-%'
            group by t.slug having count(r.harm_level) <> 5`,
      );
      expect(short.rows).toEqual([]);
    });

    it('need a session', async () => {
      await http().get('/settings/response-rules').expect(401);
      await http()
        .put('/settings/response-rules')
        .send({ rules: STARTING })
        .expect(401);
    });

    it('are read by anyone who may triage or manage settings, and by nobody else', async () => {
      for (const who of [quality, wardQuality, settingsWard]) {
        const res = await rulesOf(who.cookie).expect(200);
        expect(res.body).toEqual({ rules: STARTING });
      }
      expect((await rulesOf(a.cookie).expect(200)).body).toEqual({
        rules: STARTING,
      });
      for (const who of [reporter, nurse, manager]) {
        const res = await rulesOf(who.cookie).expect(403);
        expect(res.body).toMatchObject({ code: 'missing_permission' });
      }
    });

    it('are changed only by someone who manages settings for the whole hospital', async () => {
      const next = rulesWith({ none: { triageWithinHours: 1 } });
      for (const who of [quality, wardQuality, manager, reporter]) {
        const res = await setRules(who.cookie, next).expect(403);
        expect(res.body).toMatchObject({
          code: 'missing_permission',
          permission: 'settings.manage',
        });
      }
      // Holding it for one department is not holding it for the hospital.
      await setRules(settingsWard.cookie, next).expect(403);
      expect((await rulesOf(a.cookie)).body).toEqual({ rules: STARTING });
    });

    it('refuse anything that is not all five levels within the limits', async () => {
      const without = (level: string) =>
        STARTING.filter((r) => r.harmLevel !== level);
      for (const rules of [
        undefined,
        null,
        [],
        {},
        without('death'),
        [...without('death'), STARTING[0]],
        [...STARTING, STARTING[0]],
        rulesWith({ none: { triageWithinHours: 0 } }),
        rulesWith({ none: { triageWithinHours: 721 } }),
        rulesWith({ none: { triageWithinHours: 1.5 } }),
        rulesWith({ none: { triageWithinHours: '24' as unknown as number } }),
        rulesWith({ death: { closeWithinDays: 0 } }),
        rulesWith({ death: { closeWithinDays: 366 } }),
        rulesWith({ death: { closeWithinDays: -1 } }),
        rulesWith({ mild: { harmLevel: 'catastrophic' } }),
        STARTING.map((r) => ({ ...r, tenantId: b.id })),
        STARTING.map(({ harmLevel, triageWithinHours }) => ({
          harmLevel,
          triageWithinHours,
        })),
      ]) {
        const res = await setRules(a.cookie, rules);
        expect([JSON.stringify(rules)?.slice(0, 60), res.status]).toEqual([
          JSON.stringify(rules)?.slice(0, 60),
          400,
        ]);
      }
      await http()
        .put('/settings/response-rules')
        .set('Cookie', a.cookie)
        .send({ rules: STARTING, extra: true })
        .expect(400);
      expect((await rulesOf(a.cookie)).body).toEqual({ rules: STARTING });
      // The limits themselves are allowed.
      const edge = rulesWith({
        none: { triageWithinHours: 720, closeWithinDays: 365 },
        death: { triageWithinHours: 1, closeWithinDays: 1 },
      });
      expect((await setRules(b.cookie, edge).expect(200)).body).toEqual({
        rules: edge,
      });
    });

    it("are changed for the caller's own hospital, and each change is recorded with what it was", async () => {
      const changes = async (tenantId: string) =>
        (
          await bench.owner.db.execute<{
            actor_id: string;
            entity_type: string;
            entity_id: string;
            changes: unknown;
          }>(
            sql`select actor_id, entity_type, entity_id, changes from audit_log where tenant_id = ${tenantId} and action = 'response_rules_changed' order by occurred_at, id`,
          )
        ).rows;
      const before = await changes(a.id);
      // The same values: nothing to record.
      expect((await setRules(a.cookie, STARTING).expect(200)).body).toEqual({
        rules: STARTING,
      });
      expect(await changes(a.id)).toHaveLength(before.length);

      const next = rulesWith({
        moderate: { triageWithinHours: 36 },
        death: { triageWithinHours: 12, closeWithinDays: 60 },
      });
      // Sent in another order: it is the levels that matter.
      const saved = await setRules(a.cookie, [...next].reverse()).expect(200);
      expect(saved.body).toEqual({ rules: next });
      expect((await rulesOf(wardQuality.cookie)).body).toEqual({ rules: next });
      expect((await changes(a.id)).slice(before.length)).toEqual([
        {
          actor_id: a.adminId,
          entity_type: 'tenant',
          entity_id: a.id,
          changes: {
            moderate: { triageWithinHours: { from: 48, to: 36 } },
            death: {
              triageWithinHours: { from: 24, to: 12 },
              closeWithinDays: { from: 45, to: 60 },
            },
          },
        },
      ]);
      // Back again, recorded again, with what it was.
      await setRules(a.cookie, STARTING).expect(200);
      expect((await changes(a.id)).at(-1)?.changes).toEqual({
        moderate: { triageWithinHours: { from: 36, to: 48 } },
        death: {
          triageWithinHours: { from: 12, to: 24 },
          closeWithinDays: { from: 60, to: 45 },
        },
      });
      // Nothing of this reached another hospital.
      expect(await changes(riyadh.id)).toEqual([]);
      expect((await rulesOf(riyadh.cookie)).body).toEqual({ rules: STARTING });
    });

    it('still give a report its deadlines if a hospital has lost a rule', async () => {
      // Not something the application can do: it has no right to delete one.
      await bench.owner.db.execute(
        sql`delete from incident_response_rules where tenant_id = ${riyadh.id} and harm_level = 'none'`,
      );
      try {
        expect((await rulesOf(riyadh.cookie)).body).toEqual({
          rules: STARTING,
        });
        const { id } = await reportIn(riyadh, riyadh.cookie, riyadhUnit);
        const row = await stored(id);
        expect(row.triage_due_at!.getTime() - row.reported_at.getTime()).toBe(
          72 * HOUR,
        );
        expect(row.close_due_at).not.toBeNull();
      } finally {
        // Saving the rules puts the missing one back.
        await setRules(
          riyadh.cookie,
          rulesWith({ none: { triageWithinHours: 71 } }),
        ).expect(200);
        await setRules(riyadh.cookie, STARTING).expect(200);
      }
      const rows = await bench.owner.db.execute(
        sql`select 1 from incident_response_rules where tenant_id = ${riyadh.id}`,
      );
      expect(rows.rows).toHaveLength(5);
    });
  });

  describe('the two deadlines of an incident', () => {
    it('are set when it is reported, from the harm level the reporter gave', async () => {
      for (const [harmLevel, hours, days] of [
        ['none', 72, 30],
        ['mild', 72, 30],
        ['moderate', 48, 30],
        ['severe', 24, 45],
        ['death', 24, 45],
      ] as const) {
        const { id } = await report(reporter, { harmLevel });
        const res = await open(quality.cookie, id).expect(200);
        const reportedAt = Date.parse(res.body.reportedAt);
        expect([
          harmLevel,
          Date.parse(res.body.triageDueAt) - reportedAt,
          Date.parse(res.body.closeDueAt) - reportedAt,
          res.body.overdue,
        ]).toEqual([harmLevel, hours * HOUR, days * DAY, null]);
      }
      // A near miss harmed nobody: the rule for no harm.
      const near = await report(reporter, { type: 'near_miss' });
      const row = await stored(near.id);
      expect(row.triage_due_at!.getTime() - row.reported_at.getTime()).toBe(
        72 * HOUR,
      );
    });

    it('are set for an anonymous report and for one through the public link too', async () => {
      const anonymous = await report(reporter, { anonymous: true });
      const row = await stored(anonymous.id);
      expect(row.triage_due_at!.getTime() - row.reported_at.getTime()).toBe(
        72 * HOUR,
      );
      expect(row.close_due_at!.getTime() - row.reported_at.getTime()).toBe(
        30 * DAY,
      );
      await http()
        .put('/settings/reporting')
        .set('Cookie', b.cookie)
        .send({ publicReporting: true })
        .expect(200);
      await http()
        .post(`/public/reporting/${b.slug}`)
        .send({
          type: 'incident',
          categoryId: b.categories.equipment,
          orgUnitId: bUnit,
          occurredAt: new Date(Date.now() - HOUR).toISOString(),
          description: 'Reported from the corridor.',
          harmLevel: 'severe',
        })
        .expect(201);
      const sent = await bench.owner.db.execute<{
        id: string;
      }>(
        sql`select id from incidents where tenant_id = ${b.id} and channel = 'public'`,
      );
      expect(sent.rows).toHaveLength(1);
      // Hospital B allows itself 24 hours and 45 days for severe harm.
      const taken = await stored(sent.rows[0].id);
      expect(taken.triage_due_at!.getTime() - taken.reported_at.getTime()).toBe(
        24 * HOUR,
      );
      expect(taken.close_due_at!.getTime() - taken.reported_at.getTime()).toBe(
        45 * DAY,
      );
    });

    it('are for those handling it: its reporter is not told them, anywhere', async () => {
      const { id } = await report(reporter);
      await age(id, 80 * HOUR); // past its triage deadline
      const theirs = await open(reporter.cookie, id).expect(200);
      expect(theirs.body).toMatchObject({
        access: 'reporter',
        triageDueAt: null,
        closeDueAt: null,
        overdue: null,
      });
      const listed = (await listOf(reporter.cookie, '&mine=true')).items.find(
        (i) => i.id === id,
      );
      expect(listed).toMatchObject({
        triageDueAt: null,
        closeDueAt: null,
        overdue: null,
      });
      // Nor by asking for what is overdue, by counting it, or by the order.
      expect(
        (await listOf(reporter.cookie, '&overdue=true')).items.map((i) => i.id),
      ).not.toContain(id);
      expect((await listOf(reporter.cookie, '&overdue=true')).total).toBe(0);
      expect(await summaryOf(reporter.cookie)).toMatchObject({
        overdue: 0,
        triagedOnTime: null,
      });
      const newest = await listOf(reporter.cookie);
      const byDue = await listOf(reporter.cookie, '&sort=due');
      expect(byDue.items.map((i) => i.id)).toEqual(
        newest.items.map((i) => i.id),
      );
      // The handlers are told.
      for (const who of [quality, wardQuality, manager]) {
        const seen = await open(who.cookie, id).expect(200);
        expect(seen.body.overdue).toBe('triage');
        expect(seen.body.triageDueAt).toBeTruthy();
      }
      await triage(quality.cookie, id).expect(200);
    });

    it('keep the triage deadline and count the closing one again when triage changes the gravity', async () => {
      const { id } = await report(reporter, { harmLevel: 'none' });
      const before = await stored(id);
      // Raised to severe: 45 days to close instead of 30, still counted from
      // the report. The time to triage stays the one it was triaged within.
      const raised = await triage(quality.cookie, id, {
        harmLevel: 'severe',
      }).expect(200);
      const at = before.reported_at.getTime();
      expect(Date.parse(raised.body.triageDueAt) - at).toBe(72 * HOUR);
      expect(Date.parse(raised.body.closeDueAt) - at).toBe(45 * DAY);
      // A sentinel event takes the rule for a death, whatever its harm.
      await setRules(
        a.cookie,
        rulesWith({ death: { closeWithinDays: 10 } }),
      ).expect(200);
      try {
        const flagged = await triage(quality.cookie, id, {
          harmLevel: 'mild',
          isSentinel: true,
        }).expect(200);
        expect(Date.parse(flagged.body.closeDueAt) - at).toBe(10 * DAY);
        // No longer sentinel: back to the rule for its harm level.
        const cleared = await triage(quality.cookie, id, {
          harmLevel: 'mild',
          isSentinel: false,
        }).expect(200);
        expect(Date.parse(cleared.body.closeDueAt) - at).toBe(30 * DAY);
        // A triage that leaves the gravity alone leaves the deadline alone,
        // also when the rules have changed since it was set.
        await setRules(
          a.cookie,
          rulesWith({ mild: { closeWithinDays: 5 } }),
        ).expect(200);
        const handed = await triage(quality.cookie, id, {
          harmLevel: 'mild',
          ownerUnitId: lab,
        }).expect(200);
        expect(Date.parse(handed.body.closeDueAt) - at).toBe(30 * DAY);
      } finally {
        await setRules(a.cookie, STARTING).expect(200);
      }
      expect((await stored(id)).triage_due_at).toEqual(before.triage_due_at);
    });

    it('do not move when the rules change, which count for reports made from then on', async () => {
      const old = await report(reporter, { harmLevel: 'moderate' });
      const before = await stored(old.id);
      await setRules(
        a.cookie,
        rulesWith({ moderate: { triageWithinHours: 6, closeWithinDays: 7 } }),
      ).expect(200);
      try {
        const after = await stored(old.id);
        expect(after.triage_due_at).toEqual(before.triage_due_at);
        expect(after.close_due_at).toEqual(before.close_due_at);
        const fresh = await report(reporter, { harmLevel: 'moderate' });
        const row = await stored(fresh.id);
        expect(row.triage_due_at!.getTime() - row.reported_at.getTime()).toBe(
          6 * HOUR,
        );
        expect(row.close_due_at!.getTime() - row.reported_at.getTime()).toBe(
          7 * DAY,
        );
      } finally {
        await setRules(a.cookie, STARTING).expect(200);
      }
    });
  });

  describe('overdue', () => {
    it('is worked out when the incident is read, from its status and the clock', async () => {
      const { id } = await report(reporter);
      const seen = async () => {
        const detail = (await open(quality.cookie, id).expect(200)).body;
        const item = (await listOf(quality.cookie)).items.find(
          (i) => i.id === id,
        );
        // The list and the incident itself always say the same.
        expect(item).toMatchObject({
          overdue: detail.overdue,
          triageDueAt: detail.triageDueAt,
          closeDueAt: detail.closeDueAt,
        });
        return detail.overdue as string | null;
      };
      expect(await seen()).toBeNull();
      // 71 hours old: an hour to go.
      await age(id, 71 * HOUR);
      expect(await seen()).toBeNull();
      // 73 hours old and still new: overdue for triage.
      await age(id, 2 * HOUR);
      expect(await seen()).toBe('triage');
      // Triaged, late: the triage deadline no longer matters, and there are
      // still days to close it in.
      await triage(quality.cookie, id).expect(200);
      expect(await seen()).toBeNull();
      await move(quality.cookie, id, 'in_progress').expect(200);
      expect(await seen()).toBeNull();
      // 31 days old and being worked on: overdue for closure.
      await age(id, 28 * DAY);
      expect(await seen()).toBe('closure');
      // Closed, late: nothing left to be late for.
      await move(quality.cookie, id, 'closed', 'Done.').expect(200);
      expect(await seen()).toBeNull();
      // Reopened: a new deadline, counted from the reopening, so not overdue
      // at once (second quality review, question 9).
      const before = await stored(id);
      const reopenedAt = Date.now();
      await move(quality.cookie, id, 'in_progress', 'Not done.').expect(200);
      expect(await seen()).toBeNull();
      const after = await stored(id);
      expect(after.close_due_at).not.toEqual(before.close_due_at);
      // Thirty days on the hospital's calendar from the reopening.
      expect(after.close_due_at!.getTime() - reopenedAt).toBeGreaterThan(
        30 * DAY - 5_000,
      );
      expect(after.close_due_at!.getTime() - reopenedAt).toBeLessThan(
        30 * DAY + 5_000,
      );
      // Thirty-one days after the reopening, overdue again.
      await bench.owner.db.execute(
        sql`update incidents set close_due_at = close_due_at - interval '31 days' where id = ${id}`,
      );
      expect(await seen()).toBe('closure');
      // Nothing of this was ever stored as a fact about the incident.
      const columns = await bench.owner.db.execute<{ column_name: string }>(
        sql`select column_name from information_schema.columns where table_name = 'incidents' and column_name like '%overdue%'`,
      );
      // (When it was announced, and for which deadline: not whether it is.)
      expect(columns.rows.map((c) => c.column_name).sort()).toEqual([
        'close_overdue_at',
        'close_overdue_for',
        'triage_overdue_at',
      ]);
    });

    it('covers an incident awaiting sign-off, and one set aside is never overdue', async () => {
      const waiting = await report(reporter, { harmLevel: 'death' });
      await triage(quality.cookie, waiting.id, { harmLevel: 'death' }).expect(
        200,
      );
      await move(
        quality.cookie,
        waiting.id,
        'awaiting_sign_off',
        'Reviewed.',
      ).expect(200);
      await age(waiting.id, 46 * DAY);
      expect((await open(quality.cookie, waiting.id)).body).toMatchObject({
        status: 'awaiting_sign_off',
        overdue: 'closure',
      });
      const aside = await report(reporter);
      await move(
        quality.cookie,
        aside.id,
        'rejected',
        'Not an incident.',
      ).expect(200);
      await age(aside.id, 400 * DAY);
      expect((await open(quality.cookie, aside.id)).body.overdue).toBeNull();
    });

    it('is a filter and a count that agree, for every kind of caller', async () => {
      // Something overdue in the ward and in the laboratory, for triage and
      // for closure, and one assigned to the nurse.
      const wardNew = await report(reporter);
      const labNew = await report(reporter, { orgUnitId: lab });
      const assigned = await report(reporter, { orgUnitId: lab });
      await triage(quality.cookie, assigned.id, {
        ownerUnitId: lab,
        assignedTo: nurse.id,
      }).expect(200);
      const notDue = await report(reporter);
      for (const { id } of [wardNew, labNew]) await age(id, 100 * HOUR);
      await age(assigned.id, 40 * DAY);

      for (const who of [quality, wardQuality, manager, nurse, reporter, a]) {
        const listed = await listOf(who.cookie, '&overdue=true');
        const summary = await summaryOf(who.cookie);
        expect(listed.total).toBe(summary.overdue);
        expect(listed.items).toHaveLength(listed.total);
        expect(listed.items.every((i) => i.overdue !== null)).toBe(true);
        // Inside what they may see, and never one they see as reporter only.
        const visible = (await listOf(who.cookie)).items;
        const expected = visible.filter((i) => i.overdue !== null);
        expect(listed.items.map((i) => i.id).sort()).toEqual(
          expected.map((i) => i.id).sort(),
        );
        // With another filter on top, still inside it.
        const both = await listOf(who.cookie, '&overdue=true&status=new');
        expect(both.items.map((i) => i.id).sort()).toEqual(
          expected
            .filter((i) => i.status === 'new')
            .map((i) => i.id)
            .sort(),
        );
        expect(both.total).toBe(both.items.length);
      }
      const ids = async (who: { cookie: string }) =>
        (await listOf(who.cookie, '&overdue=true')).items.map((i) => i.id);
      expect(await ids(quality)).toEqual(
        expect.arrayContaining([wardNew.id, labNew.id, assigned.id]),
      );
      expect(await ids(quality)).not.toContain(notDue.id);
      // The ward's quality officer: the ward's, not the laboratory's.
      expect(await ids(wardQuality)).toContain(wardNew.id);
      expect(await ids(wardQuality)).not.toContain(labNew.id);
      expect(await ids(wardQuality)).not.toContain(assigned.id);
      // The nurse: the one assigned to them, and nothing else.
      expect(await ids(nurse)).toEqual([assigned.id]);
      expect((await summaryOf(nurse.cookie)).overdue).toBe(1);
      // The reporter of all four: none.
      expect(await ids(reporter)).toEqual([]);
      // `false` and nothing mean the filter is not set.
      expect((await listOf(quality.cookie, '&overdue=false')).total).toBe(
        (await listOf(quality.cookie)).total,
      );
      for (const query of ['overdue=1', 'overdue=yes', 'sort=deadline']) {
        await http()
          .get(`/incidents?${query}`)
          .set('Cookie', quality.cookie)
          .expect(400);
      }
    });

    it('comes first when the list is in order of deadline', async () => {
      const listed = await listOf(quality.cookie, '&sort=due');
      expect(listed.total).toBe((await listOf(quality.cookie)).total);
      const live = (i: Item) =>
        i.status === 'new'
          ? i.triageDueAt
          : ['triaged', 'in_progress', 'awaiting_sign_off'].includes(i.status)
            ? i.closeDueAt
            : null;
      const due = listed.items.map(live);
      const withOne = due.filter((d) => d !== null);
      // Those with a deadline to meet, nearest first; then the rest.
      expect(due.slice(0, withOne.length)).toEqual(withOne);
      expect(withOne.length).toBeGreaterThan(5);
      expect(withOne.length).toBeLessThan(due.length);
      expect(withOne).toEqual(
        [...withOne].sort((x, y) => Date.parse(x) - Date.parse(y)),
      );
      // So everything overdue is at the top, the longest overdue first.
      const marks = listed.items.map((i) => i.overdue !== null);
      const overdue = marks.filter(Boolean).length;
      expect(overdue).toBeGreaterThan(2);
      expect(marks.slice(0, overdue).every(Boolean)).toBe(true);
      expect(marks.slice(overdue).some(Boolean)).toBe(false);
      // Page by page it is the same order.
      const pages = [];
      for (let page = 1; (page - 1) * 7 < listed.total; page++) {
        const res = await http()
          .get(`/incidents?sort=due&pageSize=7&page=${page}`)
          .set('Cookie', quality.cookie)
          .expect(200);
        expect(res.body.total).toBe(listed.total);
        pages.push(...(res.body.items as Item[]).map((i) => i.id));
      }
      expect(pages).toEqual(listed.items.map((i) => i.id));
    });
  });

  describe('triaged on time', () => {
    let t: Hospital;
    let unit: string;
    const fresh = (overrides: Record<string, unknown> = {}) =>
      reportIn(t, t.cookie, unit, overrides);
    const triaged = (id: string, overrides: Record<string, unknown> = {}) =>
      triage(t.cookie, id, { ownerUnitId: unit, ...overrides });
    const share = async () => (await summaryOf(t.cookie)).triagedOnTime;

    beforeAll(async () => {
      t = await bench.createHospital('ontime');
      unit = await bench.createUnit(t, 'facility', 'MAIN', null);
    });

    it('is the share of the triaged reports of the last 30 days whose first triage met its deadline', async () => {
      expect(await share()).toBeNull();
      // Reported and not yet triaged: not counted either way.
      await fresh();
      expect(await share()).toBeNull();

      const first = await fresh();
      await triaged(first.id).expect(200);
      expect(await share()).toBe(100);

      // Triaged after 80 hours, where 72 were allowed.
      const late = await fresh();
      await age(late.id, 80 * HOUR);
      await triaged(late.id).expect(200);
      expect(await share()).toBe(50);

      const third = await fresh();
      await triaged(third.id).expect(200);
      // Two of three: a whole percentage.
      expect(await share()).toBe(67);
      const fourth = await fresh();
      await triaged(fourth.id).expect(200);
      expect(await share()).toBe(75);

      // Set aside without triage: decided on as much, so it counts as
      // triaged at that moment, against the same deadline (second quality
      // review, question 8). Four of five.
      const aside = await fresh();
      await move(t.cookie, aside.id, 'rejected', 'Not an incident.').expect(
        200,
      );
      expect((await stored(aside.id)).first_triaged_at).not.toBeNull();
      expect(await share()).toBe(80);
      // Set aside late, it is late.
      const asideLate = await fresh();
      await age(asideLate.id, 73 * HOUR);
      await move(t.cookie, asideLate.id, 'rejected', 'Duplicate.').expect(200);
      expect(await share()).toBe(67);
      // Still waiting for triage past its deadline: late already, whenever
      // it comes, and counted as such. Four of seven.
      const waiting = await fresh();
      await age(waiting.id, 71 * HOUR);
      expect(await share()).toBe(67);
      await age(waiting.id, 2 * HOUR);
      expect(await share()).toBe(57);
      // Triaged at last, it stays late, and is counted once.
      await triaged(waiting.id).expect(200);
      expect(await share()).toBe(57);
      // Closing or reopening changes nothing about when it was triaged.
      await move(t.cookie, first.id, 'closed', 'Done.').expect(200);
      await move(t.cookie, first.id, 'in_progress', 'Again.').expect(200);
      expect(await share()).toBe(57);
    });

    it('is measured on the first triage, against the deadline it was made under', async () => {
      const before = await share();
      // Triaged in time, and corrected long after: still in time.
      const corrected = await fresh();
      await triaged(corrected.id).expect(200);
      await age(corrected.id, 10 * DAY);
      await triaged(corrected.id, { harmLevel: 'mild' }).expect(200);
      const row = await stored(corrected.id);
      expect(row.first_triaged_at!.getTime()).toBeLessThan(
        row.triage_due_at!.getTime(),
      );
      // Triaged late, and lowered in the same breath to a level with more
      // time: late it was, and late it stays. The person being measured
      // cannot move the mark.
      const lowered = await fresh({ harmLevel: 'severe' });
      await age(lowered.id, 30 * HOUR); // 24 were allowed
      await triaged(lowered.id, { harmLevel: 'none' }).expect(200);
      const late = await stored(lowered.id);
      expect(late.triage_due_at!.getTime() - late.reported_at.getTime()).toBe(
        24 * HOUR,
      );
      expect(late.first_triaged_at!.getTime()).toBeGreaterThan(
        late.triage_due_at!.getTime(),
      );
      // Triaged in time and raised to a level with less: in time it was.
      const raised = await fresh({ harmLevel: 'none' });
      await age(raised.id, 30 * HOUR); // 72 were allowed
      await triaged(raised.id, { harmLevel: 'death' }).expect(200);
      // Before: 4 of 7. Now 6 of 10.
      expect(before).toBe(57);
      expect(await share()).toBe(60);
    });

    it('leaves out what was reported more than 30 days ago', async () => {
      const old = await fresh();
      await age(old.id, 80 * HOUR);
      await triaged(old.id).expect(200);
      // 6 of 11.
      expect(await share()).toBe(55);
      await age(old.id, 31 * DAY);
      expect(await share()).toBe(60);
    });
  });

  describe("the hospital's own day", () => {
    const todayIn = (timeZone: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    /** Midnight of a day in Riyadh, which is three hours ahead all year. */
    const riyadhMidnight = (day: string) =>
      Date.parse(`${day}T00:00:00Z`) - 3 * HOUR;
    const placeAt = (id: string, moment: number) =>
      bench.owner.db.execute(
        sql`update incidents set reported_at = ${new Date(moment).toISOString()}::timestamptz where id = ${id}`,
      );
    const found = async (query: string) =>
      (await listOf(riyadh.cookie, query)).items.map((i) => i.id);

    it('is told to the screens with the session', async () => {
      const me = async (hospital: Hospital) =>
        (
          await http()
            .get('/auth/me')
            .set('Cookie', hospital.cookie)
            .expect(200)
        ).body.tenant.timeZone as string;
      expect(await me(a)).toBe('UTC');
      expect(await me(riyadh)).toBe('Asia/Riyadh');
      expect(await me(beirut)).toBe('Asia/Beirut');
    });

    it('is the day the list filters by, on either side of midnight there', async () => {
      const before = await reportIn(riyadh, riyadh.cookie, riyadhUnit);
      const after = await reportIn(riyadh, riyadh.cookie, riyadhUnit);
      const end = await reportIn(riyadh, riyadh.cookie, riyadhUnit);
      // One second before midnight on 10 March in Riyadh, the stroke of
      // midnight, and the last second of the 10th. In UTC the first two are
      // both on the evening of the 9th.
      const midnight = riyadhMidnight('2026-03-10');
      expect(new Date(midnight).toISOString()).toBe('2026-03-09T21:00:00.000Z');
      await placeAt(before.id, midnight - 1000);
      await placeAt(after.id, midnight);
      await placeAt(end.id, midnight + DAY - 1000);

      expect(await found('&from=2026-03-10&to=2026-03-10')).toEqual(
        expect.arrayContaining([after.id, end.id]),
      );
      expect(await found('&from=2026-03-10&to=2026-03-10')).not.toContain(
        before.id,
      );
      expect(await found('&from=2026-03-09&to=2026-03-09')).toEqual([
        before.id,
      ]);
      expect(await found('&to=2026-03-09')).toEqual([before.id]);
      expect(await found('&from=2026-03-11&to=2026-03-11')).toEqual([]);
      expect((await found('&from=2026-03-09&to=2026-03-10')).sort()).toEqual(
        [before.id, after.id, end.id].sort(),
      );
      // The totals follow.
      expect(
        (await listOf(riyadh.cookie, '&from=2026-03-10&to=2026-03-10')).total,
      ).toBe(2);
    });

    it('is not the day in UTC: the same moments fall on other days for a hospital there', async () => {
      const one = await report(reporter);
      const other = await report(reporter);
      const midnight = riyadhMidnight('2026-03-10');
      await placeAt(one.id, midnight - 1000);
      await placeAt(other.id, midnight);
      const ids = async (query: string) =>
        (await listOf(quality.cookie, query)).items.map((i) => i.id);
      // Both on the 9th for a hospital on UTC.
      expect((await ids('&from=2026-03-09&to=2026-03-09')).sort()).toEqual(
        [one.id, other.id].sort(),
      );
      expect(await ids('&from=2026-03-10&to=2026-03-10')).toEqual([]);
    });

    it('is what "the last 30 days" are counted in', async () => {
      const summary = await summaryOf(riyadh.cookie);
      const today = todayIn('Asia/Riyadh');
      const first = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * DAY)
        .toISOString()
        .slice(0, 10);
      expect(summary.last30Days).toEqual({ from: first, to: today });
      // The list takes those days as they are given.
      const since = riyadhMidnight(first);
      const inside = await reportIn(riyadh, riyadh.cookie, riyadhUnit);
      const outside = await reportIn(riyadh, riyadh.cookie, riyadhUnit);
      for (const { id } of [inside, outside]) {
        await triage(riyadh.cookie, id, { ownerUnitId: riyadhUnit }).expect(
          200,
        );
        await move(riyadh.cookie, id, 'closed', 'Done.').expect(200);
      }
      const start = await summaryOf(riyadh.cookie);
      // Closed at the first moment of those 30 days, and the moment before.
      await bench.owner.db.execute(
        sql`update incidents set closed_at = ${new Date(since).toISOString()}::timestamptz, reported_at = ${new Date(since).toISOString()}::timestamptz where id = ${inside.id}`,
      );
      await bench.owner.db.execute(
        sql`update incidents set closed_at = ${new Date(since - 1).toISOString()}::timestamptz, reported_at = ${new Date(since - 1).toISOString()}::timestamptz where id = ${outside.id}`,
      );
      const moved = await summaryOf(riyadh.cookie);
      expect(moved.closedLast30Days).toBe(start.closedLast30Days - 1);
      const listed = await found(`&status=closed&from=${first}&to=${today}`);
      expect(listed).toContain(inside.id);
      expect(listed).not.toContain(outside.id);
    });

    it('is the calendar a deadline in days is counted on, through a change of the clocks', async () => {
      // Lebanon changes its clocks twice a year, so a deadline 200 days off
      // always lies on the other side of at least one change. It falls at
      // the same time of day there, not a whole number of 24 hours on.
      await setRules(
        beirut.cookie,
        rulesWith({ none: { closeWithinDays: 200 } }),
      ).expect(200);
      const { id } = await reportIn(beirut, beirut.cookie, beirutUnit);
      const row = await stored(id);
      const there = (moment: Date) => {
        const parts = Object.fromEntries(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Beirut',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
          })
            .formatToParts(moment)
            .map((p) => [p.type, p.value]),
        );
        return {
          day: Date.UTC(+parts.year, +parts.month - 1, +parts.day),
          time: `${parts.hour}:${parts.minute}:${parts.second}`,
        };
      };
      const reported = there(row.reported_at);
      const due = there(row.close_due_at!);
      expect(due.day - reported.day).toBe(200 * DAY);
      const elapsed = row.close_due_at!.getTime() - row.reported_at.getTime();
      // Unless the report was made in an hour the clocks skip or repeat.
      if (due.time === reported.time) {
        expect(Math.abs(elapsed - 200 * DAY)).toBeLessThanOrEqual(HOUR);
      }
      expect(due.time).toBe(reported.time);
      // Hours are hours on the clock, wherever the hospital is.
      expect(row.triage_due_at!.getTime() - row.reported_at.getTime()).toBe(
        72 * HOUR,
      );
    });
  });

  describe("a hospital's time zone", () => {
    const tenant = (settings: Record<string, unknown>, suffix: string) =>
      http()
        .post('/platform/tenants')
        .set('Cookie', bench.platform)
        .send({
          slug: `${bench.prefix}-${suffix}`,
          name: { en: `Zone ${suffix}` },
          accreditationStandard: 'JCI',
          locales: ['en'],
          defaultLocale: 'en',
          signInMethod: 'password',
          dataRegion: null,
          ...settings,
        });
    const patch = (id: string, body: unknown) =>
      http()
        .patch(`/platform/tenants/${id}`)
        .set('Cookie', bench.platform)
        .send(body as object);

    it('is UTC unless Trustline staff say otherwise when creating the client', async () => {
      const plain = await tenant({}, 'tz-plain').expect(201);
      expect(plain.body.timeZone).toBe('UTC');
      const placed = await tenant(
        { timeZone: 'Africa/Casablanca' },
        'tz-placed',
      ).expect(201);
      expect(placed.body.timeZone).toBe('Africa/Casablanca');
      const read = await http()
        .get(`/platform/tenants/${placed.body.id}`)
        .set('Cookie', bench.platform)
        .expect(200);
      expect(read.body.timeZone).toBe('Africa/Casablanca');
    });

    it('must be a name the runtime knows, on creating and on editing', async () => {
      for (const [i, timeZone] of [
        'Mars/Olympus',
        '+03:00',
        'UTC+3',
        'EST',
        'Riyadh',
        '',
      ].entries()) {
        const res = await tenant({ timeZone }, `tz-bad-${i}`).expect(400);
        expect([timeZone, res.body.code]).toEqual([
          timeZone,
          'unknown_time_zone',
        ]);
        const edited = await patch(a.id, { timeZone }).expect(400);
        expect(edited.body.code).toBe('unknown_time_zone');
      }
      for (const timeZone of [3, null, ['Asia/Riyadh'], 'x'.repeat(65)]) {
        await patch(a.id, { timeZone }).expect(400);
      }
      const none = await bench.owner.db.execute(
        sql`select 1 from tenants where slug like ${`${bench.prefix}-tz-bad-%`}`,
      );
      expect(none.rows).toEqual([]);
      expect(
        (await http().get('/auth/me').set('Cookie', a.cookie).expect(200)).body
          .tenant.timeZone,
      ).toBe('UTC');
    });

    it('is changed by Trustline staff, with what it was, and never by the hospital', async () => {
      const created = await tenant({}, 'tz-moved').expect(201);
      const moved = await patch(created.body.id, {
        timeZone: 'Asia/Dubai',
      }).expect(200);
      expect(moved.body.timeZone).toBe('Asia/Dubai');
      const log = await bench.owner.db.execute<{
        action: string;
        details: unknown;
      }>(
        sql`select action, details from platform_audit_log where target_tenant_id = ${created.body.id} order by created_at`,
      );
      expect(log.rows.at(-1)).toEqual({
        action: 'client_updated',
        details: {
          changes: { timeZone: { from: 'UTC', to: 'Asia/Dubai' } },
        },
      });
      // No route of the hospital's own takes it.
      for (const [method, path] of [
        ['put', '/settings/reporting'],
        ['put', '/settings/response-rules'],
      ] as const) {
        await http()
          [method](path)
          .set('Cookie', a.cookie)
          .send({ timeZone: 'Asia/Dubai' })
          .expect(400);
      }
      await http()
        .put('/settings/reporting')
        .set('Cookie', a.cookie)
        .send({ publicReporting: false, timeZone: 'Asia/Dubai' })
        .expect(400);
      await http()
        .patch(`/platform/tenants/${a.id}`)
        .set('Cookie', a.cookie)
        .send({ timeZone: 'Asia/Dubai' })
        .expect(401);
    });
  });
});
