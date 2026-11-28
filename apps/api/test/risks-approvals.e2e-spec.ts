import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { contentHash } from '../src/approvals/signatures.js';
import { createDatabase } from '../src/database/client.js';
import {
  auditLog,
  documentCategories,
  documents,
  documentTypes,
  documentVersions,
  notifications,
  plans,
  riskAcceptances,
  riskCommittees,
  risks,
  users,
} from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { requireEnv } from '../src/env.js';
import { dayOf, shiftDay } from '../src/i18n/time-zones.js';
import { RiskCheck } from '../src/risks/risk-check.service.js';
import { testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

const NO_LIMITS = { users: null, sites: null, storageMb: null, aiCreditsPerMonth: null };
const NO_EXTRAS = { sso: false, publicReporting: false, clinicalAiSuggestions: false };

/**
 * Risk management, steps 6 and 7 (docs/specs/risk-management.md):
 * acceptance above tolerance and closure through the approval engine, with
 * signatures by password or signing PIN over fixed content, lapsing, and
 * reopening; the acceptance and closure routes; links to incidents and
 * documents, which never tell who reported an incident or whether
 * anonymously. And the fixes of security review 17. Each route answers 401
 * without a session, 403 without the right, 404 for another client's
 * record, 400 for what it does not take.
 */
describe('risk management: approvals and links', () => {
  const run = randomBytes(4).toString('hex');
  const password = `hospital-pass-${run}`;
  let bench: TestBench;
  const http = () => bench.http();
  let check: RiskCheck;

  let h: Hospital;
  let other: Hospital;
  let facility: string;
  let d1: string;
  let d2: string;
  let otherUnit: string;
  let quality: Staff;
  let quality2: Staff;
  let authority: Staff;
  let d1Manager: Staff;
  let reader: Staff;
  let owner: Staff;
  let reporter: Staff;
  let incidentViewer: Staff;
  let signer: Staff;
  let otherQuality: Staff;
  let categories: Record<string, string>;
  let committees: Record<string, string>;
  let routes: { id: string; subject: string; variant: string | null; revision: number; steps: { roleId: string | null; kind: string }[] }[];

  const as = (who: { cookie: string }) => ({
    get: (url: string) => http().get(url).set('Cookie', who.cookie),
    post: (url: string) => http().post(url).set('Cookie', who.cookie),
    patch: (url: string) => http().patch(url).set('Cookie', who.cookie),
    delete: (url: string) => http().delete(url).set('Cookie', who.cookie),
  });
  const today = () => dayOf(new Date(), 'UTC');
  // Put into text people write, to show it reaches neither the trail nor
  // the timeline.
  const secret = `Mr-Y-${run}`;

  type Risk = { id: string; reference: string; revision: number; moves: string[]; [k: string]: unknown };
  const riskBody = (extra: Record<string, unknown> = {}) => ({
    orgUnitId: d1,
    categoryId: categories.people_safety,
    title: { en: `A risk of the approvals spec ${run}` },
    cause: { en: 'A part wears out.' },
    event: { en: 'It fails in use.' },
    consequence: { en: 'A service stops.' },
    ownerId: owner.id,
    inherent: { likelihood: 4, impact: 4 },
    // High (12): above the tolerance of Medium.
    current: { likelihood: 3, impact: 4 },
    target: { likelihood: 1, impact: 3 },
    ...extra,
  });
  const create = async (extra: Record<string, unknown> = {}, who: Staff = quality): Promise<Risk> =>
    (await as(who).post('/risks').send(riskBody(extra)).expect(201)).body;
  const fresh = async (id: string, who: { cookie: string } = quality): Promise<Risk> =>
    (await as(who).get(`/risks/${id}`).expect(200)).body;
  const noticesOf = (userId: string, kind: string, riskId?: string) =>
    bench.owner.db
      .select({ id: notifications.id, data: notifications.data })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, userId),
          sql`${notifications.kind}::text = ${kind}`,
          riskId ? eq(notifications.riskId, riskId) : undefined,
        ),
      );
  const auditOf = (action: string, entityId: string) =>
    bench.owner.db
      .select({ changes: auditLog.changes, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
  const request = (risk: Risk, who: Staff = owner, extra: Record<string, unknown> = {}) =>
    as(who)
      .post(`/risks/${risk.id}/acceptance`)
      .send({
        revision: risk.revision,
        rationale: { en: `The second machine is on order, ${secret}.` },
        conditions: { en: 'While the old one is checked weekly.' },
        until: shiftDay(today(), 90),
        ...extra,
      });
  /** Asks for and signs an acceptance of a High risk: in force. */
  const accept = async (risk: Risk, until = shiftDay(today(), 90)): Promise<Risk> => {
    const asked = await request(risk, owner, { until }).expect(200);
    return (await as(authority).post(`/risks/${risk.id}/acceptance/approve`).send({ revision: asked.body.revision, password }).expect(200)).body;
  };
  const report = async (who: Staff, extra: Record<string, unknown> = {}) =>
    (
      await as(who)
        .post('/incidents')
        .send({
          type: 'incident',
          categoryId: h.categories.equipment,
          orgUnitId: d1,
          occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
          description: `A pump alarm did not sound. ${secret}`,
          harmLevel: 'moderate',
          anonymous: false,
          ...extra,
        })
        .expect(201)
    ).body as { id: string; reference: string };

  beforeAll(async () => {
    bench = await testBench('ra', run);
    check = bench.app.get(RiskCheck, { strict: false });
    h = await bench.createHospital('main');
    other = await bench.createHospital('other');
    facility = await bench.createUnit(h, 'facility', 'F', null);
    d1 = await bench.createUnit(h, 'department', 'D1', facility);
    d2 = await bench.createUnit(h, 'department', 'D2', facility);
    otherUnit = await bench.createUnit(other, 'facility', 'OF', null);
    await bench.createRole(h, 'risk_reader', ['risks.view']);
    await bench.createRole(h, 'incident_viewer', ['incidents.view']);
    // May be named in a route, and reads nothing else.
    await bench.createRole(h, 'acceptance_signer', ['risks.approve']);
    await bench.createRole(h, 'nobody_holds', ['risks.approve']);
    await bench.createRole(h, 'cannot_sign', ['risks.view']);
    quality = await bench.createStaff(h, 'quality', { role: 'quality_officer', orgUnitId: null });
    quality2 = await bench.createStaff(h, 'quality2', { role: 'quality_officer', orgUnitId: null });
    authority = await bench.createStaff(h, 'authority', { role: 'approving_authority', orgUnitId: null });
    d1Manager = await bench.createStaff(h, 'd1manager', { role: 'department_manager', orgUnitId: d1 });
    reader = await bench.createStaff(h, 'reader', { role: 'risk_reader', orgUnitId: null });
    owner = await bench.createStaff(h, 'owner', { role: 'reporter', orgUnitId: null });
    reporter = await bench.createStaff(h, 'reporter', { role: 'reporter', orgUnitId: d1 });
    incidentViewer = await bench.createStaff(h, 'incviewer', { role: 'incident_viewer', orgUnitId: null });
    signer = await bench.createStaff(h, 'signer', { role: 'acceptance_signer', orgUnitId: null });
    otherQuality = await bench.createStaff(other, 'otherquality', { role: 'quality_officer', orgUnitId: null });
    const settings = (await as(quality).get('/risks/settings').expect(200)).body;
    categories = Object.fromEntries(settings.categories.map((c: { code: string; id: string }) => [c.code, c.id]));
    committees = Object.fromEntries(settings.committees.map((c: { code: string; id: string }) => [c.code, c.id]));
    routes = (await as(quality).get('/risks/settings/approval-routes').expect(200)).body.items;
  }, 120_000);

  afterAll(() => bench.close());

  const routeOf = (subject: string, variant: string | null) => routes.find((r) => r.subject === subject && r.variant === variant)!;

  describe('without a session', () => {
    it('answers 401 on every new route', async () => {
      const id = randomUUID();
      for (const [method, url] of [
        ['post', `/risks/${id}/acceptance`],
        ['post', `/risks/${id}/acceptance/approve`],
        ['post', `/risks/${id}/acceptance/return`],
        ['post', `/risks/${id}/acceptance/withdraw`],
        ['post', `/risks/${id}/close`],
        ['post', `/risks/${id}/closure/approve`],
        ['post', `/risks/${id}/closure/return`],
        ['post', `/risks/${id}/reopen`],
        ['post', `/risks/${id}/incident-links`],
        ['delete', `/risks/${id}/incident-links/${id}`],
        ['get', `/risks/for-incident/${id}`],
        ['get', `/risks/for-document/${id}`],
        ['get', '/risks/approvals'],
        ['get', '/risks/settings/approval-routes'],
        ['post', '/risks/settings/approval-routes'],
        ['patch', `/risks/settings/approval-routes/${id}`],
      ] as const) {
        await http()[method](url).send({}).expect(401);
      }
    });
  });

  describe('the acceptance and closure routes', () => {
    it('start with one route per band above Low and one for closure, kept apart from documents', async () => {
      expect(routes.map((r) => `${r.subject}:${r.variant}`).sort()).toEqual([
        'risk_acceptance:extreme',
        'risk_acceptance:high',
        'risk_acceptance:medium',
        'risk_closure:null',
      ]);
      expect(routeOf('risk_acceptance', 'extreme').steps.map((s) => s.kind)).toEqual(['review', 'approve']);
      expect(routeOf('risk_acceptance', 'high').steps).toMatchObject([{ kind: 'approve', roleId: h.roles.approving_authority }]);
      // The documents' routes do not show them, nor change them.
      const docs = (await as(quality).get('/policies/approval-routes').expect(200)).body;
      const ids = (Array.isArray(docs) ? docs : docs.items ?? docs.routes).map((r: { id: string }) => r.id);
      for (const r of routes) expect(ids).not.toContain(r.id);
      await as(quality).patch(`/policies/approval-routes/${routes[0].id}`).send({ revision: routes[0].revision, active: false }).expect(404);
    });

    it('are kept by a manager for the whole organization, with roles that may sign, one active per band', async () => {
      await as(d1Manager).get('/risks/settings/approval-routes').expect(403);
      await as(reader).post('/risks/settings/approval-routes').send({}).expect(403);
      const base = { subject: 'risk_acceptance', variant: 'high', name: { en: 'Another' }, steps: [{ kind: 'approve', roleId: h.roles.approving_authority, dueInDays: 5 }] };
      await as(quality).post('/risks/settings/approval-routes').send({ ...base, variant: 'low' }).expect(400);
      await as(quality).post('/risks/settings/approval-routes').send({ ...base, extra: 1 }).expect(400);
      const cannot = await as(quality)
        .post('/risks/settings/approval-routes')
        .send({ ...base, steps: [{ kind: 'approve', roleId: h.roles.cannot_sign, dueInDays: 5 }] })
        .expect(400);
      expect(cannot.body.code).toBe('role_cannot_approve');
      const last = await as(quality)
        .post('/risks/settings/approval-routes')
        .send({ ...base, steps: [{ kind: 'review', roleId: h.roles.approving_authority, dueInDays: 5 }] })
        .expect(400);
      expect(last.body.code).toBe('last_step_must_approve');
      const exists = await as(quality).post('/risks/settings/approval-routes').send(base).expect(409);
      expect(exists.body.code).toBe('route_exists');
      // Another client's route is unknown here.
      const theirs = (await as(otherQuality).get('/risks/settings/approval-routes').expect(200)).body.items[0];
      await as(quality).patch(`/risks/settings/approval-routes/${theirs.id}`).send({ revision: theirs.revision, active: false }).expect(404);
      const high = routeOf('risk_acceptance', 'high');
      const stale = await as(quality).patch(`/risks/settings/approval-routes/${high.id}`).send({ revision: high.revision + 5, active: false }).expect(409);
      expect(stale.body.code).toBe('stale_route');
      const renamed = await as(quality)
        .patch(`/risks/settings/approval-routes/${high.id}`)
        .send({ revision: high.revision, name: { en: 'High above tolerance' } })
        .expect(200);
      expect(renamed.body).toMatchObject({ name: { en: 'High above tolerance' }, revision: high.revision + 1 });
      high.revision = renamed.body.revision;
      const [entry] = await auditOf('risk_approval_route_updated', high.id);
      expect(entry.changes).toMatchObject({ name: { to: { en: 'High above tolerance' } } });
    });
  });

  describe('acceptance above tolerance', () => {
    let risk: Risk;
    beforeAll(async () => {
      risk = await create();
    });

    it('is asked for by the owner or a manager, for a risk above tolerance, until a day within the longest acceptance', async () => {
      await as(reader).post(`/risks/${risk.id}/acceptance`).send({ revision: risk.revision, rationale: { en: 'x' }, until: shiftDay(today(), 30) }).expect(403);
      await as(otherQuality).post(`/risks/${risk.id}/acceptance`).send({ revision: risk.revision, rationale: { en: 'x' }, until: shiftDay(today(), 30) }).expect(404);
      await request(risk, owner, { rationale: undefined }).expect(400);
      await request(risk, owner, { extra: true }).expect(400);
      const long = await request(risk, owner, { until: shiftDay(today(), 400) }).expect(400);
      expect(long.body.code).toBe('acceptance_too_long');
      expect((await request(risk, owner, { until: today() }).expect(400)).body.code).toBe('until_past');
      const within = await create({ current: { likelihood: 2, impact: 3 }, target: undefined });
      expect((await request(within).expect(409)).body.code).toBe('within_tolerance');
      expect(within.moves).not.toContain('request_acceptance');
      expect((await fresh(risk.id, owner)).moves).toContain('request_acceptance');
    });

    it('goes to the route of its band: the signer is told at once, and only those assigned may decide', async () => {
      const asked = await request(risk).expect(200);
      expect(asked.body.acceptances[0]).toMatchObject({ status: 'in_approval', requestedBy: owner.id, bandCode: 'high', toleranceBand: 'medium', untilOn: shiftDay(today(), 90) });
      expect(asked.body.acceptances[0].run.steps).toMatchObject([{ kind: 'approve', assigneeRoleId: h.roles.approving_authority, status: 'pending' }]);
      expect(asked.body.moves).toContain('withdraw_acceptance');
      expect(asked.body.moves).not.toContain('review');
      const [told] = await noticesOf(authority.id, 'risk_step_assigned', risk.id);
      expect(told.data).toEqual({ subject: 'acceptance', position: 1, step: 'approve', reference: risk.reference, serious: true });
      const { rows: mail } = await bench.owner.db.execute<{ category: string }>(sql`
        select q.category from email_queue q where q.notification_id = ${told.id}`);
      expect(mail).toEqual([{ category: 'immediate' }]);
      expect((await as(authority).get('/risks/approvals').expect(200)).body.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ subject: 'acceptance', riskId: risk.id, reference: risk.reference, step: 'approve' })]),
      );
      expect((await as(authority).get('/risks/mine').expect(200)).body.steps.map((s: { riskId: string }) => s.riskId)).toContain(risk.id);
      await as(reader).get('/risks/approvals').expect(403);
      await as(owner).get('/risks/approvals').expect(403);
      expect((await fresh(risk.id, authority)).moves).toEqual(expect.arrayContaining(['approve_acceptance', 'return_acceptance']));
      // Nobody may sign with the wrong password, nor without risks.approve.
      const wrong = await as(authority).post(`/risks/${risk.id}/acceptance/approve`).send({ revision: asked.body.revision, password: 'not-it' }).expect(401);
      expect(wrong.body.code).toBe('wrong_password');
      await as(reader).post(`/risks/${risk.id}/acceptance/approve`).send({ revision: asked.body.revision, password }).expect(403);
      await as(quality2).post(`/risks/${risk.id}/acceptance/approve`).send({ revision: asked.body.revision }).expect(400);
      const notAssigned = await as(quality2).post(`/risks/${risk.id}/acceptance/approve`).send({ revision: asked.body.revision, password }).expect(403);
      expect(notAssigned.body.code).toBe('not_assignee');
      await as(otherQuality).post(`/risks/${risk.id}/acceptance/approve`).send({ revision: asked.body.revision, password }).expect(404);
      risk = asked.body;
    });

    it('keeps what was put to its signers while in approval, in the application and in the database', async () => {
      const renamed = await as(quality).patch(`/risks/${risk.id}`).send({ revision: risk.revision, title: { en: 'Another title' } }).expect(409);
      expect(renamed.body.code).toBe('acceptance_in_progress');
      const rated = await as(owner).post(`/risks/${risk.id}/ratings`).send({ revision: risk.revision, kind: 'current', likelihood: 4, impact: 4 }).expect(409);
      expect(rated.body.code).toBe('acceptance_in_progress');
      const reviewed = await as(owner).post(`/risks/${risk.id}/reviews`).send({ revision: risk.revision, outcome: 'no_change', comment: 'x', current: { likelihood: 3, impact: 4 } }).expect(409);
      expect(reviewed.body.code).toBe('acceptance_in_progress');
      // The keywords are not what was signed.
      const ok = await as(quality).patch(`/risks/${risk.id}`).send({ revision: risk.revision, keywords: ['pump'] }).expect(200);
      risk = ok.body;
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      try {
        const db = new TenantDb(app.db);
        await expect(db.withTenant(h.id, (tx) => tx.update(risks).set({ currentScore: 2, currentLikelihood: 1, currentImpact: 2, currentBand: 'low' }).where(eq(risks.id, risk.id)))).rejects.toMatchObject({
          cause: { code: '23514', constraint: 'risks_acceptance_in_progress' },
        });
        const acceptanceId = (risk.acceptances as { id: string }[])[0].id;
        await expect(db.withTenant(h.id, (tx) => tx.update(riskAcceptances).set({ untilOn: shiftDay(today(), 300) }).where(eq(riskAcceptances.id, acceptanceId)))).rejects.toMatchObject({
          cause: { code: '23514', constraint: 'risk_acceptances_content_fixed' },
        });
        await expect(db.withTenant(h.id, (tx) => tx.update(riskAcceptances).set({ status: 'lapsed', lapsedReason: 'last_day', lapsedAt: new Date() }).where(eq(riskAcceptances.id, acceptanceId)))).rejects.toMatchObject({
          cause: { code: '23514', constraint: 'risk_acceptances_status_order' },
        });
      } finally {
        await app.pool.end();
      }
    });

    it('is never decided by its requester or the risk owner', async () => {
      // The requester and the owner hold risks.approve here through another role.
      const both = await bench.createStaff(h, 'bothroles', [
        { role: 'approving_authority', orgUnitId: null },
        { role: 'reporter', orgUnitId: null },
      ]);
      const theirs = await create({ ownerId: both.id });
      const asked = await request(theirs, quality).expect(200);
      const same = await as(both).post(`/risks/${theirs.id}/acceptance/approve`).send({ revision: asked.body.revision, password }).expect(403);
      expect(same.body).toMatchObject({ code: 'same_person', reason: 'owner' });
      expect((await fresh(theirs.id, both)).moves).not.toContain('approve_acceptance');
      // The requester, through the extreme route whose first step is theirs.
      const extreme = await create({ current: { likelihood: 4, impact: 4 } });
      const askedExtreme = await request(extreme, quality).expect(200);
      const requester = await as(quality).post(`/risks/${extreme.id}/acceptance/approve`).send({ revision: askedExtreme.body.revision, password }).expect(403);
      expect(requester.body).toMatchObject({ code: 'same_person', reason: 'requested' });
      // The approver of the second step waits for the first.
      const early = await as(authority).post(`/risks/${extreme.id}/acceptance/approve`).send({ revision: askedExtreme.body.revision, password }).expect(409);
      expect(early.body.code).toBe('not_current_step');
      const reviewed = await as(quality2).post(`/risks/${extreme.id}/acceptance/approve`).send({ revision: askedExtreme.body.revision, password, comment: 'Seen.' }).expect(200);
      expect(reviewed.body.acceptances[0].signatures).toMatchObject([{ userId: quality2.id, meaning: 'reviewed' }]);
      expect(reviewed.body.acceptances[0].status).toBe('in_approval');
      const signed = await as(authority).post(`/risks/${extreme.id}/acceptance/approve`).send({ revision: reviewed.body.revision, password }).expect(200);
      expect(signed.body.acceptances[0].status).toBe('accepted');
      expect(signed.body.acceptances[0].signatures.map((s: { meaning: string }) => s.meaning)).toEqual(['reviewed', 'risk_accepted']);
    });

    it('is signed over what was asked: the hash is recomputed, and the risk is accepted until its last day', async () => {
      const signed = await as(authority).post(`/risks/${risk.id}/acceptance/approve`).send({ revision: risk.revision, password, comment: `Agreed, ${secret}` }).expect(200);
      const a = signed.body.acceptances[0];
      expect(a).toMatchObject({ status: 'accepted', run: { status: 'approved' } });
      expect(signed.body).toMatchObject({ acceptanceId: a.id, treatment: 'accept', standing: 'above_accepted', acceptedUntil: a.untilOn });
      const content = {
        riskId: risk.id,
        reference: risk.reference,
        title: signed.body.title,
        categoryId: signed.body.categoryId,
        orgUnitId: signed.body.orgUnitId,
        current: { ...signed.body.current, matrixId: signed.body.matrixId },
        tolerance: 'medium',
        rationale: a.rationale,
        conditions: a.conditions,
        until: a.untilOn,
      };
      const { score, band, likelihood, impact, matrixId } = content.current as Record<string, unknown>;
      content.current = { score, band, likelihood, impact, matrixId } as never;
      expect(a.signatures).toHaveLength(1);
      expect(a.signatures[0]).toMatchObject({ userId: authority.id, meaning: 'risk_accepted', contentHash: contentHash(content) });
      expect(await noticesOf(owner.id, 'risk_acceptance_decided', risk.id)).toHaveLength(1);
      for (const action of ['risk_acceptance_requested', 'risk_acceptance_step_approved', 'risk_accepted']) {
        const [entry] = await auditOf(action, risk.id);
        expect(entry).toBeDefined();
        expect(JSON.stringify(entry.changes)).not.toContain(secret);
      }
      expect(JSON.stringify(signed.body.events)).not.toContain(secret);
      // The list says until when.
      const listed = (await as(quality).get(`/risks?q=${encodeURIComponent(risk.reference)}`).expect(200)).body.items[0];
      expect(listed).toMatchObject({ acceptedUntil: a.untilOn, standing: 'above_accepted' });
      risk = signed.body;
    });

    it('lapses when the current score rises above the one it accepted', async () => {
      const risen = await as(owner).post(`/risks/${risk.id}/ratings`).send({ revision: risk.revision, kind: 'current', likelihood: 4, impact: 4 }).expect(200);
      expect(risen.body.acceptanceId).toBeNull();
      expect(risen.body.acceptances[0]).toMatchObject({ status: 'lapsed', lapsedReason: 'score_risen' });
      expect(await noticesOf(owner.id, 'risk_acceptance_lapsed', risk.id)).toHaveLength(1);
      const [entry] = await auditOf('risk_acceptance_lapsed', risk.id);
      expect(entry).toMatchObject({ actorId: null, changes: { reason: 'score_risen' } });
    });

    it('is returned with a comment, or withdrawn by its requester with a reason kept as a note', async () => {
      const r1 = await create();
      const asked = await request(r1).expect(200);
      await as(authority).post(`/risks/${r1.id}/acceptance/return`).send({ revision: asked.body.revision }).expect(400);
      await as(reader).post(`/risks/${r1.id}/acceptance/return`).send({ revision: asked.body.revision, comment: 'No' }).expect(403);
      const returned = await as(authority).post(`/risks/${r1.id}/acceptance/return`).send({ revision: asked.body.revision, comment: `Not yet, ${secret}` }).expect(200);
      expect(returned.body.acceptances[0]).toMatchObject({ status: 'returned', run: { status: 'returned' } });
      expect((await noticesOf(owner.id, 'risk_acceptance_decided', r1.id))[0].data).toMatchObject({ outcome: 'returned' });
      expect(JSON.stringify((await auditOf('risk_acceptance_returned', r1.id))[0].changes)).not.toContain(secret);
      const again = await request(returned.body).expect(200);
      await as(reader).post(`/risks/${r1.id}/acceptance/withdraw`).send({ revision: again.body.revision, reason: 'x' }).expect(403);
      await as(owner).post(`/risks/${r1.id}/acceptance/withdraw`).send({ revision: again.body.revision }).expect(400);
      const withdrawn = await as(owner).post(`/risks/${r1.id}/acceptance/withdraw`).send({ revision: again.body.revision, reason: `Fixed sooner, ${secret}` }).expect(200);
      expect(withdrawn.body.acceptances[0]).toMatchObject({ status: 'withdrawn', run: { status: 'cancelled' } });
      const noteId = withdrawn.body.events.at(-1).details.noteId;
      expect(withdrawn.body.notes.find((n: { id: string }) => n.id === noteId)).toMatchObject({ kind: 'withdraw_reason', text: `Fixed sooner, ${secret}` });
      expect(JSON.stringify(withdrawn.body.events)).not.toContain(secret);
      expect(JSON.stringify((await auditOf('risk_acceptance_withdrawn', r1.id))[0].changes)).not.toContain(secret);
    });

    it('is signed with the signing PIN by someone who has no password', async () => {
      const pinned = await bench.createStaff(h, 'pinned', { role: 'approving_authority', orgUnitId: null });
      await bench.owner.db.update(users).set({ passwordHash: null }).where(eq(users.id, pinned.id));
      await http().put('/me/signing-pin').set('Cookie', pinned.cookie).send({ pin: '284619' }).expect(204);
      const r2 = await create();
      const asked = await request(r2).expect(200);
      // Both may sign the step: the one with the PIN does.
      await as(pinned).post(`/risks/${r2.id}/acceptance/approve`).send({ revision: asked.body.revision, password: '284610' }).expect(401);
      const signed = await as(pinned).post(`/risks/${r2.id}/acceptance/approve`).send({ revision: asked.body.revision, password: '284619' }).expect(200);
      expect(signed.body.acceptances[0]).toMatchObject({ status: 'accepted', signatures: [{ userId: pinned.id, meaning: 'risk_accepted' }] });
    });

    it('is read by an assignee holding only risks.approve while their step is in progress, and no longer after', async () => {
      const high = routeOf('risk_acceptance', 'high');
      const changed = await as(quality)
        .patch(`/risks/settings/approval-routes/${high.id}`)
        .send({ revision: high.revision, steps: [{ kind: 'approve', roleId: h.roles.acceptance_signer, dueInDays: 7 }] })
        .expect(200);
      high.revision = changed.body.revision;
      try {
        const r3 = await create();
        await as(signer).get(`/risks/${r3.id}`).expect(404);
        const asked = await request(r3).expect(200);
        expect((await fresh(r3.id, signer)).moves).toEqual(['approve_acceptance', 'return_acceptance']);
        const signed = await as(signer).post(`/risks/${r3.id}/acceptance/approve`).send({ revision: asked.body.revision, password }).expect(200);
        expect(signed.body).toEqual({ access: 'none', id: r3.id, reference: r3.reference });
        await as(signer).get(`/risks/${r3.id}`).expect(404);
      } finally {
        const back = await as(quality)
          .patch(`/risks/settings/approval-routes/${high.id}`)
          .send({ revision: high.revision, steps: [{ kind: 'approve', roleId: h.roles.approving_authority, dueInDays: 7 }] })
          .expect(200);
        high.revision = back.body.revision;
      }
    });

    it('is refused when its route cannot be covered, or there is none', async () => {
      const high = routeOf('risk_acceptance', 'high');
      const nobody = await as(quality)
        .patch(`/risks/settings/approval-routes/${high.id}`)
        .send({ revision: high.revision, steps: [{ kind: 'approve', roleId: h.roles.nobody_holds, dueInDays: 7 }] })
        .expect(200);
      high.revision = nobody.body.revision;
      const r4 = await create();
      expect((await request(r4).expect(409)).body).toMatchObject({ code: 'no_assignee', position: 1 });
      const off = await as(quality).patch(`/risks/settings/approval-routes/${high.id}`).send({ revision: high.revision, active: false }).expect(200);
      high.revision = off.body.revision;
      expect((await request(r4).expect(409)).body.code).toBe('no_route');
      const on = await as(quality)
        .patch(`/risks/settings/approval-routes/${high.id}`)
        .send({ revision: high.revision, active: true, steps: [{ kind: 'approve', roleId: h.roles.approving_authority, dueInDays: 7 }] })
        .expect(200);
      high.revision = on.body.revision;
      // Nothing was left behind by the refusals.
      expect((await fresh(r4.id)).acceptances).toEqual([]);
    });

    it('is in force at once for a band whose acceptance needs no signature, and ends when the category changes', async () => {
      const low = await as(quality)
        .post('/risks/settings/categories')
        .send({ code: `strict_${run}`, name: { en: 'Strict' }, appetite: 'averse', toleranceBand: 'low' })
        .expect(201);
      // A risk whose acceptance is in approval keeps the current rating put to its signers.
      const pending = await create();
      const asked = await request(pending).expect(200);
      // Medium's acceptance may be set to need no signature, in a new version.
      const inUse = asked.body.matrixId as string;
      const draft = await as(quality).post('/risks/settings/matrices').send({ copyOf: inUse }).expect(201);
      const edited = await as(quality)
        .patch(`/risks/settings/matrices/${draft.body.id}`)
        .send({ revision: draft.body.revision, bands: [{ code: 'medium', acceptanceNeedsSignature: false }] })
        .expect(200);
      const used = await as(quality).post(`/risks/settings/matrices/${draft.body.id}/put-in-use`).send({ revision: edited.body.revision }).expect(200);
      expect(used.body.risksAwaitingAcceptance).toBeGreaterThanOrEqual(1);
      const kept = await fresh(pending.id);
      expect((kept.current as { matrixId?: string }).matrixId ?? (kept.ratings as { matrixId: string }[])[0].matrixId).toBe(inUse);
      const r = await create({ categoryId: low.body.id, current: { likelihood: 2, impact: 3 }, target: { likelihood: 1, impact: 2 } });
      const accepted = await request(r).expect(200);
      expect(accepted.body.acceptances[0]).toMatchObject({ status: 'accepted', run: null, signatures: [] });
      expect(accepted.body).toMatchObject({ standing: 'above_accepted', treatment: 'accept' });
      expect((await auditOf('risk_accepted', r.id))[0].changes).toMatchObject({ signatureRequired: false, runId: null });
      const moved = await as(quality)
        .patch(`/risks/${r.id}`)
        .send({ revision: accepted.body.revision, categoryId: categories.people_safety, reason: 'Recategorised' })
        .expect(200);
      expect(moved.body.acceptances[0]).toMatchObject({ status: 'lapsed', lapsedReason: 'category_changed' });
      // The pending one is withdrawn, to leave nothing waiting.
      await as(owner).post(`/risks/${pending.id}/acceptance/withdraw`).send({ revision: kept.revision, reason: 'Later' }).expect(200);
    });

    it('reminds the owner 30 days before its last day, lapses on it, and tells of steps overdue', async () => {
      const until = shiftDay(today(), 40);
      const r5 = await accept(await create(), until);
      const at = (day: string) => new Date(`${day}T12:00:00Z`);
      await check.run(at(shiftDay(until, -30)), [h.id]);
      expect((await noticesOf(owner.id, 'risk_acceptance_ending', r5.id)).map((n) => n.data)).toEqual([
        expect.objectContaining({ until, reference: r5.reference }),
      ]);
      await check.run(at(shiftDay(until, -29)), [h.id]);
      expect(await noticesOf(owner.id, 'risk_acceptance_ending', r5.id)).toHaveLength(1);
      await check.run(at(until), [h.id]);
      const after = await fresh(r5.id);
      expect(after.acceptanceId).toBeNull();
      expect((after.acceptances as { status: string; lapsedReason: string }[])[0]).toMatchObject({ status: 'lapsed', lapsedReason: 'last_day' });
      expect(await noticesOf(owner.id, 'risk_acceptance_lapsed', r5.id)).toHaveLength(1);
      // A step past its due time: the managers for the whole organization, once.
      const r6 = await create();
      await request(r6).expect(200);
      await check.run(at(shiftDay(today(), 9)), [h.id]);
      await check.run(at(shiftDay(today(), 10)), [h.id]);
      expect((await noticesOf(quality.id, 'risk_step_overdue', r6.id)).map((n) => n.data)).toEqual([
        expect.objectContaining({ subject: 'acceptance', position: 1 }),
      ]);
      expect(await noticesOf(d1Manager.id, 'risk_step_overdue', r6.id)).toEqual([]);
    });
  });

  describe('closing and reopening', () => {
    it('closes a risk never serious at once, with a reason, once its actions are done', async () => {
      const r = await create({ current: { likelihood: 2, impact: 3 }, inherent: { likelihood: 2, impact: 3 }, target: undefined });
      expect(r.closureSignOffNeeded).toBe(false);
      expect(r.moves).toContain('close');
      const action = await as(quality)
        .post(`/risks/${r.id}/actions`)
        .send({ revision: r.revision, title: { en: 'Fix it' }, ownerId: owner.id, dueOn: shiftDay(today(), 10), strength: 'weaker' })
        .expect(201);
      const now = await fresh(r.id);
      await as(owner).post(`/risks/${r.id}/close`).send({ revision: now.revision, reason: 'Gone' }).expect(403);
      await as(otherQuality).post(`/risks/${r.id}/close`).send({ revision: now.revision, reason: 'Gone' }).expect(404);
      await as(quality).post(`/risks/${r.id}/close`).send({ revision: now.revision }).expect(400);
      expect((await as(quality).post(`/risks/${r.id}/close`).send({ revision: now.revision, reason: 'Gone' }).expect(409)).body.code).toBe('actions_open');
      await as(quality).post(`/risks/actions/${action.body.id}/cancel`).send({ revision: action.body.revision, reason: 'Not needed' }).expect(200);
      const merged = await as(quality).post(`/risks/${r.id}/close`).send({ revision: (await fresh(r.id)).revision, reason: 'Gone', mergedIntoId: r.id }).expect(400);
      expect(merged.body.code).toBe('unknown_risk');
      const theirRisk = (
        await as(otherQuality)
          .post('/risks')
          .send({ ...riskBody(), orgUnitId: null, ownerId: otherQuality.id, categoryId: (await as(otherQuality).get('/risks/settings').expect(200)).body.categories[0].id })
          .expect(201)
      ).body;
      expect((await as(quality).post(`/risks/${r.id}/close`).send({ revision: (await fresh(r.id)).revision, reason: 'Gone', mergedIntoId: theirRisk.id }).expect(400)).body.code).toBe('unknown_risk');
      const into = await create({ current: { likelihood: 2, impact: 3 }, target: undefined });
      const closed = await as(quality)
        .post(`/risks/${r.id}/close`)
        .send({ revision: (await fresh(r.id)).revision, reason: `Merged, ${secret}`, mergedIntoId: into.id })
        .expect(200);
      expect(closed.body).toMatchObject({ status: 'closed', closure: { closedBy: quality.id, closeReason: `Merged, ${secret}`, mergedIntoId: into.id }, moves: ['reopen', 'correct'] });
      expect(JSON.stringify(closed.body.events)).not.toContain(secret);
      expect((await auditOf('risk_closed', r.id))[0].changes).toEqual({ mergedIntoId: into.id, reasonGiven: true, signedOff: false, runId: null });
      expect(await noticesOf(owner.id, 'risk_closed', r.id)).toHaveLength(1);
      // Its owner, a reader by their place only, no longer reads it.
      await as(owner).get(`/risks/${r.id}`).expect(404);
      // Reopened with a reason and a new current rating.
      await as(quality).post(`/risks/${r.id}/reopen`).send({ revision: closed.body.revision, reason: 'Back' }).expect(400);
      await as(owner).post(`/risks/${r.id}/reopen`).send({ revision: closed.body.revision, reason: 'Back', current: { likelihood: 2, impact: 3 } }).expect(403);
      await as(otherQuality).post(`/risks/${r.id}/reopen`).send({ revision: closed.body.revision, reason: 'Back', current: { likelihood: 2, impact: 3 } }).expect(404);
      const reopened = await as(quality)
        .post(`/risks/${r.id}/reopen`)
        .send({ revision: closed.body.revision, reason: `It came back, ${secret}`, current: { likelihood: 2, impact: 3 } })
        .expect(200);
      expect(reopened.body).toMatchObject({ status: 'open', nextReviewOn: shiftDay(today(), 180) });
      expect(reopened.body.notes.at(-1)).toMatchObject({ kind: 'reopen_reason', text: `It came back, ${secret}` });
      expect(JSON.stringify((await auditOf('risk_reopened', r.id))[0].changes)).not.toContain(secret);
    });

    it('needs a second signature for a risk that has been High, never its requester or owner', async () => {
      const r = await create();
      expect(r.closureSignOffNeeded).toBe(true);
      expect(r.moves).toContain('request_closure');
      const asked = await as(quality).post(`/risks/${r.id}/close`).send({ revision: r.revision, reason: `Removed, ${secret}` }).expect(200);
      expect(asked.body).toMatchObject({ status: 'open', closure: { requestedBy: quality.id } });
      expect(asked.body.moves).toEqual(['escalate', 'correct']);
      expect((await noticesOf(quality2.id, 'risk_step_assigned', r.id))[0].data).toMatchObject({ subject: 'closure', step: 'approve' });
      // Nothing changes while it waits.
      expect((await as(quality).patch(`/risks/${r.id}`).send({ revision: asked.body.revision, keywords: ['x'] }).expect(409)).body.code).toBe('closure_in_progress');
      expect((await as(quality).post(`/risks/${r.id}/corrections`).send({ revision: asked.body.revision, kind: 'close_reason', text: 'Other' }).expect(409)).body.code).toBe('closure_in_progress');
      const same = await as(quality).post(`/risks/${r.id}/closure/approve`).send({ revision: asked.body.revision, password }).expect(403);
      expect(same.body).toMatchObject({ code: 'same_person', reason: 'requested' });
      await as(otherQuality).post(`/risks/${r.id}/closure/approve`).send({ revision: asked.body.revision, password }).expect(404);
      // Returned, it stays open; asked again, it is signed.
      const returned = await as(quality2).post(`/risks/${r.id}/closure/return`).send({ revision: asked.body.revision, comment: 'Not yet' }).expect(200);
      expect(returned.body).toMatchObject({ status: 'open' });
      expect(returned.body.moves).toContain('request_closure');
      const again = await as(quality).post(`/risks/${r.id}/close`).send({ revision: returned.body.revision, reason: 'Removed' }).expect(200);
      const signed = await as(quality2).post(`/risks/${r.id}/closure/approve`).send({ revision: again.body.revision, password }).expect(200);
      expect(signed.body).toMatchObject({ status: 'closed' });
      const signature = signed.body.closure.signatures.at(-1);
      expect(signature).toMatchObject({ userId: quality2.id, meaning: 'risk_closure_approved' });
      expect(signature.contentHash).toBe(
        contentHash({
          riskId: r.id,
          reference: r.reference,
          title: r.title,
          closeReason: 'Removed',
          mergedIntoId: null,
          highestBand: signed.body.highestBand,
          requestedBy: quality.id,
        }),
      );
      expect((await auditOf('risk_closed', r.id))[0].changes).toMatchObject({ signedOff: true });
    });
  });

  describe('links to incidents', () => {
    let risk: Risk;
    let named: { id: string; reference: string };
    let anonymous: { id: string; reference: string };
    let elsewhere: { id: string; reference: string };
    let theirs: { id: string; reference: string };

    beforeAll(async () => {
      risk = await create();
      named = await report(reporter);
      anonymous = await report(reporter, { anonymous: true });
      elsewhere = await report(quality, { orgUnitId: d2 });
      theirs = await report(otherQuality, { categoryId: other.categories.equipment, orgUnitId: otherUnit });
    });

    it('are made by a manager of the risk who sees the incident in full', async () => {
      const link = (who: Staff, body: Record<string, unknown>, id = risk.id) => as(who).post(`/risks/${id}/incident-links`).send(body);
      await link(owner, { incidentId: named.id, kind: 'supports' }).expect(403);
      await link(quality, { incidentId: named.id }).expect(400);
      await link(quality, { incidentId: named.id, kind: 'supports', extra: 1 }).expect(400);
      await link(otherQuality, { incidentId: named.id, kind: 'supports' }).expect(404);
      // Another client's incident, or one that does not exist: alike.
      expect((await link(quality, { incidentId: theirs.id, kind: 'supports' }).expect(400)).body).toEqual({ code: 'unknown_incident' });
      expect((await link(quality, { incidentId: randomUUID(), kind: 'supports' }).expect(400)).body).toEqual({ code: 'unknown_incident' });
      const made = await link(quality, { incidentId: named.id, kind: 'supports', note: `Same pump, ${secret}` }).expect(201);
      expect(made.body).toMatchObject({ riskId: risk.id, incidentId: named.id, kind: 'supports', linkedBy: quality.id });
      expect((await link(quality, { incidentId: named.id, kind: 'raised' }).expect(409)).body.code).toBe('already_linked');
      await link(quality, { incidentId: anonymous.id, kind: 'supports' }).expect(201);
      await link(quality, { incidentId: elsewhere.id, kind: 'supports' }).expect(201);
      const entry = (await auditOf('risk_incident_linked', risk.id)).find((e) => (e.changes as { incidentId: string }).incidentId === named.id)!;
      expect(entry.changes).toMatchObject({ incidentId: named.id, incidentReference: named.reference, kind: 'supports', noteGiven: true });
      expect(JSON.stringify(entry.changes)).not.toContain(secret);
      // The owner is told, by the risk's reference only.
      const told = await noticesOf(owner.id, 'risk_incident_linked', risk.id);
      expect(told).toHaveLength(3);
      for (const n of told) expect(n.data).toEqual({ reference: risk.reference, serious: true });
    });

    it('show on the risk only the incidents the reader sees in full, never who reported them or how', async () => {
      const page = await fresh(risk.id);
      const panel = page.incidents as { items: { incident: Record<string, unknown> }[]; hidden: number; last12Months: number };
      expect(panel.items).toHaveLength(3);
      expect(panel.last12Months).toBe(3);
      for (const item of panel.items) {
        expect(Object.keys(item.incident).sort()).toEqual(['categoryId', 'harmLevel', 'id', 'occurredOn', 'orgUnitId', 'reference', 'status', 'type']);
      }
      const text = JSON.stringify(page);
      expect(text).not.toContain(reporter.id);
      expect(text).not.toMatch(/anonymous|channel|reportedBy|reporter/i);
      expect(text).not.toContain('pump alarm');
      // The D1 manager sees D1's incidents in full, and only counts the other.
      const theirsPanel = (await fresh(risk.id, d1Manager)).incidents as { items: { incident: { id: string } }[]; hidden: number };
      expect(theirsPanel.items.map((i) => i.incident.id).sort()).toEqual([named.id, anonymous.id].sort());
      expect(theirsPanel.hidden).toBe(1);
      // The owner, who sees no incident, gets a count.
      expect((await fresh(risk.id, owner)).incidents).toMatchObject({ items: [], hidden: 3 });
      // An anonymous incident's link is like any other.
      const [a, b] = [panel.items.find((i) => i.incident.id === anonymous.id)!, panel.items.find((i) => i.incident.id === named.id)!];
      expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    });

    it('are listed on the incident for whoever sees it, with what "Raise a risk" offers', async () => {
      await as(quality).get(`/risks/for-incident/${theirs.id}`).expect(404);
      await as(owner).get(`/risks/for-incident/${named.id}`).expect(404);
      await as(quality).get('/risks/for-incident/not-an-id').expect(404);
      const panel = (await as(quality).get(`/risks/for-incident/${named.id}`).expect(200)).body;
      expect(panel.items).toEqual([expect.objectContaining({ id: risk.id, linkKind: 'supports' })]);
      expect(panel.raise).toEqual({ orgUnitId: d1, impact: 3, linkKind: 'raised' });
      // Its reporter sees it, and not the risk: no risk is listed.
      const forReporter = (await as(reporter).get(`/risks/for-incident/${named.id}`).expect(200)).body;
      expect(forReporter.items).toEqual([]);
      expect(forReporter.raise).toBeNull();
    });

    it('raise a risk from an incident: opened by a manager, proposed by anyone else who sees it in full', async () => {
      const source = await report(reporter, { harmLevel: 'severe' });
      const body = { ...riskBody({ current: undefined, inherent: undefined, target: undefined }), fromIncidentId: source.id };
      await as(reporter).post('/risks').send(body).expect(400);
      expect((await as(reporter).post('/risks').send(body).expect(400)).body.code).toBe('unknown_incident');
      expect((await as(quality).post('/risks').send({ ...body, fromIncidentId: theirs.id }).expect(400)).body.code).toBe('unknown_incident');
      const proposed = await as(incidentViewer).post('/risks').send(body).expect(201);
      expect(proposed.body).toMatchObject({ status: 'proposed', source: 'incident', createdBy: incidentViewer.id });
      expect(proposed.body.incidents.items).toEqual([expect.objectContaining({ kind: 'raised', incident: expect.objectContaining({ id: source.id }) })]);
      expect(await noticesOf(d1Manager.id, 'risk_proposed', proposed.body.id)).toHaveLength(1);
      const opened = await as(quality)
        .post('/risks')
        .send({ ...riskBody(), fromIncidentId: source.id, linkKind: 'supports' })
        .expect(201);
      expect(opened.body).toMatchObject({ status: 'open', source: 'incident' });
      expect((await auditOf('risk_created', opened.body.id))[0].changes).toMatchObject({ incidentId: source.id, incidentReference: source.reference, linkKind: 'supports' });
    });

    it('are taken off with a reason by the same managers', async () => {
      const page = await fresh(risk.id);
      const link = (page.incidents as { items: { linkId: string; incident: { id: string } }[] }).items.find((i) => i.incident.id === elsewhere.id)!;
      await as(d1Manager).delete(`/risks/${risk.id}/incident-links/${link.linkId}`).send({ reason: 'x' }).expect(404);
      await as(quality).delete(`/risks/${risk.id}/incident-links/${link.linkId}`).send({}).expect(400);
      await as(owner).delete(`/risks/${risk.id}/incident-links/${link.linkId}`).send({ reason: 'x' }).expect(403);
      await as(quality).delete(`/risks/${risk.id}/incident-links/${link.linkId}`).send({ reason: `Not the same, ${secret}` }).expect(204);
      await as(quality).delete(`/risks/${risk.id}/incident-links/${link.linkId}`).send({ reason: 'again' }).expect(404);
      expect(((await fresh(risk.id)).incidents as { items: unknown[] }).items).toHaveLength(2);
      expect(JSON.stringify((await auditOf('risk_incident_unlinked', risk.id))[0].changes)).not.toContain(secret);
    });

    it('are hidden while the incidents module is off', async () => {
      const [everything] = await bench.owner.db.select({ id: plans.id }).from(plans).where(eq(plans.code, 'everything'));
      const plan = await http()
        .post('/platform/plans')
        .set('Cookie', bench.platform)
        .send({ code: `${bench.prefix}-noinc`, name: { en: 'No incidents', ar: 'بلا حوادث', fr: 'Sans incidents' }, modules: ['risks', 'policies', 'actions'], limits: NO_LIMITS, extras: NO_EXTRAS })
        .expect(201);
      await http().patch(`/platform/tenants/${h.id}/subscription`).set('Cookie', bench.platform).send({ planId: plan.body.id }).expect(200);
      try {
        const page = await fresh(risk.id);
        expect(page.incidents).toBeNull();
        expect(page.moves).not.toContain('link_incident');
        expect((await as(quality).post(`/risks/${risk.id}/incident-links`).send({ incidentId: named.id, kind: 'raised' }).expect(400)).body.code).toBe('unknown_incident');
        await as(quality).get(`/risks/for-incident/${named.id}`).expect(404);
      } finally {
        await http().patch(`/platform/tenants/${h.id}/subscription`).set('Cookie', bench.platform).send({ planId: everything.id }).expect(200);
      }
    });
  });

  describe('documents as controls', () => {
    it('flag a control whose procedure is past its review or retired, tell the owner, and list the risks on the document', async () => {
      const [type] = await bench.owner.db.select({ id: documentTypes.id }).from(documentTypes).where(and(eq(documentTypes.tenantId, h.id), eq(documentTypes.code, 'procedure')));
      const [category] = await bench.owner.db.select({ id: documentCategories.id }).from(documentCategories).where(eq(documentCategories.tenantId, h.id)).limit(1);
      const [doc] = await bench.owner.db
        .insert(documents)
        .values({ tenantId: h.id, number: `PRC-RA-${run}`, typeId: type.id, categoryId: category.id, title: { en: 'Pump checks' }, ownerId: quality.id, ownerUnitId: facility, reviewMonths: 24, createdBy: quality.id })
        .returning({ id: documents.id });
      const [version] = await bench.owner.db
        .insert(documentVersions)
        .values({ tenantId: h.id, documentId: doc.id, version: 1, status: 'published', sections: [], preparedBy: quality.id })
        .returning({ id: documentVersions.id });
      await bench.owner.db.update(documents).set({ status: 'active', publishedVersionId: version.id, nextReviewOn: shiftDay(today(), -1) }).where(eq(documents.id, doc.id));
      const r = await create();
      await as(quality)
        .post(`/risks/${r.id}/controls`)
        .send({ revision: r.revision, description: { en: 'Check pumps weekly' }, kind: 'preventive', ownerId: owner.id, documentId: doc.id })
        .expect(201);
      expect(((await fresh(r.id)).controls as { flag: string | null }[])[0].flag).toBe('document_past_review');
      // The document's panel: for whoever may read the document.
      await as(otherQuality).get(`/risks/for-document/${doc.id}`).expect(404);
      await as(quality).get('/risks/for-document/x').expect(404);
      expect((await as(quality).get(`/risks/for-document/${doc.id}`).expect(200)).body).toMatchObject({ total: 1, items: [expect.objectContaining({ id: r.id })] });
      // Retired: the owner is told, and the control says so.
      const current = (await as(quality).get(`/policies/documents/${doc.id}`).expect(200)).body;
      await as(quality).post(`/policies/documents/${doc.id}/retire`).send({ revision: current.revision, reason: 'Replaced' }).expect(200);
      expect(((await fresh(r.id)).controls as { flag: string | null }[])[0].flag).toBe('document_retired');
      expect((await noticesOf(owner.id, 'risk_control_document_retired', r.id)).map((n) => n.data)).toEqual([
        expect.objectContaining({ reference: r.reference }),
      ]);
    });
  });

  describe('the fixes of security review 17', () => {
    it('M1: refuses escalating by hand to the committee a risk is before, or one below it', async () => {
      const r = await create({ current: { likelihood: 4, impact: 4 } });
      expect(r.escalatedToCommitteeId).toBe(committees.governing_body);
      for (const committeeId of [committees.governing_body, committees.risk_committee]) {
        const refused = await as(quality).post(`/risks/${r.id}/escalate`).send({ revision: r.revision, committeeId, reason: 'Down' }).expect(409);
        expect(refused.body.code).toBe('already_escalated');
      }
    });

    it('L1: a review for a committee may rate but not set the treatment; "accept" above tolerance comes only from a signed acceptance', async () => {
      const r = await create();
      expect((await as(quality).patch(`/risks/${r.id}`).send({ revision: r.revision, treatment: 'accept' }).expect(400)).body.code).toBe('acceptance_required');
      expect((await as(quality).post('/risks').send(riskBody({ treatment: 'accept' })).expect(400)).body.code).toBe('acceptance_required');
      const member = await bench.createStaff(h, 'member17', { role: 'risk_reader', orgUnitId: d2 });
      await bench.createRole(h, 'committee17', ['incidents.report']);
      const [committee] = await bench.owner.db.select({ revision: riskCommittees.revision }).from(riskCommittees).where(eq(riskCommittees.id, committees.risk_committee));
      await as(quality).patch(`/risks/settings/committees/${committees.risk_committee}`).send({ revision: committee.revision, memberRoleId: h.roles.committee17 }).expect(200);
      await bench.owner.db.execute(sql`insert into role_assignments (tenant_id, user_id, role_id, org_unit_id) values (${h.id}, ${member.id}, ${h.roles.committee17}, null)`);
      const signedIn = bench.cookieOf(await bench.login(h.slug, member.email).expect(200));
      const asMember = { cookie: signedIn };
      const now = await fresh(r.id, asMember);
      await as(asMember)
        .post(`/risks/${r.id}/reviews`)
        .send({ revision: now.revision, committeeId: committees.risk_committee, outcome: 're_rated', comment: 'x', current: { likelihood: 2, impact: 3 }, treatment: 'reduce' })
        .expect(403);
      const review = await as(asMember)
        .post(`/risks/${r.id}/reviews`)
        .send({ revision: now.revision, committeeId: committees.risk_committee, outcome: 're_rated', comment: 'x', current: { likelihood: 2, impact: 3 } })
        .expect(200);
      expect(review.body.current).toMatchObject({ score: 6, band: 'medium' });
      // Whoever lowered it today does not take it off the list; another may.
      const same = await as(asMember).post(`/risks/${r.id}/de-escalate`).send({ revision: review.body.revision, reason: 'Lower now' }).expect(403);
      expect(same.body.code).toBe('same_person');
      const down = await as(quality).post(`/risks/${r.id}/de-escalate`).send({ revision: review.body.revision, reason: 'Lower now' }).expect(200);
      expect(down.body.escalatedToCommitteeId).toBeNull();
    });

    it('L2: whoever completed an action does not verify it', async () => {
      const r = await create();
      const action = await as(quality)
        .post(`/risks/${r.id}/actions`)
        .send({ revision: r.revision, title: { en: 'Replace the pump' }, ownerId: owner.id, dueOn: shiftDay(today(), 10), strength: 'stronger' })
        .expect(201);
      const done = await as(quality).post(`/risks/actions/${action.body.id}/complete`).send({ revision: action.body.revision, note: 'Done for them.' }).expect(200);
      expect(done.body.moves).not.toContain('verify');
      expect((await as(quality).post(`/risks/actions/${action.body.id}/verify`).send({ revision: done.body.revision, outcome: 'effective' }).expect(403)).body.code).toBe('same_person');
      await as(quality2).post(`/risks/actions/${action.body.id}/verify`).send({ revision: done.body.revision, outcome: 'effective' }).expect(200);
    });

    it('L3: a committee open risks are before is not switched off, and one switched off holds no risk', async () => {
      const r = await create({ current: { likelihood: 4, impact: 4 } });
      expect(r.escalatedToCommitteeId).toBe(committees.governing_body);
      const [gb] = await bench.owner.db.select({ revision: riskCommittees.revision }).from(riskCommittees).where(eq(riskCommittees.id, committees.governing_body));
      const refused = await as(quality).patch(`/risks/settings/committees/${committees.governing_body}`).send({ revision: gb.revision, active: false }).expect(409);
      expect(refused.body.code).toBe('committee_in_use');
      // Switched off by other means: a rating that calls for a lower
      // committee puts the risk before it.
      await bench.owner.db.update(riskCommittees).set({ active: false }).where(eq(riskCommittees.id, committees.governing_body));
      try {
        const rated = await as(quality).post(`/risks/${r.id}/ratings`).send({ revision: r.revision, kind: 'current', likelihood: 3, impact: 4 }).expect(200);
        expect(rated.body.escalatedToCommitteeId).toBe(committees.risk_committee);
      } finally {
        await bench.owner.db.update(riskCommittees).set({ active: true }).where(eq(riskCommittees.id, committees.governing_body));
      }
    });

    it('L4 and L5: corrects the text of a rejected proposal, a finished action and a reason kept as a note, audited by name only', async () => {
      const proposed = await create({ current: undefined, inherent: undefined, target: undefined }, d1Manager);
      const rejected = await as(quality).post(`/risks/${proposed.id}/proposal/reject`).send({ revision: proposed.revision, reason: 'Not a risk' }).expect(200);
      const open = await create();
      expect((await as(quality).post(`/risks/${open.id}/corrections`).send({ revision: open.revision, kind: 'risk_text', field: 'cause', text: { en: 'x' } }).expect(409)).body.code).toBe('use_edit');
      await as(quality).post(`/risks/${rejected.body.id}/corrections`).send({ revision: rejected.body.revision, kind: 'risk_text', field: 'title', text: 'plain' }).expect(400);
      const fixed = await as(quality)
        .post(`/risks/${rejected.body.id}/corrections`)
        .send({ revision: rejected.body.revision, kind: 'risk_text', field: 'cause', text: { en: 'A part wears out (name removed).' } })
        .expect(200);
      expect(fixed.body.cause).toEqual({ en: 'A part wears out (name removed).' });
      expect(fixed.body.events.at(-1)).toMatchObject({ kind: 'text_corrected', details: { kind: 'risk_text', field: 'cause' } });
      // A reason kept as a note.
      const moved = await as(quality).patch(`/risks/${open.id}`).send({ revision: open.revision, ownerId: quality.id, reason: `Asked by ${secret}` }).expect(200);
      const noteId = moved.body.events.at(-1).details.noteId;
      await as(owner).post(`/risks/${open.id}/corrections`).send({ revision: moved.body.revision, kind: 'note', noteId, text: 'Asked by the ward.' }).expect(403);
      await as(quality).post(`/risks/${open.id}/corrections`).send({ revision: moved.body.revision, kind: 'note', noteId: randomUUID(), text: 'x' }).expect(404);
      const corrected = await as(quality).post(`/risks/${open.id}/corrections`).send({ revision: moved.body.revision, kind: 'note', noteId, text: 'Asked by the ward.' }).expect(200);
      expect(corrected.body.notes.find((n: { id: string }) => n.id === noteId)).toMatchObject({ text: 'Asked by the ward.', correctedAt: expect.any(String) });
      const entries = await auditOf('risk_text_corrected', open.id);
      expect(entries.map((e) => e.changes)).toEqual([{ kind: 'note', noteId }]);
      // A finished action's title.
      const action = await as(quality)
        .post(`/risks/${corrected.body.id}/actions`)
        .send({ revision: corrected.body.revision, title: { en: `Call ${secret}` }, ownerId: owner.id, dueOn: shiftDay(today(), 10), strength: 'weaker' })
        .expect(201);
      const cancelled = await as(quality).post(`/risks/actions/${action.body.id}/cancel`).send({ revision: action.body.revision, reason: 'Done otherwise' }).expect(200);
      const retitled = await as(quality).post(`/risks/actions/${action.body.id}/corrections`).send({ revision: cancelled.body.revision, field: 'title', text: { en: 'Call the supplier' } }).expect(200);
      expect(retitled.body.title).toEqual({ en: 'Call the supplier' });
      const [entry] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'action_text_corrected'), eq(auditLog.entityId, action.body.id)));
      expect(entry.changes).toEqual({ field: 'title' });
    });

    it('rates the inherent rating of a risk whose target the matrix put above its current rating', async () => {
      const r = await create();
      // As a new version of the matrix can leave it.
      await bench.owner.db.update(risks).set({ targetLikelihood: 4, targetImpact: 4, targetScore: 16, targetBand: 'extreme' }).where(eq(risks.id, r.id));
      await as(quality).post(`/risks/${r.id}/ratings`).send({ revision: r.revision, kind: 'inherent', likelihood: 5, impact: 4 }).expect(200);
      const now = await fresh(r.id);
      expect((await as(quality).post(`/risks/${r.id}/ratings`).send({ revision: now.revision, kind: 'current', likelihood: 3, impact: 3 }).expect(400)).body.code).toBe('target_above_current');
    });
  });
});
