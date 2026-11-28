import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, dataExports, notifications } from '../src/database/schema.js';
import { ExportWorker } from '../src/exports/export-worker.service.js';
import { ExportStorage } from '../src/exports/storage.js';
import { shiftDay, dayOf } from '../src/i18n/time-zones.js';
import { testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

/**
 * Full data export (docs/specs/data-export.md, steps 1 to 3): asked for by
 * one holder of `data.export`, approved by another, made by the worker
 * from one moment of the data, signed, kept encrypted, downloaded at most
 * five times, and expired.
 */
describe('full data export', () => {
  const run = randomBytes(4).toString('hex');
  const password = `hospital-pass-${run}`;
  const privateNote = `PRIVATE-TRUSTLINE-NOTE-${run}`;
  let bench: TestBench;
  let worker: ExportWorker;
  let storage: ExportStorage;
  let a: Hospital;
  let b: Hospital;
  let second: Staff; // a second Administrator of a
  let third: Staff; // a third, who neither asked nor approved
  let quality: Staff; // no data.export
  let reporter: Staff;
  let dir: string;
  const http = () => bench.http();
  const post = (cookie: string, url: string, body: object = {}) => http().post(`/exports${url}`).set('Cookie', cookie).send(body);
  const audits = (h: Hospital, action: string) =>
    bench.owner.db.select({ changes: auditLog.changes, actorId: auditLog.actorId }).from(auditLog).where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, action)));
  const unzip = (...args: string[]) => execFileSync('unzip', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  /** A binary body, whole. */
  const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };
  const download = (cookie: string, id: string, pass = password) =>
    http().post(`/exports/${id}/download`).set('Cookie', cookie).send({ password: pass }).buffer(true).parse(binary as never);
  /** An error's body, from a download's bytes. */
  const json = (res: { body: Buffer }) => JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;

  /**
   * An Administrator whom the client's first administrator, who asks for
   * the exports here, did not make: made by another Administrator, their
   * account and grant 8 days old.
   */
  const makers = new Map<string, Staff>();
  const independentAdmin = async (h: Hospital, suffix: string): Promise<Staff> => {
    if (!makers.has(h.id)) makers.set(h.id, await bench.createStaff(h, `maker${suffix}`, { role: 'administrator', orgUnitId: null }));
    const made = await bench.createStaff({ ...h, cookie: makers.get(h.id)!.cookie }, suffix, { role: 'administrator', orgUnitId: null });
    await bench.owner.db.execute(sql`update users set created_at = now() - interval '8 days', password_changed_at = now() - interval '8 days' where id = ${made.id}`);
    await bench.owner.db.execute(sql`update role_assignments set granted_at = now() - interval '8 days' where user_id = ${made.id}`);
    return made;
  };

  beforeAll(async () => {
    bench = await testBench('dex', run);
    worker = bench.app.get(ExportWorker);
    storage = bench.app.get(ExportStorage);
    a = await bench.createHospital('a', { locales: ['en', 'ar'], defaultLocale: 'en' });
    b = await bench.createHospital('b');
    // The first administrators, made by Trustline more than 7 days ago:
    // each may approve what another asks (security review 19, M3).
    for (const h of [a, b]) {
      await bench.owner.db.execute(sql`update users set created_at = now() - interval '8 days', password_changed_at = now() - interval '8 days' where id = ${h.adminId}`);
      await bench.owner.db.execute(sql`update role_assignments set granted_at = now() - interval '8 days' where user_id = ${h.adminId}`);
    }
    // Administrators made by Trustline, more than 7 days ago: a second
    // person in fact, whom the one who asks did not make (security review
    // 19, M3).
    second = await independentAdmin(a, 'second');
    third = await independentAdmin(a, 'third');
    quality = await bench.createStaff(a, 'quality', { role: 'quality_officer', orgUnitId: null });
    reporter = await bench.createStaff(a, 'reporter', { role: 'reporter', orgUnitId: null });
    const unit = await bench.createUnit(a, 'department', 'D', null);
    // Some records of each kind: an incident, an internal comment, a
    // document with its signature.
    const incident = (
      await http()
        .post('/incidents')
        .set('Cookie', reporter.cookie)
        .send({
          type: 'incident',
          categoryId: a.categories.equipment,
          orgUnitId: unit,
          occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
          description: 'A bed rail would not lock.',
          harmLevel: 'none',
          anonymous: false,
        })
        .expect(201)
    ).body as { id: string };
    await http()
      .post(`/incidents/${incident.id}/comments`)
      .set('Cookie', a.cookie)
      .send({ body: 'Checked with the ward manager.', visibility: 'internal' })
      .expect((res) => expect([200, 201]).toContain(res.status));
    const types = Object.fromEntries((await http().get('/policies/types').set('Cookie', a.cookie).expect(200)).body.map((t: { code: string; id: string }) => [t.code, t.id]));
    const categories = Object.fromEntries((await http().get('/policies/categories').set('Cookie', a.cookie).expect(200)).body.map((c: { code: string; id: string }) => [c.code, c.id]));
    const today = dayOf(new Date(), 'UTC');
    await http()
      .post('/policies/documents/import')
      .set('Cookie', quality.cookie)
      .send({
        password,
        typeId: types.procedure,
        categoryId: categories.SAF,
        title: { en: 'Handling a spill', ar: 'التعامل مع الانسكاب' },
        ownerId: quality.id,
        ownerUnitId: unit,
        approvedOn: shiftDay(today, -300),
        approvedBy: 'Head of Operations',
        originalKeptAt: { en: 'Quality office' },
        nextReviewOn: shiftDay(today, 300),
        content: { en: { purpose: 'To make a **spill** safe.', steps: '1. Mark the area.\n2. Call the porters.' } },
      })
      .expect(201);
    // Trustline's own words about the client, which no archive may carry
    // (security review 19, H1).
    await http().patch(`/platform/tenants/${a.id}/subscription`).set('Cookie', bench.platform).send({ note: privateNote }).expect(200);
    await http().patch(`/platform/tenants/${a.id}/ai`).set('Cookie', bench.platform).send({ monthlySpendingLimitUsd: 77.25 }).expect(200);
    dir = await mkdtemp(join(tmpdir(), 'dex-'));
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    for (const h of [a, b]) if (h) await storage.removeClient(h.id);
    await bench.close();
  });

  describe('asking and approving', () => {
    it('is refused without a session, without data.export for the whole organization, and for bad input', async () => {
      await http().get('/exports').expect(401);
      await http().post('/exports').send({ reason: 'on_request', password }).expect(401);
      for (const who of [quality, reporter]) {
        expect((await http().get('/exports').set('Cookie', who.cookie).expect(403)).body).toMatchObject({ code: 'missing_permission', permission: 'data.export' });
        await post(who.cookie, '', { reason: 'on_request', password }).expect(403);
      }
      for (const body of [
        {},
        { reason: 'because', password },
        { reason: 'on_request' },
        { reason: 'on_request', password, extra: 1 },
        { reason: 'on_request', password, note: 'x'.repeat(1001) },
      ]) {
        await post(a.cookie, '', body).expect(400);
      }
      expect((await post(a.cookie, '', { reason: 'on_request', password, locale: 'fr' }).expect(400)).body).toEqual({ code: 'language_mismatch', field: 'locale' });
      expect((await post(a.cookie, '', { reason: 'on_request', password: 'not it' }).expect(401)).body).toMatchObject({ code: 'wrong_password' });
      expect(await bench.owner.db.select().from(dataExports).where(eq(dataExports.tenantId, a.id))).toEqual([]);
    });

    let asked: { id: string; revision: number };

    it('takes a request, one at a time, audited and told to every holder', async () => {
      asked = (await post(a.cookie, '', { reason: 'contract_end', note: 'Moving to a new system.', locale: 'ar', password }).expect(201)).body;
      expect(asked).toMatchObject({ status: 'requested', reason: 'contract_end', locale: 'ar', requestedBy: { id: a.adminId }, may: { approve: false, cancel: true } });
      expect((await post(second.cookie, '', { reason: 'on_request', password }).expect(409)).body).toEqual({ code: 'export_in_progress' });
      const [entry] = await audits(a, 'data_export_requested');
      expect(entry).toMatchObject({ actorId: a.adminId, changes: { exportId: asked.id, reason: 'contract_end', locale: 'ar' } });
      const told = await bench.owner.db
        .select({ userId: notifications.userId, data: notifications.data })
        .from(notifications)
        .where(and(eq(notifications.tenantId, a.id), eq(notifications.kind, 'data_export_changed')));
      expect(told.map((t) => t.userId).sort()).toEqual([second.id, third.id, makers.get(a.id)!.id].sort());
      expect(told[0].data).toMatchObject({ change: 'requested', exportId: asked.id });
      // In the list, and not another client's.
      expect((await http().get('/exports').set('Cookie', second.cookie).expect(200)).body.items).toEqual([
        expect.objectContaining({ id: asked.id, may: expect.objectContaining({ approve: true, cancel: false }) }),
      ]);
      expect((await http().get('/exports').set('Cookie', b.cookie).expect(200)).body.items).toEqual([]);
    });

    it('is approved only by another holder, with the password, on its revision', async () => {
      expect((await post(a.cookie, `/${asked.id}/approve`, { password, revision: asked.revision }).expect(403)).body).toEqual({ code: 'same_person' });
      await post(b.cookie, `/${asked.id}/approve`, { password, revision: asked.revision }).expect(404);
      await post(second.cookie, `/${asked.id}/approve`, { password, revision: asked.revision, extra: 1 }).expect(400);
      await post(second.cookie, '/not-an-id/approve', { password, revision: 1 }).expect(400);
      expect((await post(second.cookie, `/${asked.id}/approve`, { password, revision: asked.revision + 5 }).expect(409)).body).toEqual({ code: 'stale_export' });
      await post(second.cookie, `/${asked.id}/approve`, { password: 'not it', revision: asked.revision }).expect(401);
      // Not by an account the one who asked made, however it is given the
      // role (security review 19, M3), nor by one made this week.
      const made = await bench.createStaff(a, 'madebyrequester', { role: 'administrator', orgUnitId: null });
      expect((await post(made.cookie, `/${asked.id}/approve`, { password, revision: asked.revision }).expect(403)).body).toEqual({
        code: 'approver_not_independent',
        reason: 'account_by_requester',
      });
      // Nor by an account made this week, a grant made this week, an
      // account whose password was set this week or for which the
      // requester made a sign-in link, nor through a role widened this week
      // (security review 20, M1).
      const reason = async (who: Staff) => (await post(who.cookie, `/${asked.id}/approve`, { password, revision: asked.revision }).expect(403)).body.reason;
      const maker = makers.get(a.id)!;
      const fresh = await bench.createStaff({ ...a, cookie: maker.cookie }, 'fresh', { role: 'administrator', orgUnitId: null });
      expect(await reason(fresh)).toBe('account_new');
      await bench.owner.db.execute(sql`update users set created_at = now() - interval '8 days', password_changed_at = now() - interval '8 days' where id = ${fresh.id}`);
      expect(await reason(fresh)).toBe('grant_new');
      await bench.owner.db.execute(sql`update role_assignments set granted_at = now() - interval '8 days' where user_id = ${fresh.id}`);
      await bench.owner.db.execute(sql`update users set password_changed_at = now() where id = ${fresh.id}`);
      expect(await reason(fresh)).toBe('password_recent');
      await bench.owner.db.execute(sql`update users set password_changed_at = now() - interval '8 days' where id = ${fresh.id}`);
      await http().post(`/users/${fresh.id}/invite`).set('Cookie', a.cookie).send({}).expect((r) => expect([200, 201]).toContain(r.status));
      expect(await reason(fresh)).toBe('link_by_requester');
      await bench.createRole(a, 'widened', ['policies.view']);
      const widened = await bench.createStaff({ ...a, cookie: maker.cookie }, 'widened', { role: 'widened', orgUnitId: null });
      await bench.owner.db.execute(sql`update users set created_at = now() - interval '8 days', password_changed_at = now() - interval '8 days' where id = ${widened.id}`);
      await bench.owner.db.execute(sql`update role_assignments set granted_at = now() - interval '8 days' where user_id = ${widened.id}`);
      const roleId = (await bench.owner.db.execute<{ id: string }>(sql`select id from roles where tenant_id = ${a.id} and code = 'widened'`)).rows[0].id;
      await http()
        .patch(`/roles/${roleId}`)
        .set('Cookie', a.cookie)
        .send({ permissions: ['policies.view', 'data.export', 'incidents.see_reporter'] })
        .expect(200);
      const widenedCookie = bench.cookieOf(await bench.login(a.slug, widened.email).expect(200));
      expect(await reason({ ...widened, cookie: widenedCookie })).toBe('role_widened');
      // Not without the right to see who reported, for the whole
      // organization: the archive names them (L1).
      await bench.createRole(a, 'exporternoreporter', ['data.export']);
      const blind = await bench.createStaff(a, 'blind', { role: 'exporternoreporter', orgUnitId: null });
      expect((await post(blind.cookie, `/${asked.id}/approve`, { password, revision: asked.revision }).expect(403)).body).toEqual({
        code: 'missing_permission',
        permission: 'incidents.see_reporter',
      });
      const approved = (await post(second.cookie, `/${asked.id}/approve`, { password, revision: asked.revision }).expect(200)).body;
      expect(approved).toMatchObject({ status: 'approved', approvedBy: { id: second.id } });
      expect(await audits(a, 'data_export_approved')).toEqual([{ actorId: second.id, changes: { exportId: asked.id } }]);
    });

    it('makes it from one moment, signed, encrypted at rest, and lets the two download it', async () => {
      const done = await worker.run(new Date(), [a.id]);
      expect(done).toMatchObject({ made: 1, failed: 0 });
      const [row] = await bench.owner.db.select().from(dataExports).where(eq(dataExports.id, asked.id));
      expect(row).toMatchObject({ status: 'ready', downloads: 0, attempts: 1 });
      expect(row.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
      // Encrypted in storage: not a ZIP there.
      const stored = await readFile(join(storage.root, row.storageKey!));
      expect(stored.subarray(0, 4).toString()).toBe('TLX1');
      expect(stored.includes(Buffer.from('PK\u0003\u0004'))).toBe(false);
      const [ready] = await audits(a, 'data_export_ready');
      expect(ready.changes).toMatchObject({ exportId: asked.id, archiveSha256: row.archiveSha256, counts: expect.objectContaining({ users: (await bench.owner.db.execute<{ n: number }>(sql`select count(*)::int as n from users where tenant_id = ${a.id}`)).rows[0].n, incidents: 1 }) });

      // Not for a third administrator, nor another client.
      expect(json(await download(third.cookie, asked.id).expect(403))).toEqual({ code: 'not_yours' });
      await download(b.cookie, asked.id).expect(404);
      await download(a.cookie, asked.id, 'not it').expect(401);
      const res = await download(a.cookie, asked.id).expect(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="trustline-export-.+\.zip"$/);
      const zip = res.body as Buffer;
      expect(createHash('sha256').update(zip).digest('hex')).toBe(row.archiveSha256);
      await writeFile(join(dir, 'archive.zip'), zip);
      expect(unzip('-tq', join(dir, 'archive.zip')).toString()).toContain('No errors detected');
      execFileSync('unzip', ['-q', join(dir, 'archive.zip'), '-d', join(dir, 'out')]);
      const [downloaded] = await audits(a, 'data_export_downloaded');
      expect(downloaded).toMatchObject({ actorId: a.adminId, changes: { exportId: asked.id, archiveSha256: row.archiveSha256, download: 1 } });
    }, 120_000);

    it('holds a manifest signed by the published export key, true to every file', async () => {
      const out = join(dir, 'out');
      const manifestBytes = await readFile(join(out, 'manifest.json'));
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      const sig = JSON.parse(await readFile(join(out, 'manifest.sig'), 'utf8'));
      const { exportKeys, keys } = (await http().get('/audit/keys').expect(200)).body;
      const key = exportKeys.find((k: { keyId: string }) => k.keyId === sig.keyId);
      expect(key).toBeDefined();
      // Never one of the audit chain's keys.
      expect(keys.map((k: { keyId: string }) => k.keyId)).not.toContain(sig.keyId);
      const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
      expect(verify(null, manifestBytes, publicKey, Buffer.from(sig.signature, 'base64'))).toBe(true);
      expect(manifest).toMatchObject({
        format: 'trustline-export',
        version: 1,
        exportId: asked.id,
        organization: { id: a.id },
        reason: 'contract_end',
        locale: 'ar',
        requestedBy: { id: a.adminId },
        approvedBy: { id: second.id },
        pdfs: { included: false },
      });
      const listed = new Map<string, { size: number; sha256: string }>(manifest.files.map((f: { path: string; size: number; sha256: string }) => [f.path, f]));
      const all = (await readdir(out, { recursive: true, withFileTypes: true }))
        .filter((e) => e.isFile())
        .map((e) => relative(out, join(e.parentPath, e.name)).split(sep).join('/'))
        .filter((p) => p !== 'manifest.json' && p !== 'manifest.sig')
        .sort();
      expect([...listed.keys()].sort()).toEqual(all);
      for (const path of all) {
        const body = await readFile(join(out, path));
        expect(`${path}: ${createHash('sha256').update(body).digest('hex')}`).toBe(`${path}: ${listed.get(path)!.sha256}`);
      }
      // The README in the language asked for first, then the client's other.
      expect(all.filter((p) => p.startsWith('README'))).toEqual(['README.ar.txt', 'README.en.txt']);
      expect(await readFile(join(out, 'README.ar.txt'), 'utf8')).toContain('تصدير كامل لبيانات');
      // The README's commands check the signature, as written (L8).
      const readme = await readFile(join(out, 'README.en.txt'), 'utf8');
      const commands = readme.split('\r\n').filter((l) => l.startsWith('  ')).map((l) => l.trim());
      expect(commands[0]).toMatch(/^curl -o keys\.json https?:\/\/.+\/api\/v1\/audit\/keys$/);
      await writeFile(join(out, 'keys.json'), JSON.stringify((await http().get('/audit/keys').expect(200)).body));
      expect(execFileSync('bash', ['-c', commands.slice(1).join(' && ')], { cwd: out, encoding: 'utf8' })).toContain('Signature Verified Successfully');
      await rm(join(out, 'keys.json'));
      for (const f of ['export-key.der', 'export-key.pem', 'manifest.sig.bin']) await rm(join(out, f), { force: true });
    });

    it('holds every table of the coverage registry, its schemas, CSV files in the language asked for, and documents as pages', async () => {
      const out = join(dir, 'out');
      for (const file of ['people/users', 'structure/org_units', 'incidents/incidents', 'incidents/comments', 'documents/versions', 'documents/signatures', 'audit/audit_log', 'reports/measure_snapshots', 'organization/data_exports']) {
        expect(`${file}: ${existsSync(join(out, `${file}.jsonl`))}`).toBe(`${file}: true`);
        expect(`${file}: ${existsSync(join(out, 'schema', `${file}.schema.json`))}`).toBe(`${file}: true`);
      }
      for (const excluded of ['sessions', 'user_tokens', 'email_outbox', 'email_queue', 'sign_in_codes']) {
        const any = (await readdir(out, { recursive: true })).some((p) => /^[^.]+/.exec(String(p).split('/').pop()!)?.[0] === excluded);
        expect(`${excluded}: ${any}`).toBe(`${excluded}: false`);
      }
      const comments = (await readFile(join(out, 'incidents/comments.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(comments).toEqual([expect.objectContaining({ body: 'Checked with the ward manager.', visibility: 'internal' })]);
      const users = (await readFile(join(out, 'people/users.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(users[0]).not.toHaveProperty('password_hash');
      expect(users[0]).not.toHaveProperty('failed_attempts');
      expect(users[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      // Arabic, as asked: headings and values.
      const csvUsers = await readFile(join(out, 'people/users.csv'), 'utf8');
      expect(csvUsers.startsWith('﻿"الاسم","البريد الإلكتروني"')).toBe(true);
      expect(await readFile(join(out, 'audit/audit_log.ar.csv'), 'utf8')).toContain('"طلب تصدير كامل للبيانات"');
      // The document: its text as stored, and a page in English that loads nothing.
      const docs = await readdir(join(out, 'documents'), { withFileTypes: true });
      const folder = docs.find((d) => d.isDirectory())!.name;
      const content = JSON.parse(await readFile(join(out, 'documents', folder, 'v1', 'content.json'), 'utf8'));
      expect(content.content.en.purpose).toBe('To make a **spill** safe.');
      const page = await readFile(join(out, 'documents', folder, 'v1', 'en.html'), 'utf8');
      expect(page).toContain('<strong>spill</strong>');
      expect(page).toContain('Approved before Trustline');
      expect(page).not.toMatch(/<script|<link|<img|src=|href=/);
      // The audit chain, checked by Trustline's own verifier against the published keys.
      await writeFile(join(dir, 'keys.json'), JSON.stringify((await http().get('/audit/keys').expect(200)).body));
      const verifier = join(__dirname, '..', 'scripts', 'verify-audit-chain.mjs');
      let output = '';
      try {
        output = execFileSync('node', [verifier, join(out, 'audit/audit-chain.jsonl'), join(dir, 'keys.json'), '--allow-unanchored-tail'], { encoding: 'utf8' });
      } catch (error) {
        output = String((error as { stdout?: string }).stdout ?? error);
      }
      expect(output).not.toMatch(/break|invalid|mismatch/i);
    });

    it('holds no other client’s id, and no secret of any account', async () => {
      const out = join(dir, 'out');
      const { rows: theirs } = await bench.owner.db.execute<{ id: string }>(sql`
        select id::text from users where tenant_id = ${b.id}
        union all select id::text from org_units where tenant_id = ${b.id}
        union all select id::text from roles where tenant_id = ${b.id}
        union all select id::text from role_assignments where tenant_id = ${b.id}
        union all select id::text from incident_categories where tenant_id = ${b.id}
        union all select id::text from document_types where tenant_id = ${b.id}
        union all select id::text from document_categories where tenant_id = ${b.id}
        union all select id::text from approval_routes where tenant_id = ${b.id}
        union all select id::text from audit_log where tenant_id = ${b.id}
        union all select id::text from notifications where tenant_id = ${b.id}
        union all select ${b.id}::text`);
      expect(theirs.length).toBeGreaterThan(20);
      // Trustline's records of the client, without its own words (H1).
      const records = (await readFile(join(out, 'organization/trustline_records.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(records.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(['client_created', 'subscription_updated', 'ai_client_settings_updated']));
      for (const r of records) expect(Object.keys(r).sort()).toEqual(['action', 'at', 'details', 'staff']);
      const subscription = records.find((r: { action: string }) => r.action === 'subscription_updated');
      expect(subscription.details).toEqual({ changes: {} });
      const forbidden = [privateNote, '77.25', 'monthlySpendingLimit', 'connectionId', 'cost_micro_usd'];
      const { rows: secrets } = await bench.owner.db.execute<{ s: string }>(sql`
        select password_hash as s from users where tenant_id = ${a.id} and password_hash is not null
        union all select signing_pin_hash from users where tenant_id = ${a.id} and signing_pin_hash is not null
        union all select token_hash from sessions where tenant_id = ${a.id}
        union all select token_hash from user_tokens where tenant_id = ${a.id}
        union all select follow_up_code_hash from incidents where tenant_id = ${a.id} and follow_up_code_hash is not null
        union all select wrapped_key from data_exports where tenant_id = ${a.id} and wrapped_key is not null`);
      expect(secrets.length).toBeGreaterThan(5);
      const files = (await readdir(out, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
      for (const f of files) {
        const body = await readFile(join(f.parentPath, f.name), 'utf8');
        for (const t of theirs) expect(`${f.name}: ${body.includes(t.id)}`).toBe(`${f.name}: false`);
        for (const s of secrets) expect(`${f.name}: ${body.includes(s.s)}`).toBe(`${f.name}: false`);
        for (const word of forbidden) expect(`${f.name}: ${word}: ${body.includes(word)}`).toBe(`${f.name}: ${word}: false`);
      }
    });

    it('is downloaded at most five times, then expires: the file deleted, the record kept', async () => {
      for (let i = 2; i <= 5; i++) await download(second.cookie, asked.id).expect(200);
      expect(json(await download(a.cookie, asked.id).expect(409))).toEqual({ code: 'download_limit' });
      const [row] = await bench.owner.db.select().from(dataExports).where(eq(dataExports.id, asked.id));
      expect(row.downloads).toBe(5);
      // Past its last day.
      await bench.owner.db.execute(sql`update data_exports set expires_at = now() - interval '1 minute' where id = ${asked.id}`);
      expect(await worker.run(new Date(), [a.id])).toMatchObject({ expired: 1 });
      const [gone] = await bench.owner.db.select().from(dataExports).where(eq(dataExports.id, asked.id));
      expect(gone).toMatchObject({ status: 'expired', storageKey: null, wrappedKey: null, archiveSha256: row.archiveSha256 });
      expect(existsSync(join(storage.root, row.storageKey!))).toBe(false);
      expect(await audits(a, 'data_export_expired')).toEqual([{ actorId: null, changes: { exportId: asked.id, by: 'expiry' } }]);
      expect(json(await download(a.cookie, asked.id).expect(410))).toEqual({ code: 'expired' });
    });
  });

  describe('refusing, cancelling and lapsing', () => {
    it('is cancelled only by the one who asked, and refused only by another, with a reason', async () => {
      const one = (await post(second.cookie, '', { reason: 'on_request', password }).expect(201)).body;
      expect((await post(a.cookie, `/${one.id}/cancel`, { revision: one.revision }).expect(403)).body).toEqual({ code: 'not_requester' });
      const cancelled = (await post(second.cookie, `/${one.id}/cancel`, { revision: one.revision }).expect(200)).body;
      expect(cancelled.status).toBe('cancelled');
      expect(await audits(a, 'data_export_cancelled')).toEqual([{ actorId: second.id, changes: { exportId: one.id } }]);
      const two = (await post(second.cookie, '', { reason: 'on_request', password }).expect(201)).body;
      expect((await post(second.cookie, `/${two.id}/refuse`, { reason: 'Mine.', revision: two.revision }).expect(403)).body).toEqual({ code: 'same_person' });
      await post(a.cookie, `/${two.id}/refuse`, { reason: '', revision: two.revision }).expect(400);
      const refused = (await post(a.cookie, `/${two.id}/refuse`, { reason: 'Not needed: the contract continues.', revision: two.revision }).expect(200)).body;
      expect(refused).toMatchObject({ status: 'refused', refusedBy: { id: a.adminId }, refusedReason: 'Not needed: the contract continues.' });
      await post(third.cookie, `/${two.id}/approve`, { password, revision: refused.revision }).expect(409);
    });

    it('lapses when nobody approves it within 7 days', async () => {
      const three = (await post(third.cookie, '', { reason: 'on_request', password }).expect(201)).body;
      await bench.owner.db.execute(sql`update data_exports set lapses_at = now() - interval '1 minute' where id = ${three.id}`);
      expect((await post(a.cookie, `/${three.id}/approve`, { password, revision: three.revision }).expect(409)).body).toEqual({ code: 'lapsed' });
      expect(await worker.run(new Date(), [a.id])).toMatchObject({ lapsed: 1, made: 0 });
      const [row] = await bench.owner.db.select().from(dataExports).where(eq(dataExports.id, three.id));
      expect(row.status).toBe('lapsed');
      expect(await audits(a, 'data_export_lapsed')).toEqual([{ actorId: null, changes: { exportId: three.id } }]);
      // A new one may be asked for.
      await post(third.cookie, '', { reason: 'on_request', password }).expect(201);
    });
  });

  describe('the worker’s safeguards (security review 19)', () => {
    let bSecond: Staff;
    const askAndApprove = async () => {
      const asked = (await post(b.cookie, '', { reason: 'on_request', password }).expect(201)).body;
      await post(bSecond.cookie, `/${asked.id}/approve`, { password, revision: asked.revision }).expect(200);
      return asked.id as string;
    };
    const rowOf = async (id: string) => (await bench.owner.db.select().from(dataExports).where(eq(dataExports.id, id)))[0];

    beforeAll(async () => {
      bSecond = await independentAdmin(b, 'bsecond');
    }, 60_000);

    it('fails a claim silent at its last try, as stopped, and tells the two (M1)', async () => {
      const id = await askAndApprove();
      await bench.owner.db.execute(sql`update data_exports set status = 'making', attempts = 3, claimed_at = now() - interval '31 minutes' where id = ${id}`);
      expect(await worker.run(new Date(), [b.id])).toMatchObject({ made: 0, failed: 1 });
      expect(await rowOf(id)).toMatchObject({ status: 'failed', errorKind: 'stopped', attempts: 3 });
      expect((await audits(b, 'data_export_failed')).map((e) => e.changes)).toContainEqual({ exportId: id, kind: 'stopped', attempt: 3, final: true });
    });

    it('gives up an attempt another run took over, and touches nothing of the other’s (M2)', async () => {
      const id = await askAndApprove();
      const running = worker.run(new Date(), [b.id]);
      for (let i = 0; i < 2000 && (await rowOf(id)).status !== 'making'; i++) await new Promise((r) => setTimeout(r, 5));
      // Another run takes it over: its own try.
      await bench.owner.db.execute(sql`update data_exports set attempts = attempts + 1 where id = ${id}`);
      expect(await running).toMatchObject({ made: 0 });
      expect(await rowOf(id)).toMatchObject({ status: 'making', attempts: 2, storageKey: null });
      expect(existsSync(join(storage.root, 'work', b.id, id, '1'))).toBe(false);
      // The other run, as if it stopped: freed for the next test.
      await bench.owner.db.execute(sql`update data_exports set status = 'failed' where id = ${id}`);
    }, 60_000);

    it('keeps one archive ready per client: the one before expires, its file deleted (L7)', async () => {
      const first = await askAndApprove();
      expect(await worker.run(new Date(), [b.id])).toMatchObject({ made: 1 });
      const before = await rowOf(first);
      const second_ = await askAndApprove();
      expect(await worker.run(new Date(), [b.id])).toMatchObject({ made: 1 });
      expect(await rowOf(first)).toMatchObject({ status: 'expired', storageKey: null });
      expect(existsSync(join(storage.root, before.storageKey!))).toBe(false);
      expect((await audits(b, 'data_export_expired')).map((e) => e.changes)).toContainEqual({ exportId: first, by: 'replaced' });
      expect(await rowOf(second_)).toMatchObject({ status: 'ready' });
    }, 120_000);

    it('counts no download of an archive that cannot be opened whole (L4)', async () => {
      const [ready] = await bench.owner.db.select().from(dataExports).where(and(eq(dataExports.tenantId, b.id), eq(dataExports.status, 'ready')));
      const path = join(storage.root, ready.storageKey!);
      const bytes = await readFile(path);
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      await writeFile(path, bytes);
      expect(json(await download(b.cookie, ready.id).expect(409))).toEqual({ code: 'archive_unavailable' });
      expect(await rowOf(ready.id)).toMatchObject({ downloads: 0 });
      expect(await audits(b, 'data_export_downloaded')).toEqual([]);
    });
  });
});
