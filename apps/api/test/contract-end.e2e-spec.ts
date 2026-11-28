import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, clientDeletions, dataExports, notifications, platformAuditLog, subscriptions, tenants } from '../src/database/schema.js';
import { ContractNotices } from '../src/exports/contract-notices.check.js';
import { ExportKeys } from '../src/exports/export-keys.js';
import { ExportWorker } from '../src/exports/export-worker.service.js';
import { ExportStorage } from '../src/exports/storage.js';
import { dayOf, shiftDay } from '../src/i18n/time-zones.js';
import { createPlatformAdmin } from '../src/platform/create-admin.js';
import { deleteClient } from '../src/platform/delete-client.js';
import { testBench, type Hospital, type TestBench } from './support/hospital.js';

/**
 * The end of a contract (docs/specs/data-export.md, steps 6 and 7): its
 * dates and the notices before it, the exit window after cancelling,
 * Trustline's second approval of an export for a client with one holder,
 * the notice of a new holder of `data.export`, and deletion after the
 * retention date by two members of Trustline's staff, with its signed
 * certificate.
 */
describe('the end of a contract', () => {
  const run = randomBytes(4).toString('hex');
  const password = `hospital-pass-${run}`;
  const secondPassword = `platform-pass-2-${run}`;
  let bench: TestBench;
  let a: Hospital;
  let c: Hospital; // one administrator, and so one holder of data.export
  let second: string; // a second member of Trustline's staff, signed in
  const http = () => bench.http();
  const today = dayOf(new Date(), 'UTC');
  const platform = (cookie: string) => ({
    put: (url: string, body: object) => http().put(`/platform/tenants${url}`).set('Cookie', cookie).send(body),
    post: (url: string, body: object = {}) => http().post(`/platform/tenants${url}`).set('Cookie', cookie).send(body),
    get: (url: string) => http().get(`/platform/tenants${url}`).set('Cookie', cookie),
  });
  const clientLog = (h: Hospital, action: string) =>
    bench.owner.db.select({ changes: auditLog.changes }).from(auditLog).where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, action)));
  const trustlineLog = (h: Hospital, action: string) =>
    bench.owner.db.select({ details: platformAuditLog.details }).from(platformAuditLog).where(and(eq(platformAuditLog.targetTenantId, h.id), eq(platformAuditLog.action, action)));
  const told = (userId: string, kind: 'contract_ending' | 'data_export_granted' | 'data_export_changed') =>
    bench.owner.db
      .select({ data: notifications.data })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, kind)));
  const writtenRequest = { receivedOn: today, from: 'Contract contact', reference: 'LETTER-1', note: null };

  beforeAll(async () => {
    bench = await testBench('cend', run);
    a = await bench.createHospital('a');
    c = await bench.createHospital('c');
    const email = `second-staff-cend-${run}@test.invalid`;
    await createPlatformAdmin({ email, name: 'Second staff', password: secondPassword });
    second = bench.cookieOf(await http().post('/platform/auth/login').send({ email, password: secondPassword }).expect(200));
  }, 90_000);

  afterAll(() => bench.close());

  it('takes the contract’s dates from Trustline’s staff only, audited in both logs', async () => {
    await http().put(`/platform/tenants/${a.id}/contract`).send({ endsOn: shiftDay(today, 20) }).expect(401);
    await http().put(`/platform/tenants/${a.id}/contract`).set('Cookie', a.cookie).send({ endsOn: shiftDay(today, 20) }).expect(401);
    for (const body of [{}, { endsOn: 'soon' }, { endsOn: today, extra: 1 }]) {
      await platform(bench.platform).put(`/${a.id}/contract`, body).expect(400);
    }
    expect((await platform(bench.platform).put(`/${a.id}/contract`, { exitUntil: shiftDay(today, 30), retainUntil: shiftDay(today, 10) }).expect(400)).body).toEqual({ code: 'invalid_dates' });
    const set = (await platform(bench.platform).put(`/${a.id}/contract`, { endsOn: shiftDay(today, 20) }).expect(200)).body;
    expect(set).toMatchObject({ endsOn: shiftDay(today, 20), exitUntil: null, subscriptionStatus: 'active', exitWindowOpen: false, deletable: 'not_cancelled' });
    expect(await trustlineLog(a, 'contract_end_set')).toEqual([{ details: { from: null, to: shiftDay(today, 20) } }]);
    expect(await clientLog(a, 'contract_end_set')).toEqual([
      { changes: expect.objectContaining({ endsOn: { from: null, to: shiftDay(today, 20) }, platformAdminName: expect.any(String) }) },
    ]);
  });

  it('tells the administrators 30 and then 7 days before the end, once each', async () => {
    const notices = bench.app.get(ContractNotices);
    expect(await notices.run(new Date(), [a.id])).toEqual({ told: 1 });
    expect(await notices.run(new Date(), [a.id])).toEqual({ told: 0 });
    expect(await told(a.adminId, 'contract_ending')).toEqual([{ data: { endsOn: shiftDay(today, 20), days: 30, serious: false } }]);
    await platform(bench.platform).put(`/${a.id}/contract`, { endsOn: shiftDay(today, 5) }).expect(200);
    expect(await notices.run(new Date(), [a.id])).toEqual({ told: 1 });
    expect((await told(a.adminId, 'contract_ending')).map((n) => n.data.days)).toEqual([30, 7]);
  });

  it('tells the other administrators when someone is given data.export, never the one who gave it', async () => {
    const other = await bench.createStaff(a, 'admin2', { role: 'administrator', orgUnitId: null });
    const third = await bench.createStaff(a, 'admin3', { role: 'administrator', orgUnitId: null });
    expect(await told(other.id, 'data_export_granted')).toEqual([{ data: { personId: third.id, serious: false } }]);
    expect(await told(a.adminId, 'data_export_granted')).toEqual([]);
    expect(await told(third.id, 'data_export_granted')).toEqual([]);
    // For one unit, it counts for nothing: nobody is told.
    await bench.createRole(a, 'exporter', ['data.export']);
    const unit = await bench.createUnit(a, 'department', 'D', null);
    await bench.createStaff(a, 'unitexporter', { role: 'exporter', orgUnitId: unit });
    expect(await told(other.id, 'data_export_granted')).toHaveLength(1);
  });

  describe('Trustline’s second approval', () => {
    let asked: { id: string; revision: number };

    it('approves, on a written request, only for a client whose one holder asked', async () => {
      asked = (await http().post('/exports').set('Cookie', c.cookie).send({ reason: 'contract_end', password }).expect(201)).body;
      const url = `/${c.id}/exports/${asked.id}/approve`;
      await http().post(`/platform/tenants${url}`).send({ writtenRequest }).expect(401);
      await platform(bench.platform).post(url, {}).expect(400);
      await platform(bench.platform).post(url, { writtenRequest: { ...writtenRequest, reference: '' } }).expect(400);
      await platform(bench.platform).post(`/${c.id}/exports/${a.id}/approve`, { writtenRequest }).expect(404);
      // A client with a second holder, independent of the one who asked:
      // that holder approves.
      const maker = await bench.createStaff(a, 'maker', { role: 'administrator', orgUnitId: null });
      const independent = await bench.createStaff({ ...a, cookie: maker.cookie }, 'independent', { role: 'administrator', orgUnitId: null });
      await bench.owner.db.execute(sql`update users set created_at = now() - interval '8 days' where id = ${independent.id}`);
      await bench.owner.db.execute(sql`update role_assignments set granted_at = now() - interval '8 days' where user_id = ${independent.id}`);
      const theirs = (await http().post('/exports').set('Cookie', a.cookie).send({ reason: 'on_request', password }).expect(201)).body;
      expect((await platform(bench.platform).post(`/${a.id}/exports/${theirs.id}/approve`, { writtenRequest }).expect(409)).body).toEqual({ code: 'not_alone' });
      // Another client's export, named under this one: as if not there.
      await platform(bench.platform).post(`/${c.id}/exports/${theirs.id}/approve`, { writtenRequest }).expect(404);
      const view = (await platform(bench.platform).post(url, { writtenRequest }).expect(200)).body;
      expect(view.exports[0]).toMatchObject({ id: asked.id, status: 'approved', trustlineApprovedAt: expect.any(String) });
      // Trustline sees no names of the client's.
      expect(view.exports[0]).not.toHaveProperty('requestedBy');
      await platform(bench.platform).post(url, { writtenRequest }).expect(409);
      expect(await clientLog(c, 'data_export_approved_by_trustline')).toEqual([
        { changes: expect.objectContaining({ exportId: asked.id, writtenRequest, platformAdminName: expect.any(String) }) },
      ]);
      expect(await trustlineLog(c, 'second_approval_recorded')).toEqual([{ details: { exportId: asked.id, writtenRequest } }]);
      expect((await told(c.adminId, 'data_export_changed')).map((n) => n.data.change)).toContain('approved');
      // The client sees it approved by Trustline, and only the one who asked may download.
      const [mine] = (await http().get('/exports').set('Cookie', c.cookie).expect(200)).body.items;
      expect(mine).toMatchObject({ status: 'approved', approvedBy: null, approvedByTrustline: { writtenRequest } });
    });

    it('is made and downloaded as any other', async () => {
      expect(await bench.app.get(ExportWorker).run(new Date(), [c.id])).toMatchObject({ made: 1 });
      await http().post(`/exports/${asked.id}/download`).set('Cookie', c.cookie).send({ password }).expect(200);
    }, 60_000);
  });

  describe('the exit window', () => {
    it('opens for 90 days on cancelling, for holders of data.export alone, and only to the export screens', async () => {
      const reporter = await bench.createStaff(a, 'reporter', { role: 'reporter', orgUnitId: null });
      await http().patch(`/platform/tenants/${a.id}/subscription`).set('Cookie', bench.platform).send({ status: 'cancelled' }).expect(200);
      const [sub] = await bench.owner.db.select().from(subscriptions).where(eq(subscriptions.tenantId, a.id));
      expect(sub).toMatchObject({ status: 'cancelled', exitUntil: shiftDay(dayOf(new Date(), 'UTC'), 90), retainUntil: shiftDay(dayOf(new Date(), 'UTC'), 90) });
      expect(await trustlineLog(a, 'exit_window_set')).toHaveLength(1);
      // No session from before comes back.
      await http().get('/auth/me').set('Cookie', a.cookie).expect(401);
      await http().get('/auth/me').set('Cookie', reporter.cookie).expect(401);
      // A reporter is refused as before; the administrator is let in.
      const [adminRow] = (await bench.owner.db.execute<{ email: string }>(sql`select email from users where id = ${a.adminId}`)).rows;
      await bench.login(a.slug, reporter.email).expect(401);
      const cookie = bench.cookieOf(await bench.login(a.slug, adminRow.email).expect(200));
      expect((await http().get('/auth/me').set('Cookie', cookie).expect(200)).body.tenant).toMatchObject({ exit: { until: sub.exitUntil } });
      expect((await http().get('/incidents').set('Cookie', cookie).expect(403)).body).toEqual({ code: 'subscription_cancelled' });
      expect((await http().get('/users').set('Cookie', cookie).expect(403)).body).toEqual({ code: 'subscription_cancelled' });
      await http().get('/exports').set('Cookie', cookie).expect(200);
      // The public routes stay closed.
      await http().get(`/public/reporting/${a.slug}`).expect(404);
      // Once the window has passed, nobody.
      await platform(bench.platform).put(`/${a.id}/contract`, { exitUntil: shiftDay(today, -1), retainUntil: shiftDay(today, -1) }).expect(200);
      await http().get('/auth/me').set('Cookie', cookie).expect(401);
      await bench.login(a.slug, adminRow.email).expect(401);
    });
  });

  describe('deletion', () => {
    it('is asked for after the retention date by one member of staff, approved by another, and certified', async () => {
      const ask = (body: object) => platform(bench.platform).post(`/${c.id}/deletion`, body);
      expect((await ask({ reason: 'Contract ended.' }).expect(409)).body).toEqual({ code: 'not_cancelled' });
      await http().patch(`/platform/tenants/${c.id}/subscription`).set('Cookie', bench.platform).send({ status: 'cancelled' }).expect(200);
      expect((await ask({ reason: 'Contract ended.' }).expect(409)).body).toEqual({ code: 'before_retention' });
      await platform(bench.platform).put(`/${c.id}/contract`, { exitUntil: shiftDay(today, -2), retainUntil: shiftDay(today, -1) }).expect(200);
      await ask({ reason: '' }).expect(400);
      const asked = (await ask({ reason: 'Contract ended; the client took its export.' }).expect(201)).body.deletion;
      expect(asked).toMatchObject({ status: 'requested', requestedBy: { name: expect.any(String) } });
      await ask({ reason: 'Again.' }).expect(409);
      expect((await platform(bench.platform).post(`/${c.id}/deletion/${asked.id}/approve`).expect(403)).body).toEqual({ code: 'same_person' });
      await platform(second).post(`/${a.id}/deletion/${asked.id}/approve`).expect(404);
      const approved = (await platform(second).post(`/${c.id}/deletion/${asked.id}/approve`).expect(200)).body.deletion;
      expect(approved).toMatchObject({ status: 'approved', approvedBy: { name: 'Second staff' } });

      const keys = bench.app.get(ExportKeys);
      const { rows: before } = await bench.owner.db.execute<{ n: number }>(sql`select count(*)::int as n from users where tenant_id = ${c.id}`);
      const done = await deleteClient(bench.owner.db, { deletionId: asked.id, backupsExpireOn: shiftDay(today, 35) }, keys, bench.app.get(ExportStorage));
      const certificate = JSON.parse(done.certificate.toString('utf8'));
      expect(certificate).toMatchObject({
        format: 'trustline-deletion-certificate',
        client: { id: c.id, identifier: c.slug },
        lastBackupExpiresOn: shiftDay(today, 35),
        requestedBy: expect.any(String),
        approvedBy: 'Second staff',
        rowsDeleted: expect.objectContaining({ users: before[0].n, data_exports: 1 }),
        auditChain: expect.objectContaining({ headSeq: expect.any(Number) }),
      });
      const key = keys.published.find((k) => k.keyId === done.signature.keyId)!;
      const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
      expect(verify(null, done.certificate, publicKey, Buffer.from(done.signature.signature, 'base64'))).toBe(true);
      // A stub, nothing else of the client's.
      const [stub] = await bench.owner.db.select({ status: tenants.status, name: tenants.name, slug: tenants.slug }).from(tenants).where(eq(tenants.id, c.id));
      expect(stub).toEqual({ status: 'deleted', name: {}, slug: c.slug });
      for (const table of ['users', 'audit_log', 'audit_chain', 'data_exports', 'subscriptions', 'notifications', 'roles']) {
        const { rows } = await bench.owner.db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.raw(table)} where tenant_id = ${c.id}`);
        expect(`${table}: ${rows[0].n}`).toBe(`${table}: 0`);
      }
      const [record] = await bench.owner.db.select().from(clientDeletions).where(eq(clientDeletions.id, asked.id));
      expect(record).toMatchObject({ status: 'done', certificateSha256: done.sha256 });
      expect(await trustlineLog(c, 'client_data_deleted')).toEqual([{ details: expect.objectContaining({ certificateSha256: done.sha256 }) }]);
      // Once only.
      await expect(deleteClient(bench.owner.db, { deletionId: asked.id, backupsExpireOn: today }, keys, bench.app.get(ExportStorage))).rejects.toThrow(/done, not approved/);
      expect(await bench.owner.db.select().from(dataExports).where(eq(dataExports.tenantId, c.id))).toEqual([]);
    }, 60_000);

    it('waits for a downloaded export or the client’s written instruction', async () => {
      // Hospital a: cancelled, past its retention, and no export downloaded.
      const ask = (body: object) => platform(bench.platform).post(`/${a.id}/deletion`, body);
      expect((await ask({ reason: 'Contract ended.' }).expect(409)).body).toEqual({ code: 'no_export_downloaded' });
      await ask({ reason: 'Contract ended.', writtenInstruction: writtenRequest }).expect(201);
    });
  });
});
