import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/app.setup.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { AccessService } from '../src/identity/access.service.js';
import type { Permission } from '../src/identity/permissions.js';
import { covers, type Scope } from '../src/identity/scope.js';
import { DeadlineCheck } from '../src/incidents/deadline-check.service.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Section 5 of docs/specs/incident-safeguards-and-deadlines.md: who is told
 * what, that nobody is told who may not see the incident, a user's own
 * notifications, and the background check for deadlines.
 */
describe('notifications', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();

  let a: Hospital;
  let b: Hospital; // another hospital, with one notification of its own

  let facility: string;
  let ward: string;
  let ward3: string; // a unit of the ward
  let lab: string;

  let reporter: Staff; // may report, and nothing else
  let nurse: Staff; // the same; gets incidents assigned
  let manager: Staff; // department manager everywhere: sees all, triages nothing
  let quality: Staff; // quality officer everywhere
  let quality2: Staff; // another
  let wardQuality: Staff; // quality officer for the ward and what is under it
  let labQuality: Staff; // quality officer for the laboratory
  let unitTriage: Staff; // views and triages for the one unit of the ward
  let signBlind: Staff; // may sign off everywhere, but sees no incident
  let invited: Staff; // quality officer everywhere who never set a password
  let gone: Staff; // quality officer everywhere, account switched off
  let admin: Staff; // the hospital's administrator: holds every right

  /** Everyone, by id, so that a failure names people and not ids. */
  const names = new Map<string, string>();
  const everyone = () => [
    reporter,
    nurse,
    manager,
    quality,
    quality2,
    wardQuality,
    labQuality,
    unitTriage,
    signBlind,
    admin,
  ];

  type Row = {
    id: string;
    user_id: string;
    kind: string;
    data: Record<string, string>;
    read_at: string | null;
  };
  const rowsFor = async (incidentId: string) =>
    (
      await bench.owner.db.execute<Row>(
        sql`select id, user_id, kind, data, read_at from notifications where incident_id = ${incidentId} order by created_at, id`,
      )
    ).rows;
  /** Who was told what about an incident: `kind` to the names, in order. */
  const told = async (incidentId: string) => {
    const byKind: Record<string, string[]> = {};
    for (const row of await rowsFor(incidentId)) {
      (byKind[row.kind] ??= []).push(names.get(row.user_id) ?? row.user_id);
    }
    for (const list of Object.values(byKind)) list.sort();
    return byKind;
  };
  const sorted = (...people: Staff[]) => people.map((p) => p.name).sort();
  /** The names of these people, in the same order as `sorted()` gives. */
  const named = (ids: Iterable<string>) =>
    [...ids].map((id) => names.get(id) ?? id).sort();
  /** Forgets what was sent so far, so a test reads only what follows. */
  const clear = (incidentId: string) =>
    bench.owner.db.execute(
      sql`delete from notifications where incident_id = ${incidentId}`,
    );

  /**
   * The rule under all the others: everyone told about an incident could
   * open it. Checked through the API, as each of them.
   */
  const expectAllCouldOpen = async (incidentId: string) => {
    const rows = await rowsFor(incidentId);
    for (const userId of new Set(rows.map((r) => r.user_id))) {
      const person = everyone().find((p) => p.id === userId);
      expect([names.get(userId), person !== undefined]).toEqual([
        names.get(userId),
        true,
      ]);
      await http()
        .get(`/incidents/${incidentId}`)
        .set('Cookie', person!.cookie)
        .expect(200);
    }
    return rows.length;
  };

  const reportBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'incident',
    categoryId: a.categories.equipment,
    orgUnitId: ward3,
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

  const triage = (
    who: Staff,
    id: string,
    overrides: Record<string, unknown> = {},
  ) =>
    http()
      .post(`/incidents/${id}/triage`)
      .set('Cookie', who.cookie)
      .send({
        harmLevel: 'none',
        isSentinel: false,
        ownerUnitId: ward,
        ...overrides,
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

  const comment = (who: Staff, id: string, body: string, visibility: string) =>
    http()
      .post(`/incidents/${id}/comments`)
      .set('Cookie', who.cookie)
      .send({ body, visibility });

  const inbox = async (who: Staff, query = '') =>
    (
      await http()
        .get(`/notifications?pageSize=100${query}`)
        .set('Cookie', who.cookie)
        .expect(200)
    ).body as {
      total: number;
      items: {
        id: string;
        kind: string;
        createdAt: string;
        readAt: string | null;
        incident: { id: string; reference: string; canOpen: boolean };
        data: Record<string, string>;
      }[];
    };
  const unread = async (who: Staff) =>
    (
      await http()
        .get('/notifications/count')
        .set('Cookie', who.cookie)
        .expect(200)
    ).body.unread as number;

  beforeAll(async () => {
    bench = await testBench('nt', run);
    a = await bench.createHospital('a');
    b = await bench.createHospital('b');

    facility = await bench.createUnit(a, 'facility', 'MAIN', null);
    ward = await bench.createUnit(a, 'department', 'WARD', facility);
    ward3 = await bench.createUnit(a, 'unit', 'WARD-3', ward);
    lab = await bench.createUnit(a, 'department', 'LAB', facility);

    await bench.createRole(a, 'triage_only', [
      'incidents.view',
      'incidents.triage',
    ]);
    await bench.createRole(a, 'sign_blind', ['incidents.sign_off']);

    const everywhere = (role: string) => ({ role, orgUnitId: null });
    const staff = (
      name: string,
      role: string,
      orgUnitId: string | null = null,
    ) => bench.createStaff(a, name, { role, orgUnitId });
    reporter = await staff('reporter', 'reporter');
    nurse = await staff('nurse', 'reporter');
    manager = await staff('manager', 'department_manager');
    quality = await staff('quality', 'quality_officer');
    quality2 = await staff('quality2', 'quality_officer');
    wardQuality = await staff('ward-quality', 'quality_officer', ward);
    labQuality = await staff('lab-quality', 'quality_officer', lab);
    unitTriage = await staff('unit-triage', 'triage_only', ward3);
    signBlind = await staff('sign-blind', 'sign_blind');
    invited = await bench.createStaff(
      a,
      'invited',
      everywhere('quality_officer'),
      { signIn: false },
    );
    gone = await staff('gone', 'quality_officer');
    await http()
      .patch(`/users/${gone.id}`)
      .set('Cookie', a.cookie)
      .send({ status: 'disabled' })
      .expect(200);
    admin = {
      id: a.adminId,
      email: '',
      name: 'Admin a',
      cookie: a.cookie,
    };
    for (const person of [...everyone(), invited, gone]) {
      names.set(person.id, person.name);
    }
  }, 180_000);

  afterAll(() => bench.close());

  describe('who may triage a unit, worked out for everyone at once', () => {
    it('agrees with what each person is told about their own rights when they sign in', async () => {
      const access = bench.app.get(AccessService, { strict: false });
      const tenantDb = bench.app.get(TenantDb, { strict: false });
      const permissions: Permission[] = [
        'incidents.view',
        'incidents.triage',
        'incidents.sign_off',
        'incidents.see_reporter',
        'settings.manage',
      ];
      const units = [facility, ward, ward3, lab];
      const holders = await tenantDb.withTenant(a.id, (tx) =>
        access.holders(tx, permissions, units),
      );
      let compared = 0;
      for (const person of everyone()) {
        const me = await http()
          .get('/auth/me')
          .set('Cookie', person.cookie)
          .expect(200);
        const scope = { scope: me.body.scope as Scope };
        for (const permission of permissions) {
          for (const unit of units) {
            expect([
              person.name,
              permission,
              unit,
              holders.of(permission, [unit]).has(person.id),
            ]).toEqual([
              person.name,
              permission,
              unit,
              covers(scope, permission, unit),
            ]);
            compared += 1;
          }
          expect(holders.everywhere(permission).has(person.id)).toBe(
            covers(scope, permission, null),
          );
        }
      }
      expect(compared).toBe(10 * 5 * 4);
      // Spot checks, so that both being wrong the same way would show.
      const triagers = (unit: string) =>
        named(holders.of('incidents.triage', [unit]));
      expect(triagers(ward3)).toEqual(
        sorted(admin, quality, quality2, wardQuality, unitTriage),
      );
      expect(triagers(ward)).toEqual(
        sorted(admin, quality, quality2, wardQuality),
      );
      expect(triagers(lab)).toEqual(
        sorted(admin, quality, quality2, labQuality),
      );
      expect(triagers(facility)).toEqual(sorted(admin, quality, quality2));
      expect(named(holders.everywhere('incidents.triage'))).toEqual(
        sorted(admin, quality, quality2),
      );
      // Never someone who is not active, whatever their role.
      for (const permission of permissions) {
        const all = holders.of(permission, units);
        expect(all.has(invited.id)).toBe(false);
        expect(all.has(gone.id)).toBe(false);
      }
    });

    it("reads one hospital's people only, and none for a unit that is not its own", async () => {
      const access = bench.app.get(AccessService, { strict: false });
      const tenantDb = bench.app.get(TenantDb, { strict: false });
      const theirs = await tenantDb.withTenant(b.id, (tx) =>
        access.holders(tx, ['incidents.triage'], [ward, ward3, lab]),
      );
      // Hospital B's administrator, for the whole of B; nobody of A's.
      expect([...theirs.of('incidents.triage', [ward, ward3, lab])]).toEqual([
        b.adminId,
      ]);
      const none = await tenantDb.withTenant(a.id, (tx) =>
        access.holders(tx, ['incidents.triage'], []),
      );
      expect(named(none.of('incidents.triage', []))).toEqual(
        sorted(admin, quality, quality2),
      );
    });
  });

  describe('a report', () => {
    it('is told to everyone who may triage the unit where it happened, and nobody else', async () => {
      const { id, reference } = await report(reporter);
      expect(await told(id)).toEqual({
        incident_reported: sorted(
          admin,
          quality,
          quality2,
          wardQuality,
          unitTriage,
        ),
      });
      // The reference, and nothing a patient or a person could be known by.
      for (const row of await rowsFor(id)) {
        expect(row.data).toEqual({ reference });
        expect(row.read_at).toBeNull();
      }
      expect(await expectAllCouldOpen(id)).toBe(5);

      // In the laboratory: its own quality officer, not the ward's.
      const inLab = await report(reporter, { orgUnitId: lab });
      expect(await told(inLab.id)).toEqual({
        incident_reported: sorted(admin, quality, quality2, labQuality),
      });
      await expectAllCouldOpen(inLab.id);
    });

    it('is not told to the one who made it, when they are named', async () => {
      const { id } = await report(quality);
      expect((await told(id)).incident_reported).toEqual(
        sorted(admin, quality2, wardQuality, unitTriage),
      );
    });

    it('made anonymously is told to all of them, so that who was left out says nothing', async () => {
      // By someone who may triage the unit themselves.
      const { id } = await report(quality, { anonymous: true });
      expect((await told(id)).incident_reported).toEqual(
        sorted(admin, quality, quality2, wardQuality, unitTriage),
      );
      // Nothing stored about the report names them.
      const stored = await bench.owner.db.execute<{
        reported_by: string | null;
      }>(sql`select reported_by from incidents where id = ${id}`);
      expect(stored.rows[0].reported_by).toBeNull();
      // By someone with no rights at all: nobody is told as its reporter.
      const other = await report(reporter, { anonymous: true });
      const rows = await rowsFor(other.id);
      expect(rows.map((r) => r.user_id)).not.toContain(reporter.id);
      expect(rows).toHaveLength(5);
    });

    it('through the public link is told the same way, with nothing of the sender', async () => {
      await http()
        .put('/settings/reporting')
        .set('Cookie', a.cookie)
        .send({ publicReporting: true })
        .expect(200);
      const sent = await http()
        .post(`/public/reporting/${a.slug}`)
        .set('X-Forwarded-For', '203.0.113.99')
        .send(reportBody({ description: 'Seen from the waiting room.' }))
        .expect(201);
      const found = await bench.owner.db.execute<{
        id: string;
        reference: string;
      }>(
        sql`select id, reference from incidents where tenant_id = ${a.id} and channel = 'public' order by reported_at desc limit 1`,
      );
      const { id, reference } = found.rows[0];
      expect((await told(id)).incident_reported).toEqual(
        sorted(admin, quality, quality2, wardQuality, unitTriage),
      );
      const everything = JSON.stringify(await rowsFor(id));
      expect(everything).toContain(reference);
      expect(everything).not.toContain('203.0.113.99');
      expect(everything).not.toContain(sent.body.followUpCode);
      expect(everything).not.toContain('waiting room');
    });
  });

  describe('triage', () => {
    it('tells the person it is assigned to, and those who may triage the department it goes to', async () => {
      const { id, reference } = await report(reporter);
      await clear(id);
      // From nobody's to the ward's, and to the nurse.
      await triage(quality, id, { assignedTo: nurse.id }).expect(200);
      expect(await told(id)).toEqual({
        incident_assigned: sorted(nurse),
        // The ward, not the unit under it; and not the one who did it.
        incident_handed_over: sorted(admin, quality2, wardQuality),
      });
      for (const row of await rowsFor(id)) {
        expect(row.data).toEqual({ reference });
      }
      await expectAllCouldOpen(id);

      // On to the laboratory, the nurse staying on it: only the handover.
      await clear(id);
      await triage(quality2, id, {
        ownerUnitId: lab,
        assignedTo: nurse.id,
      }).expect(200);
      expect(await told(id)).toEqual({
        incident_handed_over: sorted(admin, quality, labQuality),
      });
      await expectAllCouldOpen(id);
    });

    it('tells nobody twice, and nobody of their own doing', async () => {
      const { id } = await report(reporter);
      await clear(id);
      // Assigned to someone who may also triage the department it goes to:
      // one notification, the one that says it is theirs.
      await triage(quality, id, { assignedTo: wardQuality.id }).expect(200);
      expect(await told(id)).toEqual({
        incident_assigned: sorted(wardQuality),
        incident_handed_over: sorted(admin, quality2),
      });
      // Taking it oneself tells nobody.
      await clear(id);
      await triage(quality2, id, { assignedTo: quality2.id }).expect(200);
      expect(await told(id)).toEqual({});
      // Taking someone off it tells nobody either.
      await triage(quality2, id, { assignedTo: null }).expect(200);
      expect(await told(id)).toEqual({});
      // Nor does a triage that changes only the harm level, or nothing.
      await triage(quality, id, { harmLevel: 'mild' }).expect(200);
      await triage(quality, id, { harmLevel: 'mild' }).expect(200);
      expect(await told(id)).toEqual({});
    });

    it('does not tell someone it is handed away from, who can no longer see it', async () => {
      // Happened in the laboratory, handled by the ward, then handed to the
      // laboratory: the ward's quality officer could see it only while the
      // ward handled it.
      const { id } = await report(reporter, { orgUnitId: lab });
      await triage(quality, id, { ownerUnitId: ward }).expect(200);
      await http()
        .get(`/incidents/${id}`)
        .set('Cookie', wardQuality.cookie)
        .expect(200);
      await clear(id);
      const handed = await triage(wardQuality, id, {
        ownerUnitId: lab,
        assignedTo: nurse.id,
      }).expect(200);
      expect(handed.body).toMatchObject({ handedOff: true });
      expect(await told(id)).toEqual({
        incident_assigned: sorted(nurse),
        incident_handed_over: sorted(admin, quality, quality2, labQuality),
      });
      // A comment now reaches the nurse; the one who triaged it last can no
      // longer open it, and is told nothing.
      await clear(id);
      await comment(
        quality,
        id,
        'Thanks for passing it on.',
        'internal',
      ).expect(201);
      expect(await told(id)).toEqual({ comment_added: sorted(nurse) });
      await http()
        .get(`/incidents/${id}`)
        .set('Cookie', wardQuality.cookie)
        .expect(404);
      await expectAllCouldOpen(id);
    });
  });

  describe('a comment', () => {
    let id: string;
    let reference: string;

    beforeAll(async () => {
      // Reported by name, triaged by one quality officer, with the nurse.
      ({ id, reference } = await report(reporter));
      await triage(quality2, id, { assignedTo: nurse.id }).expect(200);
    });
    beforeEach(() => clear(id));

    it('for everyone is told to the reporter, the assignee and whoever triaged it, not to its author', async () => {
      await comment(
        quality,
        id,
        'We are replacing the rail.',
        'everyone',
      ).expect(201);
      expect(await told(id)).toEqual({
        comment_added: sorted(reporter, nurse, quality2),
      });
      // Not a word of it, and not who wrote it.
      for (const row of await rowsFor(id)) {
        expect(row.data).toEqual({ reference });
      }
      expect(JSON.stringify(await rowsFor(id))).not.toContain(quality.id);
      await expectAllCouldOpen(id);
      // Written by whoever triaged it: the other two.
      await clear(id);
      await comment(quality2, id, 'Done by Friday.', 'everyone').expect(201);
      expect(await told(id)).toEqual({
        comment_added: sorted(reporter, nurse),
      });
    });

    it('that is internal never reaches the reporter', async () => {
      await comment(quality, id, 'Third time this month.', 'internal').expect(
        201,
      );
      expect(await told(id)).toEqual({
        comment_added: sorted(nurse, quality2),
      });
      await clear(id);
      await comment(nurse, id, 'Rail ordered.', 'internal').expect(201);
      expect(await told(id)).toEqual({ comment_added: sorted(quality2) });
    });

    it('by the reporter is told to the handlers without saying whose it is', async () => {
      await comment(
        reporter,
        id,
        'It happened again today.',
        'everyone',
      ).expect(201);
      expect(await told(id)).toEqual({
        comment_added: sorted(nurse, quality2),
      });
      // The nurse handles the incident and is not told who reported it.
      const seen = await http()
        .get(`/incidents/${id}`)
        .set('Cookie', nurse.cookie)
        .expect(200);
      expect(seen.body).toMatchObject({
        access: 'full',
        reporter: null,
        reporterShown: false,
      });
      // Nothing in what the nurse is notified of says so either: not this
      // notification, and not all of theirs taken together.
      const theirs = await inbox(nurse);
      const latest = theirs.items[0];
      expect(latest).toMatchObject({
        kind: 'comment_added',
        incident: { id, reference, canOpen: true },
        data: { reference },
      });
      expect(Object.keys(latest).sort()).toEqual([
        'createdAt',
        'data',
        'id',
        'incident',
        'kind',
        'readAt',
      ]);
      const everything = JSON.stringify(theirs);
      expect(everything).not.toContain(reporter.id);
      expect(everything).not.toContain(reporter.name);
      expect(everything).not.toContain(reporter.email);
      expect(everything).not.toContain('happened again');
      // And in the table itself no notification carries anything but a
      // reference and, for some kinds, a word from a fixed list.
      const odd = await bench.owner.db.execute(
        sql`select data from notifications n
            where tenant_id = ${a.id}
              and exists (
                select from jsonb_each_text(n.data) d
                where d.key not in ('reference', 'deadline', 'decision', 'change')
                   or (d.key <> 'reference' and d.value not in ('triage', 'closure', 'signed_off', 'sent_back', 'closed', 'rejected', 'reopened')))`,
      );
      expect(odd.rows).toEqual([]);
    });

    it('written with a follow-up code is told to the handlers, and to nobody as its reporter', async () => {
      const anonymous = await report(reporter, { anonymous: true });
      await triage(quality2, anonymous.id, { assignedTo: nurse.id }).expect(
        200,
      );
      await clear(anonymous.id);
      await http()
        .post(`/public/follow-up/${a.slug}/comments`)
        // Signed in while using the code: it must not show.
        .set('Cookie', reporter.cookie)
        .send({ code: anonymous.followUpCode, body: 'Any news?' })
        .expect(201);
      expect(await told(anonymous.id)).toEqual({
        comment_added: sorted(nurse, quality2),
      });
      // A handler answers: there is no reporter to tell.
      await clear(anonymous.id);
      await comment(quality, anonymous.id, 'Soon.', 'everyone').expect(201);
      expect(await told(anonymous.id)).toEqual({
        comment_added: sorted(nurse, quality2),
      });
      const ever = await bench.owner.db.execute(
        sql`select 1 from notifications where incident_id = ${anonymous.id} and user_id = ${reporter.id}`,
      );
      expect(ever.rows).toEqual([]);
    });

    it('on a report nobody has triaged yet has nobody to tell but its named reporter', async () => {
      const fresh = await report(reporter);
      await clear(fresh.id);
      await comment(reporter, fresh.id, 'One more thing.', 'everyone').expect(
        201,
      );
      expect(await told(fresh.id)).toEqual({});
      await comment(quality, fresh.id, 'Noted.', 'everyone').expect(201);
      expect(await told(fresh.id)).toEqual({ comment_added: sorted(reporter) });
    });

    it('is not told to whoever triaged it once they can no longer see it', async () => {
      const leaver = await bench.createStaff(a, 'leaver', {
        role: 'quality_officer',
        orgUnitId: null,
      });
      names.set(leaver.id, leaver.name);
      const theirs = await report(reporter);
      await triage(leaver, theirs.id).expect(200);
      await clear(theirs.id);
      await comment(quality, theirs.id, 'First.', 'internal').expect(201);
      expect(await told(theirs.id)).toEqual({ comment_added: [leaver.name] });
      // They become an ordinary reporter: the incident is no longer theirs
      // to see.
      await http()
        .put(`/users/${leaver.id}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [{ roleId: a.roles.reporter, orgUnitId: null }] })
        .expect(200);
      await http()
        .get(`/incidents/${theirs.id}`)
        .set('Cookie', leaver.cookie)
        .expect(404);
      await clear(theirs.id);
      await comment(quality, theirs.id, 'Second.', 'internal').expect(201);
      await comment(quality, theirs.id, 'Third.', 'everyone').expect(201);
      expect((await told(theirs.id)).comment_added).toEqual(sorted(reporter));
      // What they were told before is still theirs to read, and says that
      // the incident no longer opens for them.
      await bench.owner.db.execute(
        sql`insert into notifications (tenant_id, user_id, kind, incident_id, data)
            values (${a.id}, ${leaver.id}, 'comment_added', ${theirs.id}, ${JSON.stringify({ reference: theirs.reference })}::jsonb)`,
      );
      const kept = (await inbox(leaver)).items.filter(
        (n) => n.incident.id === theirs.id,
      );
      expect(kept).toHaveLength(1);
      expect(kept[0].incident).toEqual({
        id: theirs.id,
        reference: theirs.reference,
        canOpen: false,
      });
    });

    it('is not told to an assignee whose account has been switched off', async () => {
      const temp = await bench.createStaff(a, 'temp', {
        role: 'reporter',
        orgUnitId: null,
      });
      names.set(temp.id, temp.name);
      const theirs = await report(reporter);
      await triage(quality2, theirs.id, { assignedTo: temp.id }).expect(200);
      await http()
        .patch(`/users/${temp.id}`)
        .set('Cookie', a.cookie)
        .send({ status: 'disabled' })
        .expect(200);
      await clear(theirs.id);
      await comment(quality, theirs.id, 'Anyone there?', 'everyone').expect(
        201,
      );
      expect(await told(theirs.id)).toEqual({
        comment_added: sorted(reporter, quality2),
      });
    });
  });

  describe('a change of status', () => {
    it('that ends or reopens the incident is told to its named reporter and its assignee', async () => {
      const { id, reference } = await report(reporter);
      await triage(quality, id, { assignedTo: nurse.id }).expect(200);
      await clear(id);
      // Starting work is not news to anyone.
      await move(quality, id, 'in_progress').expect(200);
      expect(await told(id)).toEqual({});

      await move(quality, id, 'closed', 'Rail replaced.').expect(200);
      expect(await told(id)).toEqual({
        status_changed: sorted(reporter, nurse),
      });
      expect((await rowsFor(id)).map((r) => r.data)).toEqual([
        { reference, change: 'closed' },
        { reference, change: 'closed' },
      ]);
      // The reporter is told, though they see it only as its reporter.
      await expectAllCouldOpen(id);

      await clear(id);
      await move(quality2, id, 'in_progress', 'It came loose again.').expect(
        200,
      );
      expect(await told(id)).toEqual({
        status_changed: sorted(reporter, nurse),
      });
      expect((await rowsFor(id))[0].data).toEqual({
        reference,
        change: 'reopened',
      });
      // No closure note in any of it.
      const everything = JSON.stringify(await rowsFor(id));
      expect(everything).not.toContain('loose');
    });

    it('that sets a report aside is told to its reporter, and an anonymous one to nobody', async () => {
      const named = await report(reporter);
      await clear(named.id);
      await move(quality, named.id, 'rejected', 'Not an incident.').expect(200);
      expect(await told(named.id)).toEqual({
        status_changed: sorted(reporter),
      });
      expect((await rowsFor(named.id))[0].data).toEqual({
        reference: named.reference,
        change: 'rejected',
      });
      const anonymous = await report(reporter, { anonymous: true });
      await clear(anonymous.id);
      await move(quality, anonymous.id, 'rejected', 'Not an incident.').expect(
        200,
      );
      expect(await told(anonymous.id)).toEqual({});
    });

    it('is not told to the one who made it', async () => {
      // Their own report, assigned to themselves, closed by themselves.
      const { id } = await report(quality);
      await triage(quality, id, { assignedTo: quality.id }).expect(200);
      await clear(id);
      await move(quality, id, 'closed', 'Done.').expect(200);
      expect(await told(id)).toEqual({});
      // Closed by a colleague: one notification, not two, though they are
      // both its reporter and the one it is assigned to.
      await move(quality, id, 'in_progress', 'Again.').expect(200);
      await clear(id);
      await move(quality2, id, 'closed', 'Done.').expect(200);
      expect(await told(id)).toEqual({ status_changed: sorted(quality) });
    });
  });

  describe('closing a sentinel event', () => {
    const sentinel = async (overrides: Record<string, unknown> = {}) => {
      const reported = await report(reporter, { harmLevel: 'severe' });
      await triage(quality, reported.id, {
        harmLevel: 'severe',
        isSentinel: true,
        ...overrides,
      }).expect(200);
      await clear(reported.id);
      return reported;
    };
    const revisionOf = async (id: string) =>
      (
        await bench.owner.db.execute<{ revision: number }>(
          sql`select revision from incidents where id = ${id}`,
        )
      ).rows[0].revision;

    it('is asked of everyone who may sign it off and can see it, except the one asking', async () => {
      const { id, reference } = await sentinel();
      await move(quality, id, 'awaiting_sign_off', 'Root cause found.').expect(
        200,
      );
      // Not the one who may sign off but sees no incident: the right to
      // sign does not open the incident, so they are not told of it.
      expect(await told(id)).toEqual({
        sign_off_requested: sorted(admin, quality2, wardQuality),
      });
      for (const row of await rowsFor(id)) {
        expect(row.data).toEqual({ reference });
      }
      await http()
        .get(`/incidents/${id}`)
        .set('Cookie', signBlind.cookie)
        .expect(404);
      await expectAllCouldOpen(id);
      expect(JSON.stringify(await rowsFor(id))).not.toContain('Root cause');
    });

    it('tells the one who asked what was decided, and the others that it is closed', async () => {
      const { id, reference } = await sentinel({ assignedTo: nurse.id });
      await move(quality, id, 'awaiting_sign_off', 'Root cause found.').expect(
        200,
      );
      await clear(id);
      await move(quality2, id, 'in_progress', 'Not yet convincing.', {
        kind: 'send_back',
      }).expect(200);
      // Sent back: between the two of them.
      expect(await told(id)).toEqual({ sign_off_decided: sorted(quality) });
      expect((await rowsFor(id))[0].data).toEqual({
        reference,
        decision: 'sent_back',
      });
      expect(JSON.stringify(await rowsFor(id))).not.toContain('convincing');

      await move(quality, id, 'awaiting_sign_off', 'Root cause found.').expect(
        200,
      );
      await clear(id);
      await move(wardQuality, id, 'closed', undefined, {
        revision: await revisionOf(id),
      }).expect(200);
      expect(await told(id)).toEqual({
        sign_off_decided: sorted(quality),
        status_changed: sorted(reporter, nurse),
      });
      const data = Object.fromEntries(
        (await rowsFor(id)).map((r) => [r.kind, r.data]),
      );
      expect(data).toEqual({
        sign_off_decided: { reference, decision: 'signed_off' },
        status_changed: { reference, change: 'closed' },
      });
    });

    it('tells someone who both asked and is assigned once, and nobody when a request is withdrawn', async () => {
      const { id } = await sentinel({ assignedTo: quality.id });
      await move(quality, id, 'awaiting_sign_off', 'Root cause found.').expect(
        200,
      );
      await clear(id);
      await move(quality, id, 'in_progress', 'One more check.', {
        kind: 'withdraw',
      }).expect(200);
      expect(await told(id)).toEqual({});
      await move(quality, id, 'awaiting_sign_off', 'Root cause found.').expect(
        200,
      );
      await clear(id);
      await move(quality2, id, 'closed', undefined, {
        revision: await revisionOf(id),
      }).expect(200);
      expect(await told(id)).toEqual({
        sign_off_decided: sorted(quality),
        status_changed: sorted(reporter),
      });
    });
  });

  describe('every notification written in this hospital', () => {
    it('went to an active user of it, in the same transaction as the change it announces', async () => {
      const strays = await bench.owner.db.execute(
        sql`select n.kind from notifications n
            join users u on u.id = n.user_id
            where n.tenant_id = ${a.id}
              and (u.tenant_id <> n.tenant_id or u.id in (${invited.id}, ${gone.id}, ${signBlind.id}))`,
      );
      expect(strays.rows).toEqual([]);
      const total = await bench.owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from notifications where tenant_id = ${a.id}`,
      );
      expect(total.rows[0].n).toBeGreaterThan(20);
      // A change that fails leaves no notification behind: a triage refused
      // for its assignee is refused whole.
      const { id } = await report(reporter);
      await clear(id);
      await triage(quality, id, {
        assignedTo: '00000000-0000-4000-8000-000000000000',
      }).expect(400);
      await triage(quality, id, { assignedTo: gone.id }).expect(400);
      await move(quality, id, 'closed', 'Too soon.').expect(409);
      await comment(reporter, id, 'Hidden?', 'internal').expect(403);
      expect(await told(id)).toEqual({});
    });
  });

  describe("a user's own notifications", () => {
    let mine: string; // one of the nurse's
    let theirs: string; // one of the reporter's
    let elsewhere: string; // one in hospital B

    beforeAll(async () => {
      const { id } = await report(reporter);
      await triage(quality, id, { assignedTo: nurse.id }).expect(200);
      await comment(quality, id, 'For both of you.', 'everyone').expect(201);
      const rows = await rowsFor(id);
      mine = rows.find(
        (r) => r.user_id === nurse.id && r.kind === 'comment_added',
      )!.id;
      theirs = rows.find((r) => r.user_id === reporter.id)!.id;
      // Hospital B: its administrator is told of a report made anonymously.
      const unit = await bench.createUnit(b, 'facility', 'MAIN', null);
      const res = await http()
        .post('/incidents')
        .set('Cookie', b.cookie)
        .send(
          reportBody({
            anonymous: true,
            categoryId: b.categories.equipment,
            orgUnitId: unit,
          }),
        )
        .expect(201);
      elsewhere = (await rowsFor(res.body.id))[0].id;
      expect(elsewhere).toBeTruthy();
    });

    it('need a session', async () => {
      await http().get('/notifications').expect(401);
      await http().get('/notifications/count').expect(401);
      await http().post(`/notifications/${mine}/read`).expect(401);
      await http().post('/notifications/read-all').expect(401);
      const still = await bench.owner.db.execute<{ read_at: string | null }>(
        sql`select read_at from notifications where id = ${mine}`,
      );
      expect(still.rows[0].read_at).toBeNull();
    });

    it('are listed newest first, theirs only, each with its incident', async () => {
      const list = await inbox(nurse);
      const stored = await bench.owner.db.execute<{ id: string }>(
        sql`select id from notifications where user_id = ${nurse.id} order by created_at desc, id desc`,
      );
      expect(list.total).toBe(stored.rows.length);
      expect(list.items.map((n) => n.id)).toEqual(stored.rows.map((r) => r.id));
      expect(list.total).toBeGreaterThan(5);
      const times = list.items.map((n) => Date.parse(n.createdAt));
      expect(times).toEqual([...times].sort((x, y) => y - x));
      for (const item of list.items) {
        expect(Object.keys(item).sort()).toEqual([
          'createdAt',
          'data',
          'id',
          'incident',
          'kind',
          'readAt',
        ]);
        expect(Object.keys(item.incident).sort()).toEqual([
          'canOpen',
          'id',
          'reference',
        ]);
        expect(item.data.reference).toBe(item.incident.reference);
      }
      const ids = list.items.map((n) => n.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
      expect(ids).not.toContain(elsewhere);
      // No role sees another person's: not a quality officer, not the
      // administrator.
      for (const who of [quality, admin, manager]) {
        const other = (await inbox(who)).items.map((n) => n.id);
        expect(other).not.toContain(mine);
        expect(other).not.toContain(theirs);
      }
      // Someone who has never been told anything.
      expect(await inbox(signBlind)).toEqual({ items: [], total: 0 });
      expect(await unread(signBlind)).toBe(0);
    });

    it('page, and refuse a query that is not one', async () => {
      const all = await inbox(nurse);
      const pages: string[] = [];
      for (let page = 1; (page - 1) * 3 < all.total; page++) {
        const res = await http()
          .get(`/notifications?pageSize=3&page=${page}`)
          .set('Cookie', nurse.cookie)
          .expect(200);
        expect(res.body.total).toBe(all.total);
        expect(res.body.items.length).toBeLessThanOrEqual(3);
        pages.push(...res.body.items.map((n: { id: string }) => n.id));
      }
      expect(pages).toEqual(all.items.map((n) => n.id));
      for (const query of [
        'unread=1',
        'unread=yes',
        'page=0',
        'page=x',
        'pageSize=0',
        'pageSize=101',
        'userId=' + reporter.id,
        'user=' + reporter.id,
        'kind=overdue',
      ]) {
        await http()
          .get(`/notifications?${query}`)
          .set('Cookie', nurse.cookie)
          .expect(400);
      }
      // An empty value is a filter not set.
      await http()
        .get('/notifications?unread=&page=')
        .set('Cookie', nurse.cookie)
        .expect(200);
    });

    it('are marked read one at a time, by their owner only', async () => {
      const before = await unread(nurse);
      expect(before).toBe((await inbox(nurse, '&unread=true')).total);
      expect(before).toBeGreaterThan(1);

      const res = await http()
        .post(`/notifications/${mine}/read`)
        .set('Cookie', nurse.cookie)
        .expect(200);
      expect(Object.keys(res.body).sort()).toEqual(['id', 'readAt']);
      expect(res.body.id).toBe(mine);
      expect(Date.parse(res.body.readAt)).toBeGreaterThan(Date.now() - 60_000);
      expect(await unread(nurse)).toBe(before - 1);
      const listed = await inbox(nurse);
      expect(listed.items.find((n) => n.id === mine)?.readAt).toBe(
        res.body.readAt,
      );
      const left = await inbox(nurse, '&unread=true');
      expect(left.total).toBe(before - 1);
      expect(left.items.map((n) => n.id)).not.toContain(mine);
      expect(left.items.every((n) => n.readAt === null)).toBe(true);
      // Again: still read, since when it was first read.
      const again = await http()
        .post(`/notifications/${mine}/read`)
        .set('Cookie', nurse.cookie)
        .expect(200);
      expect(again.body).toEqual(res.body);

      // Another person's, another hospital's, and no notification at all:
      // the same 404, and nothing marked.
      const refusals = [];
      for (const [who, id] of [
        [nurse, theirs],
        [quality, mine],
        [admin, theirs],
        [nurse, elsewhere],
        [nurse, '00000000-0000-4000-8000-000000000000'],
        [nurse, 'not-an-id'],
      ] as const) {
        const refused = await http()
          .post(`/notifications/${id}/read`)
          .set('Cookie', who.cookie)
          .expect(404);
        refusals.push(refused.body);
      }
      expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1);
      const untouched = await bench.owner.db.execute<{
        read_at: string | null;
      }>(
        sql`select read_at from notifications where id in (${theirs}, ${elsewhere})`,
      );
      expect(untouched.rows.map((r) => r.read_at)).toEqual([null, null]);
      // Nothing about it can be changed but that: no body is read.
      await http()
        .post(`/notifications/${mine}/read`)
        .set('Cookie', nurse.cookie)
        .send({ readAt: null, userId: reporter.id, kind: 'overdue' })
        .expect(200);
      const kept = await bench.owner.db.execute<{
        user_id: string;
        kind: string;
        read: boolean;
      }>(
        sql`select user_id, kind, read_at is not null as read from notifications where id = ${mine}`,
      );
      expect(kept.rows[0]).toEqual({
        user_id: nurse.id,
        kind: 'comment_added',
        read: true,
      });
    });

    it('are marked read all at once, theirs and nobody else’s', async () => {
      const before = await unread(nurse);
      const others = await unread(reporter);
      expect(before).toBeGreaterThan(0);
      expect(others).toBeGreaterThan(0);
      const firstRead = (
        await bench.owner.db.execute<{ read_at: string }>(
          sql`select read_at::text from notifications where id = ${mine}`,
        )
      ).rows[0].read_at;

      const res = await http()
        .post('/notifications/read-all')
        .set('Cookie', nurse.cookie)
        .expect(200);
      expect(res.body).toEqual({ marked: before });
      expect(await unread(nurse)).toBe(0);
      expect((await inbox(nurse, '&unread=true')).total).toBe(0);
      expect((await inbox(nurse)).items.every((n) => n.readAt !== null)).toBe(
        true,
      );
      // What was read before keeps its time; nobody else's was touched.
      const still = await bench.owner.db.execute<{ read_at: string }>(
        sql`select read_at::text from notifications where id = ${mine}`,
      );
      expect(still.rows[0].read_at).toBe(firstRead);
      expect(await unread(reporter)).toBe(others);
      const elsewhereRead = await bench.owner.db.execute<{ read_at: unknown }>(
        sql`select read_at from notifications where id = ${elsewhere}`,
      );
      expect(elsewhereRead.rows[0].read_at).toBeNull();
      // Nothing left to mark.
      const again = await http()
        .post('/notifications/read-all')
        .set('Cookie', nurse.cookie)
        .expect(200);
      expect(again.body).toEqual({ marked: 0 });
      // A new one counts again.
      const { id } = await report(reporter);
      await triage(quality, id, { assignedTo: nurse.id }).expect(200);
      expect(await unread(nurse)).toBe(1);
    });
  });

  describe('the check for deadlines', () => {
    // A hospital of its own: the check goes through every incident of the
    // hospital it is run for, as of whatever moment it is given.
    let d: Hospital;
    let unit: string;
    let boss: Staff; // d's administrator: may triage everywhere
    let officer: Staff; // quality officer for the unit only
    let assignee: Staff; // reports; gets incidents assigned
    let viewer: Staff; // department manager: sees, does not triage
    let check: DeadlineCheck;
    const zone = { timeZone: 'UTC' };
    const hospital = () => ({ id: d.id, ...zone });

    const fresh = async (overrides: Record<string, unknown> = {}) =>
      (
        await http()
          .post('/incidents')
          .set('Cookie', assignee.cookie)
          .send(
            reportBody({
              anonymous: true,
              categoryId: d.categories.equipment,
              orgUnitId: unit,
              ...overrides,
            }),
          )
          .expect(201)
      ).body as { id: string; reference: string };
    const triaged = async (overrides: Record<string, unknown> = {}) => {
      const reported = await fresh();
      await triage(boss, reported.id, {
        ownerUnitId: unit,
        ...overrides,
      }).expect(200);
      await clear(reported.id);
      return reported;
    };
    const timesOf = async (id: string) => {
      const [row] = (
        await bench.owner.db.execute<Record<string, string | null>>(
          sql`select extract(epoch from reported_at) * 1000 as reported,
                     extract(epoch from triage_due_at) * 1000 as triage_due,
                     extract(epoch from close_due_at) * 1000 as close_due,
                     triage_due_soon_at, triage_overdue_at, close_due_soon_at, close_overdue_at
              from incidents where id = ${id}`,
        )
      ).rows;
      return {
        reported: Math.round(Number(row.reported)),
        triageDue: Math.round(Number(row.triage_due)),
        closeDue: Math.round(Number(row.close_due)),
        sent: {
          triageDueSoon: row.triage_due_soon_at !== null,
          triageOverdue: row.triage_overdue_at !== null,
          closeDueSoon: row.close_due_soon_at !== null,
          closeOverdue: row.close_overdue_at !== null,
        },
      };
    };
    const at = (moment: number) =>
      check.checkHospital(hospital(), new Date(moment));

    beforeAll(async () => {
      d = await bench.createHospital('d');
      unit = await bench.createUnit(d, 'facility', 'MAIN', null);
      const ward9 = await bench.createUnit(d, 'department', 'WARD-9', unit);
      await bench.createRole(d, 'triage_only', [
        'incidents.view',
        'incidents.triage',
      ]);
      boss = { id: d.adminId, email: '', name: 'Admin d', cookie: d.cookie };
      officer = await bench.createStaff(d, 'officer', {
        role: 'triage_only',
        orgUnitId: unit,
      });
      assignee = await bench.createStaff(d, 'assignee', {
        role: 'reporter',
        orgUnitId: null,
      });
      viewer = await bench.createStaff(d, 'viewer', {
        role: 'department_manager',
        orgUnitId: null,
      });
      // Someone who may triage another department only: never told.
      const other = await bench.createStaff(d, 'other-ward', {
        role: 'triage_only',
        orgUnitId: ward9,
      });
      for (const person of [boss, officer, assignee, viewer, other]) {
        names.set(person.id, person.name);
      }
      check = bench.app.get(DeadlineCheck, { strict: false });
    });

    // Each test is about the incidents it makes. Those of the tests before
    // it are put beyond every deadline's announcement, so that a check as
    // of some later moment finds nothing more to say about them.
    beforeEach(async () => {
      await bench.owner.db.execute(
        sql`update incidents set
              triage_due_soon_at = coalesce(triage_due_soon_at, now()),
              triage_overdue_at = coalesce(triage_overdue_at, now()),
              close_due_soon_at = coalesce(close_due_soon_at, now()),
              close_overdue_at = coalesce(close_overdue_at, now())
            where tenant_id = ${d.id}`,
      );
    });

    it('is not running in an application that was only built, as in every test', () => {
      expect(check.active).toBe(false);
    });

    it('announces a triage deadline when a quarter of the time is left, once', async () => {
      const { id, reference } = await fresh();
      await clear(id);
      const { reported, triageDue } = await timesOf(id);
      expect(triageDue - reported).toBe(72 * HOUR);
      // 53 hours in: more than a quarter (18 hours) still left.
      expect(await at(reported + 53 * HOUR)).toBe(0);
      expect(await told(id)).toEqual({});
      // 54 hours in: exactly a quarter left.
      expect(await at(reported + 54 * HOUR)).toBe(2);
      expect(await told(id)).toEqual({ due_soon: sorted(boss, officer) });
      for (const row of await rowsFor(id)) {
        expect(row.data).toEqual({ reference, deadline: 'triage' });
      }
      expect((await timesOf(id)).sent).toEqual({
        triageDueSoon: true,
        triageOverdue: false,
        closeDueSoon: false,
        closeOverdue: false,
      });
      // Checked again and again before the deadline: nothing more.
      expect(await at(reported + 54 * HOUR)).toBe(0);
      expect(await at(reported + 60 * HOUR)).toBe(0);
      expect(await at(triageDue - 1)).toBe(0);
      expect((await rowsFor(id)).length).toBe(2);
    });

    it('announces a missed triage deadline once, to the same people and whoever may triage everywhere', async () => {
      const { id, reference } = await fresh();
      await clear(id);
      const { reported, triageDue } = await timesOf(id);
      await at(reported + 60 * HOUR);
      await clear(id);
      expect(await at(triageDue)).toBe(2);
      // The administrator may triage everywhere and this unit too: once.
      expect(await told(id)).toEqual({ overdue: sorted(boss, officer) });
      for (const row of await rowsFor(id)) {
        expect(row.data).toEqual({ reference, deadline: 'triage' });
      }
      expect(await at(triageDue + HOUR)).toBe(0);
      expect(await at(triageDue + 10 * DAY)).toBe(0);
      expect(await told(id)).toEqual({ overdue: sorted(boss, officer) });
      // Everyone told could open it; the viewer and the reporter were not.
      const rows = await rowsFor(id);
      expect(rows.map((r) => r.user_id)).not.toContain(viewer.id);
      expect(rows.map((r) => r.user_id)).not.toContain(assignee.id);
    });

    it('says only that it is overdue when the incident is found already past its deadline', async () => {
      const { id } = await fresh();
      await clear(id);
      const { triageDue } = await timesOf(id);
      // The check was not running while it was due soon.
      expect(await at(triageDue + HOUR)).toBe(2);
      expect(await told(id)).toEqual({ overdue: sorted(boss, officer) });
      // "Due soon" is not sent after "overdue".
      expect(await at(triageDue + 2 * HOUR)).toBe(0);
      expect((await timesOf(id)).sent).toMatchObject({
        triageDueSoon: true,
        triageOverdue: true,
      });
      expect(await told(id)).toEqual({ overdue: sorted(boss, officer) });
    });

    it('announces nothing about triage once the incident has been triaged or set aside', async () => {
      const done = await triaged();
      const aside = await fresh();
      await move(boss, aside.id, 'rejected', 'Not an incident.').expect(200);
      await clear(aside.id);
      const { triageDue } = await timesOf(done.id);
      await at(triageDue + HOUR);
      expect(await told(done.id)).toEqual({});
      expect(await told(aside.id)).toEqual({});
      expect((await timesOf(done.id)).sent.triageOverdue).toBe(false);
      // Nor ever anything about one that is set aside, however old.
      await at(triageDue + 400 * DAY);
      expect(await told(aside.id)).toEqual({});
    });

    it('announces a closing deadline to the person assigned, and a missed one to those who triage everywhere too', async () => {
      const { id, reference } = await triaged({ assignedTo: assignee.id });
      const { reported, closeDue } = await timesOf(id);
      expect(closeDue - reported).toBe(30 * DAY);
      // A quarter of 30 days is 7 and a half.
      expect(await at(closeDue - 8 * DAY)).toBe(0);
      expect(await at(closeDue - 7 * DAY)).toBe(1);
      expect(await told(id)).toEqual({ due_soon: sorted(assignee) });
      expect((await rowsFor(id))[0].data).toEqual({
        reference,
        deadline: 'closure',
      });
      expect(await at(closeDue - DAY)).toBe(0);
      await clear(id);
      expect(await at(closeDue + 1000)).toBe(2);
      // The officer may triage the unit, not the whole hospital: not told.
      expect(await told(id)).toEqual({ overdue: sorted(assignee, boss) });
      expect(await at(closeDue + 30 * DAY)).toBe(0);
      expect((await rowsFor(id)).length).toBe(2);
    });

    it('announces a closing deadline to those who may triage when nobody is assigned, or that person has left', async () => {
      const nobody = await triaged();
      const left = await triaged({ assignedTo: viewer.id });
      const { closeDue } = await timesOf(nobody.id);
      await http()
        .patch(`/users/${viewer.id}`)
        .set('Cookie', d.cookie)
        .send({ status: 'disabled' })
        .expect(200);
      try {
        await at(closeDue - DAY);
        expect(await told(nobody.id)).toEqual({
          due_soon: sorted(boss, officer),
        });
        expect(await told(left.id)).toEqual({
          due_soon: sorted(boss, officer),
        });
        await clear(nobody.id);
        await clear(left.id);
        await at(closeDue + HOUR);
        expect(await told(nobody.id)).toEqual({
          overdue: sorted(boss, officer),
        });
        expect(await told(left.id)).toEqual({ overdue: sorted(boss, officer) });
      } finally {
        await http()
          .patch(`/users/${viewer.id}`)
          .set('Cookie', d.cookie)
          .send({ status: 'active' })
          .expect(200);
      }
    });

    it('announces nothing about closing once closed, nothing new on reopening, and a new deadline anew', async () => {
      const { id } = await triaged({ assignedTo: assignee.id });
      const { closeDue } = await timesOf(id);
      await at(closeDue + HOUR);
      expect(await told(id)).toEqual({ overdue: sorted(assignee, boss) });
      await clear(id);
      // Closed late and reopened: the same deadline, already announced.
      await move(boss, id, 'closed', 'Done.').expect(200);
      await move(boss, id, 'in_progress', 'Not done.').expect(200);
      await clear(id);
      expect(await at(closeDue + 2 * HOUR)).toBe(0);
      expect(await told(id)).toEqual({});

      // Closed in time and reopened after the deadline: announced then.
      const early = await triaged({ assignedTo: assignee.id });
      await move(boss, early.id, 'closed', 'Done.').expect(200);
      await clear(early.id);
      await at(closeDue + 3 * HOUR);
      expect(await told(early.id)).toEqual({});
      await move(boss, early.id, 'in_progress', 'Not done.').expect(200);
      await clear(early.id);
      await at(closeDue + 4 * HOUR);
      expect(await told(early.id)).toEqual({ overdue: sorted(assignee, boss) });

      // A deadline that triage moves is another deadline: announced again.
      await clear(id);
      await triage(boss, id, {
        ownerUnitId: unit,
        assignedTo: assignee.id,
        harmLevel: 'severe',
      }).expect(200);
      await clear(id);
      const moved = await timesOf(id);
      expect(moved.closeDue - moved.reported).toBe(45 * DAY);
      expect(moved.sent).toMatchObject({
        closeDueSoon: false,
        closeOverdue: false,
      });
      await at(moved.closeDue + HOUR);
      expect(await told(id)).toEqual({ overdue: sorted(assignee, boss) });
    });

    it('sends each once when several checks run at the same moment', async () => {
      // A second application: its own connections, as another API process.
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const second = moduleRef.createNestApplication();
      setupApp(second);
      await second.init();
      try {
        const other = second.get(DeadlineCheck, { strict: false });
        expect(other).not.toBe(check);
        // More incidents than one transaction takes, half of them assigned.
        const made = await Promise.all(
          Array.from({ length: 130 }, (_, i) =>
            fresh().then(async (incident) => {
              if (i % 2 === 0) return incident;
              await triage(boss, incident.id, {
                ownerUnitId: unit,
                assignedTo: assignee.id,
              }).expect(200);
              return incident;
            }),
          ),
        );
        const ids = made.map((m) => m.id);
        const list = sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        );
        await bench.owner.db.execute(
          sql`delete from notifications where incident_id in (${list})`,
        );
        const { closeDue } = await timesOf(ids[0]);
        // Everything is overdue as of then: triage for the new ones,
        // closure for the others. Six checks at once, in two processes.
        const moment = new Date(closeDue + 2 * DAY);
        const counts = await Promise.all([
          check.checkHospital(hospital(), moment),
          other.checkHospital(hospital(), moment),
          check.checkHospital(hospital(), moment),
          other.checkHospital(hospital(), moment),
          check.run(moment),
          other.run(moment),
        ]);
        const sent = await bench.owner.db.execute<{
          incident_id: string;
          user_id: string;
          kind: string;
          n: number;
        }>(
          sql`select incident_id, user_id, kind, count(*)::int as n from notifications
              where incident_id in (${list}) group by 1, 2, 3`,
        );
        // Nobody told twice of anything.
        expect(sent.rows.filter((r) => r.n !== 1)).toEqual([]);
        expect(sent.rows.every((r) => r.kind === 'overdue')).toBe(true);
        // And everybody told: two people for each incident.
        expect(sent.rows).toHaveLength(130 * 2);
        const per = new Map<string, string[]>();
        for (const row of sent.rows) {
          per.set(row.incident_id, [
            ...(per.get(row.incident_id) ?? []),
            names.get(row.user_id)!,
          ]);
        }
        for (const [i, id] of ids.entries()) {
          expect(per.get(id)?.sort()).toEqual(
            i % 2 === 0 ? sorted(boss, officer) : sorted(assignee, boss),
          );
        }
        // What the checks say they sent adds up to what was sent, for this
        // hospital: whichever of them claimed an incident announced it.
        const mine = counts
          .slice(0, 4)
          .reduce<number>((sum, n) => sum + (n as number), 0);
        const runs = counts.slice(4) as { notified: number; failed: number }[];
        expect(runs.map((r) => r.failed)).toEqual([0, 0]);
        const all = await bench.owner.db.execute<{ n: number }>(
          sql`select count(*)::int as n from notifications where tenant_id = ${d.id} and created_at >= ${new Date(Date.now() - 60_000).toISOString()}::timestamptz and kind = 'overdue' and incident_id in (${list})`,
        );
        expect(all.rows[0].n).toBe(260);
        expect(mine).toBeLessThanOrEqual(260);
        // A check afterwards finds nothing left.
        expect(await other.checkHospital(hospital(), moment)).toBe(0);
        expect(await check.checkHospital(hospital(), moment)).toBe(0);
      } finally {
        await second.close();
      }
    }, 120_000);

    it('goes through every active hospital, each on its own, and leaves a suspended one alone', async () => {
      const s = await bench.createHospital('asleep');
      const sUnit = await bench.createUnit(s, 'facility', 'MAIN', null);
      const res = await http()
        .post('/incidents')
        .set('Cookie', s.cookie)
        .send(
          reportBody({
            anonymous: true,
            categoryId: s.categories.equipment,
            orgUnitId: sUnit,
          }),
        )
        .expect(201);
      const mine = await fresh();
      for (const id of [res.body.id as string, mine.id]) await clear(id);
      const past = sql`reported_at = reported_at - interval '80 hours', triage_due_at = triage_due_at - interval '80 hours'`;
      await bench.owner.db.execute(
        sql`update incidents set ${past} where id in (${res.body.id}, ${mine.id})`,
      );
      await http()
        .patch(`/platform/tenants/${s.id}`)
        .set('Cookie', bench.platform)
        .send({ status: 'suspended' })
        .expect(200);

      const active = await bench.owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from tenants where status = 'active'`,
      );
      // As the timer runs it: every hospital, as of now.
      const result = await check.run();
      expect(result.failed).toBe(0);
      // Other test files create and remove hospitals while this runs.
      expect(Math.abs(result.hospitals - active.rows[0].n)).toBeLessThan(10);
      expect(result.hospitals).toBeGreaterThanOrEqual(4);
      expect(result.notified).toBeGreaterThanOrEqual(2);
      expect(await told(mine.id)).toEqual({ overdue: sorted(boss, officer) });
      // The suspended hospital was not touched.
      expect(await rowsFor(res.body.id)).toEqual([]);
      // Active again, its overdue report is announced, once.
      await http()
        .patch(`/platform/tenants/${s.id}`)
        .set('Cookie', bench.platform)
        .send({ status: 'active' })
        .expect(200);
      await check.run();
      await check.run();
      const theirs = await rowsFor(res.body.id);
      expect(theirs.map((r) => [r.kind, r.user_id])).toEqual([
        ['overdue', s.adminId],
      ]);
      // Notifications of one hospital never name a user of another.
      const crossed = await bench.owner.db.execute(
        sql`select 1 from notifications n join users u on u.id = n.user_id
            join incidents i on i.id = n.incident_id
            where u.tenant_id <> n.tenant_id or i.tenant_id <> n.tenant_id`,
      );
      expect(crossed.rows).toEqual([]);
    });

    it('gives its deadlines to an incident stored without them by an older release', async () => {
      const { id } = await fresh({ harmLevel: 'severe' });
      await bench.owner.db.execute(
        sql`update incidents set triage_due_at = null, close_due_at = null where id = ${id}`,
      );
      const seen = await http()
        .get(`/incidents/${id}`)
        .set('Cookie', boss.cookie)
        .expect(200);
      // Readable meanwhile, and not overdue for want of a deadline.
      expect(seen.body).toMatchObject({
        triageDueAt: null,
        closeDueAt: null,
        overdue: null,
      });
      const before = await timesOf(id);
      await at(before.reported + 1000);
      const after = await timesOf(id);
      expect(after.triageDue - after.reported).toBe(24 * HOUR);
      expect(after.closeDue - after.reported).toBe(45 * DAY);
      await clear(id);
    });

    it('starts when told to, checks again and again, and stops with the application', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const third = moduleRef.createNestApplication();
      setupApp(third);
      await third.init();
      const timed = third.get(DeadlineCheck, { strict: false });
      const runs = vi.spyOn(timed, 'run');
      expect(timed.active).toBe(false);
      timed.start(25);
      timed.start(25); // a second start changes nothing
      expect(timed.active).toBe(true);
      await vi.waitFor(
        () => expect(runs.mock.calls.length).toBeGreaterThan(1),
        {
          timeout: 20_000,
          interval: 20,
        },
      );
      // Never two runs of one process at once: each starts after the last.
      const results = await Promise.all(
        runs.mock.results.map((r) => r.value as Promise<{ failed: number }>),
      );
      expect(results.every((r) => r.failed === 0)).toBe(true);

      // Closing the application stops it, waiting for a run in progress,
      // before the database connections go.
      await third.close();
      expect(timed.active).toBe(false);
      const after = runs.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(runs.mock.calls.length).toBe(after);
      // Every run that started also finished, without an error.
      for (const result of runs.mock.results) {
        expect(result.type).toBe('return');
        await expect(result.value).resolves.toMatchObject({ failed: 0 });
      }
    }, 60_000);
  });
});
