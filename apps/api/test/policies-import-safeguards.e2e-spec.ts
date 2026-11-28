import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { contentHash } from '../src/approvals/signatures.js';
import {
  approvalRoutes,
  approvalRouteSteps,
  auditLog,
  documents,
  documentTypes,
  documentVersions,
  roles,
  users,
} from '../src/database/schema.js';
import { shiftDay } from '../src/i18n/time-zones.js';
import { ProvisioningService } from '../src/identity/provisioning.service.js';
import { PolicyCheck } from '../src/policies/policy-check.service.js';
import { signedVersion } from '../src/policies/signed-content.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

type Doc = {
  id: string;
  number: string;
  revision: number;
  today: string;
  inProgress: { id: string } | null;
  published: { id: string } | null;
};
type Version = {
  id: string;
  status: string;
  revision: number;
  authoritativeLocale: string | null;
  languageStatus: { authoritative: string };
  contentHash: string;
};

/**
 * The fixes of security review 7 on importing documents: the large body of
 * the import routes only for a live session that may import, on their own
 * paths, and not too deeply nested; imports only of documents approved
 * before the module was first switched on, and only while the window
 * Trustline's staff set is open; numbers kept normalised, and refused when
 * they mix scripts; the authoritative language recorded on each version
 * once it leaves draft; and a starting route that always ends with an
 * approval.
 */
