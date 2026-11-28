import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { contentHash } from '../src/approvals/signatures.js';
import {
  auditLog,
  documentAcknowledgements,
  notifications,
  users,
} from '../src/database/schema.js';
import { EmailWorker } from '../src/email/email-worker.service.js';
import { addMonths, shiftDay } from '../src/i18n/time-zones.js';
import { PolicyCheck } from '../src/policies/policy-check.service.js';
import { signedImport } from '../src/policies/signed-content.js';
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
  moves: string[];
};

/** The cells of a CSV file, row by row. */
const cells = (text: string) =>
  text
    .replace(/^﻿/, '')
    .split('\r\n')
    .filter((line) => line !== '')
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replaceAll('""', '"')));

/**
 * Quality review 3 of the policies module: the original's last review and
 * its differences, signed with an import; the register of imports; the
 * library's filters for imported documents; the owner told of an import;
 * overdue approval steps in the managers' emails; the late
 * acknowledgements and each person's record as files; who has switched
 * email off; and a periodic review confirmed only when it is due.
 */
describe('policies: quality review 3', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  const password = `hospital-pass-${run}`;

  let a: Hospital;
  let b: Hospital;
  let dept: string;
  let ward: string;
  let pharmacy: string;
  let writer: Staff; // manages documents everywhere, and imports
  let owner: Staff; // owns what the writer imports
  let phaManager: Staff; // manages the pharmacy's documents only
  let reader: Staff; // on the ward
  let leaver: Staff; // on the ward, and leaves
  let quality: Staff;
  let authority: Staff;
  let deptManager: Staff; // manages the department's documents, the ward's people
  let types: Record<string, string>;
  let categories: Record<string, string>;
  let today: string;

  const get = (cookie: string, url: string) => http().get(`/policies${url}`).set('Cookie', cookie);
  const post = (cookie: string, url: string, body: unknown = {}) =>
    http().post(`/policies${url}`).set('Cookie', cookie).send(body as object);

  const document = (extra: Record<string, unknown> = {}) => ({
    typeId: types.procedure,
    categoryId: categories.SAF,
    title: { en: 'Handling a spill' },
    ownerId: owner.id,
    ownerUnitId: dept,
    revisionLabel: 'Rev. 4',
    approvedOn: shiftDay(today, -1000),
    approvedBy: 'Head of Operations',
    originalKeptAt: { en: 'Quality office' },
    nextReviewOn: shiftDay(today, 100),
    content: { en: { purpose: 'To make a spill safe.', steps: '1. Mark the area.' } },
    ...extra,
  });
  const importOne = (cookie: string, body: Record<string, unknown>) =>
    post(cookie, '/documents/import', { password, ...body });

  async function staff(h: Hospital, name: string, role: string | null, grantUnit: string | null, homeUnit: string | null) {
    const person = await bench.createStaff(h, name, role ? { role, orgUnitId: grantUnit } : null);
    if (homeUnit) await bench.owner.db.update(users).set({ orgUnitId: homeUnit }).where(eq(users.id, person.id));
    return person;
  }

  const auditOf = async (action: string) =>
    bench.owner.db
      .select({ actorId: auditLog.actorId, changes: auditLog.changes, entityId: auditLog.entityId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, action)));

  beforeAll(async () => {
    bench = await testBench('polq3', run);
    a = await bench.createHospital('a', { locales: ['en', 'ar'] });
    b = await bench.createHospital('b');
    const facility = await bench.createUnit(a, 'facility', 'F', null);
    dept = await bench.createUnit(a, 'department', 'NUR', facility);
    ward = await bench.createUnit(a, 'unit', 'WARD', dept);
    pharmacy = await bench.createUnit(a, 'department', 'PHA', facility);
    await bench.createRole(a, 'writer', ['policies.view', 'policies.manage']);
    writer = await staff(a, 'writer', 'writer', null, dept);
    owner = await staff(a, 'owner', 'writer', null, dept);
    phaManager = await staff(a, 'phamanager', 'writer', pharmacy, pharmacy);
    reader = await staff(a, 'reader', 'reporter', null, ward);
    leaver = await staff(a, 'leaver', 'reporter', null, ward);
    quality = await staff(a, 'quality', 'quality_officer', null, facility);
    authority = await staff(a, 'authority', 'approving_authority', null, facility);
    deptManager = await staff(a, 'deptmanager', 'writer', dept, dept);
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

  describe('the original’s last review (M2)', () => {
    it('is after the approval and not ahead of today, and the next review is counted from it', async () => {
      const refused = async (extra: Record<string, unknown>) =>
        (await importOne(writer.cookie, document(extra)).expect(400)).body;
      expect(await refused({ lastReviewedOn: shiftDay(today, -1001) })).toEqual({ code: 'reviewed_before_approval' });
      expect(await refused({ lastReviewedOn: shiftDay(today, 1) })).toEqual({ code: 'reviewed_in_future' });
      expect(await refused({ lastReviewedOn: shiftDay(today, -10), nextReviewOn: shiftDay(today, -20) })).toEqual({
        code: 'review_before_last_review',
      });
      // Never reviewed: at most 36 months from its approval, long past.
      expect(await refused({})).toEqual({
        code: 'review_date_too_far',
        latest: addMonths(shiftDay(today, -1000), 36),
        maxReviewMonths: 36,
        from: shiftDay(today, -1000),
      });
      // Reviewed on paper a year ago: from then.
      expect(await refused({ lastReviewedOn: shiftDay(today, -365), nextReviewOn: addMonths(shiftDay(today, -365), 37) })).toMatchObject({
        code: 'review_date_too_far',
        from: shiftDay(today, -365),
      });
      // An old document imported with its review already past: accepted,
      // and shown overdue, where it stands.
      const late = (
        await importOne(writer.cookie, document({ number: `LATE-${run}`, approvedOn: shiftDay(today, -1200), nextReviewOn: addMonths(shiftDay(today, -1200), 36) })).expect(201)
      ).body;
      expect(late.review).toBe('overdue');
    });
  });

  describe('importing with the last review and the differences (M2, M3)', () => {
    let imported: { id: string; number: string; published: { id: string } };

    it('takes the differences in the client’s languages only', async () => {
      expect(
        (await importOne(writer.cookie, document({ lastReviewedOn: shiftDay(today, -200), differences: { fr: 'Tableau 2 en liste.' } })).expect(400)).body,
      ).toEqual({ code: 'language_mismatch', field: 'differences' });
      await importOne(writer.cookie, document({ lastReviewedOn: shiftDay(today, -200), differences: { en: 'x'.repeat(2001) } })).expect(400);
    });

    it('signs both, keeps them, and shows them in the control block, the register and the master list', async () => {
      const differences = { en: 'Table 2 written as a list; the flowchart of appendix B is not reproduced, see the original.', ar: 'الجدول 2 مكتوب في قائمة.' };
      imported = (
        await importOne(writer.cookie, document({ number: `DIFF-${run}`, lastReviewedOn: shiftDay(today, -200), differences })).expect(201)
      ).body;
      const version = (await get(reader.cookie, `/documents/${imported.id}/versions/${imported.published.id}`).expect(200)).body;
      expect(version.control).toMatchObject({
        originalRevision: 'Rev. 4',
        approvedBeforeTrustline: {
          revisionLabel: 'Rev. 4',
          lastReviewedOn: shiftDay(today, -200),
          differences,
          sectionsNotInOriginal: expect.arrayContaining([{ key: 'scope', required: true }]),
        },
      });
      // What the importer signed covers both.
      const { importedBy: _by, importedAt: _at, sectionsNotInOriginal: _s, ...said } = version.control.approvedBeforeTrustline;
      expect(version.imported.signature.contentHash).toBe(
        contentHash(
          signedImport(
            { id: imported.id, number: imported.number },
            { ...version, signsAuthoritativeLocale: true },
            said,
          ),
        ),
      );
      expect(signedImport({ id: 'd', number: 'n' }, { ...version, signsAuthoritativeLocale: true }, said).importedOriginal).toMatchObject({
        lastReviewedOn: shiftDay(today, -200),
        differences,
      });

      // The master list: its last two columns.
      const list = cells((await get(writer.cookie, '/exports/documents?locale=en').expect(200)).text);
      expect(list[0].slice(-2)).toEqual(['Last reviewed on the original', 'Differences from the original']);
      expect(list.find((r) => r[0] === imported.number)!.slice(-2)).toEqual([shiftDay(today, -200), differences.en]);
    });

    it('tells the owner, and not the importer, that the document is theirs', async () => {
      const told = await bench.owner.db
        .select({ userId: notifications.userId, data: notifications.data })
        .from(notifications)
        .where(and(eq(notifications.documentId, imported.id), eq(notifications.kind, 'document_owner_assigned')));
      expect(told).toEqual([
        { userId: owner.id, data: expect.objectContaining({ version: 1, versionId: imported.published.id, number: imported.number }) },
      ]);
      // Importing a document they own themselves tells nobody.
      const own = (await importOne(writer.cookie, document({ number: `OWN-${run}`, ownerId: writer.id, nextReviewOn: shiftDay(today, 30), lastReviewedOn: shiftDay(today, -10) })).expect(201)).body;
      expect(
        await bench.owner.db.select().from(notifications).where(and(eq(notifications.documentId, own.id), eq(notifications.kind, 'document_owner_assigned'))),
      ).toEqual([]);
    });
  });

  describe('GET /policies/imports and its CSV (S1)', () => {
    it('needs a session, and policies.manage for the whole organization', async () => {
      await http().get('/policies/imports').expect(401);
      await http().get('/policies/exports/imports').expect(401);
      for (const who of [phaManager, reader]) {
        await get(who.cookie, '/imports').expect(403);
        await get(who.cookie, '/exports/imports').expect(403);
      }
    });

    it('takes only a page', async () => {
      for (const query of ['pageSize=0', 'page=x', 'tenantId=1']) await get(writer.cookie, `/imports?${query}`).expect(400);
      await get(writer.cookie, '/exports/imports?locale=fr').expect(400);
    });

    it('lists every import, newest first, with its original, importer and batch, and no other hospital’s', async () => {
      const register = (await get(writer.cookie, '/imports').expect(200)).body;
      const diff = register.items.find((i: { number: string }) => i.number === `DIFF-${run}`);
      expect(diff).toMatchObject({
        numberAsGiven: `DIFF-${run}`,
        revisionLabel: 'Rev. 4',
        approvedOn: shiftDay(today, -1000),
        approvedBy: 'Head of Operations',
        lastReviewedOn: shiftDay(today, -200),
        differences: expect.objectContaining({ en: expect.stringContaining('Table 2') }),
        importedBy: { id: writer.id, name: expect.any(Object) },
        batch: { id: expect.any(String), index: 0, size: 1, listHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(register.total).toBe(register.items.length);
      expect((await get(b.cookie, '/imports').expect(200)).body).toEqual({ items: [], total: 0 });

      const before = (await auditOf('imports_exported')).length;
      const file = cells((await get(writer.cookie, '/exports/imports?locale=en').expect(200)).text);
      expect(file[0]).toEqual([
        'Number', 'Title', 'Number on the original', 'Revision on the original', 'Approved on',
        'Approved by (as on the original)', 'Last reviewed on the original', 'Where the signed original is kept',
        'Differences from the original', 'Imported by', 'Imported at', 'Batch', 'Fingerprint of the batch',
        'Fingerprint of what was signed',
      ]);
      expect(file.find((r) => r[0] === `DIFF-${run}`)![12]).toBe(diff.batch.listHash);
      expect((await auditOf('imports_exported')).slice(before)).toEqual([
        { actorId: writer.id, entityId: a.id, changes: { locale: 'en', rows: file.length - 1 } },
      ]);
    });
  });

  describe('the library’s filters for imported documents (S1)', () => {
    it('finds what is in force as imported, and what is due for its re-issue', async () => {
      const ids = async (query: string) =>
        ((await get(writer.cookie, `/documents?${query}`).expect(200)).body.items as { number: string }[]).map((i) => i.number);
      const imported = await ids('source=imported&pageSize=100');
      expect(imported).toEqual(expect.arrayContaining([`DIFF-${run}`, `LATE-${run}`, `OWN-${run}`]));
      expect(await ids('source=written&pageSize=100')).not.toContain(`DIFF-${run}`);
      // Re-issue due: within 60 days (OWN, in 30), or past (LATE); not DIFF, in 100.
      const due = await ids('reissueDue=true&pageSize=100');
      expect(due).toEqual(expect.arrayContaining([`LATE-${run}`, `OWN-${run}`]));
      expect(due).not.toContain(`DIFF-${run}`);
      await get(writer.cookie, '/documents?source=pasted').expect(400);
      // And in the master list, with the same filter.
      const file = cells((await get(writer.cookie, '/exports/documents?locale=en&reissueDue=true').expect(200)).text);
      expect(file.slice(1).map((r) => r[0]).sort()).toEqual([...due].sort());
    });
  });

  describe('acknowledgements as files (S5)', () => {
    let asked: { id: string; number: string; published: { id: string } };

    beforeAll(async () => {
      asked = (
        await importOne(writer.cookie, document({ number: `ACK-${run}`, nextReviewOn: shiftDay(today, 300), lastReviewedOn: shiftDay(today, -100), acknowledgementRequired: true, acknowledgeWithinDays: 5 })).expect(201)
      ).body;
      // Overdue for the reader and the leaver; the leaver then leaves.
      await bench.owner.db
        .update(documentAcknowledgements)
        .set({ dueOn: shiftDay(today, -3) })
        .where(eq(documentAcknowledgements.versionId, asked.published.id));
      await http().patch(`/users/${leaver.id}`).set('Cookie', a.cookie).send({ status: 'disabled' }).expect(200);
    });

    it('gives the late list as a CSV file, audited', async () => {
      await http().get('/policies/exports/acknowledgements/overdue').expect(401);
      await get(reader.cookie, '/exports/acknowledgements/overdue').expect(403);
      await get(writer.cookie, '/exports/acknowledgements/overdue?locale=fr').expect(400);
      const file = cells((await get(writer.cookie, '/exports/acknowledgements/overdue?locale=en').expect(200)).text);
      expect(file[0]).toEqual(['Person', 'Employee number', 'Their area', 'Document number', 'Document title', 'Version', 'Due on', 'Days overdue']);
      const row = file.find((r) => r[3] === asked.number && r[0] === reader.name)!;
      expect(row).toEqual([reader.name, '', 'Unit WARD', asked.number, 'Handling a spill', '1', shiftDay(today, -3), '3']);
      // The one who has left is not on the late list: their record stands below.
      expect(file.some((r) => r[0] === leaver.name)).toBe(false);
      expect((await auditOf('overdue_acknowledgements_exported')).at(-1)).toMatchObject({ actorId: writer.id });
    });

    it('gives a person’s record to those who manage documents for their unit, and nobody else', async () => {
      const url = (who: Staff, tail = '') => `/people/${who.id}/acknowledgements${tail}`;
      await http().get(`/policies${url(reader)}`).expect(401);
      // Without policies.manage.
      await get(reader.cookie, url(leaver)).expect(403);
      // A manager for another unit, a person of another hospital, nobody.
      await get(phaManager.cookie, url(reader)).expect(404);
      await get(writer.cookie, `/people/${b.adminId}/acknowledgements`).expect(404);
      await get(writer.cookie, '/people/not-an-id/acknowledgements').expect(404);
      await get(writer.cookie, `${url(reader)}?pageSize=0`).expect(400);

      const record = (await get(writer.cookie, url(reader)).expect(200)).body;
      expect(record.person).toMatchObject({ id: reader.id, status: 'active', orgUnit: { id: ward } });
      expect(record.items).toEqual([
        expect.objectContaining({
          document: { id: asked.id, number: asked.number, title: { en: 'Handling a spill' } },
          version: { id: asked.published.id, version: 1, status: 'published' },
          dueOn: shiftDay(today, -3),
          acknowledgedAt: null,
          state: 'overdue',
          late: true,
        }),
      ]);
      // One who has left keeps their record.
      expect((await get(writer.cookie, url(leaver)).expect(200)).body).toMatchObject({
        person: { status: 'disabled' },
        items: [expect.objectContaining({ state: 'overdue', late: true })],
      });

      // Acknowledged late, it says so.
      await post(reader.cookie, `/documents/${asked.id}/versions/${asked.published.id}/acknowledge`, { password }).expect(200);
      const after = (await get(writer.cookie, url(reader)).expect(200)).body;
      expect(after.items[0]).toMatchObject({ state: 'acknowledged', late: true, acknowledgedAt: expect.any(String) });

      const file = cells((await get(writer.cookie, url(reader, '/export?locale=en')).expect(200)).text);
      expect(file[0]).toEqual([
        'Person', 'Employee number', 'Their area', 'Account', 'Document number', 'Document title', 'Version',
        'Status of the version', 'Asked on', 'Due on', 'Where it stands', 'Acknowledged at', 'Late',
        'Fingerprint of what was signed',
      ]);
      expect(file[1].slice(0, 7)).toEqual([reader.name, '', 'Unit WARD', 'Active', asked.number, 'Handling a spill', '1']);
      expect(file[1][12]).toBe('Yes');
      await get(phaManager.cookie, url(reader, '/export')).expect(404);
      expect((await auditOf('person_acknowledgements_exported')).at(-1)).toMatchObject({ actorId: writer.id, entityId: reader.id });
    });
  });

  describe('a person’s record, of a version superseded since (L1, N1)', () => {
    it('names the document a reader may open, but not a version that is no longer in force, nor its fingerprint', async () => {
      // A pharmacy document for every member of staff: the department's
      // manager may read it in force, without full sight of it.
      const doc = (
        await importOne(writer.cookie, document({
          number: `SUP-${run}`,
          ownerId: phaManager.id,
          ownerUnitId: pharmacy,
          nextReviewOn: shiftDay(today, 50),
          lastReviewedOn: shiftDay(today, -100),
          acknowledgementRequired: true,
        })).expect(201)
      ).body;
      // The reader acknowledges version 1: a signature, with its fingerprint.
      await post(reader.cookie, `/documents/${doc.id}/versions/${doc.published.id}/acknowledge`, { password }).expect(200);
      // Re-issued through the route: version 2 in force, version 1 superseded.
      let v2 = (await post(writer.cookie, `/documents/${doc.id}/versions`).expect(201)).body;
      v2 = (
        await http()
          .patch(`/policies/documents/${doc.id}/versions/${v2.id}`)
          .set('Cookie', writer.cookie)
          .send({
            revision: v2.revision,
            changeSummary: { en: 'Re-issued.' },
            content: { en: { scope: 'Everyone.', responsibilities: 'Pharmacists.' } },
          })
          .expect(200)
      ).body;
      v2 = (await post(writer.cookie, `/documents/${doc.id}/versions/${v2.id}/submit`, { revision: v2.revision }).expect(200)).body;
      v2 = (await post(quality.cookie, `/documents/${doc.id}/versions/${v2.id}/approve`, { password, revision: v2.revision }).expect(200)).body;
      v2 = (await post(authority.cookie, `/documents/${doc.id}/versions/${v2.id}/approve`, { password, revision: v2.revision }).expect(200)).body;
      await post(writer.cookie, `/documents/${doc.id}/versions/${v2.id}/publish`, { revision: v2.revision }).expect(200);

      const ofV1 = (body: { items: { document: { id: string } | null; version: unknown }[] }) =>
        body.items.filter((i) => i.document?.id === doc.id);
      // The department's manager: the document, not version 1.
      const theirs = (await get(deptManager.cookie, `/people/${reader.id}/acknowledgements`).expect(200)).body;
      // Asked again for version 2, in force: that one is named.
      expect(ofV1(theirs)).toEqual([
        expect.objectContaining({ version: expect.objectContaining({ version: 2, status: 'published' }) }),
        expect.objectContaining({ document: expect.objectContaining({ number: `SUP-${run}` }), version: null }),
      ]);
      const file = cells((await get(deptManager.cookie, `/people/${reader.id}/acknowledgements/export?locale=en`).expect(200)).text);
      const rows = file.filter((r) => r[4] === `SUP-${run}`);
      expect(rows.map((r) => [r[6], r[7]])).toEqual([['2', 'Published'], ['', '']]);
      // Acknowledged, but not theirs to open: no fingerprint.
      expect(rows[1][10]).toBe('Acknowledged');
      expect(rows[1][13]).toBe('');
      const fullFile = cells((await get(writer.cookie, `/people/${reader.id}/acknowledgements/export?locale=en`).expect(200)).text);
      expect(fullFile.filter((r) => r[4] === `SUP-${run}`)[1][13]).toMatch(/^[0-9a-f]{64}$/);
      // Whoever has full sight of it sees the version and its fingerprint.
      const full = (await get(writer.cookie, `/people/${reader.id}/acknowledgements`).expect(200)).body;
      expect(ofV1(full)[1]).toMatchObject({ version: { id: doc.published.id, version: 1, status: 'superseded' } });
    });

    it('gives only the day of what is about a document the caller may not open (N1)', async () => {
      // Restricted to the pharmacy: the department's manager may not open it.
      const restricted = (
        await importOne(writer.cookie, document({
          number: `RES-${run}`,
          ownerId: phaManager.id,
          ownerUnitId: pharmacy,
          confidentiality: 'restricted',
          audience: { orgUnitIds: [ward], roleIds: [] },
          nextReviewOn: shiftDay(today, 50),
          lastReviewedOn: shiftDay(today, -100),
          acknowledgementRequired: true,
        })).expect(201)
      ).body;
      expect(restricted.id).toBeDefined();
      const theirs = (await get(deptManager.cookie, `/people/${reader.id}/acknowledgements`).expect(200)).body;
      const hidden = theirs.items.filter((i: { document: unknown }) => i.document === null);
      expect(hidden.length).toBeGreaterThan(0);
      for (const item of hidden) {
        expect(item.version).toBeNull();
        expect(item.assignedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  describe('overdue approval steps by email (S2)', () => {
    it('go into the managers’ weekly email and daily digest, as counts and numbers', async () => {
      const doc = (await post(writer.cookie, '/documents', {
        typeId: types.procedure,
        categoryId: categories.SAF,
        title: { en: 'Stalled' },
        ownerId: owner.id,
        ownerUnitId: dept,
      }).expect(201)).body as Doc;
      let version = (await get(writer.cookie, `/documents/${doc.id}/versions/${doc.inProgress!.id}`).expect(200)).body;
      version = (
        await http()
          .patch(`/policies/documents/${doc.id}/versions/${version.id}`)
          .set('Cookie', writer.cookie)
          .send({ revision: version.revision, content: { en: { purpose: 'P.', scope: 'S.', responsibilities: 'R.', steps: '1.' } } })
          .expect(200)
      ).body;
      await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/submit`, { revision: version.revision }).expect(200);
      await bench.owner.db.execute(sql`
        update approval_run_steps set due_at = now() - interval '1 day'
        where status = 'pending' and run_id in (select id from approval_runs where subject_id = ${version.id})`);

      // The weekly digest: to those who manage the document.
      await bench.app.get(PolicyCheck, { strict: false }).run(new Date(), [a.id]);
      const weekly = await bench.owner.db
        .select({ data: notifications.data })
        .from(notifications)
        .where(and(eq(notifications.userId, owner.id), eq(notifications.kind, 'acknowledgements_overdue_digest')));
      // With the acknowledgements left overdue above, counted as before.
      expect(weekly).toEqual([{ data: expect.objectContaining({ stepsOverdue: 1, overdue: expect.any(Number) }) }]);
      // Not to a manager of another unit: theirs (for the pharmacy's own
      // late acknowledgement) counts no step.
      const theirs = await bench.owner.db
        .select({ data: notifications.data })
        .from(notifications)
        .where(and(eq(notifications.userId, phaManager.id), eq(notifications.kind, 'acknowledgements_overdue_digest')));
      expect(theirs.every((n) => n.data.stepsOverdue === 0)).toBe(true);

      // The daily digest: a section of its own, with the number.
      const worker = bench.app.get(EmailWorker);
      const hour = worker.digestHour;
      worker.digestHour = 0;
      try {
        await worker.run(new Date(), [a.id]);
      } finally {
        worker.digestHour = hour;
      }
      const kept = await bench.owner.db.execute<{ category: string; subject: string; text_body: string }>(sql`
        select q.category, o.subject, o.text_body from email_outbox o join email_queue q on q.id = o.queue_id
        where o.tenant_id = ${a.id} and q.user_id = ${owner.id}`);
      const daily = kept.rows.find((r) => r.category === 'daily_digest')!;
      expect(daily.text_body).toContain('Approval steps overdue in the documents you manage: 1');
      expect(daily.text_body).toContain(`/en/policies/${doc.id}/versions/${version.id}`);
      expect(daily.text_body).not.toContain('Stalled');
      const week = kept.rows.find((r) => r.category === 'weekly_digest')!;
      expect(week.subject).toBe('Overdue acknowledgements this week');
      expect(week.text_body).toContain('Approval steps overdue: 1');
    });
  });

  describe('GET /settings/email/opt-outs (S3)', () => {
    it('needs a session and settings.manage for the whole organization', async () => {
      await http().get('/settings/email/opt-outs').expect(401);
      for (const who of [writer, quality]) await http().get('/settings/email/opt-outs').set('Cookie', who.cookie).expect(403);
    });

    it('lists who switched which kind off, by name, with what the emails are for in their work', async () => {
      await http().patch('/me/notification-preferences').set('Cookie', quality.cookie).send({ immediate: false }).expect(200);
      await http().patch('/me/notification-preferences').set('Cookie', reader.cookie).send({ digest: false }).expect(200);
      const list = (await http().get('/settings/email/opt-outs').set('Cookie', a.cookie).expect(200)).body;
      expect(list.items).toEqual(
        expect.arrayContaining([
          { id: quality.id, name: expect.any(Object), immediate: false, digest: true, reliedOn: { approves: true, triages: true } },
          { id: reader.id, name: expect.any(Object), immediate: true, digest: false, reliedOn: { approves: false, triages: false } },
        ]),
      );
      expect(list.items.map((i: { id: string }) => i.id)).not.toContain(writer.id);
      expect(JSON.stringify(list)).not.toContain('@');
      // The other hospital's are its own.
      expect((await http().get('/settings/email/opt-outs').set('Cookie', b.cookie).expect(200)).body).toEqual({ items: [], total: 0 });
      // The person's own screen says what the emails are for in their work.
      expect((await http().get('/me/notification-preferences').set('Cookie', quality.cookie).expect(200)).body.reliedOn).toEqual({
        approves: true,
        triages: true,
      });
      expect((await http().get('/me/notification-preferences').set('Cookie', reader.cookie).expect(200)).body.reliedOn).toEqual({
        approves: false,
        triages: false,
      });
    });
  });
});
