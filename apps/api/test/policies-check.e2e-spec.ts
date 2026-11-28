import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  documentAcknowledgements,
  documents,
  documentVersions,
  notifications,
  signatures,
  users,
} from '../src/database/schema.js';
import { addMonths, dayOf, shiftDay, startOfDay } from '../src/i18n/time-zones.js';
import { PoliciesModule } from '../src/policies/policies.module.js';
import { PolicyCheck } from '../src/policies/policy-check.service.js';
import { ModulesContainer } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const DAY = 86_400_000;
const NO_LIMITS = { users: null, sites: null, storageMb: null, aiCreditsPerMonth: null };
const NO_EXTRAS = { sso: false, publicReporting: false, clinicalAiSuggestions: false };

/**
 * The daily check of the policies module (scheduled publishing, review
 * and acknowledgement reminders, people who join an audience), the module
 * switched off and the subscription suspended, and the two measures the
 * business named.
 */
describe('policies: the daily check, the module and the subscription', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  let check: PolicyCheck;
  const http = () => bench.http();
  const password = `hospital-pass-${run}`;

  // Three hours ahead of UTC all year, so that its day is not UTC's.
  let c: Hospital;
  let unit: string;
  let dept: string;
  let writer: Staff;
  let manager: Staff;
  let quality: Staff;
  let approver: Staff;
  let reader: Staff;
  let joiner: Staff;
  let types: Record<string, string>;
  let categories: Record<string, string>;

  const get = (cookie: string, url: string) =>
    http().get(`/policies${url}`).set('Cookie', cookie);
  const post = (cookie: string, url: string, body: unknown = {}) =>
    http().post(`/policies${url}`).set('Cookie', cookie).send(body as object);
  const patch = (cookie: string, url: string, body: unknown) =>
    http().patch(`/policies${url}`).set('Cookie', cookie).send(body as object);
  const runCheck = (now: Date, h: { id: string } = c) => check.run(now, [h.id]);

  async function staff(
    h: Hospital,
    name: string,
    role: string | string[] | null,
    homeUnit: string | null,
  ) {
    const person = await bench.createStaff(
      h,
      name,
      role ? [role].flat().map((r) => ({ role: r, orgUnitId: null })) : null,
    );
    if (homeUnit) {
      await bench.owner.db
        .update(users)
        .set({ orgUnitId: homeUnit })
        .where(eq(users.id, person.id));
    }
    return person;
  }

  const FULL = {
    purpose: 'Why.',
    scope: 'Who.',
    responsibilities: 'Whose.',
    steps: '1. First.',
  };

  /** An approved document of hospital `h`, written by `w`. */
  async function approvedIn(
    h: { cookie: string },
    w: Staff,
    q: Staff,
    ap: Staff,
    extra: Record<string, unknown>,
    t = types,
    cats = categories,
  ) {
    const doc = (
      await post(w.cookie, '/documents', {
        typeId: t.procedure,
        categoryId: cats.SAF,
        title: { en: `Doc ${randomBytes(3).toString('hex')}` },
        ownerId: w.id,
        ...extra,
      }).expect(201)
    ).body;
    let version = (
      await get(w.cookie, `/documents/${doc.id}/versions/${doc.inProgress.id}`).expect(200)
    ).body;
    version = (
      await patch(w.cookie, `/documents/${doc.id}/versions/${version.id}`, {
        content: { en: FULL },
        revision: version.revision,
      }).expect(200)
    ).body;
    for (const [who, action] of [
      [w, 'submit'],
      [q, 'approve'],
      [ap, 'approve'],
    ] as const) {
      version = (
        await post(who.cookie, `/documents/${doc.id}/versions/${version.id}/${action}`, {
          revision: version.revision,
          ...(action === 'approve' && { password }),
        }).expect(200)
      ).body;
    }
    expect(version.status).toBe('approved');
    expect(h.cookie).toBeTruthy();
    return { doc, version };
  }

  const approved = (extra: Record<string, unknown> = {}) =>
    approvedIn(c, writer, quality, approver, { ownerUnitId: dept, ...extra });

  async function publishedNow(extra: Record<string, unknown> = {}) {
    const { doc, version } = await approved(extra);
    const after = (
      await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, {
        revision: version.revision,
      }).expect(200)
    ).body;
    return { doc, version: after };
  }

  /** The notifications of the policies module a user was sent about a document. */
  const sentAbout = async (userId: string, documentId: string) =>
    bench.owner.db
      .select({ kind: notifications.kind, data: notifications.data })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.documentId, documentId)))
      .orderBy(notifications.createdAt);

  beforeAll(async () => {
    bench = await testBench('polchk', run);
    check = bench.app.get(PolicyCheck, { strict: false });
    c = await bench.createHospital('c', { timeZone: 'Asia/Riyadh' });
    const facility = await bench.createUnit(c, 'facility', 'F', null);
    dept = await bench.createUnit(c, 'department', 'D', facility);
    unit = await bench.createUnit(c, 'unit', 'U', dept);
    await bench.createRole(c, 'writer', ['policies.view', 'policies.manage']);
    writer = await staff(c, 'writer', 'writer', dept);
    manager = await staff(c, 'manager', 'writer', dept);
    quality = await staff(c, 'quality', 'quality_officer', null);
    approver = await staff(c, 'approver', ['administrator', 'approving_authority'], null);
    reader = await staff(c, 'reader', 'reporter', unit);
    joiner = await staff(c, 'joiner', 'reporter', null);
    types = Object.fromEntries(
      (await get(c.cookie, '/types').expect(200)).body.map((t: { code: string; id: string }) => [t.code, t.id]),
    );
    categories = Object.fromEntries(
      (await get(c.cookie, '/categories').expect(200)).body.map((t: { code: string; id: string }) => [t.code, t.id]),
    );
  }, 120_000);

  afterAll(async () => {
    await check.stop();
    await bench.close();
  });

  describe('scheduled publishing', () => {
    it("publishes an approved version on its day, the client's day, once, by nobody", async () => {
      const { doc, version } = await approved({
        acknowledgementRequired: true,
        audience: { orgUnitIds: [dept], roleIds: [] },
      });
      const today = dayOf(new Date(), 'Asia/Riyadh');
      const day = shiftDay(today, 2);
      await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, {
        effectiveOn: day,
        revision: version.revision,
      }).expect(200);
      // An hour before midnight there, it is still the day before.
      const midnight = startOfDay(day, 'Asia/Riyadh');
      await runCheck(new Date(midnight.getTime() - 3_600_000));
      expect((await get(writer.cookie, `/documents/${doc.id}`).expect(200)).body.status).toBe('draft');
      // Half an hour after it, the day has come there, not yet in UTC.
      const at = new Date(midnight.getTime() + 1_800_000);
      expect(dayOf(at, 'UTC')).toBe(shiftDay(day, -1));
      const result = await runCheck(at);
      expect(result).toMatchObject({ listed: true, clients: 1, failed: 0 });
      expect(result.published).toBeGreaterThanOrEqual(1);
      const live = (await get(reader.cookie, `/documents/${doc.id}`).expect(200)).body;
      expect(live).toMatchObject({
        status: 'active',
        published: { id: version.id, effectiveOn: day },
        nextReviewOn: addMonths(day, 24),
      });
      expect((await sentAbout(reader.id, doc.id)).map((n) => n.kind)).toEqual(['document_published']);
      const [entry] = await bench.owner.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, doc.id), eq(auditLog.action, 'document_published')));
      expect(entry).toMatchObject({ actorId: null });
      expect(entry.changes).toMatchObject({ byScheduledCheck: true, effectiveOn: day });
      // Once.
      await runCheck(at);
      expect((await sentAbout(reader.id, doc.id)).map((n) => n.kind)).toEqual(['document_published']);
    }, 60_000);

    it('leaves unpublished, and logs, a version whose signatures no longer match it, and publishes the others', async () => {
      const today = dayOf(new Date(), 'Asia/Riyadh');
      const day = shiftDay(today, 3);
      const schedule = async () => {
        const { doc, version } = await approved();
        await post(writer.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, {
          effectiveOn: day,
          revision: version.revision,
        }).expect(200);
        return { doc, version };
      };
      const bad = await schedule();
      const good = await schedule();
      // What the database itself no longer lets anyone do to the version's
      // text, done to one of its signatures instead, as the owner.
      const [signature] = await bench.owner.db
        .select({ id: signatures.id, contentHash: signatures.contentHash })
        .from(signatures)
        .where(eq(signatures.subjectId, bad.version.id))
        .limit(1);
      await bench.owner.db
        .update(signatures)
        .set({ contentHash: '0'.repeat(64) })
        .where(eq(signatures.id, signature.id));
      const logged = vi.spyOn((check as unknown as { logger: { error: (m: string) => void } }).logger, 'error');
      try {
        const at = new Date(startOfDay(day, 'Asia/Riyadh').getTime() + 1_800_000);
        const result = await runCheck(at);
        expect(result).toMatchObject({ failed: 0 });
        expect(result.published).toBeGreaterThanOrEqual(1);
        const statusOf = async (id: string) =>
          (
            await bench.owner.db
              .select({ status: documentVersions.status })
              .from(documentVersions)
              .where(eq(documentVersions.id, id))
          )[0].status;
        expect(await statusOf(bad.version.id)).toBe('approved');
        expect(await statusOf(good.version.id)).toBe('published');
        expect(logged.mock.calls.map((c) => c[0])).toEqual([
          expect.stringMatching(new RegExp(`version ${bad.version.id} of client ${c.id}.*content_changed`)),
        ]);
        // Nothing of the version's text is in the log.
        expect(logged.mock.calls[0][0]).not.toContain(FULL.purpose);
        // Put right, it is published on the next run.
        await bench.owner.db
          .update(signatures)
          .set({ contentHash: signature.contentHash })
          .where(eq(signatures.id, signature.id));
        expect((await runCheck(at)).published).toBeGreaterThanOrEqual(1);
        expect(await statusOf(bad.version.id)).toBe('published');
      } finally {
        logged.mockRestore();
      }
    }, 60_000);
  });

  describe('review reminders', () => {
    it('tell the owner 60, 30 and 7 days before, each once, and the managers too once it has passed', async () => {
      const { doc } = await publishedNow({ reviewMonths: 12, ownerId: writer.id });
      const due = (await get(writer.cookie, `/documents/${doc.id}`).expect(200)).body.nextReviewOn as string;
      const at = (day: string) => new Date(startOfDay(day, 'Asia/Riyadh').getTime() + 6 * 3_600_000);
      const kinds = async (who: Staff) =>
        (await sentAbout(who.id, doc.id))
          .filter((n) => n.kind.startsWith('review_'))
          .map((n) => `${n.kind}:${n.data.days ?? n.data.dueOn}`);
      await runCheck(at(shiftDay(due, -61)));
      expect(await kinds(writer)).toEqual([]);
      await runCheck(at(shiftDay(due, -60)));
      await runCheck(at(shiftDay(due, -59)));
      expect(await kinds(writer)).toEqual(['review_due:60']);
      await runCheck(at(shiftDay(due, -30)));
      await runCheck(at(shiftDay(due, -7)));
      await runCheck(at(shiftDay(due, -7)));
      expect(await kinds(writer)).toEqual(['review_due:60', 'review_due:30', 'review_due:7']);
      expect(await kinds(manager)).toEqual([]);
      await runCheck(at(shiftDay(due, 1)));
      await runCheck(at(shiftDay(due, 2)));
      expect(await kinds(writer)).toEqual(['review_due:60', 'review_due:30', 'review_due:7', `review_overdue:${due}`]);
      expect(await kinds(manager)).toEqual([`review_overdue:${due}`]);
      // A reader of the document is never told.
      expect(await kinds(reader)).toEqual([]);
    }, 60_000);

    it('start again for the next date once the review is confirmed', async () => {
      const { doc } = await publishedNow({ reviewMonths: 1 });
      const before = (await get(writer.cookie, `/documents/${doc.id}`).expect(200)).body;
      await runCheck(new Date(Date.now() + 40 * DAY));
      const reviews = async () =>
        (await sentAbout(writer.id, doc.id)).filter((n) => n.kind.startsWith('review_'));
      expect((await reviews()).map((n) => n.kind)).toEqual(['review_overdue']);
      const after = (
        await post(writer.cookie, `/documents/${doc.id}/review`, { password, comment: 'Still right.', revision: before.revision }).expect(200)
      ).body;
      expect(after.nextReviewOn).toBe(addMonths(dayOf(new Date(), 'Asia/Riyadh'), 1));
      await runCheck(new Date(Date.now() + DAY));
      expect((await reviews()).map((n) => `${n.kind}:${n.data.days ?? ''}`)).toEqual([
        'review_overdue:',
        // A month away: within 30 days the next morning.
        'review_due:30',
      ]);
    }, 60_000);
  });

  describe('acknowledgements', () => {
    it('asks those who join the audience, once, and reminds at half the time and when overdue, once each', async () => {
      const { doc, version } = await publishedNow({
        acknowledgementRequired: true,
        audience: { orgUnitIds: [dept], roleIds: [] },
      });
      const rows = async () =>
        bench.owner.db
          .select({ userId: documentAcknowledgements.userId })
          .from(documentAcknowledgements)
          .where(eq(documentAcknowledgements.versionId, version.id));
      expect((await rows()).map((r) => r.userId)).toContain(reader.id);
      expect((await rows()).map((r) => r.userId)).not.toContain(joiner.id);
      // The joiner moves into the department.
      await bench.owner.db.update(users).set({ orgUnitId: unit }).where(eq(users.id, joiner.id));
      // Asked before the check runs, as soon as they open it.
      const seen = (await get(joiner.cookie, `/documents/${doc.id}`).expect(200)).body;
      expect(seen.myAcknowledgement).toMatchObject({ versionId: version.id, dueOn: null, acknowledgedAt: null });
      // Two processes at once: each person asked and told once.
      await Promise.all([runCheck(new Date()), runCheck(new Date())]);
      expect((await rows()).filter((r) => r.userId === joiner.id)).toHaveLength(1);
      expect((await sentAbout(joiner.id, doc.id)).map((n) => n.kind)).toEqual(['acknowledgement_assigned']);
      // The reader acknowledges; the joiner does not.
      await post(reader.cookie, `/documents/${doc.id}/versions/${version.id}/acknowledge`, { password }).expect(200);
      await runCheck(new Date(Date.now() + 6 * DAY));
      expect((await sentAbout(joiner.id, doc.id)).map((n) => n.kind)).toEqual(['acknowledgement_assigned']);
      await Promise.all([runCheck(new Date(Date.now() + 7 * DAY)), runCheck(new Date(Date.now() + 7 * DAY))]);
      await runCheck(new Date(Date.now() + 8 * DAY));
      expect((await sentAbout(joiner.id, doc.id)).map((n) => n.kind)).toEqual([
        'acknowledgement_assigned',
        'acknowledgement_due',
      ]);
      await runCheck(new Date(Date.now() + 15 * DAY));
      await runCheck(new Date(Date.now() + 16 * DAY));
      expect((await sentAbout(joiner.id, doc.id)).map((n) => n.kind)).toEqual([
        'acknowledgement_assigned',
        'acknowledgement_due',
        'acknowledgement_overdue',
      ]);
      expect((await sentAbout(reader.id, doc.id)).map((n) => n.kind)).toEqual(['document_published']);
      // Overdue in the figures too.
      const figures = (await get(writer.cookie, `/documents/${doc.id}/versions/${version.id}/acknowledgements`).expect(200)).body;
      expect(figures).toMatchObject({ acknowledged: 1 });
    }, 60_000);

    it('leaves alone what is not its own client, and says what failed without saying any of it', async () => {
      const result = await check.run(new Date(), [randomUUID()]);
      expect(result).toEqual({ listed: true, clients: 0, failed: 0, published: 0, assigned: 0, notified: 0 });
    });
  });

  describe('the two measures', () => {
    it('give the share of documents past their review date and of targeted people who acknowledged', async () => {
      const h = await bench.createHospital('measures');
      const f = await bench.createUnit(h, 'facility', 'F', null);
      await bench.createRole(h, 'writer', ['policies.view', 'policies.manage']);
      const w = await staff(h, 'mwriter', 'writer', f);
      const q = await staff(h, 'mquality', 'quality_officer', null);
      const ap = await staff(h, 'mapprover', ['administrator', 'approving_authority'], null);
      const r1 = await staff(h, 'mreader1', 'reporter', f);
      const r2 = await staff(h, 'mreader2', 'reporter', f);
      const t = Object.fromEntries((await get(h.cookie, '/types').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
      const cat = Object.fromEntries((await get(h.cookie, '/categories').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const { doc, version } = await approvedIn(h, w, q, ap, { ownerUnitId: f, acknowledgementRequired: i === 0 }, t, cat);
        await post(w.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, { revision: version.revision }).expect(200);
        ids.push(doc.id);
        if (i === 0) {
          await post(r1.cookie, `/documents/${doc.id}/versions/${version.id}/acknowledge`, { password }).expect(200);
        }
      }
      await bench.owner.db.execute(sql`update documents set next_review_on = current_date - 1 where id = ${ids[3]}`);
      let summary = (await get(w.cookie, '/summary').expect(200)).body;
      expect(summary.pastReview).toEqual({ count: 1, of: 4, percent: 25, target: 5, met: false });
      // Everyone in the audience (the whole organization) who may read:
      // the two readers, the three who manage, review and approve, and the
      // client's first administrator. None of them is due yet, so the
      // measure has no one to count; the figure as it stands today does.
      expect(summary.acknowledgement).toEqual({
        basis: 'due_date_passed',
        targeted: 0,
        acknowledged: 0,
        percent: null,
        target: 90,
        met: null,
        live: { targeted: 6, acknowledged: 1, percent: 16.7 },
      });
      // Once their time has run out, they count.
      const first = (await get(w.cookie, `/documents/${ids[0]}`).expect(200)).body.published.id as string;
      await bench.owner.db.execute(sql`update document_acknowledgements set due_on = current_date - 10 where version_id = ${first}`);
      summary = (await get(w.cookie, '/summary').expect(200)).body;
      expect(summary.acknowledgement).toMatchObject({ targeted: 6, acknowledged: 1, percent: 16.7, met: false });
      // Of six people due, one has not yet run out of time: five are counted.
      await bench.owner.db.execute(sql`update document_acknowledgements set due_on = current_date + 1 where version_id = ${first} and user_id = ${r2.id}`);
      summary = (await get(w.cookie, '/summary').expect(200)).body;
      expect(summary.acknowledgement).toMatchObject({ targeted: 5, acknowledged: 1, percent: 20, live: { targeted: 6 } });
      expect((await get(r2.cookie, '/summary').expect(200)).body).toMatchObject({
        awaitingMyAcknowledgement: 1,
        pastReview: { count: 1, of: 4 },
        acknowledgement: null,
      });
      expect((await get(r1.cookie, '/summary').expect(200)).body.awaitingMyAcknowledgement).toBe(0);
    }, 120_000);
  });

  describe('the module switched off', () => {
    let off: Hospital;
    let offWriter: Staff;
    let offReader: Staff;
    let doc: { id: string };
    let version: { id: string; revision: number };
    let plan: { id: string };
    let everything: string;

    beforeAll(async () => {
      off = await bench.createHospital('off');
      const f = await bench.createUnit(off, 'facility', 'F', null);
      await bench.createRole(off, 'writer', ['policies.view', 'policies.manage']);
      offWriter = await staff(off, 'owriter', 'writer', f);
      const q = await staff(off, 'oquality', 'quality_officer', null);
      const ap = await staff(off, 'oapprover', ['administrator', 'approving_authority'], null);
      offReader = await staff(off, 'oreader', 'reporter', f);
      const t = Object.fromEntries((await get(off.cookie, '/types').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
      const cat = Object.fromEntries((await get(off.cookie, '/categories').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
      const published = await approvedIn(off, offWriter, q, ap, { ownerUnitId: f, acknowledgementRequired: true }, t, cat);
      await post(offWriter.cookie, `/documents/${published.doc.id}/versions/${published.version.id}/publish`, {
        revision: published.version.revision,
      }).expect(200);
      const scheduled = await approvedIn(off, offWriter, q, ap, { ownerUnitId: f }, t, cat);
      doc = scheduled.doc;
      version = scheduled.version;
      await post(offWriter.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, {
        revision: version.revision,
        effectiveOn: shiftDay(dayOf(new Date(), 'UTC'), 1),
      }).expect(200);
      everything = (
        await http().get(`/platform/tenants/${off.id}/subscription`).set('Cookie', bench.platform).expect(200)
      ).body.plan.id;
      plan = (
        await http()
          .post('/platform/plans')
          .set('Cookie', bench.platform)
          .send({
            code: `${bench.prefix}-incidents`,
            name: { en: 'Incidents', ar: 'الحوادث', fr: 'Incidents' },
            modules: ['incidents'],
            limits: NO_LIMITS,
            extras: NO_EXTRAS,
          })
          .expect(201)
      ).body;
      await http()
        .patch(`/platform/tenants/${off.id}/subscription`)
        .set('Cookie', bench.platform)
        .send({ planId: plan.id })
        .expect(200);
    }, 120_000);

    it('answers every route of the module exactly as a route that does not exist', async () => {
      const module = [...bench.app.get(ModulesContainer).values()].find((m) => m.metatype === PoliciesModule)!;
      let walked = 0;
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as unknown as { prototype: Record<string, unknown> };
        const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = controller.prototype[name];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          if (method === undefined) continue;
          const path = `/${base}/${Reflect.getMetadata(PATH_METADATA, handler) as string}`
            .replace(':id', randomUUID())
            .replace(':versionId', randomUUID());
          const verb = RequestMethod[method].toLowerCase() as 'get';
          const res = await http()[verb](path).set('Cookie', offWriter.cookie).send({});
          expect({ path, status: res.status, body: res.body }).toEqual({
            path,
            status: 404,
            body: { message: `Cannot ${RequestMethod[method]} ${path}`, error: 'Not Found', statusCode: 404 },
          });
          walked++;
        }
      }
      expect(walked).toBeGreaterThanOrEqual(30);
    });

    it('drops its permissions from the session, hides its notifications, and is skipped by the check', async () => {
      const me = (await http().get('/auth/me').set('Cookie', offWriter.cookie).expect(200)).body;
      expect(me.tenant.modules).toEqual(['incidents']);
      expect(me.permissions.filter((p: string) => p.startsWith('policies.'))).toEqual([]);
      expect(Object.keys(me.scope).filter((p) => p.startsWith('policies.'))).toEqual([]);
      const kept = await bench.owner.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.userId, offReader.id));
      expect(kept.length).toBeGreaterThan(0);
      const shown = (await http().get('/notifications').set('Cookie', offReader.cookie).expect(200)).body;
      expect(shown.total).toBe(0);
      expect((await http().get('/notifications/count').set('Cookie', offReader.cookie).expect(200)).body.unread).toBe(0);
      await runCheck(new Date(Date.now() + 30 * DAY), off);
      const [still] = await bench.owner.db
        .select({ status: documentVersions.status })
        .from(documentVersions)
        .where(eq(documentVersions.id, version.id));
      expect(still.status).toBe('approved');
    });

    it('comes back whole when switched on again, and the check catches up', async () => {
      await http()
        .patch(`/platform/tenants/${off.id}/subscription`)
        .set('Cookie', bench.platform)
        .send({ planId: everything })
        .expect(200);
      const me = (await http().get('/auth/me').set('Cookie', offWriter.cookie).expect(200)).body;
      expect(me.permissions).toEqual(expect.arrayContaining(['policies.view', 'policies.manage']));
      expect((await http().get('/notifications').set('Cookie', offReader.cookie).expect(200)).body.total).toBeGreaterThan(0);
      await runCheck(new Date(Date.now() + 2 * DAY), off);
      const [now] = await bench.owner.db
        .select({ status: documentVersions.status })
        .from(documentVersions)
        .where(eq(documentVersions.id, version.id));
      expect(now.status).toBe('published');
      const [record] = await bench.owner.db.select({ status: documents.status }).from(documents).where(eq(documents.id, doc.id));
      expect(record.status).toBe('active');
    });
  });

  describe('a suspended subscription', () => {
    it('leaves acknowledging, publishing and retiring open, makes everything else in the module read-only, and offers only what is open', async () => {
      const h = await bench.createHospital('susp');
      const f = await bench.createUnit(h, 'facility', 'F', null);
      await bench.createRole(h, 'writer', ['policies.view', 'policies.manage']);
      const w = await staff(h, 'swriter', 'writer', f);
      const q = await staff(h, 'squality', 'quality_officer', null);
      const ap = await staff(h, 'sapprover', ['administrator', 'approving_authority'], null);
      const r = await staff(h, 'sreader', 'reporter', f);
      const t = Object.fromEntries((await get(h.cookie, '/types').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
      const cat = Object.fromEntries((await get(h.cookie, '/categories').expect(200)).body.map((x: { code: string; id: string }) => [x.code, x.id]));
      const { doc, version } = await approvedIn(h, w, q, ap, { ownerUnitId: f, acknowledgementRequired: true }, t, cat);
      const live = (
        await post(w.cookie, `/documents/${doc.id}/versions/${version.id}/publish`, { revision: version.revision }).expect(200)
      ).body;
      const pending = await approvedIn(h, w, q, ap, { ownerUnitId: f }, t, cat);
      await http()
        .patch(`/platform/tenants/${h.id}/subscription`)
        .set('Cookie', bench.platform)
        .send({ status: 'suspended' })
        .expect(200);
      const refused = async (res: { status: number; body: { code?: string } }) => {
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'subscription_suspended' });
      };
      const current = (await get(w.cookie, `/documents/${doc.id}`).expect(200)).body;
      await refused(await post(w.cookie, '/documents', { typeId: t.policy, categoryId: cat.GOV, title: { en: 'x' }, ownerId: w.id, ownerUnitId: f }));
      await refused(await patch(w.cookie, `/types/${t.policy}`, { active: false, revision: 1 }));
      await refused(await patch(w.cookie, `/documents/${doc.id}`, { keywords: ['x'], revision: current.revision }));
      await refused(await post(w.cookie, `/documents/${doc.id}/review`, { password, comment: 'x', revision: current.revision }));
      await refused(await post(w.cookie, `/documents/${pending.doc.id}/versions/${pending.version.id}/withdraw`, { reason: 'x', revision: pending.version.revision }));
      // What is offered is what stays open: no edit, review or withdrawal.
      expect(current.moves).toEqual(['retire']);
      const waiting = (await get(w.cookie, `/documents/${pending.doc.id}/versions/${pending.version.id}`).expect(200)).body;
      expect(waiting.moves).toEqual(['publish']);
      // Reading goes on.
      await get(r.cookie, `/documents/${doc.id}`).expect(200);
      await get(w.cookie, '/summary').expect(200);
      // Acknowledging stays open: reading and confirming what applies to oneself.
      const toAcknowledge = (await get(r.cookie, `/documents/${doc.id}/versions/${live.id}`).expect(200)).body;
      expect(toAcknowledge.moves).toEqual(['acknowledge']);
      await post(r.cookie, `/documents/${doc.id}/versions/${live.id}/acknowledge`, { password }).expect(200);
      const asked = await bench.owner.db
        .select({ at: documentAcknowledgements.acknowledgedAt })
        .from(documentAcknowledgements)
        .where(and(eq(documentAcknowledgements.versionId, live.id), inArray(documentAcknowledgements.userId, [r.id])));
      expect(asked[0].at).not.toBeNull();
      // Publishing an approved version stays open: a corrected document
      // goes in force. And retiring: an unsafe one is taken from readers.
      const out = (
        await post(w.cookie, `/documents/${pending.doc.id}/versions/${pending.version.id}/publish`, { revision: pending.version.revision }).expect(200)
      ).body;
      expect(out.status).toBe('published');
      const retired = (
        await post(w.cookie, `/documents/${doc.id}/retire`, { reason: 'Unsafe, replaced.', revision: current.revision }).expect(200)
      ).body;
      expect(retired.status).toBe('retired');
    }, 120_000);
  });
});
