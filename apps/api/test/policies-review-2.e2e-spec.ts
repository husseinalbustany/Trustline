import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  approvalRuns,
  approvalRunSteps,
  auditLog,
  documentAcknowledgements,
  notifications,
  signatures,
  users,
} from '../src/database/schema.js';
import { dayOf, isoWeekOf, shiftDay, startOfDay } from '../src/i18n/time-zones.js';
import { PolicyCheck } from '../src/policies/policy-check.service.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const DAY = 86_400_000;

type Version = {
  id: string;
  version: number;
  status: string;
  revision: number;
  moves: string[];
  [key: string]: unknown;
};
type Doc = {
  id: string;
  number: string;
  revision: number;
  inProgress: { id: string } | null;
  published: { id: string } | null;
  [key: string]: unknown;
};

/** The cells of a CSV file the API wrote: every cell quoted, CRLF lines. */
function readCsv(text: string) {
  expect(text.charCodeAt(0)).toBe(0xfeff);
  return text
    .slice(1)
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) =>
      [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"')),
    );
}

/**
 * The policies module after its quality review (round 2) and language
 * review 6: the authoritative language and lagging translations, earlier
 * review rounds and what was returned, the control block, the exports,
 * the maximum review period and the reason for changing one, the history
 * of a document's details, the roles list for managers, the revisions of
 * types and categories, overdue steps, publishing failures and the weekly
 * digest. Each new route is tried without a session, without the
 * permission, on another client's record, with bad input, and working.
 */
