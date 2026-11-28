import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createDatabase } from '../src/database/client.js';
import type { MailConfig } from '../src/email/config.js';
import { EmailWorker } from '../src/email/email-worker.service.js';
import { MAIL_CONFIG } from '../src/email/sender.js';
import { signUnsubscribe } from '../src/email/unsubscribe-token.js';
import {
  auditLog,
  documentAcknowledgements,
  documentReviews,
  documents,
  notifications,
  roles,
  signatures,
  users,
} from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { requireEnv } from '../src/env.js';
import { pinSecret, pinTooSimple } from '../src/identity/auth.service.js';
import { verifyPassword } from '../src/security/passwords.js';
import { shiftDay } from '../src/i18n/time-zones.js';
import { PolicyCheck } from '../src/policies/policy-check.service.js';
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
  [key: string]: unknown;
};

/**
 * The business decisions after quality review 3 (policies-and-procedures.md,
 * "Decided by the business after quality review 3"): who imports, and the
 * owner's confirmation of an import (1); the emails some people may not
 * switch off (4); the language that applies per document (5); the "no
 * change" review the Approving authority signs too (6); what is never
 * deleted (8); and the signing PIN for people who sign in only through
 * single sign-on (9).
 */
describe('policies: the business decisions after quality review 3', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  const password = `hospital-pass-${run}`;

  let a: Hospital;
  let b: Hospital;
  let dept: string;
  let manager: Staff; // manages documents everywhere, does not import
  let quality: Staff; // the Quality officer: imports, reviews
  let owner: Staff; // owns what is imported, and manages documents
  let authority: Staff; // the Approving authority
  let reader: Staff;
  let types: Record<string, string>;
  let categories: Record<string, string>;
  let today: string;

  const get = (cookie: string, url: string) => http().get(`/policies${url}`).set('Cookie', cookie);
  const post = (cookie: string, url: string, body: unknown = {}) =>
    http().post(`/policies${url}`).set('Cookie', cookie).send(body as object);
  const patch = (cookie: string, url: string, body: unknown) =>
    http().patch(`/policies${url}`).set('Cookie', cookie).send(body as object);

  const document = (extra: Record<string, unknown> = {}) => ({
    typeId: types.procedure,
    categoryId: categories.SAF,
    title: { en: 'Handling a spill' },
    ownerId: owner.id,
    ownerUnitId: dept,
    approvedOn: shiftDay(today, -300),
    approvedBy: 'Head of Operations',
    originalKeptAt: { en: 'Quality office' },
    nextReviewOn: shiftDay(today, 300),
    content: { en: { purpose: 'To make a spill safe.', steps: '1. Mark the area.' } },
    ...extra,
  });
  const importOne = (cookie: string, body: Record<string, unknown>) =>
    post(cookie, '/documents/import', { password, ...body });

  const auditOf = async (action: string, h: Hospital = a) =>
    bench.owner.db
      .select({ actorId: auditLog.actorId, changes: auditLog.changes, entityId: auditLog.entityId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, action)))
      .orderBy(auditLog.occurredAt);

  const told = async (userId: string, kind: string) =>
    bench.owner.db
      .select({ data: notifications.data, documentId: notifications.documentId })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), sql`${notifications.kind}::text = ${kind}`))
      .orderBy(notifications.createdAt);

  async function staff(h: Hospital, name: string, role: string | null, homeUnit: string | null) {
    const person = await bench.createStaff(h, name, role ? { role, orgUnitId: null } : null);
    if (homeUnit) await bench.owner.db.update(users).set({ orgUnitId: homeUnit }).where(eq(users.id, person.id));
    return person;
  }

  /** A policy written and published through its route. */
  async function publishedPolicy(title: string) {
    const doc = (await post(owner.cookie, '/documents', {
      typeId: types.policy,
      categoryId: categories.GOV,
      title: { en: title },
      ownerId: owner.id,
      ownerUnitId: dept,
    }).expect(201)).body as Doc;
    let v = (await get(owner.cookie, `/documents/${doc.id}/versions/${doc.inProgress!.id}`).expect(200)).body;
    v = (
      await patch(owner.cookie, `/documents/${doc.id}/versions/${v.id}`, {
        revision: v.revision,
        content: { en: { purpose: 'P.', scope: 'S.', policy_statements: 'Statements.', responsibilities: 'R.' } },
      }).expect(200)
    ).body;
    v = (await post(owner.cookie, `/documents/${doc.id}/versions/${v.id}/submit`, { revision: v.revision }).expect(200)).body;
    v = (await post(quality.cookie, `/documents/${doc.id}/versions/${v.id}/approve`, { password, revision: v.revision }).expect(200)).body;
    v = (await post(authority.cookie, `/documents/${doc.id}/versions/${v.id}/approve`, { password, revision: v.revision }).expect(200)).body;
    await post(owner.cookie, `/documents/${doc.id}/versions/${v.id}/publish`, { revision: v.revision }).expect(200);
    return (await get(owner.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
  }

  beforeAll(async () => {
    bench = await testBench('poldec', run);
    a = await bench.createHospital('a', { locales: ['en', 'ar'] });
    b = await bench.createHospital('b');
    const facility = await bench.createUnit(a, 'facility', 'F', null);
    dept = await bench.createUnit(a, 'department', 'NUR', facility);
    await bench.createRole(a, 'manager', ['policies.view', 'policies.manage']);
    manager = await staff(a, 'manager', 'manager', dept);
    quality = await staff(a, 'quality', 'quality_officer', facility);
    owner = await staff(a, 'owner', 'manager', dept);
    authority = await staff(a, 'authority', 'approving_authority', facility);
    reader = await staff(a, 'reader', 'reporter', dept);
    types = Object.fromEntries(
      (await get(a.cookie, '/types').expect(200)).body.map((t: { code: string; id: string }) => [t.code, t.id]),
    );
    categories = Object.fromEntries(
      (await get(a.cookie, '/categories').expect(200)).body.map((c: { code: string; id: string }) => [c.code, c.id]),
    );
    today = (
      (await post(manager.cookie, '/documents', {
        typeId: types.procedure,
        categoryId: categories.SAF,
        title: { en: 'Probe' },
        ownerId: manager.id,
        ownerUnitId: dept,
      }).expect(201)).body as Doc
    ).today;
  }, 180_000);

  afterAll(async () => {
    await bench.app.get(PolicyCheck, { strict: false }).stop();
    await bench.close();
  });

  describe('1. who imports', () => {
    it('is the Quality officer: not the Administrator, nor one who only manages documents', async () => {
      for (const cookie of [a.cookie, manager.cookie]) {
        expect((await importOne(cookie, document()).expect(403)).body).toEqual({
          code: 'missing_permission',
          permission: 'policies.import',
        });
        expect((await post(cookie, '/imports/check', { documents: [document()] }).expect(403)).body.permission).toBe('policies.import');
      }
      await importOne(quality.cookie, document({ number: `QO-${run}` })).expect(201);
      // The built-in roles: the Quality officer's has it, the Administrator's not.
      const builtIn = await bench.owner.db
        .select({ code: roles.code, permissions: roles.permissions })
        .from(roles)
        .where(and(eq(roles.tenantId, a.id), eq(roles.isSystem, true)));
      const of = (code: string) => builtIn.find((r) => r.code === code)!.permissions;
      expect(of('quality_officer')).toContain('policies.import');
      expect(of('administrator')).not.toContain('policies.import');
    });

    it('may still be given by an administrator, as part of the Quality officer’s role, to someone else', async () => {
      // The bench made `quality` a Quality officer as the administrator.
      const me = (await http().get('/auth/me').set('Cookie', quality.cookie).expect(200)).body;
      expect(me.permissions).toContain('policies.import');
      // Never to themselves: nobody changes their own access.
      const [qo] = await bench.owner.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, a.id), eq(roles.code, 'quality_officer'), eq(roles.isSystem, true)));
      expect(
        (await http().put(`/users/${a.adminId}/roles`).set('Cookie', a.cookie).send({ roles: [{ roleId: qo.id, orgUnitId: null }] }).expect(409)).body.code,
      ).toBe('cannot_change_self');
      // To someone else, yes.
      await http().put(`/users/${manager.id}/roles`).set('Cookie', a.cookie).send({ roles: [{ roleId: qo.id, orgUnitId: null }] }).expect(200);
      expect((await http().get('/auth/me').set('Cookie', manager.cookie).expect(200)).body.permissions).toContain('policies.import');
      // Back as it was, for what follows.
      const [mine] = await bench.owner.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.tenantId, a.id), eq(roles.code, 'manager')));
      await http().put(`/users/${manager.id}/roles`).set('Cookie', a.cookie).send({ roles: [{ roleId: mine.id, orgUnitId: null }] }).expect(200);
    });
  });

  describe('1. the owner’s confirmation of an import', () => {
    let imported: Doc & { published: { id: string } };

    it('is awaited from the owner for 30 days, shown as such, and offered to the owner only', async () => {
      imported = (await importOne(quality.cookie, document({ number: `CONF-${run}` })).expect(201)).body;
      expect(imported.importConfirmation).toMatchObject({ state: 'awaiting', dueOn: shiftDay(today, 30), confirmedAt: null, byImport: false });
      expect(imported.moves).not.toContain('confirm_import');
      const asOwner = (await get(owner.cookie, `/documents/${imported.id}`).expect(200)).body as Doc;
      expect(asOwner.moves).toContain('confirm_import');
      // The owner was told, with the day it is due.
      expect(await told(owner.id, 'document_owner_assigned')).toEqual(
        expect.arrayContaining([
          { documentId: imported.id, data: expect.objectContaining({ confirmationDueOn: shiftDay(today, 30) }) },
        ]),
      );
      // In the register and the master list.
      const register = (await get(manager.cookie, '/imports').expect(200)).body;
      expect(register.items.find((i: { number: string }) => i.number === `CONF-${run}`).confirmation).toMatchObject({
        state: 'awaiting',
        dueOn: shiftDay(today, 30),
        byImport: false,
      });
      const list = (await get(manager.cookie, '/exports/documents?locale=en').expect(200)).text;
      expect(list.split('\r\n').find((l) => l.startsWith(`"CONF-${run}"`))).toContain('"Awaiting the owner"');
      // And in the library's list, as in the master list.
      const library = (await get(manager.cookie, `/documents?q=CONF-${run}`).expect(200)).body;
      expect(library.items).toEqual([expect.objectContaining({ id: imported.id, confirmation: 'awaiting' })]);
    });

    it('is refused to anyone but the owner, and to bad input', async () => {
      const url = `/documents/${imported.id}/confirm-import`;
      await http().post(`/policies${url}`).send({ password, revision: 1 }).expect(401);
      const current = (await get(owner.cookie, `/documents/${imported.id}`).expect(200)).body as Doc;
      expect((await post(quality.cookie, url, { password, revision: current.revision }).expect(403)).body.code).toBe('not_owner');
      await post(b.cookie, url, { password, revision: current.revision }).expect(404);
      for (const body of [{}, { password }, { password, revision: current.revision, extra: 1 }]) {
        await post(owner.cookie, url, body).expect(400);
      }
      expect((await post(owner.cookie, url, { password, revision: 1 }).expect(409)).body.code).toBe('stale_document');
      expect((await post(owner.cookie, url, { password: 'nope', revision: current.revision }).expect(401)).body.code).toBe('wrong_password');
    });

    it('is given with the owner’s signature, once, and audited', async () => {
      const url = `/documents/${imported.id}/confirm-import`;
      const current = (await get(owner.cookie, `/documents/${imported.id}`).expect(200)).body as Doc;
      const confirmed = (await post(owner.cookie, url, { password, revision: current.revision }).expect(200)).body;
      expect(confirmed.importConfirmation).toMatchObject({
        state: 'confirmed',
        confirmedBy: { id: owner.id },
        byImport: false,
        signatureId: expect.any(String),
      });
      expect(confirmed.moves).not.toContain('confirm_import');
      const [signature] = await bench.owner.db.select().from(signatures).where(eq(signatures.id, confirmed.importConfirmation.signatureId));
      expect(signature).toMatchObject({ meaning: 'import_confirmed', userId: owner.id, subjectId: imported.published.id });
      expect((await post(owner.cookie, url, { password, revision: confirmed.revision }).expect(409)).body.code).toBe('import_already_confirmed');
      expect((await auditOf('import_confirmed')).at(-1)).toMatchObject({ actorId: owner.id, entityId: imported.id });
      // In the version's control block too.
      const version = (await get(reader.cookie, `/documents/${imported.id}/versions/${imported.published.id}`).expect(200)).body;
      expect(version.control.approvedBeforeTrustline.ownerConfirmation).toMatchObject({ state: 'confirmed' });
    });

    it('is given by the import itself when the importer owns the document, and the answer says so', async () => {
      const own = (await importOne(quality.cookie, document({ number: `SELF-${run}`, ownerId: quality.id })).expect(201)).body;
      expect(own.importConfirmation).toMatchObject({ state: 'confirmed', byImport: true, confirmedBy: { id: quality.id } });
    });

    it('is reminded to the owner and the importer 7 days before it is due, and once overdue, each once', async () => {
      const late = (await importOne(quality.cookie, document({ number: `LATE-${run}` })).expect(201)).body;
      const due = (day: string) =>
        bench.owner.db.execute(sql`update document_imports set confirmation_due_on = ${day}::date where document_id = ${late.id}`);
      const check = () => bench.app.get(PolicyCheck, { strict: false }).run(new Date(), [a.id]);
      const reminders = async () =>
        (await bench.owner.db
          .select({ userId: notifications.userId, data: notifications.data })
          .from(notifications)
          .where(and(eq(notifications.documentId, late.id), eq(notifications.kind, 'import_confirmation_due')))).map((n) => [
          n.userId,
          n.data.overdue,
        ]);
      await due(shiftDay(today, 8));
      await check();
      expect(await reminders()).toEqual([]);
      await due(shiftDay(today, 5));
      await check();
      await check();
      const order = (x: unknown[], y: unknown[]) => JSON.stringify(x).localeCompare(JSON.stringify(y));
      expect((await reminders()).sort(order)).toEqual([[owner.id, false], [quality.id, false]].sort(order));
      await due(shiftDay(today, -1));
      await check();
      await check();
      expect((await reminders()).filter((r) => r[1] === true).sort(order)).toEqual([[owner.id, true], [quality.id, true]].sort(order));
      expect(((await get(owner.cookie, `/documents/${late.id}`).expect(200)).body as Doc).importConfirmation).toMatchObject({ state: 'overdue' });
    });
  });

  describe('1. an owner change while the confirmation is awaited (security review 11)', () => {
    it('makes it due from the new owner, who is told; and never makes the importer the owner', async () => {
      const doc = (await importOne(quality.cookie, document({ number: `MOVE-${run}` })).expect(201)).body as Doc;
      expect(doc.importConfirmation).toMatchObject({ state: 'awaiting', dueFrom: { id: owner.id } });
      // To the importer: refused while it awaits.
      expect(
        (await patch(manager.cookie, `/documents/${doc.id}`, { ownerId: quality.id, revision: doc.revision }).expect(409)).body,
      ).toEqual({ code: 'owner_is_importer', field: 'ownerId' });
      // To someone else: due from them now, and they are told (by whoever
      // made the change: nobody is told of their own).
      const moved = (await patch(a.cookie, `/documents/${doc.id}`, { ownerId: manager.id, revision: doc.revision }).expect(200)).body as Doc;
      expect(moved.importConfirmation).toMatchObject({ state: 'awaiting', dueFrom: { id: manager.id } });
      expect(await told(manager.id, 'document_owner_assigned')).toEqual(
        expect.arrayContaining([{ documentId: doc.id, data: expect.objectContaining({ confirmationDueOn: shiftDay(today, 30) }) }]),
      );
      expect((await auditOf('document_updated')).find((e) => e.entityId === doc.id)?.changes).toMatchObject({
        confirmationDueFrom: { from: owner.id, to: manager.id },
      });
      // The former owner may no longer confirm; the new one may.
      const now = (await get(manager.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
      expect((await post(owner.cookie, `/documents/${doc.id}/confirm-import`, { password, revision: now.revision }).expect(403)).body.code).toBe('not_owner');
      expect(now.moves).toContain('confirm_import');
      // A reminder goes to the new owner even after the old one had theirs.
      await bench.owner.db.execute(sql`update document_imports set confirmation_due_on = ${shiftDay(today, 5)}::date where document_id = ${doc.id}`);
      await bench.app.get(PolicyCheck, { strict: false }).run(new Date(), [a.id]);
      const reminded = await bench.owner.db
        .select({ userId: notifications.userId })
        .from(notifications)
        .where(and(eq(notifications.documentId, doc.id), eq(notifications.kind, 'import_confirmation_due')));
      expect(reminded.map((r) => r.userId).sort()).toEqual([manager.id, quality.id].sort());
    });

    it('is never given by the importer, whatever writes it', async () => {
      const doc = (await importOne(quality.cookie, document({ number: `SELFCONF-${run}` })).expect(201)).body as Doc;
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      try {
        await expect(
          new TenantDb(app.db).withTenant(a.id, (tx) =>
            tx.execute(sql`update document_imports set confirmed_at = now(), confirmed_by = imported_by,
              confirmation_signature_id = signature_id where document_id = ${doc.id}`),
          ),
        ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'document_imports_importer_confirms' } });
      } finally {
        await app.pool.end();
      }
    });
  });

  describe('4. the emails some people may not switch off', () => {
    it('are said in the preferences, with why', async () => {
      const prefs = (cookie: string) => http().get('/me/notification-preferences').set('Cookie', cookie).expect(200);
      expect((await prefs(quality.cookie)).body.alwaysOn).toEqual([
        { emails: 'serious_incident_alerts', reason: 'triages' },
        { emails: 'approval_steps', reason: 'decides_approval_steps' },
      ]);
      expect((await prefs(authority.cookie)).body.alwaysOn).toEqual([{ emails: 'approval_steps', reason: 'decides_approval_steps' }]);
      expect((await prefs(reader.cookie)).body.alwaysOn).toEqual([]);
    });
  });

  describe('5. the language that applies, per document', () => {
    it('is the organization’s until a document names its own, in the client’s languages, audited', async () => {
      const doc = (await post(owner.cookie, '/documents', {
        typeId: types.procedure,
        categoryId: categories.SAF,
        title: { en: 'Its own language' },
        ownerId: owner.id,
        ownerUnitId: dept,
      }).expect(201)).body as Doc;
      expect(doc.authoritativeLocale).toBeNull();
      expect(
        (await patch(owner.cookie, `/documents/${doc.id}`, { authoritativeLocale: 'fr', revision: doc.revision }).expect(400)).body,
      ).toEqual({ code: 'language_mismatch', field: 'authoritativeLocale' });
      const changed = (await patch(owner.cookie, `/documents/${doc.id}`, { authoritativeLocale: 'ar', revision: doc.revision }).expect(200)).body;
      expect(changed).toMatchObject({ authoritativeLocale: 'ar', versionsInProgress: { draft: 1, in_review: 0, approved: 0 } });
      expect((await auditOf('document_updated')).find((e) => e.entityId === doc.id)?.changes).toMatchObject({
        authoritativeLocale: { from: null, to: 'ar' },
        authoritative: { from: 'en', to: 'ar' },
      });
      // Its draft is checked against Arabic, and sent only with it.
      let v = (await get(owner.cookie, `/documents/${doc.id}/versions/${doc.inProgress!.id}`).expect(200)).body;
      expect(v.languageStatus.authoritative).toBe('ar');
      v = (
        await patch(owner.cookie, `/documents/${doc.id}/versions/${v.id}`, {
          revision: v.revision,
          content: { en: { purpose: 'P.', scope: 'S.', responsibilities: 'R.', steps: '1.' } },
        }).expect(200)
      ).body;
      expect((await post(owner.cookie, `/documents/${doc.id}/versions/${v.id}/submit`, { revision: v.revision }).expect(400)).body).toMatchObject({
        code: 'missing_sections',
        locale: 'ar',
      });
      v = (
        await patch(owner.cookie, `/documents/${doc.id}/versions/${v.id}`, {
          revision: v.revision,
          content: { ar: { purpose: 'غ.', scope: 'ن.', responsibilities: 'م.', steps: '1.' } },
        }).expect(200)
      ).body;
      v = (await post(owner.cookie, `/documents/${doc.id}/versions/${v.id}/submit`, { revision: v.revision }).expect(200)).body;
      expect(v.authoritativeLocale).toBe('ar');
      // Null goes back to the organization's.
      const current = (await get(owner.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
      expect((await patch(owner.cookie, `/documents/${doc.id}`, { authoritativeLocale: null, revision: current.revision }).expect(200)).body.authoritativeLocale).toBeNull();
      // The version in review keeps Arabic.
      expect((await get(owner.cookie, `/documents/${doc.id}/versions/${v.id}`).expect(200)).body.authoritativeLocale).toBe('ar');
    });
  });

  describe('6. a "no change" review of a policy', () => {
    let doc: Doc;

    it('is a setting of the type: on for policies, off for the others, changed by those who manage the settings', async () => {
      const list = (await get(a.cookie, '/types').expect(200)).body as { code: string; noChangeNeedsApproval: boolean }[];
      expect(Object.fromEntries(list.map((t) => [t.code, t.noChangeNeedsApproval]))).toMatchObject({
        policy: true,
        procedure: false,
        work_instruction: false,
      });
    });

    it('waits for the Approving authority’s signature before the next review moves', async () => {
      doc = await publishedPolicy('Reviewed with approval');
      await bench.owner.db.update(documents).set({ nextReviewOn: shiftDay(today, 20) }).where(eq(documents.id, doc.id));
      let current = (await get(owner.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
      expect(current.reviewNeedsApproval).toBe(true);
      current = (await post(owner.cookie, `/documents/${doc.id}/review`, { password, comment: 'Still right.', revision: current.revision }).expect(200)).body;
      expect(current).toMatchObject({
        nextReviewOn: shiftDay(today, 20),
        reviewApproval: { status: 'pending', requestedBy: { id: owner.id }, comment: 'Still right.' },
      });
      expect(current.moves).not.toContain('confirm_review');
      // Once only, while it waits.
      await bench.owner.db.update(documents).set({ revision: current.revision }).where(eq(documents.id, doc.id));
      expect((await post(owner.cookie, `/documents/${doc.id}/review`, { password, comment: 'Again.', revision: current.revision }).expect(409)).body.code).toBe('review_pending');
      // The Approving authority is told, and has it in "Awaiting me".
      expect(await told(authority.id, 'review_approval_requested')).toEqual([{ documentId: doc.id, data: expect.objectContaining({ dueOn: shiftDay(today, 20) }) }]);
      const awaiting = (await get(authority.cookie, '/approvals').expect(200)).body;
      expect(awaiting.reviews).toEqual([
        expect.objectContaining({
          documentId: doc.id,
          number: doc.number,
          dueOn: shiftDay(today, 20),
          // With who asked.
          requestedBy: { id: owner.id, name: expect.objectContaining({ en: expect.any(String) }) },
        }),
      ]);
      const asAuthority = (await get(authority.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
      expect(asAuthority.moves).toEqual(expect.arrayContaining(['approve_review', 'return_review']));
      // And by email at once, as an approval step is.
      const queued = await bench.owner.db.execute<{ category: string }>(sql`
        select q.category from email_queue q join notifications n on n.id = q.notification_id
        where n.document_id = ${doc.id} and n.kind = 'review_approval_requested'`);
      expect(queued.rows.map((r) => r.category)).toEqual(['immediate']);
    });

    it('is decided by the Approving authority only, not its owner nor another', async () => {
      const current = (await get(owner.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
      await http().post(`/policies/documents/${doc.id}/review/approve`).send({ password, revision: current.revision }).expect(401);
      await post(reader.cookie, `/documents/${doc.id}/review/approve`, { password, revision: current.revision }).expect(403);
      expect((await post(owner.cookie, `/documents/${doc.id}/review/approve`, { password, revision: current.revision }).expect(403)).body.code).toBe('missing_permission');
      expect((await post(quality.cookie, `/documents/${doc.id}/review/approve`, { password, revision: current.revision }).expect(403)).body.code).toBe('not_review_approver');
      await post(b.cookie, `/documents/${doc.id}/review/approve`, { password, revision: current.revision }).expect(404);
      await post(authority.cookie, `/documents/${doc.id}/review/return`, { revision: current.revision }).expect(400);
    });

    it('returned, goes back to its owner with why; signed, moves the next review on', async () => {
      let current = (await get(authority.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
      current = (await post(authority.cookie, `/documents/${doc.id}/review/return`, { comment: 'Check section 3 first.', revision: current.revision }).expect(200)).body;
      expect(current.reviewApproval).toMatchObject({ status: 'returned', decisionComment: 'Check section 3 first.', decidedBy: { id: authority.id } });
      expect(await told(owner.id, 'review_returned')).toEqual([expect.objectContaining({ documentId: doc.id })]);
      expect(current.nextReviewOn).toBe(shiftDay(today, 20));
      // Sent again, then signed.
      current = (await get(owner.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
      current = (await post(owner.cookie, `/documents/${doc.id}/review`, { password, comment: 'Checked.', revision: current.revision }).expect(200)).body;
      current = (await post(authority.cookie, `/documents/${doc.id}/review/approve`, { password, revision: current.revision }).expect(200)).body;
      expect(current.reviewApproval).toMatchObject({ status: 'approved', decidedBy: { id: authority.id } });
      expect(current.nextReviewOn).not.toBe(shiftDay(today, 20));
      expect(current.lastReviewedOn).toBe(today);
      const [review] = await bench.owner.db.select().from(documentReviews).where(eq(documentReviews.documentId, doc.id));
      expect(review).toMatchObject({ outcome: 'no_change', reviewedBy: owner.id, approvedBy: authority.id, comment: 'Checked.' });
      const [signature] = await bench.owner.db.select().from(signatures).where(eq(signatures.id, review.approvalSignatureId!));
      expect(signature).toMatchObject({ meaning: 'reviewed_no_change_approved', userId: authority.id, subjectId: doc.id });
      expect((await auditOf('document_review_approved')).at(-1)).toMatchObject({ actorId: authority.id, entityId: doc.id });
    });
  });

  describe('4. an approval step, to one who switched immediate emails off', () => {
    it('is still sent, and the unsubscribe page says which emails stay on', async () => {
      await http().patch('/me/notification-preferences').set('Cookie', authority.cookie).send({ immediate: false }).expect(200);
      try {
        const doc = await publishedPolicy('Still emailed');
        const worker = bench.app.get(EmailWorker);
        const hour = worker.digestHour;
        worker.digestHour = 24;
        try {
          await worker.run(new Date(), [a.id]);
        } finally {
          worker.digestHour = hour;
        }
        const rows = await bench.owner.db.execute<{ status: string; reason: string | null }>(sql`
          select q.status, q.reason from email_queue q join notifications n on n.id = q.notification_id
          where n.document_id = ${doc.id} and n.kind = 'document_step_assigned' and q.user_id = ${authority.id}`);
        expect(rows.rows).toEqual([{ status: 'sent', reason: null }]);
      } finally {
        await http().patch('/me/notification-preferences').set('Cookie', authority.cookie).send({ immediate: true }).expect(200);
      }
      const config = bench.app.get<MailConfig>(MAIL_CONFIG);
      const token = signUnsubscribe(config.linkSecret, { tenantId: a.id, userId: authority.id, switch: 'immediate', locale: 'en' });
      const page = await http().get(`/email/unsubscribe/${token}`).expect(200);
      expect(page.text).toContain('approval steps assigned to you are always sent');
    });
  });

  describe('6. who signs, and turning it off (security review 11)', () => {
    it('falls back to the Administrators when the only Approving authority asked', async () => {
      const doc = (await post(owner.cookie, '/documents', {
        typeId: types.policy,
        categoryId: categories.GOV,
        title: { en: 'Owned by the authority' },
        ownerId: authority.id,
        ownerUnitId: dept,
      }).expect(201)).body as Doc;
      let v = (await get(owner.cookie, `/documents/${doc.id}/versions/${doc.inProgress!.id}`).expect(200)).body;
      v = (await patch(owner.cookie, `/documents/${doc.id}/versions/${v.id}`, { revision: v.revision, content: { en: { purpose: 'P.', scope: 'S.', policy_statements: 'St.', responsibilities: 'R.' } } }).expect(200)).body;
      v = (await post(owner.cookie, `/documents/${doc.id}/versions/${v.id}/submit`, { revision: v.revision }).expect(200)).body;
      v = (await post(quality.cookie, `/documents/${doc.id}/versions/${v.id}/approve`, { password, revision: v.revision }).expect(200)).body;
      v = (await post(authority.cookie, `/documents/${doc.id}/versions/${v.id}/approve`, { password, revision: v.revision }).expect(200)).body;
      await post(owner.cookie, `/documents/${doc.id}/versions/${v.id}/publish`, { revision: v.revision }).expect(200);
      await bench.owner.db.update(documents).set({ nextReviewOn: shiftDay(today, 20) }).where(eq(documents.id, doc.id));
      const current = (await get(authority.cookie, `/documents/${doc.id}`).expect(200)).body as Doc;
      const asked = (await post(authority.cookie, `/documents/${doc.id}/review`, { password, comment: 'Mine, unchanged.', revision: current.revision }).expect(200)).body;
      expect(asked.reviewApproval).toMatchObject({ status: 'pending' });
      expect(await told(a.adminId, 'review_approval_requested')).toEqual([expect.objectContaining({ documentId: doc.id })]);
      expect(((await get(a.cookie, `/documents/${doc.id}`).expect(200)).body as Doc).moves).toContain('approve_review');
    });

    it('turned off for a type, tells the Approving authorities and the Administrators', async () => {
      const [type] = (await get(a.cookie, '/types').expect(200)).body.filter((t: { code: string }) => t.code === 'policy');
      await patch(quality.cookie, `/types/${type.id}`, { noChangeNeedsApproval: false, revision: type.revision }).expect(200);
      for (const who of [authority.id, a.adminId]) {
        expect(await told(who, 'review_approval_turned_off')).toEqual([
          { documentId: null, data: { typeId: type.id, typeCode: 'policy', serious: false } },
        ]);
      }
      expect(await told(quality.id, 'review_approval_turned_off')).toEqual([]);
      const after = (await get(a.cookie, '/types').expect(200)).body.find((t: { code: string }) => t.code === 'policy');
      await patch(quality.cookie, `/types/${type.id}`, { noChangeNeedsApproval: true, revision: after.revision }).expect(200);
    });
  });

  describe('8. what is never deleted', () => {
    it('acknowledgements, signatures and reviews cannot be deleted by the application, nor the people they name', async () => {
      // A document asking for acknowledgement, acknowledged; its reader then leaves.
      const asked = (await importOne(quality.cookie, document({ number: `KEEP-${run}`, acknowledgementRequired: true })).expect(201)).body;
      await post(reader.cookie, `/documents/${asked.id}/versions/${asked.published.id}/acknowledge`, { password }).expect(200);
      await http().patch(`/users/${reader.id}`).set('Cookie', a.cookie).send({ status: 'disabled' }).expect(200);
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      try {
        const asApp = (fn: Parameters<TenantDb['withTenant']>[1]) => new TenantDb(app.db).withTenant(a.id, fn);
        for (const remove of [
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.delete(documentAcknowledgements).where(eq(documentAcknowledgements.userId, reader.id)),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.delete(signatures).where(eq(signatures.userId, reader.id)),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.delete(documentReviews),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.delete(users).where(eq(users.id, reader.id)),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.delete(documents).where(eq(documents.id, asked.id)),
        ]) {
          await expect(asApp(remove)).rejects.toMatchObject({ cause: { code: '42501' } });
        }
        // Nor undone by an UPDATE (security review 11): an acknowledgement
        // given keeps its time and signature, and a decided review stays
        // decided.
        await expect(
          asApp((tx) =>
            tx
              .update(documentAcknowledgements)
              .set({ acknowledgedAt: null, signatureId: null })
              .where(eq(documentAcknowledgements.userId, reader.id)),
          ),
        ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'document_acknowledgements_given_fixed' } });
        await expect(
          asApp((tx) => tx.execute(sql`update document_review_approvals set status = 'pending', decided_by = null, decided_at = null where status <> 'pending'`)),
        ).rejects.toMatchObject({ cause: { code: '23514', constraint: 'document_review_approvals_decided_fixed' } });
      } finally {
        await app.pool.end();
      }
      // The record of the one who left stands, as on their record screen.
      const [ack] = await bench.owner.db
        .select()
        .from(documentAcknowledgements)
        .where(and(eq(documentAcknowledgements.userId, reader.id), eq(documentAcknowledgements.versionId, asked.published.id)));
      expect(ack.acknowledgedAt).not.toBeNull();
      expect((await get(manager.cookie, `/people/${reader.id}/acknowledgements`).expect(200)).body.person.status).toBe('disabled');
    });
  });

  describe('9. the signing PIN', () => {
    let sso: Staff; // signs in only through single sign-on: no password
    let savedHash: string | null;
    let asked: Doc & { published: { id: string } };

    /** A new session for the person, as single sign-on would give one. */
    const signInAgain = async () => {
      // The short lock of wrong attempts lapsed, as it does with time.
      await bench.owner.db
        .update(users)
        .set({ passwordHash: savedHash, lockedUntil: null, failedAttempts: 0 })
        .where(eq(users.id, sso.id));
      const cookie = bench.cookieOf(await bench.login(a.slug, sso.email).expect(200));
      await bench.owner.db.update(users).set({ passwordHash: null }).where(eq(users.id, sso.id));
      sso = { ...sso, cookie };
      return cookie;
    };
    const emailed = async (kind: string) =>
      (
        await bench.owner.db.execute<{ category: string; data: Record<string, unknown> }>(sql`
          select q.category, n.data from email_queue q join notifications n on n.id = q.notification_id
          where n.user_id = ${sso.id} and n.kind::text = ${kind} order by n.created_at`)
      ).rows;

    beforeAll(async () => {
      sso = await staff(a, 'sso', 'reporter', dept);
      [{ savedHash }] = await bench.owner.db.select({ savedHash: users.passwordHash }).from(users).where(eq(users.id, sso.id));
      // As a person of single sign-on has: a session, no password.
      await bench.owner.db.update(users).set({ passwordHash: null }).where(eq(users.id, sso.id));
      asked = (await importOne(quality.cookie, document({ number: `PIN-${run}`, acknowledgementRequired: true })).expect(201)).body;
    });

    const me = async (cookie: string) => (await http().get('/auth/me').set('Cookie', cookie).expect(200)).body.signingMethod;
    const setPin = (cookie: string, body: Record<string, unknown>) => http().put('/me/signing-pin').set('Cookie', cookie).send(body);

    it('tells how each person signs, and refuses a signature to one who has neither a password nor a PIN', async () => {
      expect(await me(owner.cookie)).toBe('password');
      expect(await me(sso.cookie)).toBe('none');
      expect(
        (await post(sso.cookie, `/documents/${asked.id}/versions/${asked.published.id}/acknowledge`, { password: '284619' }).expect(403)).body,
      ).toEqual({ code: 'signing_pin_required' });
    });

    it('is set only by a person without a password, soon after signing in, and not easily guessed', async () => {
      await http().put('/me/signing-pin').send({ pin: '284619' }).expect(401);
      expect((await setPin(owner.cookie, { pin: '284619' }).expect(409)).body.code).toBe('signs_with_password');
      for (const pin of ['12345', '1234567890123', 'abcdef', 284619, '28461a']) await setPin(sso.cookie, { pin }).expect(400);
      await setPin(sso.cookie, { pin: '284619', extra: 1 }).expect(400);
      // Runs, repeats, mirrors, days and the most common (security review 11).
      for (const pin of ['111111', '123456', '987654', '890123', '121212', '112233', '123123', '123321', '696969', '311290', '19800521', '000123', '147258']) {
        expect(`${pin}: ${(await setPin(sso.cookie, { pin }).expect(400)).body.code}`).toBe(`${pin}: pin_too_simple`);
      }
      expect(pinTooSimple('284619')).toBe(false);
      // A sign-in more than ten minutes ago is not fresh enough.
      await bench.owner.db.execute(sql`update sessions set created_at = now() - interval '11 minutes' where user_id = ${sso.id}`);
      expect((await setPin(sso.cookie, { pin: '284619' }).expect(403)).body.code).toBe('fresh_sign_in_required');
      // Two sessions: setting the PIN in one ends the other.
      const other = sso.cookie;
      await signInAgain();
      await setPin(sso.cookie, { pin: '284619' }).expect(204);
      expect(await me(sso.cookie)).toBe('pin');
      await http().get('/auth/me').set('Cookie', other).expect(401);
      expect((await auditOf('signing_pin_set')).at(-1)).toMatchObject({ actorId: sso.id, entityId: sso.id, changes: { action: 'set' } });
      expect(await told(sso.id, 'signing_pin_changed')).toEqual([{ documentId: null, data: { action: 'set', serious: false } }]);
      // By an email they cannot switch off, too.
      expect(await emailed('signing_pin_changed')).toEqual([{ category: 'immediate', data: { action: 'set', serious: false } }]);
      // Hashed with the server's pepper: the PIN alone does not match it.
      const [row] = await bench.owner.db.select({ hash: users.signingPinHash }).from(users).where(eq(users.id, sso.id));
      expect(await verifyPassword('284619', row.hash!)).toBe(false);
      expect(await verifyPassword(pinSecret('284619'), row.hash!)).toBe(true);
    });

    it('signs wherever a password would, and an administrator sees nothing of it', async () => {
      const url = `/documents/${asked.id}/versions/${asked.published.id}/acknowledge`;
      expect((await post(sso.cookie, url, { password: '000999' }).expect(401)).body.code).toBe('wrong_password');
      await post(sso.cookie, url, { password: '284619' }).expect(200);
      const shown = (await http().get(`/users/${sso.id}`).set('Cookie', a.cookie).expect(200)).body;
      expect(JSON.stringify(shown)).not.toMatch(/signingPin|pinHash/i);
    });

    it('is changed only with the current PIN', async () => {
      expect((await setPin(sso.cookie, { pin: '582947' }).expect(400)).body.code).toBe('current_pin_required');
      expect((await setPin(sso.cookie, { pin: '582947', currentPin: '000999' }).expect(401)).body.code).toBe('wrong_password');
      await setPin(sso.cookie, { pin: '582947', currentPin: '284619' }).expect(204);
      expect((await told(sso.id, 'signing_pin_changed')).map((n) => n.data.action)).toEqual(['set', 'changed']);
    });

    it('is not undone by a password link an administrator holds', async () => {
      expect((await http().post(`/users/${sso.id}/invite`).set('Cookie', a.cookie).expect(409)).body.code).toBe('signs_with_pin');
    });

    it('locks after ten wrong PINs in all, whatever the short locks between, until it is reset', async () => {
      const doc = (await importOne(quality.cookie, document({ number: `LOCK-${run}`, acknowledgementRequired: true })).expect(201)).body;
      const url = `/documents/${doc.id}/versions/${doc.published.id}/acknowledge`;
      for (let i = 1; i <= 9; i++) {
        await post(sso.cookie, url, { password: '000999' }).expect(401);
        // The short lock after five lapses, as it would with time.
        await bench.owner.db.update(users).set({ lockedUntil: null }).where(eq(users.id, sso.id));
      }
      const locked = sso.cookie;
      expect((await post(sso.cookie, url, { password: '000999' }).expect(403)).body.code).toBe('signing_pin_locked');
      // The session it happened in is ended; they are told, by email too.
      await http().get('/auth/me').set('Cookie', locked).expect(401);
      expect(await told(sso.id, 'signing_pin_locked')).toEqual([{ documentId: null, data: { serious: false } }]);
      expect((await emailed('signing_pin_locked')).map((r) => r.category)).toEqual(['immediate']);
      expect((await auditOf('signing_pin_locked')).at(-1)).toMatchObject({ actorId: null, entityId: sso.id, changes: { failures: 10 } });
      // Locked: even the right PIN, and changing it, are refused.
      await signInAgain();
      expect((await post(sso.cookie, url, { password: '582947' }).expect(403)).body.code).toBe('signing_pin_locked');
      expect((await setPin(sso.cookie, { pin: '639271', currentPin: '582947' }).expect(403)).body.code).toBe('signing_pin_locked');
    }, 60_000);

    it('is reset by whoever manages the person, never set by them; audited, told, and every session ended', async () => {
      await http().delete(`/users/${sso.id}/signing-pin`).expect(401);
      await http().delete(`/users/${sso.id}/signing-pin`).set('Cookie', owner.cookie).expect(403);
      await http().delete(`/users/${sso.id}/signing-pin`).set('Cookie', b.cookie).expect(404);
      const before = sso.cookie;
      await http().delete(`/users/${sso.id}/signing-pin`).set('Cookie', a.cookie).expect(204);
      await http().get('/auth/me').set('Cookie', before).expect(401);
      await signInAgain();
      expect(await me(sso.cookie)).toBe('none');
      expect((await http().delete(`/users/${sso.id}/signing-pin`).set('Cookie', a.cookie).expect(409)).body.code).toBe('no_signing_pin');
      expect((await auditOf('signing_pin_reset')).at(-1)).toMatchObject({ actorId: a.adminId, entityId: sso.id });
      expect((await told(sso.id, 'signing_pin_changed')).map((n) => n.data.action)).toEqual(['set', 'changed', 'reset']);
      expect((await emailed('signing_pin_changed')).map((r) => r.data.action)).toEqual(['set', 'changed', 'reset']);
      // Nothing lets an administrator set one.
      await http().put(`/users/${sso.id}/signing-pin`).set('Cookie', a.cookie).send({ pin: '284619' }).expect(404);
      // The lock went with it: a new PIN signs.
      await setPin(sso.cookie, { pin: '639271' }).expect(204);
      const doc = (await importOne(quality.cookie, document({ number: `AFTER-${run}`, acknowledgementRequired: true })).expect(201)).body;
      await post(sso.cookie, `/documents/${doc.id}/versions/${doc.published.id}/acknowledge`, { password: '639271' }).expect(200);
    });
  });
});
