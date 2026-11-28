import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { ActionCheck } from '../src/actions/action-check.service.js';
import { createDatabase } from '../src/database/client.js';
import {
  actions,
  auditLog,
  documentCategories,
  documents,
  documentTypes,
  documentVersions,
  emailQueue,
  notifications,
  plans,
  riskEvents,
  risks,
} from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { EmailWorker } from '../src/email/email-worker.service.js';
import { requireEnv } from '../src/env.js';
import { dayOf, shiftDay } from '../src/i18n/time-zones.js';
import { RiskCheck } from '../src/risks/risk-check.service.js';
import { testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

const NO_LIMITS = { users: null, sites: null, storageMb: null, aiCreditsPerMonth: null };
const NO_EXTRAS = { sso: false, publicReporting: false, clinicalAiSuggestions: false };

/**
 * Risk management, steps 3 to 5 (docs/specs/risk-management.md) and the
 * shared actions engine (docs/specs/actions.md): reviews and the risk
 * check, actions with their reminders and the overdue measure, escalation
 * and committees, the digest and the emails; and the fixes of security
 * review 15. Each route answers 401 without a session, 403 without the
 * right, 404 for another client's record, 400 for what it does not take.
 */
describe('risk management: reviews, actions, escalation', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  let check: RiskCheck;
  let actionCheck: ActionCheck;

  let h: Hospital;
  let other: Hospital;
  let facility: string;
  let d1: string;
  let d2: string;
  let quality: Staff;
  let d1Manager: Staff;
  let viewer: Staff;
  let owner: Staff;
  let doer: Staff;
  let member: Staff;
  let otherQuality: Staff;
  let categories: Record<string, string>;
  let committees: Record<string, string>;

  const as = (who: { cookie: string }) => ({
    get: (url: string) => http().get(url).set('Cookie', who.cookie),
    post: (url: string) => http().post(url).set('Cookie', who.cookie),
    patch: (url: string) => http().patch(url).set('Cookie', who.cookie),
  });
  const today = () => dayOf(new Date(), 'UTC');
  // Put into text people write, to show it reaches neither the trail nor
  // the timeline.
  const secret = `Mrs-X-${run}`;

  type Risk = { id: string; reference: string; revision: number; nextReviewOn: string; moves: string[]; [k: string]: unknown };
  const riskBody = (extra: Record<string, unknown> = {}) => ({
    orgUnitId: d1,
    categoryId: categories.people_safety,
    title: { en: `A risk of the work spec ${run}` },
    cause: { en: 'Something wears out.' },
    event: { en: 'It fails while in use.' },
    consequence: { en: 'A service stops.' },
    ownerId: owner.id,
    inherent: { likelihood: 4, impact: 3 },
    current: { likelihood: 2, impact: 3 },
    ...extra,
  });
  const create = async (extra: Record<string, unknown> = {}, who: Staff = d1Manager): Promise<Risk> =>
    (await as(who).post('/risks').send(riskBody(extra)).expect(201)).body;
  const fresh = async (id: string, who: { cookie: string } = quality): Promise<Risk> =>
    (await as(who).get(`/risks/${id}`).expect(200)).body;
  const noticesOf = (userId: string, kind: string, about?: { riskId?: string; actionId?: string }) =>
    bench.owner.db
      .select({ id: notifications.id, data: notifications.data })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          sql`${notifications.kind}::text = ${kind}`,
          about?.riskId ? eq(notifications.riskId, about.riskId) : undefined,
          about?.actionId ? eq(notifications.actionId, about.actionId) : undefined,
        ),
      );
  const auditOf = (action: string, entityId: string) =>
    bench.owner.db
      .select({ changes: auditLog.changes, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
  const setRisk = (id: string, values: Partial<typeof risks.$inferInsert>) =>
    bench.owner.db.update(risks).set(values).where(eq(risks.id, id));

  beforeAll(async () => {
    bench = await testBench('rw', run);
    check = bench.app.get(RiskCheck, { strict: false });
    actionCheck = bench.app.get(ActionCheck, { strict: false });
    h = await bench.createHospital('main');
    other = await bench.createHospital('other');
    facility = await bench.createUnit(h, 'facility', 'F', null);
    d1 = await bench.createUnit(h, 'department', 'D1', facility);
    d2 = await bench.createUnit(h, 'department', 'D2', facility);
    await bench.createRole(h, 'risk_reader', ['risks.view']);
    // A committee's role need hold no permission of the module.
    await bench.createRole(h, 'committee_member', ['incidents.report']);
    quality = await bench.createStaff(h, 'quality', { role: 'quality_officer', orgUnitId: null });
    d1Manager = await bench.createStaff(h, 'd1manager', { role: 'department_manager', orgUnitId: d1 });
    viewer = await bench.createStaff(h, 'viewer', { role: 'risk_reader', orgUnitId: d2 });
    owner = await bench.createStaff(h, 'owner', { role: 'reporter', orgUnitId: null });
    doer = await bench.createStaff(h, 'doer', { role: 'reporter', orgUnitId: null });
    member = await bench.createStaff(h, 'member', { role: 'committee_member', orgUnitId: null });
    otherQuality = await bench.createStaff(other, 'otherquality', { role: 'quality_officer', orgUnitId: null });
    const settings = (await as(h).get('/risks/settings').expect(200)).body;
    categories = Object.fromEntries(settings.categories.map((c: { code: string; id: string }) => [c.code, c.id]));
    committees = Object.fromEntries(settings.committees.map((c: { code: string; id: string }) => [c.code, c.id]));
    // The risk committee's members hold `committee_member` for the whole
    // organization; the governing body has no role yet.
    await as(quality)
      .patch(`/risks/settings/committees/${committees.risk_committee}`)
      .send({ revision: 1, memberRoleId: h.roles.committee_member })
      .expect(200);
  }, 120_000);

  afterAll(() => bench.close());

  describe('without a session', () => {
    it('answers 401 on every new route', async () => {
      const id = randomUUID();
      for (const [method, url] of [
        ['get', '/risks/mine'],
        ['get', '/risks/reviews'],
        ['get', '/risks/summary'],
        ['get', `/risks/committees/${id}/risks`],
        ['get', `/risks/actions/${id}`],
        ['patch', `/risks/actions/${id}`],
        ['post', `/risks/actions/${id}/complete`],
        ['post', `/risks/actions/${id}/verify`],
        ['post', `/risks/actions/${id}/cancel`],
        ['post', `/risks/actions/${id}/reopen`],
        ['post', `/risks/actions/${id}/corrections`],
        ['post', `/risks/${id}/reviews`],
        ['post', `/risks/${id}/escalate`],
        ['post', `/risks/${id}/de-escalate`],
        ['post', `/risks/${id}/corrections`],
        ['get', `/risks/${id}/actions`],
        ['post', `/risks/${id}/actions`],
      ] as const) {
        await http()[method](url).send({}).expect(401);
      }
    });
  });

  describe('reviews', () => {
    let risk: Risk;
    beforeAll(async () => {
      risk = await create();
    });

    it('are recorded by the owner, with a new rating, the next review from the band, and the trail without the comment', async () => {
      const reviewed = await as(owner)
        .post(`/risks/${risk.id}/reviews`)
        .send({ revision: risk.revision, outcome: 'no_change', comment: `Checked with ${secret}: nothing new.`, current: { likelihood: 2, impact: 3 } })
        .expect(200);
      expect(reviewed.body.reviews).toHaveLength(1);
      expect(reviewed.body.reviews[0]).toMatchObject({ outcome: 'no_change', reviewedBy: owner.id, late: false, committeeId: null });
      // Medium: 180 days.
      expect(reviewed.body).toMatchObject({ lastReviewedOn: today(), nextReviewOn: shiftDay(today(), 180) });
      expect(reviewed.body.ratings[0]).toMatchObject({ kind: 'current', reviewId: reviewed.body.reviews[0].id });
      const [entry] = await auditOf('risk_reviewed', risk.id);
      expect(entry.changes).toMatchObject({ outcome: 'no_change', late: false, reviewId: reviewed.body.reviews[0].id });
      expect(JSON.stringify(entry.changes)).not.toContain(secret);
      expect(JSON.stringify(reviewed.body.events)).not.toContain(secret);
      risk = reviewed.body;
    });

    it('refuses what does not hold together, an out-of-date revision, and anyone without a place', async () => {
      const mismatch = await as(owner)
        .post(`/risks/${risk.id}/reviews`)
        .send({ revision: risk.revision, outcome: 'no_change', comment: 'x', current: { likelihood: 3, impact: 3 } })
        .expect(400);
      expect(mismatch.body.code).toBe('outcome_mismatch');
      const tooLong = await as(owner)
        .post(`/risks/${risk.id}/reviews`)
        .send({ revision: risk.revision, outcome: 're_rated', comment: 'x', current: { likelihood: 1, impact: 3 }, nextReviewOn: shiftDay(today(), 400) })
        .expect(400);
      expect(tooLong.body).toMatchObject({ code: 'review_interval_too_long', latest: shiftDay(today(), 365) });
      await as(owner).post(`/risks/${risk.id}/reviews`).send({ revision: risk.revision, outcome: 'no_change' }).expect(400);
      const old = await as(owner)
        .post(`/risks/${risk.id}/reviews`)
        .send({ revision: risk.revision - 1, outcome: 'no_change', comment: 'x', current: { likelihood: 2, impact: 3 } })
        .expect(409);
      expect(old.body.code).toBe('stale_risk');
      await as(viewer).post(`/risks/${risk.id}/reviews`).send({ revision: risk.revision, outcome: 'no_change', comment: 'x', current: { likelihood: 2, impact: 3 } }).expect(404);
      await as(otherQuality).post(`/risks/${risk.id}/reviews`).send({ revision: risk.revision, outcome: 'no_change', comment: 'x', current: { likelihood: 2, impact: 3 } }).expect(404);
      const early = await as(owner)
        .post(`/risks/${risk.id}/reviews`)
        .send({ revision: risk.revision, outcome: 're_rated', comment: 'Better', current: { likelihood: 1, impact: 3 }, nextReviewOn: shiftDay(today(), 20) })
        .expect(200);
      expect(early.body.nextReviewOn).toBe(shiftDay(today(), 20));
      risk = early.body;
    });

    it('are listed as due and overdue for managers of the unit, not for others', async () => {
      await setRisk(risk.id, { nextReviewOn: shiftDay(today(), -3) });
      const overdue = (await as(d1Manager).get('/risks/reviews?state=overdue').expect(200)).body;
      expect(overdue.items.map((r: { id: string }) => r.id)).toContain(risk.id);
      expect(overdue.items.find((r: { id: string }) => r.id === risk.id).review).toBe('overdue');
      await as(owner).get('/risks/reviews').expect(403);
      expect((await as(viewer).get('/risks/reviews').expect(403)).body.code).toBe('missing_permission');
      expect((await as(otherQuality).get('/risks/reviews').expect(200)).body.total).toBe(0);
      await as(d1Manager).get('/risks/reviews?state=soon').expect(400);
      // Made late: the next review says so.
      const late = await as(owner)
        .post(`/risks/${risk.id}/reviews`)
        .send({ revision: (await fresh(risk.id)).revision, outcome: 'no_change', comment: 'Late, but done.', current: { likelihood: 1, impact: 3 } })
        .expect(200);
      expect(late.body.reviews[0].late).toBe(true);
      // "My risks": the owner's, review first.
      const mine = (await as(owner).get('/risks/mine').expect(200)).body;
      expect(mine.risks.map((r: { id: string }) => r.id)).toContain(risk.id);
      expect(mine.steps).toEqual([]);
    });
  });

  describe('the risk check', () => {
    it('reminds the owner before a review and the unit’s managers after it, each once, with any number of processes', async () => {
      const due = await create();
      const overdue = await create();
      await setRisk(due.id, { nextReviewOn: shiftDay(today(), 5) });
      await setRisk(overdue.id, { nextReviewOn: shiftDay(today(), -1) });
      await Promise.all([check.run(new Date(), [h.id]), check.run(new Date(), [h.id])]);
      await check.run(new Date(), [h.id]);
      expect(await noticesOf(owner.id, 'risk_review_due', { riskId: due.id })).toHaveLength(1);
      expect(await noticesOf(owner.id, 'risk_review_overdue', { riskId: overdue.id })).toHaveLength(1);
      expect(await noticesOf(d1Manager.id, 'risk_review_overdue', { riskId: overdue.id })).toHaveLength(1);
      expect(await noticesOf(quality.id, 'risk_review_overdue', { riskId: overdue.id })).toHaveLength(1);
      expect(await noticesOf(d1Manager.id, 'risk_review_due', { riskId: due.id })).toHaveLength(0);
      const [notice] = await noticesOf(owner.id, 'risk_review_due', { riskId: due.id });
      expect(notice.data).toEqual({ reference: due.reference, serious: false, dueOn: shiftDay(today(), 5) });
      // A new review day gives new reminders.
      await setRisk(due.id, { nextReviewOn: shiftDay(today(), 2) });
      await check.run(new Date(), [h.id]);
      expect(await noticesOf(owner.id, 'risk_review_due', { riskId: due.id })).toHaveLength(2);
    });

    it('sends the weekly email to managers once a week, with counts only', async () => {
      await Promise.all([check.run(new Date(), [h.id]), check.run(new Date(), [h.id])]);
      const digests = await noticesOf(d1Manager.id, 'risks_overdue_digest');
      expect(digests).toHaveLength(1);
      expect(digests[0].data).toMatchObject({ serious: false, reviewsOverdue: expect.any(Number), actionsOverdue: expect.any(Number) });
      expect(Number(digests[0].data.reviewsOverdue)).toBeGreaterThan(0);
      const queued = await bench.owner.db
        .select({ category: emailQueue.category })
        .from(emailQueue)
        .where(eq(emailQueue.notificationId, digests[0].id));
      expect(queued).toEqual([{ category: 'weekly_digest' }]);
      // The owner manages nothing: no digest.
      expect(await noticesOf(owner.id, 'risks_overdue_digest')).toHaveLength(0);
    });

    it('works on the client’s calendar, skips a client without the module and catches up once it is back', async () => {
      const far = await bench.createHospital('kiritimati', { timeZone: 'Pacific/Kiritimati' });
      const unit = await bench.createUnit(far, 'facility', 'K', null);
      const farOwner = await bench.createStaff(far, 'farowner', { role: 'reporter', orgUnitId: null });
      const farCategories = (await as(far).get('/risks/settings/categories').expect(200)).body;
      const farRisk = (
        await as(far)
          .post('/risks')
          .send({ ...riskBody(), orgUnitId: unit, categoryId: farCategories[0].id, ownerId: farOwner.id })
          .expect(201)
      ).body as Risk;
      // At noon UTC it is already the next day at UTC+14: a review due on
      // the UTC day is overdue there.
      const now = new Date(`${shiftDay(today(), 10)}T12:00:00Z`);
      await setRisk(farRisk.id, { nextReviewOn: shiftDay(today(), 10) });
      const plan = await http()
        .post('/platform/plans')
        .set('Cookie', bench.platform)
        .send({ code: `${bench.prefix}-norisk`, name: { en: 'No risks', ar: 'بلا مخاطر', fr: 'Sans risques' }, modules: ['incidents'], limits: NO_LIMITS, extras: NO_EXTRAS })
        .expect(201);
      const [everything] = await bench.owner.db.select({ id: plans.id }).from(plans).where(eq(plans.code, 'everything'));
      await http().patch(`/platform/tenants/${far.id}/subscription`).set('Cookie', bench.platform).send({ planId: plan.body.id }).expect(200);
      await check.run(now, [far.id]);
      expect(await noticesOf(farOwner.id, 'risk_review_overdue', { riskId: farRisk.id })).toHaveLength(0);
      await http()
        .patch(`/platform/tenants/${far.id}/subscription`)
        .set('Cookie', bench.platform)
        .send({ planId: everything.id })
        .expect(200);
      await check.run(now, [far.id]);
      await check.run(now, [far.id]);
      expect(await noticesOf(farOwner.id, 'risk_review_overdue', { riskId: farRisk.id })).toHaveLength(1);
      // The same moment on a UTC client is the review's own day: due, not overdue.
      expect(dayOf(now, 'Pacific/Kiritimati')).toBe(shiftDay(today(), 11));
    });
  });

  describe('actions on risks', () => {
    let risk: Risk;
    let action: { id: string; reference: string; revision: number; dueOn: string };

    beforeAll(async () => {
      risk = await create();
    });

    it('are added by the owner or a manager, assigned with a notice, and refused otherwise', async () => {
      const body = {
        revision: risk.revision,
        title: { en: 'Replace the worn part' },
        ownerId: doer.id,
        dueOn: shiftDay(today(), 20),
        strength: 'stronger',
      };
      await as(viewer).post(`/risks/${risk.id}/actions`).send(body).expect(404);
      await as(otherQuality).post(`/risks/${risk.id}/actions`).send(body).expect(404);
      await as(doer).post(`/risks/${risk.id}/actions`).send(body).expect(404);
      await as(owner).post(`/risks/${risk.id}/actions`).send({ ...body, strength: 'strong' }).expect(400);
      await as(owner).post(`/risks/${risk.id}/actions`).send({ ...body, extra: 1 }).expect(400);
      const past = await as(owner).post(`/risks/${risk.id}/actions`).send({ ...body, dueOn: shiftDay(today(), -1) }).expect(400);
      expect(past.body.code).toBe('due_in_past');
      const added = await as(owner).post(`/risks/${risk.id}/actions`).send(body).expect(201);
      expect(added.body).toMatchObject({
        status: 'open',
        ownerId: doer.id,
        orgUnitId: d1,
        dueOn: body.dueOn,
        originalDueOn: body.dueOn,
        riskRevision: risk.revision + 1,
        editable: 'all',
      });
      expect(added.body.reference).toMatch(/^ACT-\d{4}-\d{5}$/);
      action = added.body;
      expect(await noticesOf(doer.id, 'action_assigned', { actionId: action.id })).toHaveLength(1);
      const listed = (await as(quality).get(`/risks/${risk.id}/actions`).expect(200)).body;
      expect(listed.items.map((a: { id: string }) => a.id)).toEqual([action.id]);
      expect(listed.summary).toMatchObject({ open: 1, overdue: 0, allWeaker: false });
    });

    it('are read by their owner with the risk’s summary only, who moves the due day with a reason and completes it', async () => {
      const summary = (await as(doer).get(`/risks/${risk.id}`).expect(200)).body;
      expect(summary).toEqual({
        access: 'summary',
        id: risk.id,
        reference: risk.reference,
        title: risk.title,
        status: 'open',
        current: expect.objectContaining({ band: 'medium' }),
        moves: [],
        actions: [expect.objectContaining({ id: action.id, editable: 'progress', moves: ['edit', 'complete'] })],
      });
      // Not in the register.
      expect((await as(doer).get('/risks').expect(200)).body.total).toBe(0);
      const mine = (await as(doer).get('/risks/mine').expect(200)).body;
      expect(mine.actions).toEqual([expect.objectContaining({ id: action.id, risk: { id: risk.id, reference: risk.reference, title: risk.title, current: expect.any(Object) } })]);
      const titled = await as(doer).patch(`/risks/actions/${action.id}`).send({ revision: action.revision, title: { en: 'Mine now' } }).expect(403);
      expect(titled.body.code).toBe('missing_permission');
      const noReason = await as(doer).patch(`/risks/actions/${action.id}`).send({ revision: action.revision, dueOn: shiftDay(today(), 40) }).expect(400);
      expect(noReason.body.code).toBe('reason_required');
      const moved = await as(doer)
        .patch(`/risks/actions/${action.id}`)
        .send({ revision: action.revision, dueOn: shiftDay(today(), 40), status: 'in_progress', reason: `The part arrives late, ${secret}` })
        .expect(200);
      expect(moved.body).toMatchObject({ dueOn: shiftDay(today(), 40), originalDueOn: action.dueOn, dueMoved: true, status: 'in_progress' });
      const [due] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'action_due_changed'), eq(auditLog.entityId, action.id)));
      // The reason is a note on the action, named by its id (security review 17, L5).
      expect(due.changes).toEqual({ from: action.dueOn, to: shiftDay(today(), 40), noteId: expect.any(String), originalDueOn: action.dueOn });
      expect(JSON.stringify(due.changes)).not.toContain(secret);
      const stale = await as(doer).post(`/risks/actions/${action.id}/complete`).send({ revision: action.revision, note: 'Done' }).expect(409);
      expect(stale.body.code).toBe('stale_action');
      await as(doer).post(`/risks/actions/${action.id}/complete`).send({ revision: moved.body.revision }).expect(400);
      const done = await as(doer).post(`/risks/actions/${action.id}/complete`).send({ revision: moved.body.revision, note: 'Fitted the new part.' }).expect(200);
      expect(done.body).toMatchObject({ status: 'completed', completedBy: doer.id, completionNote: 'Fitted the new part.', moves: [] });
      expect(await noticesOf(owner.id, 'action_completed', { actionId: action.id })).toHaveLength(1);
      action = done.body;
      // The database keeps the first due day.
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      try {
        await expect(
          new TenantDb(app.db).withTenant(h.id, (tx) => tx.update(actions).set({ originalDueOn: shiftDay(today(), 99) }).where(eq(actions.id, action.id))),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
      } finally {
        await app.pool.end();
      }
    });

    it('are checked for effectiveness by someone other than their owner, and reopened or cancelled by a manager', async () => {
      // The risk's owner, who is also an action's owner, checks no action of their own.
      const theirs = await as(owner)
        .post(`/risks/${risk.id}/actions`)
        .send({ revision: (await fresh(risk.id)).revision, title: { en: 'Retrain the team' }, ownerId: owner.id, dueOn: shiftDay(today(), 10), strength: 'weaker' })
        .expect(201);
      const finished = await as(owner).post(`/risks/actions/${theirs.body.id}/complete`).send({ revision: theirs.body.revision, note: 'Trained.' }).expect(200);
      const same = await as(owner).post(`/risks/actions/${theirs.body.id}/verify`).send({ revision: finished.body.revision, outcome: 'effective' }).expect(403);
      expect(same.body.code).toBe('same_person');
      await as(doer).post(`/risks/actions/${action.id}/verify`).send({ revision: action.revision, outcome: 'effective' }).expect(403);
      const verified = await as(owner).post(`/risks/actions/${action.id}/verify`).send({ revision: action.revision, outcome: 'not_effective' }).expect(200);
      expect(verified.body).toMatchObject({ status: 'verified', effectiveness: 'not_effective', verifiedBy: owner.id });
      await as(owner).post(`/risks/actions/${action.id}/reopen`).send({ revision: verified.body.revision }).expect(400);
      const reopened = await as(d1Manager).post(`/risks/actions/${action.id}/reopen`).send({ revision: verified.body.revision, reason: 'It did not work.' }).expect(200);
      expect(reopened.body.status).toBe('open');
      const cancelled = await as(d1Manager).post(`/risks/actions/${action.id}/cancel`).send({ revision: reopened.body.revision, reason: `Replaced by another, ${secret}` }).expect(200);
      expect(cancelled.body.status).toBe('cancelled');
      const entries = await bench.owner.db
        .select({ action: auditLog.action, changes: auditLog.changes })
        .from(auditLog)
        .where(eq(auditLog.entityId, action.id));
      expect(entries.map((e) => e.action)).toEqual(
        expect.arrayContaining(['action_created', 'action_due_changed', 'action_completed', 'action_verified', 'action_reopened', 'action_cancelled']),
      );
      expect(JSON.stringify(entries)).not.toContain(secret);
      // A note is corrected by a manager, audited without the text.
      // Its owner no longer reads a cancelled action (security review 17, L6).
      await as(doer).post(`/risks/actions/${action.id}/corrections`).send({ revision: cancelled.body.revision, field: 'cancelReason', text: 'Replaced.' }).expect(404);
      const corrected = await as(d1Manager)
        .post(`/risks/actions/${action.id}/corrections`)
        .send({ revision: cancelled.body.revision, field: 'cancelReason', text: 'Replaced.' })
        .expect(200);
      expect(corrected.body.cancelReason).toBe('Replaced.');
      const timeline = (await as(quality).get(`/risks/actions/${action.id}`).expect(200)).body.events;
      expect(timeline.at(-1)).toMatchObject({ kind: 'text_corrected', details: { field: 'cancelReason' } });
      expect(JSON.stringify(timeline)).not.toContain(secret);
      // Another client's action is unknown here.
      const theirRisk = (
        await as(otherQuality)
          .post('/risks')
          .send({
            ...riskBody(),
            orgUnitId: null,
            categoryId: (await as(other).get('/risks/settings/categories').expect(200)).body[0].id,
            ownerId: otherQuality.id,
          })
          .expect(201)
      ).body as Risk;
      const theirAction = (
        await as(otherQuality)
          .post(`/risks/${theirRisk.id}/actions`)
          .send({ revision: theirRisk.revision, title: { en: 'Theirs' }, ownerId: otherQuality.id, dueOn: shiftDay(today(), 5), strength: 'intermediate' })
          .expect(201)
      ).body;
      await as(quality).get(`/risks/actions/${theirAction.id}`).expect(404);
      await as(quality).post(`/risks/actions/${theirAction.id}/complete`).send({ revision: 1, note: 'x' }).expect(404);
    });

    it('make a risk above tolerance "being treated", and are counted overdue by the measure', async () => {
      const above = await create({ inherent: { likelihood: 4, impact: 3 }, current: { likelihood: 3, impact: 3 }, target: { likelihood: 2, impact: 2 }, treatment: 'reduce' });
      expect(above).toMatchObject({ standing: 'above_not_addressed' });
      expect(await noticesOf(owner.id, 'risk_above_tolerance', { riskId: above.id })).toHaveLength(1);
      const added = await as(owner)
        .post(`/risks/${above.id}/actions`)
        .send({ revision: above.revision, title: { en: 'Fix it' }, ownerId: doer.id, dueOn: shiftDay(today(), 3), strength: 'intermediate' })
        .expect(201);
      expect((await fresh(above.id)).standing).toBe('above_treated');
      const notAddressed = (await as(quality).get('/risks?notAddressed=true&pageSize=100').expect(200)).body.items.map((r: { id: string }) => r.id);
      expect(notAddressed).not.toContain(above.id);
      expect((await as(quality).get('/risks?aboveTolerance=true&pageSize=100').expect(200)).body.items.map((r: { id: string }) => r.id)).toContain(above.id);
      const before = (await as(quality).get('/risks/summary').expect(200)).body.overdueActions;
      await bench.owner.db.update(actions).set({ dueOn: shiftDay(today(), -2) }).where(eq(actions.id, added.body.id));
      const after = (await as(quality).get('/risks/summary').expect(200)).body;
      expect(after.overdueActions).toMatchObject({ code: 'actions.overdue', count: before.count + 1, of: before.of, target: 10 });
      expect(after.overdueActions.percent).toBeGreaterThan(0);
      // Out of the reader's reach, the actions are not counted.
      expect((await as(viewer).get('/risks/summary').expect(200)).body.overdueActions.of).toBe(0);
      expect((await as(otherQuality).get('/risks/summary').expect(200)).body.overdueActions.count).toBe(0);
    });

    it('are reminded by the action check: due soon, overdue and escalated, each once', async () => {
      const r = await create();
      const soon = (await as(owner).post(`/risks/${r.id}/actions`).send({ revision: r.revision, title: { en: 'Soon' }, ownerId: doer.id, dueOn: shiftDay(today(), 3), strength: 'weaker' }).expect(201)).body;
      const late = (await as(owner).post(`/risks/${r.id}/actions`).send({ revision: soon.riskRevision, title: { en: 'Late' }, ownerId: doer.id, dueOn: shiftDay(today(), 3), strength: 'weaker' }).expect(201)).body;
      await bench.owner.db.update(actions).set({ dueOn: shiftDay(today(), -20) }).where(eq(actions.id, late.id));
      await Promise.all([actionCheck.run(new Date(), [h.id]), actionCheck.run(new Date(), [h.id])]);
      await actionCheck.run(new Date(), [h.id]);
      expect(await noticesOf(doer.id, 'action_due_soon', { actionId: soon.id })).toHaveLength(1);
      expect(await noticesOf(doer.id, 'action_overdue', { actionId: late.id })).toHaveLength(1);
      expect(await noticesOf(owner.id, 'action_overdue', { actionId: late.id })).toHaveLength(1);
      expect(await noticesOf(d1Manager.id, 'action_escalated', { actionId: late.id })).toHaveLength(1);
      expect(await noticesOf(doer.id, 'action_escalated', { actionId: late.id })).toHaveLength(0);
      const [notice] = await noticesOf(doer.id, 'action_due_soon', { actionId: soon.id });
      expect(notice.data).toEqual({ reference: soon.reference, sourceReference: r.reference, serious: false, dueOn: shiftDay(today(), 3) });
    });
  });

  describe('escalation', () => {
    it('is automatic in the rating’s transaction, once, and never down to a lower committee', async () => {
      const r = await create({ current: { likelihood: 2, impact: 3 }, target: { likelihood: 1, impact: 2 } });
      const high = await as(owner).post(`/risks/${r.id}/ratings`).send({ revision: r.revision, kind: 'current', likelihood: 3, impact: 4 }).expect(200);
      expect(high.body.escalatedToCommitteeId).toBe(committees.risk_committee);
      expect(high.body.events.at(-1)).toMatchObject({ kind: 'escalated', details: { committeeId: committees.risk_committee, automatic: true, band: 'high' } });
      // The committee's member is told, in the app; not emailed, as it is not Extreme.
      const [toMember] = await noticesOf(member.id, 'risk_escalated', { riskId: r.id });
      expect(toMember.data).toMatchObject({ reference: r.reference, serious: true, automatic: true, band: 'high' });
      expect(await bench.owner.db.select().from(emailQueue).where(eq(emailQueue.notificationId, toMember.id))).toEqual([]);
      // No repeat at the same level.
      const again = await as(owner).post(`/risks/${r.id}/ratings`).send({ revision: high.body.revision, kind: 'current', likelihood: 4, impact: 3 }).expect(200);
      expect(again.body.events.filter((e: { kind: string }) => e.kind === 'escalated')).toHaveLength(1);
      // Extreme: to the governing body, which has no role yet, so its
      // notices go to the managers for the whole organization; emailed at once.
      const extreme = await as(owner).post(`/risks/${r.id}/ratings`).send({ revision: again.body.revision, kind: 'current', likelihood: 4, impact: 4 }).expect(200);
      expect(extreme.body.escalatedToCommitteeId).toBe(committees.governing_body);
      const [toQuality] = await noticesOf(quality.id, 'risk_escalated', { riskId: r.id });
      expect(toQuality.data).toMatchObject({ band: 'extreme' });
      expect(
        (await bench.owner.db.select({ category: emailQueue.category }).from(emailQueue).where(eq(emailQueue.notificationId, toQuality.id))),
      ).toEqual([{ category: 'immediate' }]);
      // Rated High again, it stays before the higher committee.
      const back = await as(owner).post(`/risks/${r.id}/ratings`).send({ revision: extreme.body.revision, kind: 'current', likelihood: 3, impact: 4 }).expect(200);
      expect(back.body.escalatedToCommitteeId).toBe(committees.governing_body);
      const [entry] = await auditOf('risk_escalated', r.id);
      expect(entry.changes).toMatchObject({ automatic: true });
    });

    it('gives the committee its list, read by its members by their place, and their review', async () => {
      const r = await create({ current: { likelihood: 3, impact: 4 }, target: { likelihood: 1, impact: 2 } });
      expect(r.escalatedToCommitteeId).toBe(committees.risk_committee);
      const list = (await as(member).get(`/risks/committees/${committees.risk_committee}/risks`).expect(200)).body;
      expect(list.items.map((x: { id: string }) => x.id)).toContain(r.id);
      expect(list.items[0]).toHaveProperty('lastReview');
      await as(member).get(`/risks/${r.id}`).expect(200);
      expect((await as(d1Manager).get(`/risks/committees/${committees.risk_committee}/risks`).expect(403)).body.code).toBe('missing_permission');
      await as(quality).get(`/risks/committees/${committees.risk_committee}/risks`).expect(200);
      const theirs = (await as(other).get('/risks/settings/committees').expect(200)).body[0].id;
      await as(quality).get(`/risks/committees/${theirs}/risks`).expect(404);
      // The committee's review, by a member.
      const now = await fresh(r.id, member);
      expect(now.moves).toEqual(['review']);
      await as(member).post(`/risks/${r.id}/reviews`).send({ revision: now.revision, outcome: 'no_change', comment: 'Seen', current: { likelihood: 3, impact: 4 } }).expect(403);
      const reviewed = await as(member)
        .post(`/risks/${r.id}/reviews`)
        .send({ revision: now.revision, outcome: 'no_change', comment: 'Seen at the committee.', current: { likelihood: 3, impact: 4 }, committeeId: committees.risk_committee })
        .expect(200);
      expect(reviewed.body.reviews[0]).toMatchObject({ committeeId: committees.risk_committee, reviewedBy: member.id });
      expect((await as(member).get('/risks/mine').expect(200)).body.committees).toEqual([
        expect.objectContaining({ id: committees.risk_committee, risks: expect.any(Number) }),
      ]);
    });

    it('comes down only below the threshold, by a member or a manager for the whole organization; by hand it needs a reason', async () => {
      const r = await create({ current: { likelihood: 3, impact: 4 }, target: { likelihood: 1, impact: 2 } });
      const above = await as(member).post(`/risks/${r.id}/de-escalate`).send({ revision: r.revision, reason: 'Done' }).expect(409);
      expect(above.body.code).toBe('still_above_threshold');
      const lower = await as(owner).post(`/risks/${r.id}/ratings`).send({ revision: r.revision, kind: 'current', likelihood: 2, impact: 3 }).expect(200);
      expect(lower.body.escalatedToCommitteeId).toBe(committees.risk_committee);
      await as(d1Manager).post(`/risks/${r.id}/de-escalate`).send({ revision: lower.body.revision, reason: 'Done' }).expect(403);
      await as(member).post(`/risks/${r.id}/de-escalate`).send({ revision: lower.body.revision }).expect(400);
      expect((await fresh(r.id, member)).moves).toEqual(['review', 'de_escalate']);
      const down = await as(member).post(`/risks/${r.id}/de-escalate`).send({ revision: lower.body.revision, reason: `Medium now, ${secret}` }).expect(200);
      // The member no longer reads it: told it is done, nothing more.
      expect(down.body).toEqual({ access: 'none', id: r.id, reference: r.reference, escalatedToCommitteeId: null });
      const afterDown = await fresh(r.id, d1Manager);
      expect(await noticesOf(owner.id, 'risk_de_escalated', { riskId: r.id })).toHaveLength(1);
      const [entry] = await auditOf('risk_de_escalated', r.id);
      expect(entry.changes).toEqual({ committeeId: committees.risk_committee, band: 'medium', noteId: expect.any(String) });
      // By hand, to any committee.
      await as(owner).post(`/risks/${r.id}/escalate`).send({ revision: afterDown.revision, committeeId: committees.risk_committee, reason: 'x' }).expect(403);
      const unknown = await as(d1Manager).post(`/risks/${r.id}/escalate`).send({ revision: afterDown.revision, committeeId: randomUUID(), reason: 'x' }).expect(400);
      expect(unknown.body.code).toBe('unknown_committee');
      const byHand = await as(d1Manager).post(`/risks/${r.id}/escalate`).send({ revision: afterDown.revision, committeeId: committees.risk_committee, reason: 'Wanted at the committee' }).expect(200);
      expect(byHand.body.events.at(-1)).toMatchObject({ kind: 'escalated', details: { automatic: false, noteId: expect.any(String) } });
      expect(byHand.body.notes.at(-1)).toMatchObject({ kind: 'escalation_reason', text: 'Wanted at the committee' });
      const twice = await as(d1Manager).post(`/risks/${r.id}/escalate`).send({ revision: byHand.body.revision, committeeId: committees.risk_committee, reason: 'Again' }).expect(409);
      expect(twice.body.code).toBe('already_escalated');
      expect(JSON.stringify(byHand.body.events)).not.toContain(secret);
    });
  });

  describe('the fixes of security review 15', () => {
    it('lets a manager correct a rationale, a comment or a reason, audited and in the timeline without the text', async () => {
      const r = await create({ current: { likelihood: 2, impact: 3, rationale: { en: `${secret} fell twice` } } });
      const rating = ((await fresh(r.id)).ratings as { kind: string; id: string }[]).find((x) => x.kind === 'current')!;
      await as(owner).post(`/risks/${r.id}/corrections`).send({ revision: r.revision, kind: 'rating_rationale', ratingId: rating.id, text: null }).expect(403);
      await as(d1Manager).post(`/risks/${r.id}/corrections`).send({ revision: r.revision, kind: 'rating_rationale', ratingId: randomUUID(), text: null }).expect(404);
      await as(d1Manager).post(`/risks/${r.id}/corrections`).send({ revision: r.revision, kind: 'something' }).expect(400);
      const corrected = await as(d1Manager)
        .post(`/risks/${r.id}/corrections`)
        .send({ revision: r.revision, kind: 'rating_rationale', ratingId: rating.id, text: { en: 'A fall in the corridor.' } })
        .expect(200);
      expect(corrected.body.ratings.find((x: { id: string }) => x.id === rating.id).rationale).toEqual({ en: 'A fall in the corridor.' });
      expect(corrected.body.events.at(-1)).toMatchObject({ kind: 'text_corrected', details: { kind: 'rating_rationale', ratingId: rating.id } });
      const [entry] = await auditOf('risk_text_corrected', r.id);
      expect(entry.changes).toEqual({ kind: 'rating_rationale', ratingId: rating.id });
      expect(JSON.stringify(corrected.body)).not.toContain(secret);
      // The application may change the rationale and nothing else of a rating.
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      try {
        await expect(
          new TenantDb(app.db).withTenant(h.id, (tx) => tx.execute(sql`update risk_ratings set score = 1 where id = ${rating.id}`)),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
      } finally {
        await app.pool.end();
      }
      // A review's comment.
      const reviewed = await as(owner)
        .post(`/risks/${r.id}/reviews`)
        .send({ revision: corrected.body.revision, outcome: 'no_change', comment: `Spoke to ${secret}`, current: { likelihood: 2, impact: 3 } })
        .expect(200);
      const fixed = await as(d1Manager)
        .post(`/risks/${r.id}/corrections`)
        .send({ revision: reviewed.body.revision, kind: 'review_comment', reviewId: reviewed.body.reviews[0].id, text: 'Spoke to the team.' })
        .expect(200);
      expect(fixed.body.reviews[0].comment).toBe('Spoke to the team.');
      expect(JSON.stringify(fixed.body)).not.toContain(secret);
      const none = await as(d1Manager).post(`/risks/${r.id}/corrections`).send({ revision: fixed.body.revision, kind: 'reject_reason', text: 'x' }).expect(409);
      expect(none.body.code).toBe('nothing_to_correct');
    });

    it('records only which text fields changed, never the text', async () => {
      const r = await create();
      const changed = await as(d1Manager)
        .patch(`/risks/${r.id}`)
        .send({ revision: r.revision, cause: { en: `${secret} in bed 12` }, keywords: [secret] })
        .expect(200);
      expect(changed.body.events.at(-1)).toMatchObject({ kind: 'updated', details: { cause: { changed: true }, keywords: { changed: true } } });
      const [entry] = await auditOf('risk_updated', r.id);
      expect(entry.changes).toEqual({ cause: { changed: true }, keywords: { changed: true } });
      expect(JSON.stringify(changed.body.events)).not.toContain(secret);
    });

    it('refuses a current rating below the target', async () => {
      const r = await create({ current: { likelihood: 3, impact: 2 }, target: { likelihood: 2, impact: 3 } });
      const below = await as(owner).post(`/risks/${r.id}/ratings`).send({ revision: r.revision, kind: 'current', likelihood: 1, impact: 2 }).expect(400);
      expect(below.body.code).toBe('target_above_current');
      expect(r).toMatchObject({ targetAboveCurrent: false });
    });

    it('gives the matrix preview to managers for the whole organization only, audits wording from and to, and holds twelve domains at most', async () => {
      const settings = (await as(quality).get('/risks/settings').expect(200)).body;
      const inUse = settings.matrix;
      const draft = (await as(quality).post('/risks/settings/matrices').send({ copyOf: inUse.id }).expect(201)).body;
      expect((await as(d1Manager).get(`/risks/settings/matrices/${draft.id}`).expect(200)).body.preview).toBeNull();
      expect((await as(quality).get(`/risks/settings/matrices/${draft.id}`).expect(200)).body.preview).toMatchObject({
        risksChangingBand: 0,
        risksOutOfRange: 0,
        risksTargetAboveCurrent: 0,
      });
      await as(quality).post(`/risks/settings/matrices/${draft.id}/discard`).send({ revision: draft.revision }).expect(200);
      const label = inUse.impact[4].label;
      const renamed = await as(quality)
        .patch(`/risks/settings/matrices/${inUse.id}`)
        .send({ revision: inUse.revision, levels: [{ axis: 'impact', level: 5, label: { en: 'Severe' }, descriptor: inUse.impact[4].descriptor ? { en: inUse.impact[4].descriptor.en } : null }] })
        .expect(200);
      const [entry] = await auditOf('risk_matrix_changed', inUse.id);
      expect((entry.changes as { levels: unknown[] }).levels[0]).toMatchObject({ axis: 'impact', level: 5, label: { from: label, to: { en: 'Severe' } } });
      const many = Array.from({ length: 8 }, (_, i) => ({ name: { en: `Domain ${i}` }, descriptors: {} }));
      const tooMany = await as(quality).patch(`/risks/settings/matrices/${inUse.id}`).send({ revision: renamed.body.revision, domains: many }).expect(400);
      expect(tooMany.body).toMatchObject({ code: 'too_many_domains', max: 12 });
    });

    it('links a document only for someone who may read it, and shows a restricted one as such to anyone else', async () => {
      // A restricted procedure in force, written straight to the database:
      // only those with full sight of its unit read it.
      const [type] = await bench.owner.db.select({ id: documentTypes.id }).from(documentTypes).where(and(eq(documentTypes.tenantId, h.id), eq(documentTypes.code, 'procedure')));
      const [category] = await bench.owner.db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.tenantId, h.id)).limit(1);
      const [doc] = await bench.owner.db
        .insert(documents)
        .values({ tenantId: h.id, number: `PRC-RW-${run}`, typeId: type.id, categoryId: category.id, title: { en: 'Restricted procedure' }, ownerId: quality.id, ownerUnitId: facility, confidentiality: 'restricted', reviewMonths: 24, createdBy: quality.id })
        .returning({ id: documents.id });
      const [version] = await bench.owner.db
        .insert(documentVersions)
        .values({ tenantId: h.id, documentId: doc.id, version: 1, status: 'published', sections: [], preparedBy: quality.id })
        .returning({ id: documentVersions.id });
      await bench.owner.db.update(documents).set({ status: 'active', publishedVersionId: version.id, nextReviewOn: shiftDay(today(), 300) }).where(eq(documents.id, doc.id));
      const r = await create();
      const refused = await as(owner)
        .post(`/risks/${r.id}/controls`)
        .send({ revision: r.revision, description: { en: 'Follow the procedure' }, kind: 'preventive', ownerId: owner.id, documentId: doc.id })
        .expect(400);
      expect(refused.body.code).toBe('unknown_document');
      const linked = await as(quality)
        .post(`/risks/${r.id}/controls`)
        .send({ revision: r.revision, description: { en: 'Follow the procedure' }, kind: 'preventive', ownerId: owner.id, documentId: doc.id })
        .expect(201);
      expect(linked.body.documentId).toBe(doc.id);
      const forOwner = (await fresh(r.id, owner)).controls as { document: Record<string, unknown> }[];
      expect(forOwner[0].document).toEqual({ id: doc.id, restricted: true, number: null, status: null, version: null, nextReviewOn: null, pastReview: false, title: null });
      const forQuality = (await fresh(r.id)).controls as { document: Record<string, unknown> }[];
      expect(forQuality[0].document).toMatchObject({ restricted: true, number: `PRC-RW-${run}`, status: 'active', version: 1, title: { en: 'Restricted procedure' } });
      // Nor as the framework, for someone who may not read it.
      const s = (await as(quality).get('/risks/settings').expect(200)).body;
      await as(quality).patch('/risks/settings').send({ revision: s.revision, frameworkDocumentId: doc.id }).expect(200);
      expect((await as(owner).get('/risks/settings').expect(200)).body.frameworkDocument).toMatchObject({ id: doc.id, number: null, title: null });
    });

    it('refuses rating a proposed risk while suspended, where moves offer nothing', async () => {
      const proposed = await create({ current: undefined, inherent: undefined }, quality);
      await http().patch(`/platform/tenants/${h.id}/subscription`).set('Cookie', bench.platform).send({ status: 'suspended' }).expect(200);
      try {
        expect((await fresh(proposed.id)).moves).toEqual([]);
        const refused = await as(quality).post(`/risks/${proposed.id}/ratings`).send({ revision: proposed.revision, kind: 'current', likelihood: 1, impact: 1 }).expect(403);
        expect(refused.body.code).toBe('subscription_suspended');
      } finally {
        await http().patch(`/platform/tenants/${h.id}/subscription`).set('Cookie', bench.platform).send({ status: 'active' }).expect(200);
      }
    });
  });

  describe('the notifications list, the digest and the timeline', () => {
    it('names a risk or an action by its reference, with whether it can still be opened, and the digest lists the work', async () => {
      const list = (await as(owner).get('/notifications?pageSize=100').expect(200)).body.items as {
        kind: string;
        risk: { id: string; reference: string; canOpen: boolean; title: unknown } | null;
        action: { id: string; reference: string; canOpen: boolean } | null;
      }[];
      const aboutRisk = list.find((n) => n.kind === 'risk_review_due');
      expect(aboutRisk?.risk).toMatchObject({ canOpen: true, title: expect.any(Object) });
      const aboutAction = (await as(doer).get('/notifications?pageSize=100').expect(200)).body.items.find((n: { kind: string }) => n.kind === 'action_assigned');
      expect(aboutAction.action).toMatchObject({ canOpen: true, reference: expect.stringMatching(/^ACT-/) });
      // The morning digest and the queued emails, as the worker sends them
      // (into the outbox, in tests): references and counts only.
      const worker = bench.app.get(EmailWorker, { strict: false });
      const hour = worker.digestHour;
      worker.digestHour = 0;
      try {
        await worker.run(new Date(), [h.id]);
      } finally {
        worker.digestHour = hour;
      }
      const { rows: mails } = await bench.owner.db.execute<{ user_id: string; category: string; subject: string; text_body: string }>(sql`
        select q.user_id, q.category, o.subject, o.text_body
        from email_outbox o join email_queue q on q.id = o.queue_id
        where o.tenant_id = ${h.id}`);
      const doers = mails.find((m) => m.user_id === doer.id && m.category === 'daily_digest')!;
      expect(doers.text_body).toMatch(/Actions due: \d+/);
      expect(doers.text_body).toContain('/en/risks/');
      const owners = mails.find((m) => m.user_id === owner.id && m.category === 'daily_digest')!;
      expect(owners.text_body).toMatch(/Risks to review: \d+/);
      expect(owners.text_body).not.toContain(secret);
      expect(owners.text_body).not.toContain('A risk of the work spec');
      const escalated = mails.filter((m) => m.user_id === quality.id && m.category === 'immediate' && m.subject.startsWith('Extreme risk escalated'));
      expect(escalated.length).toBeGreaterThan(0);
      expect(escalated[0].text_body).toMatch(/RSK-\d{4}-\d{5}/);
      const weekly = mails.find((m) => m.user_id === d1Manager.id && m.category === 'weekly_digest')!;
      expect(weekly.subject).toBe('Risk reviews and actions overdue this week');
      // Timeline entries of another client are not anyone's here.
      const theirs = await bench.owner.db.select({ n: sql<number>`count(*)` }).from(riskEvents).where(eq(riskEvents.tenantId, other.id));
      expect(Number(theirs[0].n)).toBeGreaterThan(0);
    });
  });
});