describe('policies: the safeguards of importing documents', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  const password = `hospital-pass-${run}`;

  let a: Hospital;
  let b: Hospital;
  let dept: string;
  let writer: Staff; // manages documents everywhere
  let reader: Staff; // reads documents only
  let types: Record<string, string>;
  let categories: Record<string, string>;
  let today: string;

  const get = (cookie: string, url: string) => http().get(`/policies${url}`).set('Cookie', cookie);
  const post = (cookie: string, url: string, body: unknown = {}) =>
    http().post(`/policies${url}`).set('Cookie', cookie).send(body as object);
  const patch = (cookie: string, url: string, body: unknown) =>
    http().patch(`/policies${url}`).set('Cookie', cookie).send(body as object);
  const window = (h: Hospital) =>
    http().get(`/platform/tenants/${h.id}/import-window`).set('Cookie', bench.platform);
  const setWindow = (h: Hospital, body: unknown) =>
    http().put(`/platform/tenants/${h.id}/import-window`).set('Cookie', bench.platform).send(body as object);

  const document = (extra: Record<string, unknown> = {}) => ({
    typeId: types.procedure,
    categoryId: categories.SAF,
    title: { en: 'Lifting a load safely' },
    ownerId: writer.id,
    ownerUnitId: dept,
    approvedOn: shiftDay(today, -400),
    approvedBy: 'Head of Operations',
    originalKeptAt: { en: 'Quality office, cabinet 2' },
    nextReviewOn: shiftDay(today, 200),
    content: { en: { purpose: 'To lift without injury.', steps: '1. Bend the knees.' } },
    ...extra,
  });
  const importOne = (cookie: string, body: Record<string, unknown>) =>
    post(cookie, '/documents/import', { password, ...body });

  beforeAll(async () => {
    bench = await testBench('polsafe', run);
    a = await bench.createHospital('a', { locales: ['en', 'ar'] });
    b = await bench.createHospital('b');
    const facility = await bench.createUnit(a, 'facility', 'F', null);
    dept = await bench.createUnit(a, 'department', 'NUR', facility);
    await bench.createRole(a, 'writer', ['policies.view', 'policies.manage']);
    writer = await bench.createStaff(a, 'writer', { role: 'writer', orgUnitId: null });
    reader = await bench.createStaff(a, 'reader', { role: 'reporter', orgUnitId: null });
    // Who decides the starting route's steps.
    await bench.createStaff(a, 'quality', { role: 'quality_officer', orgUnitId: null });
    await bench.createStaff(a, 'authority', { role: 'approving_authority', orgUnitId: null });
    await bench.owner.db.update(users).set({ orgUnitId: dept }).where(eq(users.id, writer.id));
    types = Object.fromEntries(
      (await get(a.cookie, '/types').expect(200)).body.map((t: { code: string; id: string }) => [t.code, t.id]),
    );
    categories = Object.fromEntries(
      (await get(a.cookie, '/categories').expect(200)).body.map((c: { code: string; id: string }) => [c.code, c.id]),
    );
    today = (
      (await post(writer.cookie, '/documents', {
        typeId: types.policy,
        categoryId: categories.GOV,
        title: { en: 'Probe' },
        ownerId: writer.id,
        ownerUnitId: dept,
      }).expect(201)).body as Doc
    ).today;
  }, 180_000);

  afterAll(async () => {
    await bench.app.get(PolicyCheck, { strict: false }).stop();
    await bench.close();
  });

  describe('the large body of the import routes', () => {
    // More than 100 kB, well within the 2 MB of the import routes.
    const big = () => document({ content: { en: { purpose: 'x'.repeat(19_000), steps: 'y'.repeat(19_000), scope: 'z'.repeat(19_000), definitions: 'w'.repeat(19_000), responsibilities: 'v'.repeat(19_000), records: 'u'.repeat(19_000) } } });

    it('is read only for a live session that may import', async () => {
      // A session that may import: read whole.
      await importOne(writer.cookie, big()).expect(201);
      // A credential that is no session, or a session that may not import:
      // 100 kB, as anywhere else, before the guard is reached.
      for (const auth of [
        { Authorization: 'Bearer x' },
        { Authorization: `Bearer ${a.id}.forged` },
        { Cookie: 'tl_session=x' },
        { Cookie: reader.cookie },
      ]) {
        await http().post('/policies/documents/import').set(auth).send({ password, ...big() }).expect(413);
      }
    });

    it('is read on the import paths only, matched whole', async () => {
      await http().post('/x/policies/imports').set('Cookie', writer.cookie).send({ password, documents: [big()] }).expect(413);
      await http().post('/policies/imports/').set('Cookie', writer.cookie).send({ password, documents: [big()] }).expect(413);
    });

    it('is refused nested too deeply, before it is parsed', async () => {
      const deep = `{"documents": ${'['.repeat(65)}${']'.repeat(65)}}`;
      const res = await http()
        .post('/policies/imports/check')
        .set('Cookie', writer.cookie)
        .set('Content-Type', 'application/json')
        .send(deep)
        .expect(400);
      expect(res.body).toMatchObject({ code: 'body_too_deep', max: 64 });
      // Brackets in text are text.
      await post(writer.cookie, '/imports/check', { documents: [document({ approvedBy: '['.repeat(100) })] }).expect(200);
    });
  });

  describe('the import window', () => {
    it('is open for 90 days from the day the module was first switched on, and said with the settings and the check', async () => {
      const expected = {
        startedOn: today,
        closesOn: shiftDay(today, 89),
        latestApprovedOn: shiftDay(today, -1),
        open: true,
      };
      expect((await get(writer.cookie, '/settings').expect(200)).body.importWindow).toEqual(expected);
      const checked = (await post(writer.cookie, '/imports/check', { documents: [document()] }).expect(200)).body;
      expect(checked.window).toEqual(expected);
      expect((await window(a).expect(200)).body).toMatchObject({ ...expected, setByTrustline: false, reason: null });
    });

    it('takes only documents approved before the module was first switched on', async () => {
      for (const approvedOn of [today]) {
        const res = await importOne(writer.cookie, document({ approvedOn })).expect(400);
        expect(res.body).toEqual({
          code: 'approved_after_start',
          latestApprovedOn: shiftDay(today, -1),
          startedOn: today,
        });
      }
      const batch = await post(writer.cookie, '/imports/check', {
        documents: [document(), document({ approvedOn: today })],
      }).expect(400);
      expect(batch.body.problems).toEqual([
        expect.objectContaining({ index: 1, code: 'approved_after_start', latestApprovedOn: shiftDay(today, -1) }),
      ]);
      await importOne(writer.cookie, document({ approvedOn: shiftDay(today, -1), number: `DAYBEFORE-${run}` })).expect(201);
    });

    it('is set by Trustline staff only, with a reason, within bounds', async () => {
      await http().get(`/platform/tenants/${a.id}/import-window`).expect(401);
      await http().put(`/platform/tenants/${a.id}/import-window`).send({ closesOn: today, reason: 'x' }).expect(401);
      // A hospital's own session is not the portal's.
      await http().get(`/platform/tenants/${a.id}/import-window`).set('Cookie', a.cookie).expect(401);
      await http().get('/platform/tenants/00000000-0000-4000-8000-000000000000/import-window').set('Cookie', bench.platform).expect(404);
      for (const body of [{}, { closesOn: today }, { reason: 'Late start' }, { closesOn: 'soon', reason: 'x' }, { closesOn: today, reason: '' }, { closesOn: today, reason: 'x', tenantId: b.id }]) {
        await setWindow(a, body).expect(400);
      }
      for (const closesOn of [shiftDay(today, -2), shiftDay(today, 367)]) {
        expect((await setWindow(a, { closesOn, reason: 'Out of bounds' }).expect(400)).body).toEqual({
          code: 'invalid_closes_on',
          earliest: shiftDay(today, -1),
          latest: shiftDay(today, 366),
        });
      }
    });

    it('closed, refuses imports and their check with when it closed; reopened, takes them again; each change audited', async () => {
      await setWindow(a, { closesOn: shiftDay(today, -1), reason: 'Migration finished' }).expect(200);
      const closed = {
        code: 'import_window_closed',
        closedOn: shiftDay(today, -1),
        latestApprovedOn: shiftDay(today, -1),
        startedOn: today,
      };
      expect((await importOne(writer.cookie, document()).expect(403)).body).toEqual(closed);
      expect((await post(writer.cookie, '/imports', { password, documents: [document()] }).expect(403)).body).toEqual(closed);
      expect((await post(writer.cookie, '/imports/check', { documents: [document()] }).expect(403)).body).toEqual(closed);
      expect((await get(writer.cookie, '/settings').expect(200)).body.importWindow.open).toBe(false);
      // The other hospital's is its own.
      expect((await window(b).expect(200)).body.open).toBe(true);

      const reopened = await setWindow(a, { closesOn: shiftDay(today, 30), reason: 'Second site joins' }).expect(200);
      expect(reopened.body).toMatchObject({ closesOn: shiftDay(today, 30), open: true, setByTrustline: true, reason: 'Second site joins' });
      await importOne(writer.cookie, document({ number: `REOPENED-${run}` })).expect(201);

      // In the client's own log, by Trustline's staff, never by one of its own.
      const entries = await bench.owner.db
        .select({ actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'import_window_changed')))
        .orderBy(auditLog.occurredAt);
      expect(entries).toEqual([
        {
          actorId: null,
          changes: expect.objectContaining({ closesOn: { from: shiftDay(today, 89), to: shiftDay(today, -1) }, reason: 'Migration finished' }),
        },
        {
          actorId: null,
          changes: expect.objectContaining({ closesOn: { from: shiftDay(today, -1), to: shiftDay(today, 30) }, reason: 'Second site joins' }),
        },
      ]);
      const platformEntries = await bench.owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from platform_audit_log where target_tenant_id = ${a.id} and action = 'import_window_set'`,
      );
      expect(platformEntries.rows[0].n).toBe(2);
    });

    it('starts on the first day a client has the module', async () => {
      const started = await bench.owner.db.execute<{ module: string; started_on: string }>(
        sql`select module, started_on::text from module_starts where tenant_id = ${b.id} and module = 'policies'`,
      );
      expect(started.rows).toEqual([{ module: 'policies', started_on: expect.any(String) }]);
      // Switched off and on again, it keeps its first day.
      await bench.owner.db.execute(sql`update module_starts set started_on = '2020-01-01' where tenant_id = ${b.id} and module = 'policies'`);
      await http().patch(`/platform/tenants/${b.id}/subscription`).set('Cookie', bench.platform).send({ status: 'cancelled' }).expect(200);
      await http().patch(`/platform/tenants/${b.id}/subscription`).set('Cookie', bench.platform).send({ status: 'active' }).expect(200);
      expect((await window(b).expect(200)).body.startedOn).toBe('2020-01-01');
    });
  });

  describe('numbers', () => {
    it('are kept normalised: another script’s digits and fullwidth forms are the same number', async () => {
      const checked = (await post(writer.cookie, '/imports/check', {
        documents: [document({ number: `NORM${run.slice(0, 2).toUpperCase()}-٠٤٢` }), document({ number: 'ＦＷ-７' })],
      }).expect(200)).body;
      expect(checked.documents.map((d: { number: string }) => d.number)).toEqual([
        `NORM${run.slice(0, 2).toUpperCase()}-042`,
        'FW-7',
      ]);
      const kept = (await importOne(writer.cookie, document({ number: `NORM${run.slice(0, 2).toUpperCase()}-٠٤٢` })).expect(201)).body;
      expect(kept.number).toBe(`NORM${run.slice(0, 2).toUpperCase()}-042`);
      // The same number however it is written.
      for (const same of [`NORM${run.slice(0, 2).toUpperCase()}-042`, `norm${run.slice(0, 2).toLowerCase()}-०४२`]) {
        expect((await importOne(writer.cookie, document({ number: same })).expect(409)).body.code).toBe('number_taken');
      }
    });

    it('in Trustline’s shape in another script’s digits, are counted in their series', async () => {
      const checked = (await post(writer.cookie, '/imports/check', { documents: [document({ number: 'PRC-SAF-٠٠٧' })] }).expect(200)).body;
      expect(checked.documents[0]).toMatchObject({ number: 'PRC-SAF-007', series: 'PRC-SAF' });
    });

    it('are refused when their letters mix scripts', async () => {
      for (const number of ['РОL-GOV-007', 'POLα-1', 'ПОЛ-GOV-1']) {
        expect((await importOne(writer.cookie, document({ number })).expect(400)).body).toEqual({
          code: 'invalid_number',
          reason: 'mixed_scripts',
        });
      }
      // One script, any script, is a number.
      await importOne(writer.cookie, document({ number: `ПОЛ-${parseInt(run, 16)}` })).expect(201);
    });
  });

  describe('the authoritative language of a version', () => {
    it('is recorded when it is sent for review and kept whatever the setting becomes; a draft follows the setting', async () => {
      const doc = (await post(writer.cookie, '/documents', {
        typeId: types.procedure,
        categoryId: categories.SAF,
        title: { en: 'Recorded language' },
        ownerId: writer.id,
        ownerUnitId: dept,
      }).expect(201)).body as Doc;
      let version = (await get(writer.cookie, `/documents/${doc.id}/versions/${doc.inProgress!.id}`).expect(200)).body as Version;
      expect(version.authoritativeLocale).toBeNull();
      version = (await patch(writer.cookie, `/documents/${doc.id}/versions/${version.id}`, {
        revision: version.revision,
        content: { en: { purpose: 'P.', scope: 'S.', responsibilities: 'R.', steps: '1.' } },
      }).expect(200)).body;
      version = (await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/submit`, { revision: version.revision }).expect(200)).body;
      expect(version.authoritativeLocale).toBe('en');
      // Signed with it.
      const [row] = await bench.owner.db.select().from(documentVersions).where(eq(documentVersions.id, version.id));
      expect(row.signsAuthoritativeLocale).toBe(true);
      expect(version.contentHash).toBe(contentHash(signedVersion({ id: doc.id, number: doc.number }, row)));
      expect(signedVersion({ id: doc.id, number: doc.number }, row)).toHaveProperty('authoritativeLocale', 'en');

      // The setting changes: the version in review keeps English; a new draft follows Arabic.
      const settings = (await get(a.cookie, '/settings').expect(200)).body;
      await http().patch('/policies/settings').set('Cookie', a.cookie).send({ authoritativeLocale: 'ar', revision: settings.revision }).expect(200);
      try {
        const inReview = (await get(writer.cookie, `/documents/${doc.id}/versions/${version.id}`).expect(200)).body as Version;
        expect(inReview.authoritativeLocale).toBe('en');
        expect(inReview.languageStatus.authoritative).toBe('en');
        const draft = (await post(writer.cookie, '/documents', {
          typeId: types.procedure,
          categoryId: categories.SAF,
          title: { en: 'Follows the setting' },
          ownerId: writer.id,
          ownerUnitId: dept,
        }).expect(201)).body as Doc;
        const drafted = (await get(writer.cookie, `/documents/${draft.id}/versions/${draft.inProgress!.id}`).expect(200)).body as Version;
        expect(drafted.languageStatus.authoritative).toBe('ar');
      } finally {
        const now = (await get(a.cookie, '/settings').expect(200)).body;
        await http().patch('/policies/settings').set('Cookie', a.cookie).send({ authoritativeLocale: null, revision: now.revision }).expect(200);
      }

      // The database keeps it as it keeps the text.
      await expect(
        bench.owner.db.update(documentVersions).set({ authoritativeLocale: 'ar' }).where(eq(documentVersions.id, version.id)),
      ).rejects.toThrow();
    });

    it('keeps the earlier form of what is signed for a version recorded by the migration', () => {
      const doc = { id: 'd', number: 'N-1' };
      const version = {
        id: 'v',
        version: 1,
        sections: [],
        content: {},
        changeSummary: null,
        acknowledgementRequired: false,
        acknowledgeWithinDays: 14,
      };
      const before = signedVersion(doc, { ...version, authoritativeLocale: 'en', signsAuthoritativeLocale: false });
      expect(before).not.toHaveProperty('authoritativeLocale');
      expect(Object.keys(before)).toEqual([
        'documentId',
        'number',
        'versionId',
        'version',
        'sections',
        'content',
        'changeSummary',
        'acknowledgementRequired',
        'acknowledgeWithinDays',
      ]);
    });
  });

  describe('the starting route', () => {
    it('falls back to an Administrator approval when the client has no built-in Approving authority, and says so', async () => {
      const provisioning = bench.app.get(ProvisioningService);
      // As for a client whose own role holds the code: no built-in one.
      // The procedure type made routeless, as a type is before its route.
      const [type] = await bench.owner.db
        .select({ id: documentTypes.id })
        .from(documentTypes)
        .where(and(eq(documentTypes.tenantId, b.id), eq(documentTypes.code, 'procedure')));
      const routes = await bench.owner.db
        .select({ id: approvalRoutes.id })
        .from(approvalRoutes)
        .where(and(eq(approvalRoutes.tenantId, b.id), eq(approvalRoutes.documentTypeId, type.id)));
      for (const r of routes) {
        await bench.owner.db.delete(approvalRouteSteps).where(eq(approvalRouteSteps.routeId, r.id));
        await bench.owner.db.delete(approvalRoutes).where(eq(approvalRoutes.id, r.id));
      }
      await bench.owner.db
        .update(roles)
        .set({ isSystem: false })
        .where(and(eq(roles.tenantId, b.id), eq(roles.code, 'approving_authority')));

      await bench.owner.db.transaction((tx) => provisioning.ensurePolicyDefaults(tx, b.id));

      const steps = await bench.owner.db
        .select({ position: approvalRouteSteps.position, kind: approvalRouteSteps.kind, role: roles.code })
        .from(approvalRouteSteps)
        .innerJoin(approvalRoutes, eq(approvalRoutes.id, approvalRouteSteps.routeId))
        .innerJoin(roles, eq(roles.id, approvalRouteSteps.assigneeRoleId))
        .where(and(eq(approvalRoutes.tenantId, b.id), eq(approvalRoutes.documentTypeId, type.id)))
        .orderBy(approvalRouteSteps.position);
      expect(steps).toEqual([
        { position: 1, kind: 'review', role: 'quality_officer' },
        { position: 2, kind: 'approve', role: 'administrator' },
      ]);
      const [entry] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, b.id), eq(auditLog.action, 'approval_route_created')));
      expect(entry.changes).toMatchObject({
        documentTypeId: type.id,
        startingRoute: true,
        fallback: { missing: ['approving_authority'], approvedBy: 'administrator' },
      });
      // The documents of b are none of a's.
      expect(
        (await bench.owner.db.select({ id: documents.id }).from(documents).where(eq(documents.tenantId, b.id))).length,
      ).toBe(0);
    });
  });
});
