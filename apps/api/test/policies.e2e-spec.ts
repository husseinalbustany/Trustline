import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  approvalRouteSteps,
  approvalRunSteps,
  auditLog,
  documentAcknowledgements,
  documents,
  documentVersions,
  signatures,
  users,
} from '../src/database/schema.js';
import {
  DEFAULT_DOCUMENT_CATEGORIES,
  DEFAULT_DOCUMENT_TYPES,
} from '../src/policies/defaults.js';
import { contentHash } from '../src/approvals/signatures.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const randomUUIDLike = () => randomUUID();

type Doc = {
  id: string;
  number: string;
  revision: number;
  status: string;
  moves: string[];
  inProgress: { id: string; version: number; status: string } | null;
  published: { id: string; version: number } | null;
};
type Version = {
  id: string;
  version: number;
  status: string;
  revision: number;
  moves: string[];
  contentHash: string;
  content: Record<string, Record<string, string>>;
  comparison: { key: string; changed: boolean }[] | null;
  control: { approvals: { position: number; signedBy: { id: string } }[] };
  returned: { comment: string }[];
  run: { status: string; steps: { status: string }[] } | null;
};

/**
 * The policies and procedures module (docs/specs/policies-and-procedures.md):
 * documents and their versions, who may see and do what, the approval
 * order with signatures, publishing, acknowledgement and periodic review,
 * and the settings. The daily check, the module switched off and the
 * subscription suspended are in policies-check.e2e-spec.ts.
 */