describe('policies after review 2', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  let check: PolicyCheck;
  const http = () => bench.http();
  const password = `hospital-pass-${run}`;

  let a: Hospital;
  let b: Hospital;
  let facility: string;
  let dept: string;
  let ward: string;
  let pharmacy: string;
  let writer: Staff; // manages documents everywhere
  let phaWriter: Staff; // manages documents of the pharmacy only
  let quality: Staff;
  let approver: Staff;
  let reader: Staff; // reads, works on the ward
  let leaver: Staff; // reads, works on the ward, and leaves
  let auditor: Staff; // sees every document
  let deptManager: Staff; // department manager of dept
  let nobody: Staff;
  let bWriter: Staff;
  let types: Record<string, string>;
  let categories: Record<string, string>;

  const get = (cookie: string, url: string) =>
    http().get(`/policies${url}`).set('Cookie', cookie);
  const post = (cookie: string, url: string, body: unknown = {}) =>
    http().post(`/policies${url}`).set('Cookie', cookie).send(body as object);
  const patch = (cookie: string, url: string, body: unknown) =>
    http().patch(`/policies${url}`).set('Cookie', cookie).send(body as object);

  async function staff(
    h: Hospital,
    name: string,
    role: string | string[] | null,
    grantUnit: string | null,
    homeUnit: string | null,
  ) {
    const person = await bench.createStaff(
      h,
      name,
      role ? [role].flat().map((r) => ({ role: r, orgUnitId: grantUnit })) : null,
    );
    if (homeUnit) {
      await bench.owner.db
        .update(users)
        .set({ orgUnitId: homeUnit })
        .where(eq(users.id, person.id));
    }
    return person;
  }

  const FULL_EN = {
    purpose: 'To make a spill safe quickly.',
    scope: 'Everyone working on the premises.',
    responsibilities: 'The person who finds it reports it.',
    steps: '1. Mark the area.\n2. Clean it.',
    definitions: 'A spill: any liquid on the floor.',
  };
  const FULL_AR = {
    purpose: 'جعل الانسكاب آمنًا بسرعة.',
    scope: 'كل من يعمل في المكان.',
    responsibilities: 'من يجده يبلّغ عنه.',
    steps: '1. حدّد المكان.\n2. نظّفه.',
  };

  const newDocument = (cookie: string, extra: Record<string, unknown> = {}) =>
    post(cookie, '/documents', {
      typeId: types.procedure,
      categoryId: categories.SAF,
      title: { en: 'Handling a spill', ar: 'التعامل مع الانسكاب' },
      ownerId: writer.id,
      ownerUnitId: dept,
      ...extra,
    });

  const versionOf = async (cookie: string, docId: string, versionId: string) =>
    (await get(cookie, `/documents/${docId}/versions/${versionId}`).expect(200)).body as Version;

  const write = (doc: { id: string }, version: Version, body: Record<string, unknown>) =>
    patch(writer.cookie, `/documents/${doc.id}/versions/${version.id}`, {
      revision: version.revision,
      ...body,
    });

  const act = async (
    who: Staff,
    doc: { id: string },
    version: Version,
    action: 'submit' | 'approve' | 'return' | 'publish',
    extra: Record<string, unknown> = {},
  ) =>
    (
      await post(who.cookie, `/documents/${doc.id}/versions/${version.id}/${action}`, {
        revision: version.revision,
        ...(action === 'approve' && { password }),
        ...(action === 'return' && { comment: 'Say who records it.' }),
        ...extra,
      }).expect(200)
    ).body as Version;

  /** Written in both languages and sent for review. */
  async function inReview(extra: Record<string, unknown> = {}, content: Record<string, unknown> = { en: FULL_EN, ar: FULL_AR }) {
    const doc = (await newDocument(writer.cookie, extra).expect(201)).body as Doc;
    let version = await versionOf(writer.cookie, doc.id, doc.inProgress!.id);
    version = (await write(doc, version, { content }).expect(200)).body;
    version = await act(writer, doc, version, 'submit');
    return { doc, version };
  }

  async function publishedDoc(extra: Record<string, unknown> = {}, content?: Record<string, unknown>) {
    const { doc, version } = await inReview(extra, content);
    const reviewed = await act(quality, doc, version, 'approve');
    const approved = await act(approver, doc, reviewed, 'approve');
    const live = await act(writer, doc, approved, 'publish');
    return { doc, version: live };
  }

  /** The next version of a published document, written and sent for review. */
  async function nextVersion(doc: Doc, content: Record<string, unknown>) {
    let v = (await post(writer.cookie, `/documents/${doc.id}/versions`).expect(201)).body as Version;
    v = (await write(doc, v, { content, changeSummary: { en: 'Steps changed.' } }).expect(200)).body;
    return act(writer, doc, v, 'submit');
  }

  const notificationsOf = async (cookie: string) =>
    (await http().get('/notifications?pageSize=100').set('Cookie', cookie).expect(200)).body.items as {
      kind: string;
      document: { id: string } | null;
      incident: unknown;
      data: Record<string, unknown>;
    }[];

  beforeAll(async () => {
    bench = await testBench('polr2', run);
    check = bench.app.get(PolicyCheck, { strict: false });
    a = await bench.createHospital('a', { locales: ['en', 'ar'] });
    b = await bench.createHospital('b');
    facility = await bench.createUnit(a, 'facility', 'F', null);
    dept = await bench.createUnit(a, 'department', 'NUR', facility);
    ward = await bench.createUnit(a, 'unit', 'WARD', dept);
    pharmacy = await bench.createUnit(a, 'department', 'PHA', facility);
    await bench.createRole(a, 'writer', ['policies.view', 'policies.manage']);
    await bench.createRole(a, 'auditor', ['policies.view_all']);
    await bench.createRole(a, 'none', ['reports.view']);
    writer = await staff(a, 'writer', 'writer', null, dept);
    phaWriter = await staff(a, 'phawriter', 'writer', pharmacy, pharmacy);
    quality = await staff(a, 'quality', 'quality_officer', null, facility);
    approver = await staff(a, 'approver', ['administrator', 'approving_authority'], null, facility);
    reader = await staff(a, 'reader', 'reporter', null, ward);
    leaver = await staff(a, 'leaver', 'reporter', null, ward);
    auditor = await staff(a, 'auditor', 'auditor', null, facility);
    deptManager = await staff(a, 'deptmgr', 'department_manager', dept, dept);
    nobody = await staff(a, 'nobody', 'none', null, ward);
    const bUnit = await bench.createUnit(b, 'facility', 'F', null);
    await bench.createRole(b, 'writer', ['policies.view', 'policies.manage']);
    bWriter = await staff(b, 'bwriter', 'writer', null, bUnit);
    types = Object.fromEntries(
      (await get(a.cookie, '/types').expect(200)).body.map((t: { code: string; id: string }) => [t.code, t.id]),
    );
    categories = Object.fromEntries(
      (await get(a.cookie, '/categories').expect(200)).body.map((c: { code: string; id: string }) => [c.code, c.id]),
    );
  }, 180_000);

  afterAll(async () => {
    await check.stop();
    await bench.close();
  });

  describe('the roles, for those who manage documents', () => {
    it('lists names and ids, and whether each may be named in a step, for any manager of documents', async () => {
      await http().get('/policies/roles').expect(401);
      expect((await get(reader.cookie, '/roles').expect(403)).body).toEqual({
        code: 'missing_permission',
        permission: 'policies.manage',
      });
      await get(auditor.cookie, '/roles').expect(403);
      // A manager of one department only, who manages neither users nor roles.
      const list = (await get(phaWriter.cookie, '/roles').expect(200)).body as {
        id: string;
        code: string;
        name: Record<string, string>;
        approves: boolean;
        isSystem: boolean;
      }[];
      const byCode = Object.fromEntries(list.map((r) => [r.code, r]));
      expect(byCode.administrator).toMatchObject({ id: a.roles.administrator, approves: true, isSystem: true });
      expect(byCode.reporter).toMatchObject({ approves: false });
      expect(byCode.writer).toMatchObject({ id: a.roles.writer, approves: false, isSystem: false });
      // Names and ids only: not what each allows.
      expect(Object.keys(list[0]).sort()).toEqual(['approves', 'code', 'id', 'isSystem', 'name']);
      // The client's own only.
      expect(list.map((r) => r.id)).not.toContain(b.roles.administrator);
    });
  });

  describe('the longest review period', () => {
    it('is the default until a manager for the whole organization sets it, and holds for documents and types', async () => {
      await http().get('/policies/settings').expect(401);
      await get(nobody.cookie, '/settings').expect(403);
      expect((await get(reader.cookie, '/settings').expect(200)).body).toEqual({
        maxReviewMonths: 36,
        authoritativeLocale: null,
        authoritative: 'en',
        revision: 1,
        // When existing documents may be imported (security review 7).
        importWindow: expect.objectContaining({ open: true }),
      });
      await http().patch('/policies/settings').send({ maxReviewMonths: 48, revision: 1 }).expect(401);
      // Only for the whole organization.
      expect((await patch(phaWriter.cookie, '/settings', { maxReviewMonths: 48, revision: 1 }).expect(403)).body.code).toBe(
        'missing_permission',
      );
      await patch(reader.cookie, '/settings', { maxReviewMonths: 48, revision: 1 }).expect(403);
      for (const bad of [{ maxReviewMonths: 0, revision: 1 }, { maxReviewMonths: 121, revision: 1 }, { maxReviewMonths: 48 }, { maxReviewMonths: 48, revision: 1, extra: true }]) {
        await patch(writer.cookie, '/settings', bad).expect(400);
      }
      expect((await patch(writer.cookie, '/settings', { maxReviewMonths: 48, revision: 7 }).expect(409)).body.code).toBe('stale_settings');
      // Not below a type's own period: the policy type's 36 months.
      const below = (await patch(writer.cookie, '/settings', { maxReviewMonths: 30, revision: 1 }).expect(409)).body;
      expect(below).toEqual({
        code: 'type_exceeds_max',
        types: [{ id: types.policy, code: 'policy', defaultReviewMonths: 36 }],
      });
      // Lowered to 24 once the type is lowered, the policy type kept at 24.
      const set = (await patch(writer.cookie, '/settings', { maxReviewMonths: 48, revision: 1 }).expect(200)).body;
      expect(set).toEqual({ maxReviewMonths: 48, authoritativeLocale: null, authoritative: 'en', revision: 2, importWindow: expect.objectContaining({ open: true }) });
      const [entry] = await bench.owner.db
        .select({ actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'document_settings_updated')));
      expect(entry).toEqual({ actorId: writer.id, changes: { maxReviewMonths: { from: 36, to: 48 } } });
      // Another client's settings are its own.
      expect((await get(bWriter.cookie, '/settings').expect(200)).body).toEqual({
        maxReviewMonths: 36,
        authoritativeLocale: null,
        authoritative: 'en',
        revision: 1,
        importWindow: expect.objectContaining({ open: true }),
      });

      // Within it, documents and types.
      expect((await newDocument(writer.cookie, { reviewMonths: 60 }).expect(400)).body).toEqual({
        code: 'review_period_too_long',
        max: 48,
      });
      const doc = (await newDocument(writer.cookie, { reviewMonths: 48 }).expect(201)).body as Doc;
      expect(
        (await patch(writer.cookie, `/documents/${doc.id}`, { reviewMonths: 60, reason: 'Longer.', revision: doc.revision }).expect(400)).body,
      ).toEqual({ code: 'review_period_too_long', max: 48 });
      const sections = [{ key: 'items', name: { en: 'Items' }, required: true }];
      expect(
        (await post(writer.cookie, '/types', { code: 'longone', name: { en: 'Long' }, numberPrefix: 'LNG', sections, defaultReviewMonths: 60 }).expect(400)).body.code,
      ).toBe('review_period_too_long');
      const policy = (await get(writer.cookie, '/types').expect(200)).body.find((t: { id: string }) => t.id === types.policy);
      expect(
        (await patch(writer.cookie, `/types/${types.policy}`, { defaultReviewMonths: 60, revision: policy.revision }).expect(400)).body.code,
      ).toBe('review_period_too_long');
      // Back to the default for the rest of these tests.
      await patch(writer.cookie, '/settings', { maxReviewMonths: 36, revision: 2 }).expect(200);
    });

    it('does not switch a type back on with a review period above the maximum', async () => {
      const sections = [{ key: 'items', name: { en: 'Items' }, required: true }];
      const code = `long${run}`;
      let settings = (await get(writer.cookie, '/settings').expect(200)).body;
      settings = (await patch(writer.cookie, '/settings', { maxReviewMonths: 48, revision: settings.revision }).expect(200)).body;
      let type = (
        await post(writer.cookie, '/types', { code, name: { en: 'Long' }, numberPrefix: 'LNG', sections, defaultReviewMonths: 48 }).expect(201)
      ).body;
      type = (await patch(writer.cookie, `/types/${type.id}`, { active: false, revision: type.revision }).expect(200)).body;
      // Off, it does not hold the maximum up.
      settings = (await patch(writer.cookie, '/settings', { maxReviewMonths: 36, revision: settings.revision }).expect(200)).body;
      await http().patch(`/policies/types/${type.id}`).send({ active: true, revision: type.revision }).expect(401);
      await patch(reader.cookie, `/types/${type.id}`, { active: true, revision: type.revision }).expect(403);
      await patch(bWriter.cookie, `/types/${type.id}`, { active: true, revision: type.revision }).expect(404);
      await patch(writer.cookie, `/types/${type.id}`, { active: 'yes', revision: type.revision }).expect(400);
      // Back on with its 48 months: refused, and nothing changed.
      expect((await patch(writer.cookie, `/types/${type.id}`, { active: true, revision: type.revision }).expect(400)).body).toEqual({
        code: 'review_period_too_long',
        max: 36,
      });
      const still = (await get(writer.cookie, '/types?includeInactive=true').expect(200)).body.find((t: { id: string }) => t.id === type.id);
      expect(still).toMatchObject({ active: false, defaultReviewMonths: 48, revision: type.revision });
      // Changed while off, still off: no check needed.
      type = (await patch(writer.cookie, `/types/${type.id}`, { name: { en: 'Longer' }, revision: type.revision }).expect(200)).body;
      // Back on with a period within the maximum, in the same change.
      const on = (await patch(writer.cookie, `/types/${type.id}`, { active: true, defaultReviewMonths: 24, revision: type.revision }).expect(200)).body;
      expect(on).toMatchObject({ active: true, defaultReviewMonths: 24 });
    });
  });

  describe("a document's history of changes", () => {
    it('needs a reason for a new review period, and shows who changed which detail, from what to what', async () => {
      const doc = (await newDocument(writer.cookie).expect(201)).body as Doc;
      expect(
        (await patch(writer.cookie, `/documents/${doc.id}`, { reviewMonths: 12, revision: doc.revision }).expect(400)).body,
      ).toEqual({ code: 'reason_required', field: 'reviewMonths' });
      // The same period again is no change, and needs none.
      await patch(writer.cookie, `/documents/${doc.id}`, { reviewMonths: 24, revision: doc.revision }).expect(200);
      let current = (
        await patch(writer.cookie, `/documents/${doc.id}`, {
          reviewMonths: 12,
          reason: 'Checked every year, as the ward asks.',
          revision: doc.revision,
        }).expect(200)
      ).body as Doc;
      current = (
        await patch(writer.cookie, `/documents/${doc.id}`, {
          ownerId: quality.id,
          audience: { orgUnitIds: [ward], roleIds: [a.roles.reporter] },
          confidentiality: 'restricted',
          revision: current.revision,
        }).expect(200)
      ).body as Doc;
      await patch(writer.cookie, `/documents/${doc.id}`, {
        title: { en: 'Handling any spill', ar: 'التعامل مع أي انسكاب' },
        ownerUnitId: ward,
        revision: current.revision,
      }).expect(200);

      await http().get(`/policies/documents/${doc.id}/changes`).expect(401);
      expect((await get(reader.cookie, `/documents/${doc.id}/changes`).expect(403)).body.code).toBe('missing_permission');
      // A manager of another department does not see this draft at all.
      await get(phaWriter.cookie, `/documents/${doc.id}/changes`).expect(404);
      await get(bWriter.cookie, `/documents/${doc.id}/changes`).expect(404);
      await get(writer.cookie, '/documents/not-an-id/changes').expect(404);
      // The department's manager sees it in full, as does the auditor.
      await get(deptManager.cookie, `/documents/${doc.id}/changes`).expect(200);
      const history = (await get(auditor.cookie, `/documents/${doc.id}/changes`).expect(200)).body;
      expect(history.total).toBe(3);
      // Newest first.
      const [title, people, period] = history.items;
      expect(period).toMatchObject({
        by: { id: writer.id, name: { en: 'Person writer' } },
        reason: 'Checked every year, as the ward asks.',
        changes: [{ field: 'reviewMonths', from: 24, to: 12 }],
      });
      expect(people.reason).toBeNull();
      expect(people.changes).toEqual([
        {
          field: 'owner',
          from: { id: writer.id, name: { en: 'Person writer' } },
          to: { id: quality.id, name: { en: 'Person quality' } },
        },
        {
          field: 'audience',
          from: { wholeOrganization: true, orgUnits: [], roles: [] },
          to: {
            wholeOrganization: false,
            orgUnits: [{ id: ward, name: { en: 'Unit WARD' } }],
            roles: [{ id: a.roles.reporter, name: expect.objectContaining({ en: 'Reporter' }) }],
          },
        },
        { field: 'confidentiality', from: 'all_staff', to: 'restricted' },
      ]);
      expect(title.changes.map((c: { field: string }) => c.field)).toEqual(['title', 'ownerUnit']);
      expect(title.changes[1]).toEqual({
        field: 'ownerUnit',
        from: { id: dept, name: { en: 'Unit NUR' } },
        to: { id: ward, name: { en: 'Unit WARD' } },
      });

      // A page at a time, the total counting every change, not the page.
      const first = (await get(auditor.cookie, `/documents/${doc.id}/changes?pageSize=2`).expect(200)).body;
      expect(first.total).toBe(3);
      expect(first.items.map((i: { id: string }) => i.id)).toEqual([title.id, people.id]);
      const second = (await get(auditor.cookie, `/documents/${doc.id}/changes?page=2&pageSize=2`).expect(200)).body;
      expect(second).toMatchObject({ total: 3, items: [{ id: period.id }] });
      expect((await get(auditor.cookie, `/documents/${doc.id}/changes?page=3&pageSize=2`).expect(200)).body).toEqual({ items: [], total: 3 });
      for (const bad of ['pageSize=0', 'pageSize=201', 'page=0', 'page=x', 'order=asc']) {
        await get(auditor.cookie, `/documents/${doc.id}/changes?${bad}`).expect(400);
      }
      await http().get(`/policies/documents/${doc.id}/changes?pageSize=2`).expect(401);
      await get(reader.cookie, `/documents/${doc.id}/changes?pageSize=2`).expect(403);
      await get(bWriter.cookie, `/documents/${doc.id}/changes?pageSize=2`).expect(404);
    });
  });

  describe('languages, review rounds and the control block', () => {
    let doc: Doc;
    let v1: Version;
    let v2: Version;

    it('says which sections fall back to the authoritative language, and which lag behind it', async () => {
      ({ doc, version: v1 } = await publishedDoc({ acknowledgementRequired: true }));
      const first = await versionOf(reader.cookie, doc.id, v1.id);
      expect(first.source).toBe('written');
      expect(first.languageStatus).toMatchObject({
        authoritative: 'en',
        comparedWith: null,
        lagging: false,
      });
      const states = (v: Version) =>
        Object.fromEntries(
          (v.languageStatus as { sections: { key: string; locales: Record<string, string> }[] }).sections.map((s) => [
            s.key,
            s.locales.ar,
          ]),
        );
      expect(states(first)).toMatchObject({
        purpose: 'written',
        definitions: 'fallback',
        records: 'empty',
        steps: 'written',
      });
      // Version 2 changes the steps in English only, and the scope in both.
      v2 = await nextVersion(doc, {
        en: { steps: '1. Mark the area.\n2. Clean it.\n3. Record it.', scope: 'Everyone, visitors too.' },
        ar: { scope: 'الجميع، والزوار أيضًا.' },
      });
      const review = await versionOf(quality.cookie, doc.id, v2.id);
      expect(review.languageStatus).toMatchObject({
        authoritative: 'en',
        comparedWith: { id: v1.id, version: 1 },
        lagging: true,
        byLocale: { ar: { lagging: 1, fallback: 1 } },
      });
      expect(states(review)).toMatchObject({ steps: 'lagging', scope: 'written', purpose: 'written', definitions: 'fallback' });
    });

    it('keeps earlier review rounds and their comments, and compares with what was returned', async () => {
      const back = await act(quality, doc, v2, 'return', { comment: 'Add the Arabic step 3.' });
      expect(back.status).toBe('draft');
      const fixed = (
        await write(doc, back, { content: { ar: { steps: '1. حدّد المكان.\n2. نظّفه.\n3. سجّله.' } } }).expect(200)
      ).body as Version;
      const again = await act(writer, doc, fixed, 'submit');
      const seen = await versionOf(quality.cookie, doc.id, again.id);
      const rounds = seen.rounds as { status: string; snapshot: boolean; steps: { status: string; comment: string | null }[] }[];
      expect(rounds.map((r) => r.status)).toEqual(['in_progress', 'returned']);
      expect(rounds.every((r) => r.snapshot)).toBe(true);
      expect(rounds[1].steps[0]).toMatchObject({ status: 'returned', comment: 'Add the Arabic step 3.' });
      const since = seen.sinceReturned as {
        runId: string;
        returnedAt: string;
        changeSummaryChanged: boolean;
        comparison: { key: string; changed: boolean; locales: Record<string, { changed: boolean }> }[];
      };
      expect(since.runId).toBe((seen.rounds as { id: string }[])[1].id);
      expect(since.returnedAt).toBeTruthy();
      expect(since.changeSummaryChanged).toBe(false);
      const steps = since.comparison.find((s) => s.key === 'steps')!;
      expect(steps).toMatchObject({ changed: true, locales: { ar: { changed: true }, en: { changed: false } } });
      expect(since.comparison.find((s) => s.key === 'purpose')!.changed).toBe(false);
      // Against the published version, the English steps changed too.
      expect((seen.comparison as { key: string; changed: boolean }[]).find((s) => s.key === 'steps')!.changed).toBe(true);
      // The Arabic steps no longer lag.
      expect(seen.languageStatus).toMatchObject({ lagging: false });
      // A reader sees no round of anything.
      const readerView = await versionOf(reader.cookie, doc.id, v1.id);
      expect(readerView.rounds).toEqual([]);
      expect(readerView.sinceReturned).toBeNull();
      v2 = seen;
    });

    it('says in the control block who prepared it, its title, and whether it is the copy in force', async () => {
      const reviewed = await act(quality, doc, v2, 'approve');
      const approved = await act(approver, doc, reviewed, 'approve');
      const live = await act(writer, doc, approved, 'publish');
      const now = await versionOf(reader.cookie, doc.id, live.id);
      expect(now.today).toBe(dayOf(new Date(), 'UTC'));
      expect(now.control).toMatchObject({
        number: doc.number,
        title: { en: 'Handling a spill', ar: 'التعامل مع الانسكاب' },
        version: 2,
        status: 'published',
        documentStatus: 'active',
        inForce: true,
        preparedBy: { id: writer.id },
      });
      const old = await versionOf(writer.cookie, doc.id, v1.id);
      expect(old.control).toMatchObject({ status: 'superseded', inForce: false, nextReviewOn: null });
      // Readers of the published version see where its languages stand.
      expect(now.languageStatus).toMatchObject({ comparedWith: { version: 1 } });
    });

    it('puts the version in the data of document notifications, so a link can open it', async () => {
      const [assigned] = (await notificationsOf(quality.cookie)).filter(
        (n) => n.kind === 'document_step_assigned' && n.document?.id === doc.id,
      );
      expect(assigned.data).toMatchObject({ versionId: v2.id, version: 2, number: doc.number });
      const returned = (await notificationsOf(writer.cookie)).find((n) => n.kind === 'document_returned' && n.document?.id === doc.id)!;
      expect(returned.data).toMatchObject({ versionId: v2.id });
      const published = (await notificationsOf(reader.cookie)).find((n) => n.kind === 'document_published' && n.document?.id === doc.id)!;
      expect(published.data.versionId).toBeTruthy();
    });
  });

  describe('the master list as a file', () => {
    let open: Doc;
    let restricted: Doc;
    let draft: Doc;

    beforeAll(async () => {
      ({ doc: open } = await publishedDoc({
        title: { en: '=HYPERLINK("x")', ar: 'التعامل مع الانسكاب' },
        keywords: ['spill'],
      }));
      ({ doc: restricted } = await publishedDoc({
        confidentiality: 'restricted',
        audience: { orgUnitIds: [pharmacy], roleIds: [] },
        title: { en: 'Pharmacy only' },
      }));
      draft = (await newDocument(writer.cookie, { title: { en: 'Still a draft' } }).expect(201)).body as Doc;
    }, 120_000);

    it('holds what the caller sees of the library, in their language, ready for a spreadsheet', async () => {
      await http().get('/policies/exports/documents').expect(401);
      expect((await get(nobody.cookie, '/exports/documents').expect(403)).body.code).toBe('missing_permission');
      await get(writer.cookie, '/exports/documents?sort=nonsense').expect(400);
      await get(writer.cookie, '/exports/documents?page=2').expect(400);
      await get(writer.cookie, '/exports/documents?locale=de').expect(400);
      // French is not one of this client's languages.
      expect((await get(writer.cookie, '/exports/documents?locale=fr').expect(400)).body.code).toBe('language_mismatch');

      const res = await get(writer.cookie, '/exports/documents?locale=ar').expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="documents-\d{4}-\d{2}-\d{2}\.csv"$/);
      expect(res.headers['cache-control']).toBe('no-store');
      const rows = readCsv(res.text);
      expect(rows[0].slice(0, 5)).toEqual(['الرقم', 'العنوان', 'النوع', 'الفئة', 'الجهة المسؤولة']);
      const byNumber = new Map(rows.slice(1).map((r) => [r[0], r]));
      // In full sight: drafts and restricted documents too.
      expect([...byNumber.keys()]).toEqual(expect.arrayContaining([open.number, restricted.number, draft.number]));
      const row = byNumber.get(open.number)!;
      expect(row[1]).toBe('التعامل مع الانسكاب');
      expect(row[6]).toBe('سارية');
      expect(row[8]).toBe('1');
      expect(byNumber.get(draft.number)![6]).toBe('مسودة');
      expect(byNumber.get(draft.number)![15]).toBe('1');
      expect(byNumber.get(draft.number)![16]).toBe('مسودة');

      // In English, the formula a title holds is text, not a formula.
      const en = readCsv((await get(writer.cookie, '/exports/documents?locale=en&q=spill').expect(200)).text);
      expect(en[0][0]).toBe('Number');
      expect(en.find((r) => r[0] === open.number)![1]).toBe(`'=HYPERLINK("x")`);
      expect(en.find((r) => r[0] === open.number)![6]).toBe('Current');

      const [entry] = await bench.owner.db
        .select({ actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'documents_exported')))
        .orderBy(auditLog.occurredAt)
        .limit(1);
      expect(entry).toMatchObject({ actorId: writer.id, changes: { locale: 'ar', filters: { search: { used: false } } } });
      // Whether a search was used, and how long it was: not what it was.
      const searched = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'documents_exported')))
        .orderBy(auditLog.occurredAt);
      const withSearch = searched.find((e) => (e.changes as { locale: string }).locale === 'en')!;
      expect(withSearch.changes).toMatchObject({ filters: { search: { used: true, length: 5 }, sort: 'number' } });
      expect((withSearch.changes as { filters: Record<string, unknown> }).filters).not.toHaveProperty('q');
      expect(JSON.stringify(withSearch.changes)).not.toContain('spill');
    });

    it('holds for a reader only what they may read, and nothing of another client', async () => {
      // The reader's own language when none is asked: the client's default here.
      const rows = readCsv((await get(reader.cookie, '/exports/documents').expect(200)).text);
      expect(rows[0][0]).toBe('Number');
      const numbers = rows.slice(1).map((r) => r[0]);
      expect(numbers).toContain(open.number);
      expect(numbers).not.toContain(restricted.number);
      expect(numbers).not.toContain(draft.number);
      // Nothing of a version in progress for a reader.
      expect(rows.slice(1).every((r) => r[15] === '' && r[16] === '')).toBe(true);
      const theirs = readCsv((await get(bWriter.cookie, '/exports/documents').expect(200)).text);
      expect(theirs.slice(1).map((r) => r[0])).not.toContain(open.number);
    });
  });

  describe('acknowledgements as a file', () => {
    let doc: Doc;
    let v1: Version;
    let other: Doc;
    let otherVersion: Version;

    beforeAll(async () => {
      ({ doc, version: v1 } = await publishedDoc({ acknowledgementRequired: true }));
      await post(reader.cookie, `/documents/${doc.id}/versions/${v1.id}/acknowledge`, { password }).expect(200);
      // The leaver was asked, did not acknowledge, and left.
      await bench.owner.db.update(users).set({ status: 'disabled' }).where(eq(users.id, leaver.id));
      // A document of the pharmacy, which the department manager reads but does not see in full.
      ({ doc: other, version: otherVersion } = await publishedDoc({ ownerUnitId: pharmacy, acknowledgementRequired: true }));
    }, 120_000);

    it('lists everyone asked, those who left included and marked, with the fingerprint of what they signed', async () => {
      const url = `/documents/${doc.id}/versions/${v1.id}/acknowledgements/export`;
      await http().get(`/policies${url}`).expect(401);
      expect((await get(reader.cookie, url).expect(403)).body.code).toBe('missing_permission');
      expect(
        (await get(deptManager.cookie, `/documents/${other.id}/versions/${otherVersion.id}/acknowledgements/export`).expect(403)).body,
      ).toEqual({ code: 'missing_permission', permission: 'policies.view_all' });
      await get(bWriter.cookie, url).expect(404);
      await get(writer.cookie, `/documents/${doc.id}/versions/${otherVersion.id}/acknowledgements/export`).expect(404);
      await get(writer.cookie, `${url}?locale=xx`).expect(400);
      await get(writer.cookie, `${url}?state=pending`).expect(400);

      const res = await get(auditor.cookie, url).expect(200);
      expect(res.headers['content-disposition']).toMatch(
        new RegExp(`^attachment; filename="acknowledgements-${doc.number}-v1-\\d{4}-\\d{2}-\\d{2}\\.csv"$`),
      );
      const rows = readCsv(res.text);
      expect(rows[0]).toEqual([
        'Document number',
        'Version',
        'Status of the version',
        'Person',
        'Employee number',
        'Their area',
        'Account',
        'Asked on',
        'Due on',
        'Where it stands',
        'Acknowledged at',
        'Fingerprint of what was signed',
      ]);
      const of = (name: string) => rows.find((r) => r[3] === name)!;
      expect(of('Person reader')).toEqual([
        doc.number,
        '1',
        'Published',
        'Person reader',
        '',
        'Unit WARD',
        'Active',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        'Acknowledged',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
        expect.stringMatching(/^[0-9a-f]{64}$/),
      ]);
      expect(of('Person leaver').slice(6, 12)).toEqual([
        'No longer active',
        expect.any(String),
        expect.any(String),
        'Not yet',
        '',
        '',
      ]);
      const [entry] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, doc.id), eq(auditLog.action, 'acknowledgements_exported')));
      expect(entry.changes).toMatchObject({ versionId: v1.id, version: 1 });
    });

    it("fills in employee numbers only for the people whose accounts the caller manages", async () => {
      // A manager of the department's documents and staff, and the
      // department's manager, who manages no accounts.
      await bench.createRole(a, 'staffadmin', ['policies.view_all', 'users.manage']);
      const staffAdmin = await staff(a, 'staffadmin', 'staffadmin', dept, dept);
      const numbers = { [reader.id]: `R-${run}`, [phaWriter.id]: `P-${run}`, [quality.id]: `Q-${run}` };
      for (const [id, employeeNumber] of Object.entries(numbers)) {
        await http().patch(`/users/${id}`).set('Cookie', a.cookie).send({ employeeNumber }).expect(200);
      }
      // The document is for the whole organization, and the department's.
      const url = `/documents/${doc.id}/versions/${v1.id}/acknowledgements/export`;
      const numberOf = async (who: Staff) => {
        const rows = readCsv((await get(who.cookie, url).expect(200)).text);
        expect(rows[0][4]).toBe('Employee number');
        const cell = (name: string) => rows.find((r) => r[3] === name)![4];
        return { reader: cell('Person reader'), pharmacy: cell('Person phawriter'), quality: cell('Person quality') };
      };
      // The department's manager sees the document in full, and its people,
      // but not the staff register: no employee number at all.
      expect(await numberOf(deptManager)).toEqual({ reader: '', pharmacy: '', quality: '' });
      // Nor does someone who sees every document and manages no accounts.
      expect(await numberOf(auditor)).toEqual({ reader: '', pharmacy: '', quality: '' });
      // Accounts of the department: the ward's reader only.
      expect(await numberOf(staffAdmin)).toEqual({ reader: `R-${run}`, pharmacy: '', quality: '' });
      // Accounts everywhere: everyone's.
      expect(await numberOf(approver)).toEqual({ reader: `R-${run}`, pharmacy: `P-${run}`, quality: `Q-${run}` });
    });

    it('is there for a version no longer in force, and on screen the leavers show only when asked', async () => {
      const v2 = await nextVersion(doc, { en: { steps: '1. Mark it.' } });
      const r = await act(quality, doc, v2, 'approve');
      const ap = await act(approver, doc, r, 'approve');
      await act(writer, doc, ap, 'publish');
      const rows = readCsv(
        (await get(writer.cookie, `/documents/${doc.id}/versions/${v1.id}/acknowledgements/export?locale=ar`).expect(200)).text,
      );
      expect(rows[0][0]).toBe('رقم الوثيقة');
      expect(rows.find((x) => x[3] === 'Person reader')![2]).toBe('حلّ محله إصدار أحدث');
      const screen = `/documents/${doc.id}/versions/${v1.id}/acknowledgements`;
      const plain = (await get(writer.cookie, screen).expect(200)).body;
      expect(plain.people.items.map((p: { user: { id: string } }) => p.user.id)).not.toContain(leaver.id);
      const all = (await get(writer.cookie, `${screen}?includeLeft=true`).expect(200)).body;
      const left = all.people.items.find((p: { user: { id: string } }) => p.user.id === leaver.id);
      expect(left).toMatchObject({ left: true, account: 'disabled', acknowledgedAt: null });
      // The figures count those still active either way.
      expect(all.targeted).toBe(plain.targeted);
      expect(all.people.total).toBe(plain.people.total + 1);
      await get(writer.cookie, `${screen}?includeLeft=maybe`).expect(400);
    });
  });

  describe('the daily check', () => {
    it('tells the managers of a document once when a step of its review is overdue', async () => {
      const { doc, version } = await inReview();
      const runIds = bench.owner.db
        .select({ id: approvalRuns.id })
        .from(approvalRuns)
        .where(eq(approvalRuns.subjectId, version.id));
      await bench.owner.db
        .update(approvalRunSteps)
        .set({ dueAt: new Date(Date.now() - DAY) })
        .where(and(inArray(approvalRunSteps.runId, runIds), eq(approvalRunSteps.status, 'pending')));
      await check.run(new Date(), [a.id]);
      await check.run(new Date(), [a.id]);
      const told = (await notificationsOf(writer.cookie)).filter(
        (n) => n.kind === 'document_step_overdue' && n.document?.id === doc.id,
      );
      expect(told).toHaveLength(1);
      expect(told[0].data).toMatchObject({ versionId: version.id, version: 1, position: 1, step: 'review' });
      // Only those who manage it.
      expect((await notificationsOf(reader.cookie)).some((n) => n.kind === 'document_step_overdue')).toBe(false);
    }, 60_000);

    it("tells a document's managers once when a scheduled version could not be published", async () => {
      const { doc, version } = await inReview();
      const reviewed = await act(quality, doc, version, 'approve');
      const approved = await act(approver, doc, reviewed, 'approve');
      const day = shiftDay(dayOf(new Date(), 'UTC'), 2);
      await act(writer, doc, approved, 'publish', { effectiveOn: day });
      const [signature] = await bench.owner.db
        .select({ id: signatures.id, contentHash: signatures.contentHash })
        .from(signatures)
        .where(eq(signatures.subjectId, version.id))
        .limit(1);
      await bench.owner.db.update(signatures).set({ contentHash: '0'.repeat(64) }).where(eq(signatures.id, signature.id));
      try {
        const at = new Date(startOfDay(day, 'UTC').getTime() + 3_600_000);
        await check.run(at, [a.id]);
        await check.run(at, [a.id]);
        const told = (await notificationsOf(writer.cookie)).filter(
          (n) => n.kind === 'document_publish_failed' && n.document?.id === doc.id,
        );
        expect(told).toHaveLength(1);
        expect(told[0].data).toMatchObject({ versionId: version.id, effectiveOn: day, reason: 'content_changed' });
      } finally {
        await bench.owner.db.update(signatures).set({ contentHash: signature.contentHash }).where(eq(signatures.id, signature.id));
      }
    }, 60_000);

    describe('the weekly digest of overdue acknowledgements', () => {
      let c: Hospital;
      let cWriter: Staff;
      let cManager: Staff;
      let onWard: Staff;
      let noUnit: Staff;
      let cQuality: Staff;
      let cApprover: Staff;
      let cFacility: string;
      let cWard: string;

      beforeAll(async () => {
        c = await bench.createHospital('c');
        const f = await bench.createUnit(c, 'facility', 'F', null);
        const d = await bench.createUnit(c, 'department', 'D', f);
        const u = await bench.createUnit(c, 'unit', 'U', d);
        await bench.createRole(c, 'writer', ['policies.view', 'policies.manage']);
        cWriter = await staff(c, 'cwriter', 'writer', null, f);
        const q = await staff(c, 'cquality', 'quality_officer', null, f);
        const ap = await staff(c, 'capprover', ['administrator', 'approving_authority'], null, f);
        cQuality = q;
        cApprover = ap;
        cFacility = f;
        cWard = u;
        cManager = await staff(c, 'cmanager', 'department_manager', d, d);
        onWard = await staff(c, 'onward', 'reporter', null, u);
        noUnit = await staff(c, 'nounit', 'reporter', null, null);
        const t = Object.fromEntries((await get(c.cookie, '/types').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
        const cat = Object.fromEntries((await get(c.cookie, '/categories').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
        const created = (
          await post(cWriter.cookie, '/documents', {
            typeId: t.procedure,
            categoryId: cat.SAF,
            title: { en: 'Everyone reads this' },
            ownerId: cWriter.id,
            ownerUnitId: f,
            acknowledgementRequired: true,
          }).expect(201)
        ).body as Doc;
        let v = (await get(cWriter.cookie, `/documents/${created.id}/versions/${created.inProgress!.id}`).expect(200)).body as Version;
        v = (
          await patch(cWriter.cookie, `/documents/${created.id}/versions/${v.id}`, {
            content: { en: FULL_EN },
            revision: v.revision,
          }).expect(200)
        ).body;
        for (const [who, action] of [[cWriter, 'submit'], [q, 'approve'], [ap, 'approve'], [cWriter, 'publish']] as const) {
          v = (
            await post(who.cookie, `/documents/${created.id}/versions/${v.id}/${action}`, {
              revision: v.revision,
              ...(action === 'approve' && { password }),
            }).expect(200)
          ).body;
        }
        // The two readers' time has run out, three days ago.
        await bench.owner.db
          .update(documentAcknowledgements)
          .set({ dueOn: shiftDay(dayOf(new Date(), 'UTC'), -3) })
          .where(and(eq(documentAcknowledgements.versionId, v.id), inArray(documentAcknowledgements.userId, [onWard.id, noUnit.id])));
      }, 180_000);

      const digests = async (who: Staff) =>
        bench.owner.db
          .select({ data: notifications.data, documentId: notifications.documentId })
          .from(notifications)
          .where(and(eq(notifications.userId, who.id), eq(notifications.kind, 'acknowledgements_overdue_digest')))
          .orderBy(notifications.createdAt);

      it("goes once a week to the managers of each person's unit, or else to those who manage documents everywhere", async () => {
        const now = new Date();
        await check.run(now, [c.id]);
        await check.run(now, [c.id]);
        const week = isoWeekOf(dayOf(now, 'UTC'));
        // The department's manager, for the one on the ward.
        expect(await digests(cManager)).toEqual([
          { documentId: null, data: { overdue: 1, people: 1, stepsOverdue: 0, week, serious: false } },
        ]);
        // The one with no unit goes to those who manage documents for the
        // whole organization; the one on the ward does not, as their unit
        // has a manager of its own.
        expect(await digests(cWriter)).toEqual([
          { documentId: null, data: { overdue: 1, people: 1, stepsOverdue: 0, week, serious: false } },
        ]);
        // Neither reader is told of it.
        expect(await digests(onWard)).toEqual([]);
        // On screen, it is a notification about no one document.
        const shown = (await notificationsOf(cManager.cookie)).find((n) => n.kind === 'acknowledgements_overdue_digest')!;
        expect(shown).toMatchObject({ document: null, incident: null, data: { overdue: 1, week } });
        // A week later, again, once.
        const later = new Date(now.getTime() + 7 * DAY);
        await check.run(later, [c.id]);
        await check.run(later, [c.id]);
        expect((await digests(cManager)).map((n) => n.data.week)).toEqual([week, isoWeekOf(dayOf(later, 'UTC'))]);
      }, 60_000);

      it('leads to the list of what is overdue among the people whose figures the caller sees', async () => {
        await http().get('/policies/acknowledgements/overdue').expect(401);
        expect((await get(onWard.cookie, '/acknowledgements/overdue').expect(403)).body.code).toBe('missing_permission');
        await get(cManager.cookie, '/acknowledgements/overdue?pageSize=0').expect(400);
        await get(cManager.cookie, '/acknowledgements/overdue?mine=1').expect(400);
        const mine = (await get(cManager.cookie, '/acknowledgements/overdue').expect(200)).body;
        expect(mine.total).toBe(1);
        expect(mine.items[0]).toMatchObject({
          user: { id: onWard.id },
          orgUnit: { name: { en: 'Unit U' } },
          document: { title: { en: 'Everyone reads this' }, canOpen: true },
          daysOverdue: 3,
        });
        const all = (await get(cWriter.cookie, '/acknowledgements/overdue').expect(200)).body;
        expect(all.items.map((i: { user: { id: string } }) => i.user.id).sort()).toEqual([onWard.id, noUnit.id].sort());
        // Another client's people are not there.
        const theirs = (await get(writer.cookie, '/acknowledgements/overdue?pageSize=500').expect(200)).body;
        expect(theirs.items.map((i: { user: { id: string } }) => i.user.id)).not.toContain(onWard.id);
      });

      it('names no document the caller may not open: not its number, id or version', async () => {
        // A restricted document of another department, for the ward.
        const lab = await bench.createUnit(c, 'department', 'LAB', cFacility);
        const t = Object.fromEntries((await get(c.cookie, '/types').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
        const cat = Object.fromEntries((await get(c.cookie, '/categories').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
        const created = (
          await post(cWriter.cookie, '/documents', {
            typeId: t.procedure,
            categoryId: cat.SAF,
            title: { en: 'Laboratory only' },
            ownerId: cWriter.id,
            ownerUnitId: lab,
            confidentiality: 'restricted',
            audience: { orgUnitIds: [cWard], roleIds: [] },
            acknowledgementRequired: true,
          }).expect(201)
        ).body as Doc;
        let v = (await get(cWriter.cookie, `/documents/${created.id}/versions/${created.inProgress!.id}`).expect(200)).body as Version;
        v = (await patch(cWriter.cookie, `/documents/${created.id}/versions/${v.id}`, { content: { en: FULL_EN }, revision: v.revision }).expect(200)).body;
        for (const [who, action] of [[cWriter, 'submit'], [cQuality, 'approve'], [cApprover, 'approve'], [cWriter, 'publish']] as const) {
          v = (
            await post(who.cookie, `/documents/${created.id}/versions/${v.id}/${action}`, {
              revision: v.revision,
              ...(action === 'approve' && { password }),
            }).expect(200)
          ).body;
        }
        // The one on the ward is overdue on it, five days.
        await bench.owner.db
          .update(documentAcknowledgements)
          .set({ dueOn: shiftDay(dayOf(new Date(), 'UTC'), -5) })
          .where(and(eq(documentAcknowledgements.versionId, v.id), eq(documentAcknowledgements.userId, onWard.id)));
        // The department's manager may not open it.
        await get(cManager.cookie, `/documents/${created.id}`).expect(404);

        const list = (await get(cManager.cookie, '/acknowledgements/overdue').expect(200)).body;
        // Counted, and the person and the due date shown.
        expect(list.total).toBe(2);
        expect(list.items).toHaveLength(2);
        const hidden = list.items.find((i: { daysOverdue: number }) => i.daysOverdue === 5);
        expect(hidden).toEqual({
          user: { id: onWard.id, name: { en: 'Person onward' } },
          orgUnit: { id: cWard, name: { en: 'Unit U' } },
          document: null,
          version: null,
          dueOn: shiftDay(dayOf(new Date(), 'UTC'), -5),
          daysOverdue: 5,
        });
        expect(JSON.stringify(list)).not.toContain(created.number);
        expect(JSON.stringify(list)).not.toContain(created.id);
        expect(JSON.stringify(list)).not.toContain(v.id);
        // The one the manager may open is named in full, as before.
        const shown = list.items.find((i: { daysOverdue: number }) => i.daysOverdue === 3);
        expect(shown.document).toEqual({ id: expect.any(String), number: expect.any(String), title: { en: 'Everyone reads this' }, canOpen: true });
        expect(shown.version).toEqual({ id: expect.any(String), version: 1 });
        // Whoever may open it sees it named.
        const all = (await get(cWriter.cookie, '/acknowledgements/overdue').expect(200)).body;
        const named = all.items.find((i: { document: { id: string } | null }) => i.document?.id === created.id);
        expect(named).toMatchObject({
          user: { id: onWard.id },
          document: { number: created.number, title: { en: 'Laboratory only' }, canOpen: true },
          version: { id: v.id, version: 1 },
        });
      }, 120_000);
    });
  });
});
