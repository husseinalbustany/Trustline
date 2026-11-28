import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { contentHash } from '../src/approvals/signatures.js';
import {
  approvalRuns,
  auditLog,
  documentImportBatches,
  documentImports,
  documentReviews,
  documents,
  notifications,
  referenceCounters,
  signatures,
  users,
} from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';
import { addMonths, shiftDay } from '../src/i18n/time-zones.js';
import { PolicyCheck } from '../src/policies/policy-check.service.js';
import { signedImport } from '../src/policies/signed-content.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

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
  moves: string[];
  inProgress: { id: string } | null;
  published: { id: string; source: string; approvedBeforeTrustline: boolean } | null;
  [key: string]: unknown;
};

/**
 * Business decisions 1 to 3 on the policies module: importing an
 * organization's existing documents as approved before Trustline (one by
 * one, in batches, and a batch checked first), the built-in Approving
 * authority and the starting route that ends with it, and the
 * authoritative language each organization chooses. Each new route is
 * tried without a session, without the permission, on another client's
 * record, with bad input, and working; and the same-person rules on the
 * re-issue of an imported document.
 */
describe('policies: importing documents, the approving authority, the authoritative language', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  const password = `hospital-pass-${run}`;

  let a: Hospital;
  let b: Hospital;
  let facility: string;
  let dept: string;
  let ward: string;
  let pharmacy: string;
  let importer: Staff; // a quality officer: manages documents everywhere, and reviews
  let writer: Staff; // manages documents everywhere
  let phaWriter: Staff; // manages the pharmacy's documents only
  let quality: Staff; // another quality officer
  let authority: Staff; // the Approving authority, and nothing else
  let reader: Staff;
  let auditor: Staff;
  let nobody: Staff;
  let bWriter: Staff;
  let types: Record<string, string>;
  let categories: Record<string, string>;
  let bCategory: string;
  let today: string;

  const get = (cookie: string, url: string) => http().get(`/policies${url}`).set('Cookie', cookie);
  const post = (cookie: string, url: string, body: unknown = {}) =>
    http().post(`/policies${url}`).set('Cookie', cookie).send(body as object);
  const patch = (cookie: string, url: string, body: unknown) =>
    http().patch(`/policies${url}`).set('Cookie', cookie).send(body as object);

  async function staff(h: Hospital, name: string, role: string | null, grantUnit: string | null, homeUnit: string | null) {
    const person = await bench.createStaff(h, name, role ? { role, orgUnitId: grantUnit } : null);
    if (homeUnit) {
      await bench.owner.db.update(users).set({ orgUnitId: homeUnit }).where(eq(users.id, person.id));
    }
    return person;
  }

  /** A procedure as an original would give it: three of its nine sections. */
  const document = (extra: Record<string, unknown> = {}) => ({
    typeId: types.procedure,
    categoryId: categories.SAF,
    title: { en: 'Lifting a load safely', ar: 'رفع الأحمال بأمان' },
    ownerId: writer.id,
    ownerUnitId: dept,
    revisionLabel: 'Rev. 3',
    approvedOn: shiftDay(today, -400),
    approvedBy: 'Head of Operations',
    originalKeptAt: { en: 'Quality office, cabinet 2', ar: 'مكتب الجودة، الخزانة 2' },
    nextReviewOn: shiftDay(today, 200),
    content: {
      en: { purpose: 'To lift without injury.', steps: '1. Bend the knees.\n2. Keep the load close.' },
      ar: { purpose: 'الرفع دون إصابة.' },
    },
    ...extra,
  });

  const importOne = (cookie: string, body: Record<string, unknown>) =>
    post(cookie, '/documents/import', { password, ...body });

  const versionOf = async (cookie: string, docId: string, versionId: string) =>
    (await get(cookie, `/documents/${docId}/versions/${versionId}`).expect(200)).body as Version;

  const failedAttempts = async (who: Staff) =>
    (await bench.owner.db.select({ n: users.failedAttempts }).from(users).where(eq(users.id, who.id)))[0].n;

  const documentCount = async (tenantId: string) =>
    (await bench.owner.db.select({ n: sql<number>`count(*)::int` }).from(documents).where(eq(documents.tenantId, tenantId)))[0].n;

  beforeAll(async () => {
    bench = await testBench('polimp', run);
    a = await bench.createHospital('a', { locales: ['en', 'ar'] });
    b = await bench.createHospital('b');
    facility = await bench.createUnit(a, 'facility', 'F', null);
    dept = await bench.createUnit(a, 'department', 'NUR', facility);
    ward = await bench.createUnit(a, 'unit', 'WARD', dept);
    pharmacy = await bench.createUnit(a, 'department', 'PHA', facility);
    await bench.createRole(a, 'writer', ['policies.view', 'policies.manage']);
    await bench.createRole(a, 'auditor', ['policies.view_all']);
    await bench.createRole(a, 'none', ['reports.view']);
    importer = await staff(a, 'importer', 'quality_officer', null, facility);
    writer = await staff(a, 'writer', 'writer', null, dept);
    phaWriter = await staff(a, 'phawriter', 'writer', pharmacy, pharmacy);
    quality = await staff(a, 'quality', 'quality_officer', null, facility);
    authority = await staff(a, 'authority', 'approving_authority', null, facility);
    reader = await staff(a, 'reader', 'reporter', null, ward);
    auditor = await staff(a, 'auditor', 'auditor', null, facility);
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
    bCategory = (await get(b.cookie, '/categories').expect(200)).body[0].id;
    // The client's own day, as the documents say it.
    const probe = (await post(writer.cookie, '/documents', {
      typeId: types.policy,
      categoryId: categories.GOV,
      title: { en: 'Probe' },
      ownerId: writer.id,
      ownerUnitId: dept,
    }).expect(201)).body as Doc;
    today = probe.today as string;
  }, 180_000);

  afterAll(async () => {
    await bench.app.get(PolicyCheck, { strict: false }).stop();
    await bench.close();
  });

  describe('the Approving authority', () => {
    it('is a built-in role of every new client, which the starting routes end with', async () => {
      const roleList = (await get(writer.cookie, '/roles').expect(200)).body as {
        id: string;
        code: string;
        name: Record<string, string>;
        isSystem: boolean;
        approves: boolean;
      }[];
      const role = roleList.find((r) => r.code === 'approving_authority')!;
      expect(role).toMatchObject({ id: a.roles.approving_authority, isSystem: true, approves: true });
      expect(Object.keys(role.name).sort()).toEqual(['ar', 'en', 'fr']);
      const routes = (await get(writer.cookie, '/approval-routes').expect(200)).body as {
        steps: { kind: string; assignee: { role: { id: string } } }[];
      }[];
      for (const route of routes) {
        expect(route.steps.map((s) => [s.kind, s.assignee.role.id])).toEqual([
          ['review', a.roles.quality_officer],
          ['approve', a.roles.approving_authority],
        ]);
      }
      // It reads every document and approves; it manages none.
      const me = (await http().get('/auth/me').set('Cookie', authority.cookie).expect(200)).body;
      expect([...(me.permissions as string[])].sort((x, y) => x.localeCompare(y))).toEqual(['policies.approve', 'policies.view', 'policies.view_all']);
      await post(authority.cookie, '/documents/import', { password, ...document() }).expect(403);
    });
  });

  describe('importing one document', () => {
    it('is for those who manage documents for the whole organization, and checks everything before the password', async () => {
      await http().post('/policies/documents/import').send({ password, ...document() }).expect(401);
      for (const who of [reader, auditor, nobody, phaWriter, authority]) {
        expect((await importOne(who.cookie, document()).expect(403)).body).toEqual({
          code: 'missing_permission',
          permission: 'policies.manage',
        });
      }
      // Strict input.
      await importOne(writer.cookie, { ...document(), extra: true }).expect(400);
      const { approvedOn: _approvedOn, ...undated } = document();
      await importOne(writer.cookie, undated).expect(400);
      await post(writer.cookie, '/documents/import', document()).expect(400);
      await importOne(writer.cookie, document({ number: '<b>12</b>' })).expect(400);
      await importOne(writer.cookie, document({ approvedOn: '2025-02-30' })).expect(400);
      // Another client's category is no category of this one.
      expect((await importOne(writer.cookie, document({ categoryId: bCategory })).expect(400)).body).toEqual({
        code: 'unknown_category',
      });
      const inEnglish = { title: { en: 'Theirs' }, originalKeptAt: { en: 'Office' }, content: { en: { purpose: 'Why.' } } };
      expect((await importOne(bWriter.cookie, document(inEnglish)).expect(400)).body.code).toBe('unknown_type');
      // The same rules as written text, and as the client's languages.
      expect(
        (await importOne(writer.cookie, document({ content: { en: { purpose: 'See <a href="x">here</a>.' } } })).expect(400)).body,
      ).toEqual({ code: 'unsupported_markup', locale: 'en', section: 'purpose', problem: 'html' });
      expect(
        (await importOne(writer.cookie, document({ content: { en: { purpose: 'Why.' }, fr: { purpose: 'Pourquoi.' } } })).expect(400))
          .body,
      ).toEqual({ code: 'language_mismatch', field: 'content' });
      expect(
        (await importOne(writer.cookie, document({ content: { en: { purpose: 'Why.', annex: 'More.' } } })).expect(400)).body,
      ).toEqual({ code: 'unknown_section', section: 'annex' });
      expect(
        (await importOne(writer.cookie, document({ content: { en: { purpose: 'x'.repeat(20_001) } } })).expect(400)).body,
      ).toEqual({ code: 'section_too_long', locale: 'en', section: 'purpose', max: 20_000 });
      // Some of it in the authoritative language.
      expect((await importOne(writer.cookie, document({ content: { ar: { purpose: 'لماذا.' } } })).expect(400)).body).toEqual({
        code: 'content_required',
        locale: 'en',
      });
      expect((await importOne(writer.cookie, document({ title: { ar: 'بلا عنوان إنجليزي' } })).expect(400)).body).toEqual({
        code: 'language_mismatch',
        field: 'title',
      });
      expect((await importOne(writer.cookie, document({ originalKeptAt: { fr: 'Bureau' } })).expect(400)).body).toEqual({
        code: 'language_mismatch',
        field: 'originalKeptAt',
      });
      // The days: approved and in force already, reviewed later than approved
      // and no further away than the longest review period.
      const refusedFor = async (extra: Record<string, unknown>) =>
        (await importOne(writer.cookie, document(extra)).expect(400)).body;
      expect(await refusedFor({ approvedOn: shiftDay(today, 5) })).toEqual({ code: 'approved_in_future' });
      expect(await refusedFor({ effectiveOn: shiftDay(today, -401) })).toEqual({ code: 'effective_before_approval' });
      expect(await refusedFor({ effectiveOn: shiftDay(today, 3) })).toEqual({ code: 'effective_in_future' });
      expect(await refusedFor({ nextReviewOn: shiftDay(today, -400) })).toEqual({ code: 'review_before_approval' });
      expect(await refusedFor({ nextReviewOn: addMonths(today, 37) })).toEqual({
        code: 'review_date_too_far',
        latest: addMonths(today, 36),
        maxReviewMonths: 36,
      });
      expect(await refusedFor({ reviewMonths: 48 })).toEqual({ code: 'review_period_too_long', max: 36 });
      // None of it asked for the password, nor counted it.
      const wrong = { ...document(), password: 'not-it' };
      await post(writer.cookie, '/documents/import', { ...wrong, approvedOn: shiftDay(today, 5) }).expect(400);
      expect(await failedAttempts(writer)).toBe(0);
      // A wrong password: 401, nothing written, the session kept.
      const before = await documentCount(a.id);
      expect((await post(writer.cookie, '/documents/import', wrong).expect(401)).body).toEqual({ code: 'wrong_password' });
      expect(await documentCount(a.id)).toBe(before);
      await get(writer.cookie, '/summary').expect(200);
      await bench.owner.db.update(users).set({ failedAttempts: 0 }).where(eq(users.id, writer.id));
    });

    it('publishes it as version 1, approved before Trustline, signed by the importer, and shown so everywhere', async () => {
      const imported = (await importOne(importer.cookie, document({ number: 'LIFT-07/B' })).expect(201)).body as Doc;
      expect(imported).toMatchObject({
        number: 'LIFT-07/B',
        status: 'active',
        source: 'imported',
        nextReviewOn: shiftDay(today, 200),
        lastReviewedOn: null,
        reissueRequired: true,
        published: { version: 1, source: 'imported', approvedBeforeTrustline: true, acknowledgementRequired: false },
      });
      // Its review is a re-issue: a new version through the route, not a
      // confirmation that nothing changed.
      expect(imported.moves).toEqual(['edit', 'new_version', 'retire']);
      const version = await versionOf(reader.cookie, imported.id, imported.published!.id);
      expect(version).toMatchObject({ version: 1, status: 'published', source: 'imported', approvedAt: null, run: null });
      const control = version.control as Record<string, unknown>;
      expect(control).toMatchObject({
        number: 'LIFT-07/B',
        approvedThrough: 'before_trustline',
        approvals: [],
        preparedBy: null,
        inForce: true,
        effectiveOn: shiftDay(today, -400),
        approvedBeforeTrustline: {
          numberAsGiven: 'LIFT-07/B',
          revisionLabel: 'Rev. 3',
          approvedOn: shiftDay(today, -400),
          approvedBy: 'Head of Operations',
          originalKeptAt: { en: 'Quality office, cabinet 2', ar: 'مكتب الجودة، الخزانة 2' },
          effectiveOn: shiftDay(today, -400),
          nextReviewOn: shiftDay(today, 200),
          importedBy: { id: importer.id, name: { en: 'Person importer' } },
        },
      });
      const details = version.imported as {
        signature: { id: string; meaning: string; contentHash: string; signedBy: { id: string } };
        sectionsNotWritten: { key: string; required: boolean }[];
        batch: { size: number; index: number };
      };
      expect(details.batch).toMatchObject({ size: 1, index: 0 });
      expect(details.signature).toMatchObject({ meaning: 'imported', signedBy: { id: importer.id } });
      // The sections it came without, required ones too.
      expect(details.sectionsNotWritten).toEqual([
        { key: 'scope', required: true },
        { key: 'definitions', required: false },
        { key: 'responsibilities', required: true },
        { key: 'equipment_and_forms', required: false },
        { key: 'records', required: false },
        { key: 'exceptions_and_escalation', required: false },
        { key: 'references', required: false },
      ]);
      // The hash is of the version and what the original says, as signed.
      const original = (control.approvedBeforeTrustline as Record<string, unknown>);
      const { importedBy: _by, importedAt: _at, ...said } = original;
      expect(details.signature.contentHash).toBe(
        contentHash(
          signedImport({ id: imported.id, number: imported.number }, version as never, said as never),
        ),
      );
      // In the library and its history, and in nobody else's.
      const list = (await get(reader.cookie, '/documents?q=LIFT-07').expect(200)).body;
      expect(list.items).toEqual([expect.objectContaining({ id: imported.id, source: 'imported', version: 1 })]);
      const history = (await get(auditor.cookie, `/documents/${imported.id}/versions`).expect(200)).body;
      expect(history.versions).toEqual([expect.objectContaining({ version: 1, source: 'imported', status: 'published' })]);
      await get(bWriter.cookie, `/documents/${imported.id}`).expect(404);
      await get(bWriter.cookie, `/documents/${imported.id}/versions/${version.id}`).expect(404);

      // Stored: written once, one signature, no run, audited.
      const [row] = await bench.owner.db.select().from(documentImports).where(eq(documentImports.documentId, imported.id));
      expect(row).toMatchObject({ numberAsGiven: 'LIFT-07/B', signatureId: details.signature.id, importedBy: importer.id });
      const signed = await bench.owner.db.select().from(signatures).where(eq(signatures.subjectId, version.id));
      expect(signed.map((s) => [s.meaning, s.userId])).toEqual([['imported', importer.id]]);
      expect(await bench.owner.db.select().from(approvalRuns).where(eq(approvalRuns.subjectId, version.id))).toEqual([]);
      const [entry] = await bench.owner.db
        .select({ actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, imported.id), eq(auditLog.action, 'document_imported')));
      expect(entry).toMatchObject({
        actorId: importer.id,
        changes: {
          number: 'LIFT-07/B',
          numberFrom: 'given',
          versionId: version.id,
          signatureId: details.signature.id,
          contentHash: details.signature.contentHash,
          acknowledgementsAsked: 0,
          original: { approvedBy: 'Head of Operations', revisionLabel: 'Rev. 3' },
        },
      });

      // Asked of nobody, since the importer did not say so.
      expect(version.myAcknowledgement).toBeNull();
      expect(version.moves).not.toContain('acknowledge');
      const figures = (await get(auditor.cookie, `/documents/${imported.id}/versions/${version.id}/acknowledgements`).expect(200)).body;
      expect(figures).toMatchObject({ acknowledgementRequired: false, targeted: 0 });

      // The owner's review cannot confirm it unchanged: it is re-issued.
      // Refused before the password is asked.
      expect(
        (await post(writer.cookie, `/documents/${imported.id}/review`, { password: 'not-it', comment: 'Fine.', revision: imported.revision }).expect(409)).body,
      ).toEqual({ code: 'reissue_required' });
      expect(await failedAttempts(writer)).toBe(0);
    });

    it('keeps what it says of the original, and where it came from, as written: the database refuses a change', async () => {
      const imported = (await importOne(importer.cookie, document()).expect(201)).body as Doc;
      const app = new Pool({ connectionString: requireEnv('APP_DATABASE_URL') });
      const client = await app.connect();
      const refused = async (statement: string) => {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [a.id]);
        try {
          await expect(client.query(statement, [imported.id])).rejects.toThrow();
        } finally {
          await client.query('rollback');
        }
      };
      try {
        await refused(`update document_imports set approved_by = 'Someone else' where document_id = $1`);
        await refused(`delete from document_imports where document_id = $1`);
        await refused(`update document_import_batches set size = 2 where id in (select batch_id from document_imports where document_id = $1)`);
        await refused(`update document_versions set source = 'written' where document_id = $1`);
        await refused(`update documents set source = 'written' where id = $1`);
        await refused(`update documents set number = 'OTHER-1' where id = $1`);
        // An imported version is a document's first.
        await refused(
          `insert into document_versions (tenant_id, document_id, version, status, source, sections, prepared_by)
           select tenant_id, id, 9, 'draft', 'imported', '[]'::jsonb, created_by from documents where id = $1`,
        );
      } finally {
        client.release();
        await app.end();
      }
    });
  });

  describe('numbers', () => {
    it('keeps a free number as given, refuses one taken in any capitals, and keeps Trustline numbering after it', async () => {
      // In Trustline's shape: kept, and the series' counter moved past it.
      const counterOf = async () =>
        (
          await bench.owner.db
            .select({ last: referenceCounters.lastNumber })
            .from(referenceCounters)
            .where(and(eq(referenceCounters.tenantId, a.id), eq(referenceCounters.prefix, 'PRC-SAF')))
        )[0]?.last ?? 0;
      const from = await counterOf();
      expect(from).toBeLessThan(50);
      const given = (await importOne(writer.cookie, document({ number: 'PRC-SAF-050' })).expect(201)).body as Doc;
      expect(given.number).toBe('PRC-SAF-050');
      expect(await counterOf()).toBe(50);
      const [entry] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, given.id), eq(auditLog.action, 'document_imported')));
      expect(entry.changes).toMatchObject({ counter: { series: 'PRC-SAF', from, to: 50 } });
      // A document written in Trustline comes after it.
      const written = (await post(writer.cookie, '/documents', {
        typeId: types.procedure,
        categoryId: categories.SAF,
        title: { en: 'Written here' },
        ownerId: writer.id,
        ownerUnitId: dept,
      }).expect(201)).body as Doc;
      expect(written.number).toBe('PRC-SAF-051');
      // None given: Trustline numbers it.
      const numbered = (await importOne(writer.cookie, document()).expect(201)).body as Doc;
      expect(numbered.number).toBe('PRC-SAF-052');
      const numberedVersion = await versionOf(writer.cookie, numbered.id, numbered.published!.id);
      expect((numberedVersion.control as { approvedBeforeTrustline: { numberAsGiven: unknown } }).approvedBeforeTrustline.numberAsGiven).toBeNull();
      // Taken: in any capitals, with any zeros, by an import or by Trustline.
      for (const number of ['prc-saf-50', 'PRC-SAF-0050', 'PRC-SAF-51', 'Prc-Saf-052']) {
        expect((await importOne(writer.cookie, document({ number })).expect(409)).body.code).toBe('number_taken');
      }
      // A number of another shape is kept as given, spaces made one.
      const other = (await importOne(writer.cookie, document({ number: '  QM / 12  ' })).expect(201)).body as Doc;
      expect(other.number).toBe('QM / 12');
      expect((await importOne(writer.cookie, document({ number: 'qm / 12' })).expect(409)).body).toEqual({
        code: 'number_taken',
        takenBy: 'QM / 12',
      });
      // Another client's numbers are its own.
      const bType = (await get(b.cookie, '/types').expect(200)).body.find((t: { code: string }) => t.code === 'procedure').id;
      const bUnit = (await bench.owner.db.select({ id: users.orgUnitId }).from(users).where(eq(users.id, bWriter.id)))[0].id!;
      await post(bWriter.cookie, '/documents/import', {
        password,
        ...document({ typeId: bType, categoryId: bCategory, ownerId: bWriter.id, ownerUnitId: bUnit, number: 'QM / 12', title: { en: 'Theirs' }, originalKeptAt: { en: 'Office' }, content: { en: { purpose: 'Why.' } } }),
      }).expect(201);
      // Too many digits for a counter.
      expect((await importOne(writer.cookie, document({ number: 'PRC-SAF-1234567890' })).expect(400)).body).toEqual({
        code: 'invalid_number',
      });
    });
  });

  describe('a batch', () => {
    it('is checked first without the password, and refused whole with every document refused and why', async () => {
      await http().post('/policies/imports/check').send({ documents: [document()] }).expect(401);
      await http().post('/policies/imports').send({ password, documents: [document()] }).expect(401);
      for (const who of [reader, phaWriter, authority]) {
        await post(who.cookie, '/imports/check', { documents: [document()] }).expect(403);
        await post(who.cookie, '/imports', { password, documents: [document()] }).expect(403);
      }
      await post(writer.cookie, '/imports/check', { documents: [] }).expect(400);
      await post(writer.cookie, '/imports/check', { documents: document() }).expect(400);
      await post(writer.cookie, '/imports', { documents: [document()] }).expect(400);
      await post(writer.cookie, '/imports', { password, documents: [document()], extra: 1 }).expect(400);
      expect((await post(writer.cookie, '/imports/check', { documents: Array.from({ length: 21 }, () => document()) }).expect(400)).body).toEqual({
        code: 'batch_too_large',
        maxDocuments: 20,
        maxCharacters: 600_000,
      });

      const checked = (
        await post(writer.cookie, '/imports/check', {
          documents: [document({ number: 'BATCH-OK-1' }), document()],
        }).expect(200)
      ).body;
      expect(checked.documents).toEqual([
        expect.objectContaining({ index: 0, number: 'BATCH-OK-1', numberFrom: 'given', series: 'BATCH-OK' }),
        expect.objectContaining({ index: 1, number: null, numberFrom: 'trustline', series: 'PRC-SAF' }),
      ]);
      expect(checked.documents[0].sectionsNotWritten).toContainEqual({ key: 'scope', required: true });

      const before = await documentCount(a.id);
      const bad = [
        document({ number: 'BATCH-A-1' }),
        document({ number: 'BATCH-A-2', content: { en: { purpose: 'Write to x@example.com.' } } }),
        document({ number: 'batch-a-1' }),
        { ...document(), categoryId: 'nope' },
        document({ number: 'PRC-SAF-050' }),
      ];
      const refusal = (await post(writer.cookie, '/imports/check', { documents: bad }).expect(400)).body;
      expect(refusal).toEqual({
        code: 'batch_refused',
        problems: [
          { index: 1, number: 'BATCH-A-2', code: 'unsupported_markup', locale: 'en', section: 'purpose', problem: 'email_address', status: 400 },
          { index: 2, number: 'batch-a-1', code: 'duplicate_in_batch', sameAs: 0, status: 400 },
          { index: 3, number: null, code: 'invalid_document', fields: ['categoryId'], status: 400 },
          { index: 4, number: 'PRC-SAF-050', code: 'number_taken', takenBy: 'PRC-SAF-050', status: 409 },
        ],
      });
      // The same, signed: refused before the password, which is not counted,
      // and nothing imported, the good document neither.
      expect((await post(writer.cookie, '/imports', { password: 'not-it', documents: bad }).expect(400)).body).toEqual(refusal);
      expect(await failedAttempts(writer)).toBe(0);
      expect(await documentCount(a.id)).toBe(before);
    });

    it('imports every listed document under one password re-entry, each signed and audited, asking acknowledgement only where said', async () => {
      await post(writer.cookie, '/imports', { password: 'not-it', documents: [document()] }).expect(401);
      await bench.owner.db.update(users).set({ failedAttempts: 0 }).where(eq(users.id, writer.id));
      const res = (
        await post(writer.cookie, '/imports', {
          password,
          documents: [
            document({ number: 'BATCH-B-1' }),
            document({ acknowledgementRequired: true, acknowledgeWithinDays: 10, title: { en: 'Read and confirm' } }),
            document({
              number: 'BATCH-B-3',
              confidentiality: 'restricted',
              audience: { orgUnitIds: [pharmacy], roleIds: [] },
              ownerUnitId: pharmacy,
            }),
          ],
        }).expect(201)
      ).body as {
        batch: { id: string; size: number; listHash: string };
        documents: { index: number; id: string; number: string; versionId: string; acknowledgementsAsked: number; signature: { id: string; meaning: string; contentHash: string } }[];
      };
      expect(res.batch.size).toBe(3);
      expect(res.documents.map((d) => [d.index, d.number, d.signature.meaning])).toEqual([
        [0, 'BATCH-B-1', 'imported'],
        [1, expect.stringMatching(/^PRC-SAF-\d{3}$/), 'imported'],
        [2, 'BATCH-B-3', 'imported'],
      ]);
      // One signature each, a hash per version, and the batch's hash of the list.
      expect(new Set(res.documents.map((d) => d.signature.contentHash)).size).toBe(3);
      expect(res.batch.listHash).toBe(
        contentHash(
          res.documents.map((d) => ({
            index: d.index,
            documentId: d.id,
            number: d.number,
            versionId: d.versionId,
            contentHash: d.signature.contentHash,
          })),
        ),
      );
      const [batch] = await bench.owner.db.select().from(documentImportBatches).where(eq(documentImportBatches.id, res.batch.id));
      expect(batch).toMatchObject({ size: 3, importedBy: writer.id, listHash: res.batch.listHash });
      const entries = await bench.owner.db
        .select({ entityId: auditLog.entityId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'document_imported'), sql`${auditLog.changes} ->> 'batchId' = ${res.batch.id}`))
        .orderBy(asc(sql`${auditLog.changes} ->> 'batchIndex'`));
      expect(entries.map((e) => e.entityId)).toEqual(res.documents.map((d) => d.id));
      const [signedBatch] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'document_import_signed'), sql`${auditLog.changes} ->> 'batchId' = ${res.batch.id}`));
      expect(signedBatch.changes).toMatchObject({ size: 3, listHash: res.batch.listHash });

      // The second asks its audience, who are told; the others ask nobody.
      expect(res.documents.map((d) => d.acknowledgementsAsked)).toEqual([0, expect.any(Number), 0]);
      expect(res.documents[1].acknowledgementsAsked).toBeGreaterThan(0);
      const asked = res.documents[1];
      const seen = await versionOf(reader.cookie, asked.id, asked.versionId);
      expect(seen.myAcknowledgement).toMatchObject({ dueOn: shiftDay(today, 10), acknowledgedAt: null });
      expect(seen.moves).toContain('acknowledge');
      const told = await bench.owner.db
        .select({ kind: notifications.kind, data: notifications.data })
        .from(notifications)
        .where(and(eq(notifications.userId, reader.id), eq(notifications.documentId, asked.id)));
      expect(told).toEqual([
        {
          kind: 'document_published',
          data: expect.objectContaining({ version: 1, versionId: asked.versionId, dueOn: shiftDay(today, 10), number: asked.number }),
        },
      ]);
      await post(reader.cookie, `/documents/${asked.id}/versions/${asked.versionId}/acknowledge`, { password }).expect(200);

      // A restricted one is seen as any other restricted document.
      const restricted = res.documents[2];
      await get(reader.cookie, `/documents/${restricted.id}`).expect(404);
      await get(auditor.cookie, `/documents/${restricted.id}`).expect(200);
      await get(phaWriter.cookie, `/documents/${restricted.id}`).expect(200);
      await get(bWriter.cookie, `/documents/${res.documents[0].id}`).expect(404);
    });

    it('takes a body larger than other routes, up to its own limit, and only with a session', async () => {
      // A document of 180,000 characters: more than 100 kB, in one request.
      const long = 'A line of an existing procedure.\n'.repeat(600).slice(0, 19_999);
      const content = { en: Object.fromEntries(['purpose', 'scope', 'definitions', 'responsibilities', 'equipment_and_forms', 'steps', 'records', 'exceptions_and_escalation', 'references'].map((k) => [k, long])) };
      const big = (await importOne(writer.cookie, document({ content })).expect(201)).body as Doc;
      expect(big.source).toBe('imported');
      // Elsewhere, 100 kB.
      await post(writer.cookie, '/documents', { ...document({ content }), password: undefined }).expect(413);
      // Without a session, 100 kB here too.
      await http().post('/policies/documents/import').send({ password, ...document({ content }) }).expect(413);
      // Past 2 MB, refused as too large.
      const huge = 'x'.repeat(2 * 1024 * 1024);
      expect((await post(writer.cookie, '/imports', { password, documents: [huge] }).expect(413)).body).toMatchObject({
        code: 'body_too_large',
        max: 2 * 1024 * 1024,
      });
      // Not JSON: 400.
      await http()
        .post('/policies/imports')
        .set('Cookie', writer.cookie)
        .set('Content-Type', 'application/json')
        .send('{"documents": [')
        .expect(400);
    });
  });

  describe('the review of an imported document', () => {
    it('is a re-issue through the route and its signatures, which its importer decides no step of', async () => {
      const imported = (await importOne(importer.cookie, document({ number: 'REISSUE-1' })).expect(201)).body as Doc;
      // Started by another manager, from the imported text.
      let v2 = (await post(writer.cookie, `/documents/${imported.id}/versions`).expect(201)).body as Version;
      expect((v2.languageStatus as { comparedWith: { version: number } }).comparedWith).toMatchObject({ version: 1 });
      expect((v2.control as { approvedThrough: string }).approvedThrough).toBe('trustline_route');
      const [created] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'document_version_created'), sql`${auditLog.changes} ->> 'versionId' = ${v2.id}`));
      expect(created.changes).toMatchObject({ contributors: [importer.id, writer.id] });
      // The sections the original lacked are written before it goes.
      v2 = (await patch(writer.cookie, `/documents/${imported.id}/versions/${v2.id}`, { changeSummary: { en: 'Re-issued in Trustline.' }, revision: v2.revision }).expect(200)).body;
      expect((await post(writer.cookie, `/documents/${imported.id}/versions/${v2.id}/submit`, { revision: v2.revision }).expect(400)).body).toEqual({
        code: 'missing_sections',
        locale: 'en',
        sections: ['scope', 'responsibilities'],
      });
      v2 = (
        await patch(writer.cookie, `/documents/${imported.id}/versions/${v2.id}`, {
          content: { en: { scope: 'Everyone who lifts.', responsibilities: 'Managers train their staff.' } },
          revision: v2.revision,
        }).expect(200)
      ).body;
      v2 = (await post(writer.cookie, `/documents/${imported.id}/versions/${v2.id}/submit`, { revision: v2.revision }).expect(200)).body;
      // The importer is a quality officer, the step's role, but put the text here.
      const theirs = await versionOf(importer.cookie, imported.id, v2.id);
      expect(theirs.moves).not.toContain('approve');
      expect(
        (await post(importer.cookie, `/documents/${imported.id}/versions/${v2.id}/approve`, { password, revision: v2.revision }).expect(403)).body,
      ).toEqual({ code: 'same_person', reason: 'prepared' });
      v2 = (await post(quality.cookie, `/documents/${imported.id}/versions/${v2.id}/approve`, { password, revision: v2.revision }).expect(200)).body;
      // The Approving authority gives the approval.
      v2 = (await post(authority.cookie, `/documents/${imported.id}/versions/${v2.id}/approve`, { password, revision: v2.revision }).expect(200)).body;
      expect(v2.status).toBe('approved');
      v2 = (await post(writer.cookie, `/documents/${imported.id}/versions/${v2.id}/publish`, { revision: v2.revision }).expect(200)).body;
      expect(v2).toMatchObject({ status: 'published', source: 'written', imported: null });
      const control = v2.control as { approvedThrough: string; approvals: { signedBy: { id: string } }[]; approvedBeforeTrustline: unknown };
      expect(control.approvedThrough).toBe('trustline_route');
      expect(control.approvals.map((x) => x.signedBy.id)).toEqual([quality.id, authority.id]);
      expect(control.approvedBeforeTrustline).toBeNull();
      // The review it was due for is answered by the revision; reviews are
      // confirmed again from now on.
      const doc = (await get(writer.cookie, `/documents/${imported.id}`).expect(200)).body as Doc;
      expect(doc).toMatchObject({ source: 'imported', reissueRequired: false, published: { version: 2, source: 'written', approvedBeforeTrustline: false } });
      expect(doc.moves).toContain('confirm_review');
      const [review] = await bench.owner.db.select().from(documentReviews).where(eq(documentReviews.documentId, imported.id));
      expect(review).toMatchObject({ outcome: 'revised', dueOn: shiftDay(today, 200) });
      // The imported version stays in the history as it was.
      const v1 = await versionOf(auditor.cookie, imported.id, imported.published!.id);
      expect(v1).toMatchObject({ status: 'superseded', source: 'imported' });
      expect((v1.control as { approvedThrough: string }).approvedThrough).toBe('before_trustline');
    });

    it('counts in the measures as any document: by its review date, and its readers only if asked', async () => {
      const before = (await get(auditor.cookie, '/summary').expect(200)).body;
      const late = (
        await importOne(writer.cookie, document({ approvedOn: shiftDay(today, -800), nextReviewOn: shiftDay(today, -10) })).expect(201)
      ).body as Doc;
      expect(late.review).toBe('overdue');
      const after = (await get(auditor.cookie, '/summary').expect(200)).body;
      expect(after.active).toBe(before.active + 1);
      expect(after.pastReview.count).toBe(before.pastReview.count + 1);
      // Its review is due and is a re-issue.
      const reviews = (await get(writer.cookie, '/reviews').expect(200)).body.items as { id: string; state: string; reissue: boolean }[];
      expect(reviews.find((r) => r.id === late.id)).toMatchObject({ state: 'overdue', reissue: true });
      // Asked of nobody: the acknowledgement figures do not change.
      expect(after.acknowledgement.live.targeted).toBe(before.acknowledgement.live.targeted);
      // Its owner is reminded as for any document, and told it is a re-issue.
      await bench.app.get(PolicyCheck, { strict: false }).run(new Date(), [a.id]);
      const [overdue] = await bench.owner.db
        .select({ data: notifications.data })
        .from(notifications)
        .where(and(eq(notifications.userId, writer.id), eq(notifications.documentId, late.id), eq(notifications.kind, 'review_overdue')));
      expect(overdue.data).toMatchObject({ dueOn: shiftDay(today, -10), reissue: true });
      // The master list says which documents are in force as approved before Trustline.
      const rows = (await get(auditor.cookie, '/exports/documents?locale=en').expect(200)).text
        .slice(1)
        .split('\r\n')
        .filter((line) => line !== '')
        .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]));
      expect(rows[0].at(-1)).toBe('Approved before Trustline');
      expect(rows.find((r) => r[0] === late.number)!.at(-1)).toBe('Yes');
      expect(rows.find((r) => r[0] === 'REISSUE-1')!.at(-1)).toBe('No');
    });
  });

  describe('the authoritative language', () => {
    it('is the main language until a manager for the whole organization chooses another, audited', async () => {
      let settings = (await get(reader.cookie, '/settings').expect(200)).body;
      expect(settings).toMatchObject({ authoritativeLocale: null, authoritative: 'en' });
      await http().patch('/policies/settings').send({ authoritativeLocale: 'ar', revision: settings.revision }).expect(401);
      expect((await patch(phaWriter.cookie, '/settings', { authoritativeLocale: 'ar', revision: settings.revision }).expect(403)).body.code).toBe('missing_permission');
      await patch(reader.cookie, '/settings', { authoritativeLocale: 'ar', revision: settings.revision }).expect(403);
      await patch(writer.cookie, '/settings', { authoritativeLocale: 'de', revision: settings.revision }).expect(400);
      await patch(writer.cookie, '/settings', { revision: settings.revision }).expect(400);
      expect((await patch(writer.cookie, '/settings', { authoritativeLocale: 'fr', revision: settings.revision }).expect(400)).body).toEqual({
        code: 'language_mismatch',
      });
      expect((await patch(writer.cookie, '/settings', { authoritativeLocale: 'ar', revision: settings.revision + 5 }).expect(409)).body.code).toBe(
        'stale_settings',
      );

      // A draft written in English only, in progress when it changes.
      const draft = (await post(writer.cookie, '/documents', {
        typeId: types.work_instruction,
        categoryId: categories.OPS,
        title: { en: 'Opening up' },
        ownerId: writer.id,
        ownerUnitId: dept,
      }).expect(201)).body as Doc;
      let version = await versionOf(writer.cookie, draft.id, draft.inProgress!.id);
      version = (
        await patch(writer.cookie, `/documents/${draft.id}/versions/${version.id}`, {
          content: { en: { purpose: 'To open safely.', steps: '1. Unlock.' }, ar: { purpose: 'الفتح بأمان.' } },
          revision: version.revision,
        }).expect(200)
      ).body;

      const changed = (await patch(writer.cookie, '/settings', { authoritativeLocale: 'ar', revision: settings.revision }).expect(200)).body;
      expect(changed).toMatchObject({
        authoritativeLocale: 'ar',
        authoritative: 'ar',
        revision: settings.revision + 1,
        versionsInProgress: { draft: expect.any(Number), in_review: expect.any(Number), approved: expect.any(Number) },
      });
      expect(changed.versionsInProgress.draft).toBeGreaterThan(0);
      const [entry] = await bench.owner.db
        .select({ actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'document_settings_updated')))
        .orderBy(sql`${auditLog.occurredAt} desc`)
        .limit(1);
      expect(entry).toMatchObject({
        actorId: writer.id,
        changes: {
          authoritativeLocale: { from: null, to: 'ar' },
          authoritative: { from: 'en', to: 'ar' },
          versionsInProgress: changed.versionsInProgress,
        },
      });
      settings = (await get(reader.cookie, '/settings').expect(200)).body;
      expect(settings).toMatchObject({ authoritativeLocale: 'ar', authoritative: 'ar' });
      // Another client's is its own.
      expect((await get(bWriter.cookie, '/settings').expect(200)).body).toMatchObject({ authoritativeLocale: null, authoritative: 'en' });

      // The version in progress keeps its text, and is now shown and
      // checked against Arabic.
      version = await versionOf(writer.cookie, draft.id, version.id);
      expect(version.languages).toEqual(['ar', 'en']);
      expect(version.languageStatus).toMatchObject({
        authoritative: 'ar',
        byLocale: { ar: { written: 1, empty: 3 }, en: { written: 2, fallback: 0, empty: 2 } },
      });
      expect((await post(writer.cookie, `/documents/${draft.id}/versions/${version.id}/submit`, { revision: version.revision }).expect(400)).body).toEqual({
        code: 'missing_sections',
        locale: 'ar',
        sections: ['steps'],
      });
      // An import too: some of its text in Arabic.
      expect((await importOne(writer.cookie, document({ content: { en: { purpose: 'Why.' } } })).expect(400)).body).toEqual({
        code: 'content_required',
        locale: 'ar',
      });
      const arabic = (await importOne(writer.cookie, document()).expect(201)).body as Doc;
      const arabicVersion = await versionOf(writer.cookie, arabic.id, arabic.published!.id);
      // Not written in Arabic: everything but the purpose.
      expect((arabicVersion.imported as { sectionsNotWritten: { key: string }[] }).sectionsNotWritten.map((s) => s.key)).not.toContain('purpose');
      expect((arabicVersion.imported as { sectionsNotWritten: { key: string }[] }).sectionsNotWritten.map((s) => s.key)).toContain('steps');

      // Back to the main language, whatever it is.
      const back = (await patch(writer.cookie, '/settings', { authoritativeLocale: null, revision: settings.revision }).expect(200)).body;
      expect(back).toMatchObject({ authoritativeLocale: null, authoritative: 'en' });
      version = await versionOf(writer.cookie, draft.id, version.id);
      expect(version.languages).toEqual(['en', 'ar']);
      await post(writer.cookie, `/documents/${draft.id}/versions/${version.id}/submit`, { revision: version.revision }).expect(200);
    });
  });
});