describe('policies and procedures', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  const password = `hospital-pass-${run}`;

  let a: Hospital;
  let b: Hospital;
  let facility: string;
  let nursing: string; // a department
  let ward: string; // a unit of nursing
  let pharmacy: string; // another department

  let writer: Staff; // manages documents everywhere, approves nothing
  let pharmacyWriter: Staff; // manages documents of the pharmacy only
  let quality: Staff; // quality officer everywhere: reviews by default
  let approver: Staff; // administrator everywhere: approves by default
  let secondApprover: Staff; // administrator everywhere too
  let reader: Staff; // reads documents, works on the ward
  let pharmacist: Staff; // reads documents, works in the pharmacy
  let auditor: Staff; // sees every document, does nothing else
  let nurseManager: Staff; // department manager of nursing
  let nobody: Staff; // holds no permission of the module
  let quality2: Staff; // a second quality officer everywhere
  let signer: Staff; // reads and approves, manages and sees nothing more
  let lockme: Staff; // an administrator whose password is tried wrong
  let bWriter: Staff;
  // A type of document of these tests' own, whose route reviews by the
  // signer role, so that an assignee who sees nothing else can be tested.
  let guideline: string;

  const get = (cookie: string, url: string) =>
    http().get(`/policies${url}`).set('Cookie', cookie);
  const post = (cookie: string, url: string, body: unknown = {}) =>
    http().post(`/policies${url}`).set('Cookie', cookie).send(body as object);
  const patch = (cookie: string, url: string, body: unknown) =>
    http().patch(`/policies${url}`).set('Cookie', cookie).send(body as object);

  let types: Record<string, string>;
  let categories: Record<string, string>;
  const roleOf = (h: Hospital, code: string) => h.roles[code];

  /** A member of staff with one role and a home unit. */
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

  const newDocument = (cookie: string, extra: Record<string, unknown> = {}) =>
    post(cookie, '/documents', {
      typeId: types.procedure,
      categoryId: categories.SAF,
      title: { en: 'Handling a spill', ar: 'التعامل مع الانسكاب' },
      ownerId: writer.id,
      ownerUnitId: nursing,
      ...extra,
    });

  const FULL = {
    purpose: 'To make a spill safe quickly.',
    scope: 'Everyone working on the premises.',
    responsibilities: 'The person who finds it **reports** it.',
    steps: '1. Mark the area.\n2. Clean it.\n3. Record it.',
  };

  const write = (
    cookie: string,
    doc: { id: string },
    version: { id: string; revision: number },
    body: Record<string, unknown>,
  ) =>
    patch(cookie, `/documents/${doc.id}/versions/${version.id}`, {
      revision: version.revision,
      ...body,
    });

  const versionOf = async (cookie: string, docId: string, versionId: string) =>
    (await get(cookie, `/documents/${docId}/versions/${versionId}`).expect(200))
      .body as Version;

  /** A document with its first version written and sent for review. */
  async function inReview(extra: Record<string, unknown> = {}) {
    const doc = (await newDocument(writer.cookie, extra).expect(201))
      .body as Doc;
    let version = await versionOf(writer.cookie, doc.id, doc.inProgress!.id);
    version = (
      await write(writer.cookie, doc, version, { content: { en: FULL } }).expect(
        200,
      )
    ).body;
    version = (
      await post(
        writer.cookie,
        `/documents/${doc.id}/versions/${version.id}/submit`,
        { revision: version.revision },
      ).expect(200)
    ).body;
    return { doc, version };
  }

  const decide = (
    who: Staff,
    doc: { id: string },
    version: { id: string; revision: number },
    action: 'approve' | 'return',
    extra: Record<string, unknown> = {},
  ) =>
    post(who.cookie, `/documents/${doc.id}/versions/${version.id}/${action}`, {
      revision: version.revision,
      ...(action === 'approve' ? { password } : { comment: 'Not yet.' }),
      ...extra,
    });

  /** A document approved by both steps of its route, not yet published. */
  async function approved(extra: Record<string, unknown> = {}) {
    const { doc, version } = await inReview(extra);
    const reviewed = (await decide(quality, doc, version, 'approve').expect(200))
      .body as Version;
    const done = (await decide(approver, doc, reviewed, 'approve').expect(200))
      .body as Version;
    return { doc, version: done };
  }

  /** A document published now. */
  async function published(extra: Record<string, unknown> = {}) {
    const { doc, version } = await approved(extra);
    const after = (
      await post(
        writer.cookie,
        `/documents/${doc.id}/versions/${version.id}/publish`,
        { revision: version.revision },
      ).expect(200)
    ).body as Version;
    return { doc, version: after };
  }

  const listOf = async (cookie: string, query = '') =>
    (await get(cookie, `/documents?pageSize=100${query}`).expect(200)).body as {
      total: number;
      items: { id: string; number: string }[];
    };

  const notificationsOf = async (cookie: string) =>
    (
      await http()
        .get('/notifications?pageSize=100')
        .set('Cookie', cookie)
        .expect(200)
    ).body.items as {
      kind: string;
      document: { id: string; number: string; title: unknown; canOpen: boolean } | null;
      data: Record<string, unknown>;
    }[];

  beforeAll(async () => {
    bench = await testBench('pol', run);
    a = await bench.createHospital('a', { locales: ['en', 'ar'] });
    b = await bench.createHospital('b');
    facility = await bench.createUnit(a, 'facility', 'F', null);
    nursing = await bench.createUnit(a, 'department', 'NUR', facility);
    ward = await bench.createUnit(a, 'unit', 'WARD', nursing);
    pharmacy = await bench.createUnit(a, 'department', 'PHA', facility);
    await bench.createRole(a, 'writer', ['policies.view', 'policies.manage']);
    await bench.createRole(a, 'auditor', ['policies.view_all']);
    await bench.createRole(a, 'none', ['reports.view']);
    await bench.createRole(a, 'signer', ['policies.view', 'policies.approve']);
    await bench.createRole(a, 'lonely', ['policies.approve']);

    writer = await staff(a, 'writer', 'writer', null, nursing);
    pharmacyWriter = await staff(a, 'phawriter', 'writer', pharmacy, pharmacy);
    quality = await staff(a, 'quality', 'quality_officer', null, facility);
    approver = await staff(a, 'approver', ['administrator', 'approving_authority'], null, facility);
    secondApprover = await staff(a, 'approver2', ['administrator', 'approving_authority'], null, facility);
    reader = await staff(a, 'reader', 'reporter', null, ward);
    pharmacist = await staff(a, 'pharmacist', 'reporter', null, pharmacy);
    auditor = await staff(a, 'auditor', 'auditor', null, facility);
    nurseManager = await staff(a, 'nursemgr', 'department_manager', nursing, nursing);
    nobody = await staff(a, 'nobody', 'none', null, ward);
    quality2 = await staff(a, 'quality2', 'quality_officer', null, facility);
    signer = await staff(a, 'signer', 'signer', null, pharmacy);
    lockme = await staff(a, 'lockme', ['administrator', 'approving_authority'], null, facility);

    const bUnit = await bench.createUnit(b, 'facility', 'F', null);
    await bench.createRole(b, 'writer', ['policies.view', 'policies.manage']);
    bWriter = await staff(b, 'bwriter', 'writer', null, bUnit);

    const typeList = (await get(a.cookie, '/types').expect(200)).body as {
      id: string;
      code: string;
    }[];
    types = Object.fromEntries(typeList.map((t) => [t.code, t.id]));
    const categoryList = (await get(a.cookie, '/categories').expect(200))
      .body as { id: string; code: string }[];
    categories = Object.fromEntries(categoryList.map((c) => [c.code, c.id]));

    guideline = (
      await post(a.cookie, '/types', {
        code: 'guideline',
        name: { en: 'Guideline', ar: 'دليل' },
        numberPrefix: 'gdl',
        sections: [
          { key: 'purpose', name: { en: 'Purpose' }, required: true },
          { key: 'guidance', name: { en: 'Guidance' }, required: true },
        ],
        defaultReviewMonths: 12,
      }).expect(201)
    ).body.id;
    await post(a.cookie, '/approval-routes', {
      name: { en: 'Guideline approval' },
      documentTypeId: guideline,
      steps: [
        { kind: 'review', roleId: roleOf(a, 'signer'), dueInDays: 5 },
        { kind: 'approve', roleId: roleOf(a, 'administrator'), dueInDays: 5 },
      ],
    }).expect(201);
  }, 180_000);

  afterAll(() => bench.close());

  describe('what every client starts with', () => {
    // The other client: this one has a type of the tests' own.
    it('has the three types with their sections, the categories and a route per type, in every language', async () => {
      const typeList = (await get(b.cookie, '/types').expect(200)).body;
      expect(
        typeList.map((t: { code: string; numberPrefix: string; defaultReviewMonths: number }) => [
          t.code,
          t.numberPrefix,
          t.defaultReviewMonths,
        ]),
      ).toEqual(
        DEFAULT_DOCUMENT_TYPES.map((t) => [t.code, t.numberPrefix, t.defaultReviewMonths]),
      );
      for (const type of typeList) {
        expect(Object.keys(type.name).sort()).toEqual(['ar', 'en', 'fr']);
        for (const s of type.sections) {
          expect(Object.keys(s.name).sort()).toEqual(['ar', 'en', 'fr']);
        }
      }
      expect(typeList[1].sections.map((s: { key: string }) => s.key)).toEqual([
        'purpose',
        'scope',
        'definitions',
        'responsibilities',
        'equipment_and_forms',
        'steps',
        'records',
        'exceptions_and_escalation',
        'references',
      ]);
      const categoryList = (await get(b.cookie, '/categories').expect(200)).body;
      expect(categoryList.map((c: { code: string }) => c.code)).toEqual(
        DEFAULT_DOCUMENT_CATEGORIES.map((c) => c.code),
      );
      const routes = (await get(b.cookie, '/approval-routes').expect(200)).body;
      expect(routes).toHaveLength(3);
      for (const route of routes) {
        expect(Object.keys(route.name).sort()).toEqual(['ar', 'en', 'fr']);
        expect(
          route.steps.map((s: { kind: string; assignee: { role: { id: string } } }) => [
            s.kind,
            s.assignee.role.id,
          ]),
        ).toEqual([
          ['review', roleOf(b, 'quality_officer')],
          ['approve', roleOf(b, 'approving_authority')],
        ]);
      }
    });
  });

  describe('the cycle', () => {
    it('drafts, reviews, approves with signatures, publishes and is acknowledged', async () => {
      const created = await newDocument(writer.cookie, {
        acknowledgementRequired: true,
        audience: { orgUnitIds: [nursing], roleIds: [] },
      }).expect(201);
      const doc = created.body as Doc;
      expect(doc.number).toMatch(/^PRC-SAF-\d{3}$/);
      expect(doc.status).toBe('draft');
      expect(doc.inProgress).toMatchObject({ version: 1, status: 'draft' });
      let version = await versionOf(writer.cookie, doc.id, doc.inProgress!.id);
      expect(version.moves).toEqual(['edit', 'submit', 'withdraw']);
      version = (
        await write(writer.cookie, doc, version, { content: { en: FULL } }).expect(200)
      ).body;
      version = (
        await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/submit`, {
          revision: version.revision,
        }).expect(200)
      ).body;
      expect(version.status).toBe('in_review');
      const toQuality = await notificationsOf(quality.cookie);
      expect(toQuality.find((n) => n.document?.id === doc.id)).toMatchObject({
        kind: 'document_step_assigned',
        data: { number: doc.number, version: 1, position: 1, step: 'review' },
        document: { canOpen: true },
      });
      const reviewed = (await decide(quality, doc, version, 'approve').expect(200))
        .body as Version;
      const done = (await decide(approver, doc, reviewed, 'approve').expect(200))
        .body as Version;
      expect(done.status).toBe('approved');
      expect(done.control.approvals.map((x) => x.signedBy.id)).toEqual([
        quality.id,
        approver.id,
      ]);
      const stored = await bench.owner.db
        .select()
        .from(signatures)
        .where(eq(signatures.subjectId, version.id));
      expect(stored.map((s) => s.meaning)).toEqual(['reviewed', 'approved']);
      expect(new Set(stored.map((s) => s.contentHash))).toEqual(
        new Set([done.contentHash]),
      );
      const live = (
        await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, {
          revision: done.revision,
        }).expect(200)
      ).body as Version;
      expect(live.status).toBe('published');
      const asked = await notificationsOf(reader.cookie);
      expect(asked.find((n) => n.document?.id === doc.id)).toMatchObject({
        kind: 'document_published',
        data: { version: 1 },
      });
      const forReader = await versionOf(reader.cookie, doc.id, version.id);
      expect(forReader.moves).toEqual(['acknowledge']);
      const ack = await post(
        reader.cookie,
        `/documents/${doc.id}/versions/${version.id}/acknowledge`,
        { password },
      ).expect(200);
      expect(ack.body.signature.contentHash).toBe(done.contentHash);
      const figures = await get(
        writer.cookie,
        `/documents/${doc.id}/versions/${version.id}/acknowledgements`,
      ).expect(200);
      expect(figures.body.acknowledged).toBe(1);
      expect(figures.body.targeted).toBeGreaterThanOrEqual(2);
    }, 60_000);
  });

  /** A guideline sent for review: its first step is the signer's. */
  async function guidelineInReview(extra: Record<string, unknown> = {}) {
    const doc = (
      await newDocument(writer.cookie, {
        typeId: guideline,
        categoryId: categories.QUA,
        title: { en: `Guideline ${randomBytes(3).toString('hex')}` },
        ...extra,
      }).expect(201)
    ).body as Doc;
    let version = await versionOf(writer.cookie, doc.id, doc.inProgress!.id);
    version = (
      await write(writer.cookie, doc, version, {
        content: {
          en: {
            purpose: 'Why this guidance exists.',
            guidance: `Keep the corridor clear of trolleys ${run}.`,
          },
        },
      }).expect(200)
    ).body;
    version = (
      await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/submit`, {
        revision: version.revision,
      }).expect(200)
    ).body;
    return { doc, version };
  }

  describe('creating a document', () => {
    it('needs a session', async () => {
      await http().post('/policies/documents').send({}).expect(401);
      await http().get('/policies/documents').expect(401);
    });

    it('needs the right to manage documents, for the owning unit', async () => {
      const refused = await newDocument(reader.cookie).expect(403);
      expect(refused.body).toMatchObject({
        code: 'missing_permission',
        permission: 'policies.manage',
      });
      // Managing the pharmacy's documents does not reach nursing's.
      const outside = await newDocument(pharmacyWriter.cookie).expect(403);
      expect(outside.body.code).toBe('outside_scope');
      await newDocument(pharmacyWriter.cookie, {
        ownerUnitId: pharmacy,
        ownerId: pharmacyWriter.id,
      }).expect(201);
      // Holding none of the module's permissions, not even the library.
      expect(
        (await get(nobody.cookie, '/documents').expect(403)).body.code,
      ).toBe('missing_permission');
    });

    it('refuses what is not a document', async () => {
      const bad = [
        { title: undefined },
        { title: { en: 'A\u0007bell' } },
        { title: { fr: 'Pas une langue du client' } },
        { surprise: true },
        { confidentiality: 'secret' },
        { keywords: ['x'.repeat(61)] },
        { reviewMonths: 0 },
        { audience: { orgUnitIds: ['not-an-id'] } },
      ];
      for (const extra of bad) {
        const res = await newDocument(writer.cookie, extra);
        expect({ extra, status: res.status }).toEqual({ extra, status: 400 });
      }
      const codes = async (extra: Record<string, unknown>) =>
        (await newDocument(writer.cookie, extra).expect(400)).body.code;
      expect(await codes({ title: { fr: 'Non' } })).toBe('language_mismatch');
      expect(await codes({ typeId: randomUUIDLike() })).toBe('unknown_type');
      const bCategories = (await get(b.cookie, '/categories').expect(200)).body;
      expect(await codes({ categoryId: bCategories[0].id })).toBe(
        'unknown_category',
      );
      expect(await codes({ ownerId: bWriter.id })).toBe('unknown_owner');
      expect(await codes({ audience: { orgUnitIds: [randomUUIDLike()] } })).toBe(
        'unknown_org_unit',
      );
      expect(await codes({ audience: { roleIds: [b.roles.reporter] } })).toBe(
        'unknown_role',
      );
    });

    it("answers another client's document as one that does not exist", async () => {
      const theirs = (
        await post(bWriter.cookie, '/documents', {
          typeId: (await get(b.cookie, '/types').expect(200)).body[0].id,
          categoryId: (await get(b.cookie, '/categories').expect(200)).body[0].id,
          title: { en: 'Theirs' },
          ownerId: bWriter.id,
          ownerUnitId: (
            await bench.owner.db.execute<{ id: string }>(
              sql`select id from org_units where tenant_id = ${b.id} limit 1`,
            )
          ).rows[0].id,
        }).expect(201)
      ).body as Doc;
      await get(a.cookie, `/documents/${theirs.id}`).expect(404);
      await get(a.cookie, `/documents/${theirs.id}/versions`).expect(404);
      await get(
        a.cookie,
        `/documents/${theirs.id}/versions/${theirs.inProgress!.id}`,
      ).expect(404);
      await patch(a.cookie, `/documents/${theirs.id}`, {
        title: { en: 'Mine now' },
        revision: theirs.revision,
      }).expect(404);
      await post(a.cookie, `/documents/${theirs.id}/versions/${theirs.inProgress!.id}/submit`, {
        revision: 1,
      }).expect(404);
      await post(a.cookie, `/documents/${theirs.id}/retire`, {
        reason: 'No.',
        revision: theirs.revision,
      }).expect(404);
      await get(a.cookie, '/documents/not-an-id').expect(404);
    });

    it('numbers documents from a counter per prefix and category, never twice, even at the same moment', async () => {
      const made = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          newDocument(writer.cookie, {
            typeId: types.work_instruction,
            categoryId: categories.OPS,
            title: { en: `At once ${i}` },
          }),
        ),
      );
      expect(made.map((r) => r.status)).toEqual(Array(8).fill(201));
      const numbers = made.map((r) => r.body.number as string).sort();
      expect(numbers).toEqual(
        Array.from({ length: 8 }, (_, i) => `WI-OPS-${String(i + 1).padStart(3, '0')}`),
      );
      // Another category is another series.
      const other = await newDocument(writer.cookie, {
        typeId: types.work_instruction,
        categoryId: categories.HR,
      }).expect(201);
      expect(other.body.number).toBe('WI-HR-001');
      // Another client counts its own.
      expect(
        (
          await bench.owner.db.execute<{ n: number }>(
            sql`select count(*)::int as n from reference_counters where tenant_id = ${a.id} and prefix = 'WI-OPS' and last_number = 8`,
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it('is audited', async () => {
      const doc = (await newDocument(writer.cookie).expect(201)).body as Doc;
      const [entry] = await bench.owner.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, doc.id), eq(auditLog.action, 'document_created')));
      expect(entry).toMatchObject({ actorId: writer.id, tenantId: a.id });
      expect(entry.changes).toMatchObject({ number: doc.number });
    });
  });

  describe('writing a version', () => {
    let doc: Doc;
    let version: Version;
    beforeAll(async () => {
      doc = (await newDocument(writer.cookie).expect(201)).body;
      version = await versionOf(writer.cookie, doc.id, doc.inProgress!.id);
    });
    const save = (content: unknown) =>
      write(writer.cookie, doc, version, { content });

    it('keeps the small markup and refuses everything else', async () => {
      const fine = '# Heading\n\nA paragraph with **bold**.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\nLess than < 5 is text.';
      const saved = await save({ en: { purpose: fine } }).expect(200);
      expect(saved.body.content.en.purpose).toBe(fine);
      version = saved.body;
      const refused: [string, string][] = [
        ['<script>alert(1)</script>', 'html'],
        ['<b>bold</b>', 'html'],
        ['<!-- hidden -->', 'html'],
        ['See [here](https://example.invalid)', 'link'],
        ['- [x]: javascript:alert(1)\n\nSee [x] for details.', 'link'],
        ['1. [x]: https://example.invalid/login\n\nSee [x].', 'link'],
        ['Sign in at https://example.invalid/login', 'web_address'],
        ['- see www.example.invalid', 'web_address'],
        ['Write to someone@example.invalid', 'email_address'],
        ['<https://example.invalid>', 'html'],
        ['![picture](https://example.invalid/a.png)', 'image'],
        ['Run `rm`', 'code'],
        ['> quoted', 'quote'],
        ['| a | b |', 'table'],
        ['#### Too deep', 'heading_level'],
        ['Text.\n\n    indented code', 'indented'],
        ['A bell \u0007 rings', 'control_character'],
      ];
      for (const [text, problem] of refused) {
        const res = await save({ en: { purpose: text } }).expect(400);
        expect({ text, body: res.body }).toMatchObject({
          text,
          body: { code: 'unsupported_markup', section: 'purpose', locale: 'en', problem },
        });
      }
    });

    it('limits each section and the whole version', async () => {
      const long = 'a'.repeat(20_001);
      const res = await save({ en: { purpose: long } }).expect(400);
      expect(res.body).toMatchObject({ code: 'section_too_long', max: 20_000 });
      const full = 'b'.repeat(20_000);
      const keys = ['purpose', 'scope', 'definitions', 'responsibilities', 'equipment_and_forms', 'steps', 'records', 'exceptions_and_escalation', 'references'];
      version = (await save({ en: Object.fromEntries(keys.slice(0, 4).map((k) => [k, full])) }).expect(200)).body;
      version = (await save({ en: Object.fromEntries(keys.slice(4, 8).map((k) => [k, full])) }).expect(200)).body;
      const over = await save({
        en: { references: full },
        ar: { purpose: full, scope: full },
      }).expect(400);
      expect(over.body).toMatchObject({ code: 'content_too_large', max: 200_000 });
      // Emptied, a section is gone.
      version = (
        await save({ en: Object.fromEntries(keys.map((k) => [k, null])) }).expect(200)
      ).body;
      expect(version.content).toEqual({});
    });

    it('takes only its own sections, in the languages of the client', async () => {
      expect((await save({ en: { nonsense: 'x' } }).expect(400)).body).toMatchObject({
        code: 'unknown_section',
        section: 'nonsense',
      });
      expect((await save({ fr: { purpose: 'x' } }).expect(400)).body.code).toBe(
        'language_mismatch',
      );
      await write(writer.cookie, doc, version, { surprise: 1 }).expect(400);
      await write(writer.cookie, doc, version, {}).expect(400);
    });

    it('is refused on an out-of-date revision, and to anyone who does not manage it', async () => {
      const stale = await write(writer.cookie, doc, { ...version, revision: 1 }, {
        content: { en: { purpose: 'x' } },
      }).expect(409);
      expect(stale.body.code).toBe('stale_version');
      await write(reader.cookie, doc, version, { content: { en: { purpose: 'x' } } }).expect(403);
      expect(
        (
          await write(pharmacyWriter.cookie, doc, version, {
            content: { en: { purpose: 'x' } },
          }).expect(404)
        ).status,
      ).toBe(404);
    });
  });

  describe('sending for review', () => {
    it('needs every required section in the default language', async () => {
      const doc = (await newDocument(writer.cookie).expect(201)).body as Doc;
      let version = await versionOf(writer.cookie, doc.id, doc.inProgress!.id);
      version = (
        await write(writer.cookie, doc, version, {
          content: { en: { purpose: FULL.purpose }, ar: { scope: 'النطاق' } },
        }).expect(200)
      ).body;
      const res = await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/submit`, {
        revision: version.revision,
      }).expect(400);
      expect(res.body).toEqual({
        code: 'missing_sections',
        locale: 'en',
        sections: ['scope', 'responsibilities', 'steps'],
      });
    });

    it('needs someone other than its preparers to be able to decide each step', async () => {
      // A route naming a role nobody holds.
      const route = (await get(a.cookie, '/approval-routes').expect(200)).body.find(
        (r: { documentTypeId: string }) => r.documentTypeId === types.work_instruction,
      );
      const changed = await patch(a.cookie, `/approval-routes/${route.id}`, {
        steps: [{ kind: 'approve', roleId: roleOf(a, 'lonely'), dueInDays: 3 }],
        revision: route.revision,
      }).expect(200);
      const doc = (
        await newDocument(writer.cookie, {
          typeId: types.work_instruction,
          categoryId: categories.SAF,
        }).expect(201)
      ).body as Doc;
      let version = await versionOf(writer.cookie, doc.id, doc.inProgress!.id);
      version = (
        await write(writer.cookie, doc, version, {
          content: { en: { purpose: 'p', steps: 's' } },
        }).expect(200)
      ).body;
      const res = await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/submit`, {
        revision: version.revision,
      }).expect(409);
      expect(res.body).toEqual({ code: 'no_assignee', position: 1 });
      // A route naming only the person who prepared it.
      const named = await patch(a.cookie, `/approval-routes/${route.id}`, {
        steps: [{ kind: 'approve', userId: approver.id, dueInDays: 3 }],
        revision: changed.body.revision,
      }).expect(200);
      const own = (
        await newDocument(approver.cookie, {
          typeId: types.work_instruction,
          categoryId: categories.SAF,
          ownerId: approver.id,
        }).expect(201)
      ).body as Doc;
      let ownVersion = await versionOf(approver.cookie, own.id, own.inProgress!.id);
      ownVersion = (
        await write(approver.cookie, own, ownVersion, {
          content: { en: { purpose: 'p', steps: 's' } },
        }).expect(200)
      ).body;
      expect(
        (
          await post(approver.cookie, `/documents/${own.id}/versions/${ownVersion.id}/submit`, {
            revision: ownVersion.revision,
          }).expect(409)
        ).body,
      ).toEqual({ code: 'no_assignee', position: 1 });
      // Back to the starting route.
      await patch(a.cookie, `/approval-routes/${route.id}`, {
        steps: [
          { kind: 'review', roleId: roleOf(a, 'quality_officer'), dueInDays: 7 },
          { kind: 'approve', roleId: roleOf(a, 'administrator'), dueInDays: 7 },
        ],
        revision: named.body.revision,
      }).expect(200);
    });

    it('needs as many different people as the route has steps', async () => {
      const route = (await get(a.cookie, '/approval-routes').expect(200)).body.find(
        (r: { documentTypeId: string }) => r.documentTypeId === types.work_instruction,
      );
      let revision = route.revision as number;
      const setSteps = async (steps: unknown[]) => {
        revision = (
          await patch(a.cookie, `/approval-routes/${route.id}`, { steps, revision }).expect(200)
        ).body.revision;
      };
      const draft = async () => {
        const doc = (
          await newDocument(writer.cookie, {
            typeId: types.work_instruction,
            categoryId: categories.SAF,
          }).expect(201)
        ).body as Doc;
        const version = await versionOf(writer.cookie, doc.id, doc.inProgress!.id);
        const written = (
          await write(writer.cookie, doc, version, { content: { en: { purpose: 'p', steps: 's' } } }).expect(200)
        ).body as Version;
        return { doc, version: written };
      };
      const submit = (d: { doc: Doc; version: Version }) =>
        post(writer.cookie, `/documents/${d.doc.id}/versions/${d.version.id}/submit`, {
          revision: d.version.revision,
        });
      try {
        // One person named for both steps is refused when the route is
        // saved: the second step would have nobody left.
        const both = [
          { kind: 'review', userId: secondApprover.id, dueInDays: 3 },
          { kind: 'approve', userId: secondApprover.id, dueInDays: 3 },
        ];
        expect(
          (await patch(a.cookie, `/approval-routes/${route.id}`, { steps: both, revision }).expect(400)).body,
        ).toEqual({ code: 'same_person_in_two_steps', userId: secondApprover.id, positions: [1, 2] });
        expect(
          (await post(a.cookie, '/approval-routes', { name: { en: 'Twice' }, documentTypeId: null, steps: both }).expect(400)).body.code,
        ).toBe('same_person_in_two_steps');
        // A route saved so before that rule is still refused at sending.
        await setSteps([
          { kind: 'review', userId: approver.id, dueInDays: 3 },
          { kind: 'approve', userId: secondApprover.id, dueInDays: 3 },
        ]);
        await bench.owner.db
          .update(approvalRouteSteps)
          .set({ assigneeUserId: secondApprover.id })
          .where(eq(approvalRouteSteps.routeId, route.id));
        const twice = await draft();
        expect((await submit(twice).expect(409)).body).toEqual({ code: 'no_assignee', position: 2 });
        // A role for the first step and one of its holders named for the
        // second: covered, by giving the first step to another holder.
        await setSteps([
          { kind: 'review', roleId: roleOf(a, 'administrator'), dueInDays: 3 },
          { kind: 'approve', userId: secondApprover.id, dueInDays: 3 },
        ]);
        const covered = await draft();
        const sent = (await submit(covered).expect(200)).body as Version;
        // And the one named for the second step, deciding the first, may
        // not then decide the second: someone else decides the first.
        expect(sent.status).toBe('in_review');
        await post(writer.cookie, `/documents/${covered.doc.id}/versions/${sent.id}/withdraw`, {
          revision: sent.revision,
          reason: 'Only a test of the route.',
        }).expect(200);
      } finally {
        await setSteps([
          { kind: 'review', roleId: roleOf(a, 'quality_officer'), dueInDays: 7 },
          { kind: 'approve', roleId: roleOf(a, 'administrator'), dueInDays: 7 },
        ]);
      }
    });
  });

  describe('who sees drafts and versions in review', () => {
    let doc: Doc;
    let version: Version;
    let draft: Doc;
    beforeAll(async () => {
      ({ doc, version } = await guidelineInReview());
      draft = (
        await newDocument(writer.cookie, { title: { en: `Draft only ${run}` } }).expect(201)
      ).body;
      await write(
        writer.cookie,
        draft,
        await versionOf(writer.cookie, draft.id, draft.inProgress!.id),
        { content: { en: { purpose: `Secret wording ${run}` } } },
      ).expect(200);
    });

    it('hides them from readers everywhere: the document, its versions, the list, the search and the counts', async () => {
      for (const d of [doc, draft]) {
        await get(reader.cookie, `/documents/${d.id}`).expect(404);
        await get(reader.cookie, `/documents/${d.id}/versions`).expect(404);
        await get(reader.cookie, `/documents/${d.id}/versions/${d.inProgress!.id}`).expect(404);
      }
      const listed = await listOf(reader.cookie);
      expect(listed.items.map((i) => i.id)).not.toContain(doc.id);
      expect(listed.items.map((i) => i.id)).not.toContain(draft.id);
      for (const q of [draft.number, `Draft only ${run}`, `Secret wording ${run}`, `trolleys ${run}`]) {
        expect((await listOf(reader.cookie, `&q=${encodeURIComponent(q)}`)).total).toBe(0);
      }
      const summary = (await get(reader.cookie, '/summary').expect(200)).body;
      expect(summary.awaitingMyApproval).toBe(0);
      // The writer, who manages them, finds both by their text.
      expect(
        (await listOf(writer.cookie, `&q=${encodeURIComponent(`Secret wording ${run}`)}`)).items.map((i) => i.id),
      ).toEqual([draft.id]);
    });

    it('shows an assignee the version under their review and nothing else', async () => {
      const seen = (await get(signer.cookie, `/documents/${doc.id}`).expect(200)).body;
      expect(seen.access).toBe('assignee');
      expect(seen.inProgress).toMatchObject({ id: version.id, status: 'in_review' });
      expect(seen.moves).toEqual([]);
      const theirs = await versionOf(signer.cookie, doc.id, version.id);
      expect(theirs.moves).toEqual(['approve', 'return']);
      expect(theirs.run?.steps.map((s) => s.status)).toEqual(['pending', 'waiting']);
      // The draft nobody asked them to review stays hidden, in the search too.
      await get(signer.cookie, `/documents/${draft.id}`).expect(404);
      expect((await listOf(signer.cookie, `&q=${encodeURIComponent(`Secret wording ${run}`)}`)).total).toBe(0);
      expect((await listOf(signer.cookie, `&q=${encodeURIComponent(`trolleys ${run}`)}`)).items.map((i) => i.id)).toEqual([doc.id]);
      // "Awaiting me".
      const mine = (await get(signer.cookie, '/approvals').expect(200)).body;
      expect(mine.items.map((i: { document: { id: string } }) => i.document.id)).toContain(doc.id);
      expect((await get(signer.cookie, '/summary').expect(200)).body.awaitingMyApproval).toBeGreaterThanOrEqual(1);
      // Once the run has passed them and ended, they see it no more.
      const after = (await decide(signer, doc, theirs, 'approve').expect(200)).body as Version;
      await get(signer.cookie, `/documents/${doc.id}`).expect(200);
      await decide(approver, doc, after, 'approve').expect(200);
      await get(signer.cookie, `/documents/${doc.id}`).expect(404);
    });

    it('shows them to those who see every document, within their reach, who may change nothing', async () => {
      const seen = (await get(auditor.cookie, `/documents/${draft.id}`).expect(200)).body;
      expect(seen.access).toBe('full');
      expect(seen.moves).toEqual([]);
      await write(auditor.cookie, draft, { id: draft.inProgress!.id, revision: 2 }, {
        content: { en: { purpose: 'x' } },
      }).expect(403);
      // The nursing manager sees nursing's drafts, not the pharmacy's.
      await get(nurseManager.cookie, `/documents/${draft.id}`).expect(200);
      const theirs = (
        await newDocument(pharmacyWriter.cookie, {
          ownerUnitId: pharmacy,
          ownerId: pharmacyWriter.id,
        }).expect(201)
      ).body as Doc;
      await get(nurseManager.cookie, `/documents/${theirs.id}`).expect(404);
      await get(pharmacyWriter.cookie, `/documents/${draft.id}`).expect(404);
    });
  });

  describe('restricted documents', () => {
    let doc: Doc;
    let version: Version;
    beforeAll(async () => {
      ({ doc, version } = await published({
        title: { en: `Restricted ${run}` },
        confidentiality: 'restricted',
        audience: { orgUnitIds: [pharmacy], roleIds: [] },
        acknowledgementRequired: true,
      }));
    });

    it('are read only by their audience, the owner, and those who see them all', async () => {
      await get(pharmacist.cookie, `/documents/${doc.id}`).expect(200);
      await get(pharmacist.cookie, `/documents/${doc.id}/versions/${version.id}`).expect(200);
      await get(writer.cookie, `/documents/${doc.id}`).expect(200);
      await get(auditor.cookie, `/documents/${doc.id}`).expect(200);
      await get(reader.cookie, `/documents/${doc.id}`).expect(404);
      await get(reader.cookie, `/documents/${doc.id}/versions/${version.id}`).expect(404);
      expect((await listOf(reader.cookie)).items.map((i) => i.id)).not.toContain(doc.id);
      expect((await listOf(reader.cookie, `&q=${encodeURIComponent(`Restricted ${run}`)}`)).total).toBe(0);
      expect((await listOf(reader.cookie, `&q=${encodeURIComponent(doc.number)}`)).total).toBe(0);
      expect((await listOf(pharmacist.cookie, `&q=${encodeURIComponent(doc.number)}`)).total).toBe(1);
      expect((await listOf(pharmacist.cookie, '&appliesToMe=true')).items.map((i) => i.id)).toContain(doc.id);
    });

    it('are announced to their audience only, and a notification stops naming one its reader can no longer open', async () => {
      const toPharmacist = (await notificationsOf(pharmacist.cookie)).filter((n) => n.document?.id === doc.id);
      expect(toPharmacist).toEqual([
        expect.objectContaining({
          kind: 'document_published',
          document: { id: doc.id, number: doc.number, title: { en: `Restricted ${run}` }, canOpen: true },
        }),
      ]);
      expect((await notificationsOf(reader.cookie)).filter((n) => n.document?.id === doc.id)).toEqual([]);
      const current = (await get(writer.cookie, `/documents/${doc.id}`).expect(200)).body;
      await patch(writer.cookie, `/documents/${doc.id}`, {
        audience: { orgUnitIds: [ward], roleIds: [] },
        revision: current.revision,
      }).expect(200);
      const after = (await notificationsOf(pharmacist.cookie)).filter((n) => n.document?.id === doc.id);
      expect(after[0].document).toEqual({ id: doc.id, number: doc.number, title: null, canOpen: false });
      await get(pharmacist.cookie, `/documents/${doc.id}`).expect(404);
      await get(reader.cookie, `/documents/${doc.id}`).expect(200);
    });

    it('are counted in the summary only for those who may read them', async () => {
      const before = (await get(nobody.cookie, '/summary').expect(403)).body;
      expect(before.code).toBe('missing_permission');
      const forPharmacist = (await get(pharmacist.cookie, '/summary').expect(200)).body;
      const forAuditor = (await get(auditor.cookie, '/summary').expect(200)).body;
      expect(forAuditor.active).toBeGreaterThan(forPharmacist.active);
      expect(forPharmacist.acknowledgement).toBeNull();
      expect(forAuditor.acknowledgement).toMatchObject({ target: 90 });
    });
  });

  describe('the order of approval, and the same person', () => {
    it('is decided step by step, by an assignee of the current step only', async () => {
      const { doc, version } = await inReview();
      // The approver's step comes second.
      expect((await decide(approver, doc, version, 'approve').expect(409)).body.code).toBe('not_current_step');
      // Approving is a right of its own.
      expect((await decide(reader, doc, version, 'approve').expect(403)).body).toMatchObject({
        code: 'missing_permission',
        permission: 'policies.approve',
      });
      // Holding it is not being an assignee.
      expect((await decide(nurseManager, doc, version, 'approve').expect(403)).body.code).toBe('not_assignee');
      expect((await decide(nurseManager, doc, version, 'return').expect(403)).body.code).toBe('not_assignee');
      const reviewed = (await decide(quality, doc, version, 'approve').expect(200)).body as Version;
      expect(reviewed.status).toBe('in_review');
      // The first step is decided: its assignee cannot decide it again.
      expect((await decide(quality, doc, reviewed, 'approve').expect(403)).body.code).toBe('not_assignee');
      // A decision on an out-of-date screen.
      expect((await decide(approver, doc, version, 'approve').expect(409)).body.code).toBe('stale_version');
      const toApprover = (await notificationsOf(approver.cookie)).find(
        (n) => n.document?.id === doc.id && n.kind === 'document_step_assigned',
      );
      expect(toApprover?.data).toMatchObject({ position: 2, step: 'approve' });
    });

    it('never lets whoever prepared a version decide a step of it', async () => {
      const doc = (
        await newDocument(approver.cookie, { ownerId: approver.id }).expect(201)
      ).body as Doc;
      let version = await versionOf(approver.cookie, doc.id, doc.inProgress!.id);
      version = (await write(approver.cookie, doc, version, { content: { en: FULL } }).expect(200)).body;
      version = (
        await post(approver.cookie, `/documents/${doc.id}/versions/${version.id}/submit`, {
          revision: version.revision,
        }).expect(200)
      ).body;
      const reviewed = (await decide(quality, doc, version, 'approve').expect(200)).body as Version;
      const own = await versionOf(approver.cookie, doc.id, version.id);
      expect(own.moves).not.toContain('approve');
      expect((own as unknown as { myStep: { samePerson: boolean } }).myStep.samePerson).toBe(true);
      expect((await decide(approver, doc, reviewed, 'approve').expect(403)).body.code).toBe('same_person');
      expect((await decide(approver, doc, reviewed, 'return').expect(403)).body.code).toBe('same_person');
      // Not in their pending steps either.
      const mine = (await get(approver.cookie, '/approvals').expect(200)).body;
      expect(mine.items.map((i: { version: { id: string } }) => i.version.id)).not.toContain(version.id);
      await decide(secondApprover, doc, reviewed, 'approve').expect(200);
    });

    it('keeps whoever wrote a withdrawn version among the contributors of the one started from it', async () => {
      // The approver writes version 1 and withdraws it.
      const doc = (
        await newDocument(approver.cookie, { ownerId: approver.id }).expect(201)
      ).body as Doc;
      let v1 = await versionOf(approver.cookie, doc.id, doc.inProgress!.id);
      v1 = (await write(approver.cookie, doc, v1, { content: { en: FULL } }).expect(200)).body;
      await post(approver.cookie, `/documents/${doc.id}/versions/${v1.id}/withdraw`, {
        revision: v1.revision,
        reason: 'Started again.',
      }).expect(200);
      // Someone else starts version 2 from it, word for word, and sends it
      // with a change summary of their own.
      const started = (await post(writer.cookie, `/documents/${doc.id}/versions`, {}).expect(201))
        .body as Version;
      expect(started.content).toEqual(v1.content);
      const v2 = (
        await write(writer.cookie, doc, started, { changeSummary: { en: 'Started again.' } }).expect(200)
      ).body as Version;
      expect(v2.content).toEqual(v1.content);
      const sent = (
        await post(writer.cookie, `/documents/${doc.id}/versions/${v2.id}/submit`, {
          revision: v2.revision,
        }).expect(200)
      ).body as Version;
      const reviewed = (await decide(quality, doc, sent, 'approve').expect(200)).body as Version;
      // The approver wrote the text: they do not approve it.
      expect((await decide(approver, doc, reviewed, 'approve').expect(403)).body).toEqual({
        code: 'same_person',
        reason: 'prepared',
      });
      const created = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, doc.id), eq(auditLog.action, 'document_version_created')));
      expect(created.map((e) => e.changes)).toContainEqual(
        expect.objectContaining({
          versionId: v2.id,
          copiedFromVersionId: v1.id,
          contributors: [approver.id, writer.id],
        }),
      );
      const ok = (await decide(secondApprover, doc, reviewed, 'approve').expect(200)).body as Version;
      await post(writer.cookie, `/documents/${doc.id}/versions/${v2.id}/publish`, {
        revision: ok.revision,
      }).expect(200);
      // From the published version, which was approved by others, the new
      // version starts with whoever started it only.
      const v3 = (await post(writer.cookie, `/documents/${doc.id}/versions`, {}).expect(201))
        .body as Version;
      const [entry] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'document_version_created'),
            sql`${auditLog.changes} ->> 'versionId' = ${v3.id}`,
          ),
        );
      expect(entry.changes).toMatchObject({ copiedFromVersionId: v2.id, contributors: [writer.id] });
    }, 60_000);

    it('has each step of a run decided by a different person', async () => {
      // A quality officer who is the Approving authority too.
      const both = await staff(a, 'both', 'quality_officer', null, facility);
      const grant = (roles: string[]) =>
        http()
          .put(`/users/${both.id}/roles`)
          .set('Cookie', a.cookie)
          .send({ roles: roles.map((code) => ({ roleId: roleOf(a, code), orgUnitId: null })) })
          .expect(200);
      await grant(['quality_officer', 'approving_authority']);
      try {
        const { doc, version } = await inReview();
        const reviewed = (await decide(both, doc, version, 'approve').expect(200)).body as Version;
        const seen = await versionOf(both.cookie, doc.id, version.id);
        expect(seen.moves).not.toContain('approve');
        expect((seen as unknown as { myStep: { position: number; samePerson: boolean } }).myStep).toMatchObject({
          position: 2,
          samePerson: true,
        });
        for (const action of ['approve', 'return'] as const) {
          expect((await decide(both, doc, reviewed, action).expect(403)).body).toEqual({
            code: 'same_person',
            reason: 'decided_earlier_step',
          });
        }
        // Not among their pending steps, and not told of the second step.
        const mine = (await get(both.cookie, '/approvals').expect(200)).body;
        expect(mine.items.map((i: { version: { id: string } }) => i.version.id)).not.toContain(version.id);
        expect(
          (await notificationsOf(both.cookie)).filter(
            (n) => n.document?.id === doc.id && n.kind === 'document_step_assigned',
          ).map((n) => n.data.position),
        ).toEqual([1]);
        const done = (await decide(approver, doc, reviewed, 'approve').expect(200)).body as Version;
        expect(done.control.approvals.map((x) => x.signedBy.id)).toEqual([both.id, approver.id]);
      } finally {
        await grant([]);
      }
    }, 60_000);

    it('returns to draft with a required comment, which the preparer is told of and shown', async () => {
      const { doc, version } = await inReview();
      await post(quality.cookie, `/documents/${doc.id}/versions/${version.id}/return`, {
        revision: version.revision,
      }).expect(400);
      const back = (await decide(quality, doc, version, 'return', { comment: 'Say who records it.' }).expect(200)).body as Version;
      expect(back.status).toBe('draft');
      const seen = await versionOf(writer.cookie, doc.id, version.id);
      expect(seen.returned).toEqual([
        expect.objectContaining({ comment: 'Say who records it.', position: 1 }),
      ]);
      expect(seen.run?.status).toBe('returned');
      const told = (await notificationsOf(writer.cookie)).find((n) => n.document?.id === doc.id);
      expect(told).toMatchObject({ kind: 'document_returned', data: { version: 1, position: 1 } });
      // Sent again, it starts a new run from the first step.
      const again = (
        await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/submit`, {
          revision: seen.revision,
        }).expect(200)
      ).body as Version;
      expect(again.run?.steps.map((s) => s.status)).toEqual(['pending', 'waiting']);
    });

    it('lets one of two people deciding the same step at once decide it', async () => {
      const { doc, version } = await inReview();
      const results = await Promise.all([
        decide(quality, doc, version, 'approve'),
        decide(quality2, doc, version, 'approve'),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 409]);
      const stored = await bench.owner.db
        .select()
        .from(signatures)
        .where(eq(signatures.subjectId, version.id));
      expect(stored).toHaveLength(1);
      const seen = await versionOf(writer.cookie, doc.id, version.id);
      expect(seen.run?.steps.map((s) => s.status)).toEqual(['approved', 'pending']);
    }, 30_000);
  });

  describe('signatures', () => {
    it('take the password again: a wrong one is 401 wrong_password, writes nothing and keeps the session', async () => {
      const { doc, version } = await inReview();
      const wrong = await decide(quality, doc, version, 'approve', { password: 'not it' }).expect(401);
      expect(wrong.body).toEqual({ code: 'wrong_password' });
      await http().get('/auth/me').set('Cookie', quality.cookie).expect(200);
      const seen = await versionOf(quality.cookie, doc.id, version.id);
      expect(seen.run?.steps[0].status).toBe('pending');
      expect(
        await bench.owner.db.select().from(signatures).where(eq(signatures.subjectId, version.id)),
      ).toEqual([]);
      const failures = await bench.owner.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.actorId, quality.id), eq(auditLog.action, 'password_confirmation_failed')));
      expect(failures[0].changes).toEqual({ locked: false, purpose: 'approval' });
      // The password is nowhere in the audit log.
      const { rows } = await bench.owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from audit_log where tenant_id = ${a.id} and (changes::text like ${`%${password}%`} or changes::text like '%not it%')`,
      );
      expect(rows[0].n).toBe(0);
    });

    it('count against the same lock as signing in', async () => {
      const { doc, version } = await approved();
      // The lock: five wrong passwords, then even the right one is refused.
      const doc2 = await inReview();
      await decide(quality, doc2.doc, doc2.version, 'approve').expect(200);
      const atStep2 = await versionOf(writer.cookie, doc2.doc.id, doc2.version.id);
      for (let i = 0; i < 5; i++) {
        await decide(lockme, doc2.doc, atStep2, 'approve', { password: `wrong ${i}` }).expect(401);
      }
      expect((await decide(lockme, doc2.doc, atStep2, 'approve').expect(401)).body).toEqual({
        code: 'password_locked',
      });
      // Signing in is locked too; the session goes on.
      await bench.login(a.slug, lockme.email).expect(401);
      await http().get('/auth/me').set('Cookie', lockme.cookie).expect(200);
      await bench.owner.db
        .update(users)
        .set({ lockedUntil: null, failedAttempts: 0 })
        .where(eq(users.id, lockme.id));
      await decide(lockme, doc2.doc, atStep2, 'approve').expect(200);
      expect(doc.id).toBeTruthy();
      expect(version.status).toBe('approved');
    }, 60_000);

    it('cannot be changed or removed by the application', async () => {
      const { version } = await approved();
      const { createDatabase } = await import('../src/database/client.js');
      const { requireEnv } = await import('../src/env.js');
      const { TenantDb } = await import('../src/database/tenant-db.service.js');
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      try {
        const tenantDb = new TenantDb(app.db);
        await expect(
          tenantDb.withTenant(a.id, (tx) =>
            tx.update(signatures).set({ contentHash: '0'.repeat(64) }).where(eq(signatures.subjectId, version.id)),
          ),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(
          tenantDb.withTenant(a.id, (tx) => tx.delete(signatures).where(eq(signatures.subjectId, version.id))),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
        const kept = await tenantDb.withTenant(a.id, (tx) =>
          tx.select().from(signatures).where(eq(signatures.subjectId, version.id)),
        );
        expect(kept).toHaveLength(2);
      } finally {
        await app.pool.end();
      }
    });

    it('stand behind text the database keeps, whoever writes to it', async () => {
      const { doc: pubDoc, version: pub } = await published();
      const { doc: other } = await published();
      const { version: inRun } = await approved();
      const { createDatabase } = await import('../src/database/client.js');
      const { requireEnv } = await import('../src/env.js');
      const { TenantDb } = await import('../src/database/tenant-db.service.js');
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      const refusedBy = (constraint: string) => ({ cause: { code: '23514', constraint } });
      try {
        const tenantDb = new TenantDb(app.db);
        const asApp = (fn: Parameters<typeof tenantDb.withTenant>[1]) => tenantDb.withTenant(a.id, fn);
        // The text of a version outside draft, as the application...
        for (const set of [
          { content: {} },
          { sections: [] },
          { changeSummary: { en: 'Changed.' } },
          { acknowledgementRequired: true },
          { acknowledgeWithinDays: 1 },
        ]) {
          for (const id of [pub.id, inRun.id]) {
            await expect(
              asApp((tx) => tx.update(documentVersions).set(set).where(eq(documentVersions.id, id))),
            ).rejects.toMatchObject(refusedBy('document_versions_signed_text_fixed'));
          }
        }
        // ...and as the owner of the tables.
        await expect(
          bench.owner.db.update(documentVersions).set({ content: {} }).where(eq(documentVersions.id, pub.id)),
        ).rejects.toMatchObject(refusedBy('document_versions_signed_text_fixed'));
        // Nor put back to draft to be edited there.
        await expect(
          asApp((tx) => tx.update(documentVersions).set({ status: 'draft' }).where(eq(documentVersions.id, pub.id))),
        ).rejects.toMatchObject(refusedBy('document_versions_status_order'));
        // What is not signed still changes.
        await asApp((tx) =>
          tx.update(documentVersions).set({ updatedAt: new Date() }).where(eq(documentVersions.id, pub.id)),
        );
        // A run's step: what it is never changes, and once decided nothing.
        const [step] = await bench.owner.db
          .select({ id: approvalRunSteps.id, decidedBy: approvalRunSteps.decidedBy })
          .from(approvalRunSteps)
          .innerJoin(signatures, eq(signatures.id, approvalRunSteps.signatureId))
          .where(eq(signatures.subjectId, pub.id))
          .limit(1);
        await expect(
          asApp((tx) => tx.update(approvalRunSteps).set({ assigneeUserId: writer.id }).where(eq(approvalRunSteps.id, step.id))),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
        for (const set of [{ decidedBy: writer.id }, { comment: 'After the fact.' }, { status: 'pending' as const }]) {
          await expect(
            asApp((tx) => tx.update(approvalRunSteps).set(set).where(eq(approvalRunSteps.id, step.id))),
          ).rejects.toMatchObject(refusedBy('approval_run_steps_decided_fixed'));
        }
        await expect(
          bench.owner.db.update(approvalRunSteps).set({ decidedBy: writer.id }).where(eq(approvalRunSteps.id, step.id)),
        ).rejects.toMatchObject(refusedBy('approval_run_steps_decided_fixed'));
        // A document's published version is one of its own.
        await expect(
          asApp((tx) =>
            tx.update(documents).set({ publishedVersionId: pub.id }).where(eq(documents.id, other.id)),
          ),
        ).rejects.toMatchObject({ cause: { code: '23503', constraint: 'documents_published_version_own_fk' } });
        // All of it as it was.
        const seen = await versionOf(writer.cookie, pubDoc.id, pub.id);
        expect(seen.contentHash).toBe(pub.contentHash);
        expect(seen.control.approvals.map((x) => x.signedBy.id)).toEqual([quality.id, approver.id]);
        expect(step.decidedBy).toBe(quality.id);
      } finally {
        await app.pool.end();
      }
    }, 60_000);

    it('hash exactly what was signed', async () => {
      const { doc, version } = await approved();
      const full = await versionOf(writer.cookie, doc.id, version.id);
      expect(full.contentHash).toBe(
        contentHash({
          documentId: doc.id,
          number: doc.number,
          versionId: version.id,
          version: 1,
          sections: (full as unknown as { sections: unknown }).sections,
          content: full.content,
          changeSummary: null,
          acknowledgementRequired: false,
          acknowledgeWithinDays: 14,
        }),
      );
    });
  });

  describe('publishing and new versions', () => {
    it('publishes only what is approved, now or on a later day', async () => {
      const { doc, version } = await inReview();
      expect(
        (await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, { revision: version.revision }).expect(409)).body.code,
      ).toBe('not_approved');
      await post(reader.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, { revision: version.revision }).expect(403);
      const ready = await approved();
      const path = `/documents/${ready.doc.id}/versions/${ready.version.id}/publish`;
      expect(
        (await post(writer.cookie, path, { revision: ready.version.revision, effectiveOn: '2020-01-01' }).expect(400)).body.code,
      ).toBe('effective_in_past');
      await post(writer.cookie, path, { revision: ready.version.revision, effectiveOn: 'soon' }).expect(400);
      const later = (
        await post(writer.cookie, path, { revision: ready.version.revision, effectiveOn: '2099-03-01' }).expect(200)
      ).body;
      expect(later).toMatchObject({ status: 'approved', scheduledFor: '2099-03-01' });
      await get(reader.cookie, `/documents/${ready.doc.id}`).expect(404);
    });

    it('makes a new version from the published one, compared section by section, and supersedes it when published', async () => {
      const { doc, version } = await published();
      expect((await get(writer.cookie, `/documents/${doc.id}`).expect(200)).body.moves).toEqual([
        'edit',
        'new_version',
        'retire',
        'confirm_review',
      ]);
      const v2 = (await post(writer.cookie, `/documents/${doc.id}/versions`).expect(201)).body as Version;
      expect(v2).toMatchObject({ version: 2, status: 'draft' });
      expect(v2.content).toEqual(version.content);
      expect(v2.comparison?.every((s) => !s.changed)).toBe(true);
      expect(
        (await post(writer.cookie, `/documents/${doc.id}/versions`).expect(409)).body.code,
      ).toBe('version_in_progress');
      let edited = (
        await write(writer.cookie, doc, v2, { content: { en: { steps: '1. Mark the area.\n2. Call the cleaners.\n3. Record it.' } } }).expect(200)
      ).body as Version;
      const steps = (edited as unknown as {
        comparison: { key: string; changed: boolean; locales: { en: { lines: { op: string; text: string }[] } } }[];
      }).comparison.find((s) => s.key === 'steps')!;
      expect(steps.changed).toBe(true);
      expect(steps.locales.en.lines).toEqual([
        { op: 'same', text: '1. Mark the area.' },
        { op: 'removed', text: '2. Clean it.' },
        { op: 'added', text: '2. Call the cleaners.' },
        { op: 'same', text: '3. Record it.' },
      ]);
      expect(
        (await post(writer.cookie, `/documents/${doc.id}/versions/${v2.id}/submit`, { revision: edited.revision }).expect(400)).body.code,
      ).toBe('change_summary_required');
      edited = (await write(writer.cookie, doc, edited, { changeSummary: { en: 'The cleaners are called.' } }).expect(200)).body;
      const sent = (await post(writer.cookie, `/documents/${doc.id}/versions/${v2.id}/submit`, { revision: edited.revision }).expect(200)).body as Version;
      // Readers go on reading version 1 meanwhile, and never see version 2.
      expect((await get(reader.cookie, `/documents/${doc.id}`).expect(200)).body).toMatchObject({
        published: { id: version.id, version: 1 },
        inProgress: null,
      });
      await get(reader.cookie, `/documents/${doc.id}/versions/${v2.id}`).expect(404);
      const reviewed = (await decide(quality, doc, sent, 'approve').expect(200)).body as Version;
      const ok = (await decide(approver, doc, reviewed, 'approve').expect(200)).body as Version;
      await post(writer.cookie, `/documents/${doc.id}/versions/${v2.id}/publish`, { revision: ok.revision }).expect(200);
      const history = (await get(writer.cookie, `/documents/${doc.id}/versions`).expect(200)).body;
      expect(history.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([
        [2, 'published'],
        [1, 'superseded'],
      ]);
      expect(history.reviews.map((r: { outcome: string }) => r.outcome)).toEqual(['revised']);
      // A reader sees the published version only.
      const theirs = (await get(reader.cookie, `/documents/${doc.id}/versions`).expect(200)).body;
      expect(theirs.versions.map((v: { version: number }) => v.version)).toEqual([2]);
      expect(theirs.reviews).toEqual([]);
      await get(reader.cookie, `/documents/${doc.id}/versions/${version.id}`).expect(404);
    }, 60_000);

    it('withdraws and recalls versions in progress, and refuses what is out of date', async () => {
      const { doc, version } = await inReview();
      const recalled = (await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/recall`, { revision: version.revision }).expect(200)).body as Version;
      expect(recalled.status).toBe('draft');
      expect(recalled.run?.status).toBe('cancelled');
      // Withdrawing needs a reason.
      await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/withdraw`, { revision: recalled.revision }).expect(400);
      expect(
        (await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/withdraw`, { revision: version.revision, reason: 'Not needed.' }).expect(409)).body.code,
      ).toBe('stale_version');
      const gone = (await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/withdraw`, { revision: recalled.revision, reason: 'Not needed.' }).expect(200)).body as Version;
      expect(gone.status).toBe('withdrawn');
      expect(
        (await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/withdraw`, { revision: gone.revision, reason: 'Again.' }).expect(409)).body.code,
      ).toBe('not_in_progress');
      // A document never published can be started again.
      const next = (await post(writer.cookie, `/documents/${doc.id}/versions`).expect(201)).body;
      expect(next.version).toBe(2);
    });
  });

  describe('acknowledgement', () => {
    let doc: Doc;
    let version: Version;
    beforeAll(async () => {
      ({ doc, version } = await published({
        acknowledgementRequired: true,
        audience: { orgUnitIds: [nursing], roleIds: [roleOf(a, 'reporter')] },
      }));
    });
    const path = () => `/documents/${doc.id}/versions/${version.id}/acknowledge`;

    it('is asked of the audience, and given once, with the password', async () => {
      expect((await listOf(reader.cookie, '&awaitingMyAcknowledgement=true')).items.map((i) => i.id)).toContain(doc.id);
      const before = (await get(reader.cookie, '/summary').expect(200)).body.awaitingMyAcknowledgement;
      expect((await post(reader.cookie, path(), { password: 'nope' }).expect(401)).body.code).toBe('wrong_password');
      await post(reader.cookie, path(), {}).expect(400);
      await post(reader.cookie, path(), { password }).expect(200);
      expect((await post(reader.cookie, path(), { password }).expect(409)).body.code).toBe('already_acknowledged');
      expect((await get(reader.cookie, '/summary').expect(200)).body.awaitingMyAcknowledgement).toBe(before - 1);
      const [row] = await bench.owner.db
        .select()
        .from(documentAcknowledgements)
        .where(and(eq(documentAcknowledgements.versionId, version.id), eq(documentAcknowledgements.userId, reader.id)));
      expect(row.acknowledgedAt).not.toBeNull();
      const [signature] = await bench.owner.db.select().from(signatures).where(eq(signatures.id, row.signatureId!));
      expect(signature).toMatchObject({ meaning: 'acknowledged', userId: reader.id, method: 'password' });
    });

    it('is not asked of anyone outside the audience', async () => {
      // The nursing manager reads it (open to all staff) but holds no reporter role.
      await get(nurseManager.cookie, `/documents/${doc.id}`).expect(200);
      expect((await post(nurseManager.cookie, path(), { password }).expect(403)).body.code).toBe('not_in_audience');
      await post(nobody.cookie, path(), { password }).expect(403);
      await post(bWriter.cookie, path(), { password }).expect(404);
    });

    it('shows who has and has not acknowledged, by unit, to those allowed', async () => {
      const figures = (await get(auditor.cookie, `/documents/${doc.id}/versions/${version.id}/acknowledgements`).expect(200)).body;
      expect(figures).toMatchObject({ targeted: 1, acknowledged: 1, pending: 0, percent: 100 });
      expect(figures.byUnit).toEqual([
        expect.objectContaining({ orgUnit: { id: ward, name: expect.any(Object) }, targeted: 1, acknowledged: 1 }),
      ]);
      expect(figures.people.items[0].user.id).toBe(reader.id);
      const refused = await get(reader.cookie, `/documents/${doc.id}/versions/${version.id}/acknowledgements`).expect(403);
      expect(refused.body.code).toBe('missing_permission');
      await get(a.cookie, `/documents/${doc.id}/versions/${version.id}/acknowledgements?state=late`).expect(400);
    });

    it('is of the published version only', async () => {
      const v2 = (await post(writer.cookie, `/documents/${doc.id}/versions`).expect(201)).body as Version;
      expect(
        (await post(reader.cookie, `/documents/${doc.id}/versions/${v2.id}/acknowledge`, { password }).expect(404)).status,
      ).toBe(404);
      await post(writer.cookie, `/documents/${doc.id}/versions/${v2.id}/withdraw`, { revision: v2.revision, reason: 'Not needed.' }).expect(200);
    });
  });

  describe('periodic review', () => {
    it('is confirmed with no change by the owner, with a signature, and moves the next review on', async () => {
      const { doc } = await published();
      const current = (await get(writer.cookie, `/documents/${doc.id}`).expect(200)).body;
      const comment = 'Checked against current practice.';
      await post(reader.cookie, `/documents/${doc.id}/review`, { password, comment, revision: current.revision }).expect(403);
      // A comment is required.
      await post(writer.cookie, `/documents/${doc.id}/review`, { password, revision: current.revision }).expect(400);
      expect(
        (await post(writer.cookie, `/documents/${doc.id}/review`, { password, comment, revision: 1 }).expect(409)).body.code,
      ).toBe('stale_document');
      expect(
        (await post(writer.cookie, `/documents/${doc.id}/review`, { password: 'nope', comment, revision: current.revision }).expect(401)).body.code,
      ).toBe('wrong_password');
      await bench.owner.db.execute(sql`update documents set next_review_on = current_date - 3 where id = ${doc.id}`);
      const due = (await get(writer.cookie, '/reviews').expect(200)).body;
      expect(due.items.find((i: { id: string }) => i.id === doc.id)).toMatchObject({ state: 'overdue', mine: true });
      const reviewed = (
        await post(writer.cookie, `/documents/${doc.id}/review`, { password, revision: current.revision, comment: 'Still right.' }).expect(200)
      ).body;
      expect(reviewed.review).toBeNull();
      // A review period from today, the day it was also published.
      expect(reviewed.nextReviewOn).toBe(current.nextReviewOn);
      expect(reviewed.lastReviewedOn).toBe(current.lastReviewedOn);
      const history = (await get(writer.cookie, `/documents/${doc.id}/versions`).expect(200)).body;
      expect(history.reviews[0]).toMatchObject({ outcome: 'no_change', comment: 'Still right.', reviewedBy: { id: writer.id } });
      const [signature] = await bench.owner.db.select().from(signatures).where(eq(signatures.id, history.reviews[0].signatureId));
      expect(signature).toMatchObject({ meaning: 'reviewed_no_change', subjectType: 'document', subjectId: doc.id });
      const draft = (await newDocument(writer.cookie).expect(201)).body;
      expect(
        (await post(writer.cookie, `/documents/${draft.id}/review`, { password, comment, revision: draft.revision }).expect(409)).body.code,
      ).toBe('not_active');
    });
  });

  describe('retiring', () => {
    it('takes a document out of the library for readers, keeps it in the history, and withdraws what was in progress', async () => {
      const { doc } = await published();
      const v2 = (await post(writer.cookie, `/documents/${doc.id}/versions`).expect(201)).body;
      const current = (await get(writer.cookie, `/documents/${doc.id}`).expect(200)).body;
      await post(writer.cookie, `/documents/${doc.id}/retire`, { revision: current.revision }).expect(400);
      await post(reader.cookie, `/documents/${doc.id}/retire`, { reason: 'Old.', revision: current.revision }).expect(403);
      const retired = (await post(writer.cookie, `/documents/${doc.id}/retire`, { reason: 'Replaced by another.', revision: current.revision }).expect(200)).body;
      expect(retired).toMatchObject({ status: 'retired', retireReason: 'Replaced by another.', moves: [] });
      await get(reader.cookie, `/documents/${doc.id}`).expect(404);
      expect((await listOf(reader.cookie)).items.map((i) => i.id)).not.toContain(doc.id);
      const history = (await get(writer.cookie, `/documents/${doc.id}/versions`).expect(200)).body;
      expect(history.versions.map((v: { status: string }) => v.status)).toEqual(['withdrawn', 'published']);
      expect(v2.status).toBe('draft');
      expect(
        (await post(writer.cookie, `/documents/${doc.id}/retire`, { reason: 'Again.', revision: retired.revision }).expect(409)).body.code,
      ).toBe('document_retired');
      expect(
        (await patch(writer.cookie, `/documents/${doc.id}`, { title: { en: 'New' }, revision: retired.revision }).expect(409)).body.code,
      ).toBe('document_retired');
    });
  });

  describe('editing a document', () => {
    it('changes what it says of itself, audited, on a fresh revision, within the manager\'s reach', async () => {
      const doc = (await newDocument(writer.cookie).expect(201)).body as Doc;
      const res = await patch(writer.cookie, `/documents/${doc.id}`, {
        title: { en: 'Handling any spill' },
        keywords: ['spill', 'floor'],
        references: ['ISO 45001 7.2'],
        revision: doc.revision,
      }).expect(200);
      expect(res.body).toMatchObject({ title: { en: 'Handling any spill' }, keywords: ['spill', 'floor'], revision: 2 });
      expect((await patch(writer.cookie, `/documents/${doc.id}`, { title: { en: 'x' }, revision: 1 }).expect(409)).body.code).toBe('stale_document');
      expect(
        (await patch(writer.cookie, `/documents/${doc.id}`, { ownerUnitId: pharmacy, revision: 2 }).expect(200)).body.ownerUnit.id,
      ).toBe(pharmacy);
      // A manager of the pharmacy only cannot take it to nursing.
      const theirs = (await get(pharmacyWriter.cookie, `/documents/${doc.id}`).expect(200)).body;
      expect((await patch(pharmacyWriter.cookie, `/documents/${doc.id}`, { ownerUnitId: nursing, revision: theirs.revision }).expect(403)).body.code).toBe('outside_scope');
      await patch(writer.cookie, `/documents/${doc.id}`, { revision: theirs.revision }).expect(400);
      const [entry] = await bench.owner.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, doc.id), eq(auditLog.action, 'document_updated')));
      expect(entry.changes).toMatchObject({ title: { from: { en: 'Handling a spill', ar: 'التعامل مع الانسكاب' }, to: { en: 'Handling any spill' } } });
      // The keyword is searched.
      expect((await listOf(writer.cookie, '&q=floor')).items.map((i) => i.id)).toContain(doc.id);
    });

    it('keeps its owning unit while a version is in review, and its title until it is published', async () => {
      const edit = async (id: string, body: Record<string, unknown>, status: number) => {
        const { revision } = (await get(writer.cookie, `/documents/${id}`).expect(200)).body;
        return (await patch(writer.cookie, `/documents/${id}`, { revision, ...body }).expect(status)).body;
      };
      const { doc, version } = await inReview();
      expect(await edit(doc.id, { ownerUnitId: pharmacy }, 409)).toEqual({
        code: 'in_review',
        field: 'ownerUnitId',
        version: 1,
      });
      expect(await edit(doc.id, { title: { en: 'Another title' } }, 409)).toEqual({
        code: 'in_review',
        field: 'title',
        version: 1,
      });
      // The same title and unit again are no change, and the rest changes.
      await edit(doc.id, {
        title: { en: 'Handling a spill', ar: 'التعامل مع الانسكاب' },
        ownerUnitId: nursing,
        keywords: ['wet floor'],
      }, 200);
      const reviewed = (await decide(quality, doc, await versionOf(writer.cookie, doc.id, version.id), 'approve').expect(200)).body as Version;
      const ok = (await decide(approver, doc, reviewed, 'approve').expect(200)).body as Version;
      // Approved: the unit may move, the title waits for publication.
      expect(await edit(doc.id, { title: { en: 'Another title' } }, 409)).toEqual({
        code: 'awaiting_publication',
        field: 'title',
        version: 1,
      });
      await edit(doc.id, { ownerUnitId: ward }, 200);
      await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, {
        revision: (await versionOf(writer.cookie, doc.id, version.id)).revision,
      }).expect(200);
      expect(ok.status).toBe('approved');
      // Published: it may be renamed, and that is audited.
      const renamed = await edit(doc.id, { title: { en: 'Another title' } }, 200);
      expect(renamed.title).toEqual({ en: 'Another title' });
      const entries = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, doc.id), eq(auditLog.action, 'document_updated')));
      expect(entries.map((e) => e.changes)).toContainEqual(
        expect.objectContaining({ title: { from: { en: 'Handling a spill', ar: 'التعامل مع الانسكاب' }, to: { en: 'Another title' } } }),
      );
      // Nothing of a refused change was written.
      expect(entries.filter((e) => 'ownerUnitId' in (e.changes as object))).toHaveLength(1);
    }, 60_000);
  });

  describe('settings', () => {
    it('are for those who manage documents for the whole organization', async () => {
      await get(reader.cookie, '/types').expect(200);
      await get(nobody.cookie, '/types').expect(403);
      await get(reader.cookie, '/types?includeInactive=true').expect(403);
      await get(reader.cookie, '/approval-routes').expect(403);
      const body = {
        code: 'checklist',
        name: { en: 'Checklist' },
        numberPrefix: 'CHK',
        sections: [{ key: 'items', name: { en: 'Items' }, required: true }],
        defaultReviewMonths: 6,
      };
      expect((await post(pharmacyWriter.cookie, '/types', body).expect(403)).body.code).toBe('missing_permission');
      await http().post('/policies/types').send(body).expect(401);
      await post(writer.cookie, '/types', { ...body, sections: [] }).expect(400);
      await post(writer.cookie, '/types', { ...body, sections: [body.sections[0], body.sections[0]] }).expect(400);
      await post(writer.cookie, '/types', { ...body, numberPrefix: 'TOO-LONG' }).expect(400);
      await post(writer.cookie, '/types', { ...body, name: { fr: 'Liste' } }).expect(400);
      const created = (await post(writer.cookie, '/types', body).expect(201)).body;
      expect((await post(writer.cookie, '/types', body).expect(409)).body.code).toBe('code_taken');
      expect(created.revision).toBe(1);
      // The revision read is required, and refused when out of date.
      await patch(writer.cookie, `/types/${created.id}`, { active: false }).expect(400);
      expect(
        (await patch(writer.cookie, `/types/${created.id}`, { active: false, revision: 2 }).expect(409)).body.code,
      ).toBe('stale_type');
      const off = (await patch(writer.cookie, `/types/${created.id}`, { active: false, revision: 1 }).expect(200)).body;
      expect(off).toMatchObject({ active: false, revision: 2 });
      expect((await get(writer.cookie, '/types').expect(200)).body.map((t: { id: string }) => t.id)).not.toContain(created.id);
      expect(
        (await newDocument(writer.cookie, { typeId: created.id }).expect(400)).body.code,
      ).toBe('unknown_type');
      await patch(writer.cookie, `/types/${randomUUIDLike()}`, { active: true, revision: 1 }).expect(404);
      const bTypes = (await get(b.cookie, '/types').expect(200)).body;
      await patch(writer.cookie, `/types/${bTypes[0].id}`, { active: false, revision: bTypes[0].revision }).expect(404);
    });

    it('keep the tree of categories free of loops', async () => {
      const parent = (await post(writer.cookie, '/categories', { code: 'cln', name: { en: 'Cleaning' } }).expect(201)).body;
      expect(parent.code).toBe('CLN');
      const child = (await post(writer.cookie, '/categories', { code: 'CLF', name: { en: 'Floors' }, parentId: parent.id }).expect(201)).body;
      expect((await patch(writer.cookie, `/categories/${parent.id}`, { parentId: child.id, revision: 1 }).expect(400)).body.code).toBe('invalid_parent');
      expect((await patch(writer.cookie, `/categories/${parent.id}`, { parentId: parent.id, revision: 1 }).expect(400)).body.code).toBe('invalid_parent');
      expect((await patch(writer.cookie, `/categories/${parent.id}`, { position: 4, revision: 3 }).expect(409)).body.code).toBe('stale_category');
      expect((await patch(writer.cookie, `/categories/${parent.id}`, { position: 4, revision: 1 }).expect(200)).body).toMatchObject({ position: 4, revision: 2 });
      expect((await post(writer.cookie, '/categories', { code: 'CLN', name: { en: 'Again' } }).expect(409)).body.code).toBe('code_taken');
      await post(writer.cookie, '/categories', { code: 'C', name: { en: 'Short' } }).expect(400);
      // Filtering by a category takes those beneath it.
      const doc = (await newDocument(writer.cookie, { categoryId: child.id }).expect(201)).body;
      expect(doc.number).toMatch(/^PRC-CLF-001$/);
      expect((await listOf(writer.cookie, `&categoryId=${parent.id}`)).items.map((i) => i.id)).toEqual([doc.id]);
    });

    it('name in a route only roles and people who may approve, and end with an approval', async () => {
      const step = (extra: Record<string, unknown>) => ({ kind: 'approve', dueInDays: 3, ...extra });
      const body = (steps: unknown[]) => ({ name: { en: 'Any type' }, documentTypeId: null, steps });
      expect((await post(writer.cookie, '/approval-routes', body([step({ roleId: roleOf(a, 'writer') })])).expect(400)).body.code).toBe('role_cannot_approve');
      expect((await post(writer.cookie, '/approval-routes', body([step({ userId: writer.id })])).expect(400)).body.code).toBe('user_cannot_approve');
      expect((await post(writer.cookie, '/approval-routes', body([step({ roleId: roleOf(a, 'signer'), kind: 'review' })])).expect(400)).body.code).toBe('last_step_must_approve');
      await post(writer.cookie, '/approval-routes', body([step({ roleId: roleOf(a, 'signer'), userId: signer.id })])).expect(400);
      await post(writer.cookie, '/approval-routes', body([step({ roleId: b.roles.administrator })])).expect(400);
      const made = (await post(writer.cookie, '/approval-routes', body([step({ userId: signer.id })])).expect(201)).body;
      expect(made.steps[0].assignee).toMatchObject({ type: 'user', user: { id: signer.id } });
      expect((await post(writer.cookie, '/approval-routes', body([step({ userId: signer.id })])).expect(409)).body.code).toBe('route_exists');
      expect((await patch(writer.cookie, `/approval-routes/${made.id}`, { active: false, revision: 9 }).expect(409)).body.code).toBe('stale_route');
      await patch(writer.cookie, `/approval-routes/${made.id}`, { active: false, revision: made.revision }).expect(200);
    });

    it('change a route for what is sent from then on, never for a run in progress', async () => {
      const { doc, version } = await inReview();
      const route = (await get(a.cookie, '/approval-routes').expect(200)).body.find(
        (r: { documentTypeId: string }) => r.documentTypeId === types.procedure,
      );
      const changed = await patch(a.cookie, `/approval-routes/${route.id}`, {
        steps: [{ kind: 'approve', userId: signer.id, dueInDays: 2 }],
        revision: route.revision,
      }).expect(200);
      const reviewed = (await decide(quality, doc, version, 'approve').expect(200)).body as Version;
      expect(reviewed.run?.steps).toHaveLength(2);
      await decide(approver, doc, reviewed, 'approve').expect(200);
      await patch(a.cookie, `/approval-routes/${route.id}`, {
        steps: route.steps.map((s: { kind: string; assignee: { role: { id: string } } }) => ({
          kind: s.kind,
          roleId: s.assignee.role.id,
          dueInDays: 7,
        })),
        revision: changed.body.revision,
      }).expect(200);
      const entries = await bench.owner.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, route.id), eq(auditLog.action, 'approval_route_updated')));
      expect(entries.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('the session', () => {
    it("lists the module's permissions", async () => {
      const me = (await http().get('/auth/me').set('Cookie', nurseManager.cookie).expect(200)).body;
      expect(me.permissions).toEqual(expect.arrayContaining(['policies.view', 'policies.approve', 'policies.view_all']));
      expect(me.permissions).not.toContain('policies.manage');
      expect(me.scope['policies.view_all']).toContain(nursing);
      expect(me.scope['policies.view_all']).toContain(ward);
    });
  });
});
