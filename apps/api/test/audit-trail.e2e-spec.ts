import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AuditKeys } from '../src/audit/audit-keys.js';
import { AuditChainCheck, fullCheckDayOf } from '../src/audit/chain-check.service.js';
import { createDatabase } from '../src/database/client.js';
import {
  auditChainCheckpoints,
  auditChainHeads,
  auditChainVerifications,
  auditLog,
  emailOutbox,
  emailQueue,
  notifications,
  users,
} from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { EmailWorker } from '../src/email/email-worker.service.js';
import { requireEnv } from '../src/env.js';
import { ProvisioningService } from '../src/identity/provisioning.service.js';
import { dayOf, momentIn, shiftDay, startOfDay } from '../src/i18n/time-zones.js';
import { daytimeZone, testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

/**
 * The audit trail's viewer, its files, external reviewers and Trustline's
 * mirrored actions (docs/specs/audit-trail.md, steps 4 to 7), and security
 * review 12 of the seal.
 */
describe('the audit trail', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  let check: AuditChainCheck;
  let a: Hospital;
  let b: Hospital;
  let unit: string;
  let quality: Staff;
  let reporter: Staff;
  let auditor: Staff; // audit.view only: told no reporter
  const password = `hospital-pass-${run}`;
  const http = () => bench.http();
  const get = (cookie: string, url: string) => http().get(url).set('Cookie', cookie);
  const entries = async (cookie: string, query = '') =>
    (await get(cookie, `/audit/entries${query}`).expect(200)).body as {
      items: { id: string; seq: number; action: string; actor: { kind: string; id?: string; name?: unknown }; entity: { type: string; id: string; label: unknown; canOpen: boolean } | null; details: Record<string, unknown> | null; ip: string | null; sealedLate: boolean }[];
      more: boolean;
      next: string | null;
      total: number;
      totalCapped: boolean;
    };
  const report = async (who: Staff, extra: Record<string, unknown> = {}, h: Hospital = a, at = unit) =>
    (
      await http()
        .post('/incidents')
        .set('Cookie', who.cookie)
        .send({
          type: 'incident',
          categoryId: h.categories.equipment,
          orgUnitId: at,
          occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
          description: 'A bed rail would not lock.',
          harmLevel: 'none',
          anonymous: false,
          ...extra,
        })
        .expect((res) => {
          if (res.status !== 201) throw new Error(`report: ${res.status} ${JSON.stringify(res.body)}`);
        })
    ).body as { id: string; reference: string };
  const appDb = () => {
    const app = createDatabase(requireEnv('APP_DATABASE_URL'));
    return { ...app, tenantDb: new TenantDb(app.db) };
  };
  const denied = { cause: { code: '42501' } };

  beforeAll(async () => {
    bench = await testBench('atr', run);
    check = bench.app.get(AuditChainCheck);
    a = await bench.createHospital('a');
    b = await bench.createHospital('b');
    unit = await bench.createUnit(a, 'department', `W-${run}`, null);
    quality = await bench.createStaff(a, 'quality', { role: 'quality_officer', orgUnitId: null });
    reporter = await bench.createStaff(a, 'reporter', { role: 'reporter', orgUnitId: null });
    await bench.createRole(a, 'auditor', ['audit.view']);
    auditor = await bench.createStaff(a, 'auditor', { role: 'auditor', orgUnitId: null });
  }, 90_000);

  afterAll(() => bench.close());

  describe('security review 12', () => {
    it('H1: no role but the owner makes a temporary table, and every function run as the owner names pg_temp last', async () => {
      const app = appDb();
      const platform = createDatabase(requireEnv('PLATFORM_DATABASE_URL'));
      try {
        // The redirection the review proved: a temporary head, then an entry.
        await expect(
          app.tenantDb.withTenant(a.id, async (tx) => {
            await tx.execute(sql`create temp table audit_chain_heads (tenant_id uuid primary key, seq bigint, hash text, updated_at timestamptz)`);
            await tx.insert(auditLog).values({ tenantId: a.id, action: 'sign_out', entityType: 'user', entityId: a.adminId });
          }),
        ).rejects.toMatchObject(denied);
        await expect(
          platform.db.transaction(async (tx) => {
            await tx.execute(sql`create temp table audit_chain (tenant_id uuid, seq bigint)`);
          }),
        ).rejects.toMatchObject(denied);
      } finally {
        await app.pool.end();
        await platform.pool.end();
      }
      const { rows } = await bench.owner.db.execute<{ name: string; config: string[] | null }>(sql`
        select p.proname as name, p.proconfig as config from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef`);
      expect(rows.length).toBeGreaterThanOrEqual(5);
      for (const row of rows) {
        const path = (row.config ?? []).find((c) => c.startsWith('search_path='));
        expect(`${row.name}: ${path}`).toMatch(/: search_path=.*pg_temp$/);
      }
    });

    it('H2: an entry sealed while a check runs is left for the next one, not taken for a break', async () => {
      const h = await bench.createHospital('during');
      const [before] = await bench.owner.db.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, h.id));
      expect(before.seq).toBeGreaterThan(2);
      const app = appDb();
      let wrote = false;
      check.batch = 2;
      check.afterBatch = async () => {
        if (wrote) return;
        wrote = true;
        await app.tenantDb.withTenant(h.id, (tx) =>
          tx.insert(auditLog).values({ tenantId: h.id, action: 'sign_out', entityType: 'user', entityId: h.adminId }),
        );
      };
      try {
        const result = await check.verify(h.id, { full: true });
        expect(wrote).toBe(true);
        expect(result).toMatchObject({ result: 'passed', toSeq: before.seq });
        // And the next one takes it in.
        check.afterBatch = undefined;
        expect(await check.verify(h.id, { full: true })).toMatchObject({ result: 'passed', toSeq: before.seq + 1 });
      } finally {
        check.batch = 10_000;
        check.afterBatch = undefined;
        await app.pool.end();
      }
    });

    it('M1: a check runs in full on its client’s own day of the week, and is dated by the database', async () => {
      const h = await bench.createHospital('fullday');
      const zone = daytimeZone();
      await http().patch(`/platform/tenants/${h.id}`).set('Cookie', bench.platform).send({ timeZone: zone }).expect(200);
      expect(await check.verify(h.id)).toMatchObject({ result: 'passed', full: true });
      // The latest past day of each kind, other than today.
      const today = dayOf(new Date(), zone);
      const pastDay = (pick: (weekday: number) => boolean) => {
        for (let i = 1; i <= 8; i++) {
          const day = shiftDay(today, -i);
          if (pick(new Date(`${day}T00:00:00Z`).getUTCDay())) return new Date(startOfDay(day, zone).getTime() + 3 * 3_600_000);
        }
        throw new Error('no day');
      };
      const full = fullCheckDayOf(h.id);
      expect(await check.verify(h.id, { scheduled: zone, now: pastDay((w) => w !== full) })).toMatchObject({ full: false });
      expect(await check.verify(h.id, { scheduled: zone, now: pastDay((w) => w === full) })).toMatchObject({ full: true });
      // Whatever the application says, a run is dated now, and a checkpoint
      // is never dated ahead.
      const app = appDb();
      try {
        await app.tenantDb.withTenant(h.id, (tx) =>
          tx.insert(auditChainVerifications).values({
            tenantId: h.id,
            runAt: new Date('2099-01-01T00:00:00Z'),
            fromSeq: 1,
            toSeq: 1,
            full: true,
            result: 'passed',
          }),
        );
        const [latest] = await bench.owner.db
          .select({ runAt: auditChainVerifications.runAt })
          .from(auditChainVerifications)
          .where(eq(auditChainVerifications.tenantId, h.id))
          .orderBy(desc(auditChainVerifications.runAt))
          .limit(1);
        expect(Math.abs(latest.runAt.getTime() - Date.now())).toBeLessThan(60_000);
        await expect(
          app.tenantDb.withTenant(h.id, (tx) =>
            tx.insert(auditChainCheckpoints).values({ tenantId: h.id, seq: 1, hash: '0'.repeat(64), at: new Date(Date.now() + 86_400_000) }),
          ),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
        // L3: and a result names a checkpoint of its own client only.
        const [theirs] = await bench.owner.db.select({ id: auditChainCheckpoints.id }).from(auditChainCheckpoints).where(eq(auditChainCheckpoints.tenantId, h.id)).limit(1);
        await expect(
          app.tenantDb.withTenant(a.id, (tx) =>
            tx.insert(auditChainVerifications).values({ tenantId: a.id, fromSeq: 1, toSeq: 1, full: true, result: 'passed', checkpointId: theirs.id }),
          ),
        ).rejects.toMatchObject({ cause: { code: '23503' } });
      } finally {
        await app.pool.end();
      }
    });

    it('M2: a checkpoint under a key nobody knows is a break, unless the key was retired', async () => {
      const h = await bench.createHospital('unknownkey');
      await check.verify(h.id);
      await bench.owner.db.update(auditChainCheckpoints).set({ keyId: 'ed25519-0000000000000000' }).where(eq(auditChainCheckpoints.tenantId, h.id));
      expect(await check.verify(h.id)).toMatchObject({ result: 'failed', kind: 'bad_checkpoint' });
      const saved = process.env.AUDIT_RETIRED_KEY_IDS;
      process.env.AUDIT_RETIRED_KEY_IDS = 'ed25519-0000000000000000';
      try {
        const keys = new AuditKeys();
        const [cp] = await bench.owner.db.select().from(auditChainCheckpoints).where(eq(auditChainCheckpoints.tenantId, h.id));
        expect(keys.check({ ...cp, tenantId: h.id })).toBe('retired');
      } finally {
        if (saved === undefined) delete process.env.AUDIT_RETIRED_KEY_IDS;
        else process.env.AUDIT_RETIRED_KEY_IDS = saved;
      }
    });

    it('M3: the application never dates an entry, and an unsealed one is found whatever its date', async () => {
      const h = await bench.createHospital('dated');
      const app = appDb();
      try {
        await app.tenantDb.withTenant(h.id, (tx) =>
          tx.insert(auditLog).values({ tenantId: h.id, action: 'sign_out', entityType: 'user', entityId: h.adminId, occurredAt: new Date('2099-01-01T00:00:00Z') }),
        );
      } finally {
        await app.pool.end();
      }
      const [latest] = await bench.owner.db.select().from(auditLog).where(eq(auditLog.tenantId, h.id)).orderBy(desc(auditLog.occurredAt)).limit(1);
      expect(latest.occurredAt.getTime()).toBeLessThan(Date.now() + 60_000);
      expect(await check.verify(h.id)).toMatchObject({ result: 'passed' });
      // Round the trigger, dated far ahead: found by the daily check too.
      await bench.owner.db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.execute(sql`insert into audit_log (tenant_id, action, entity_type, entity_id, occurred_at)
          values (${h.id}, 'sign_out', 'user', ${h.adminId}, '2099-01-01T00:00:00Z')`);
      });
      expect(await check.verify(h.id)).toMatchObject({ result: 'failed', kind: 'missing_seal', full: false });
    });

    it('L2: a bad checkpoint is taken as found only when the next check finds it again', async () => {
      const h = await bench.createHospital('confirm');
      await check.verify(h.id);
      await bench.owner.db.update(auditChainCheckpoints).set({ signature: Buffer.alloc(64).toString('base64') }).where(eq(auditChainCheckpoints.tenantId, h.id));
      const told = () =>
        bench.owner.db.select().from(notifications).where(and(eq(notifications.userId, h.adminId), eq(notifications.kind, 'audit_chain_broken')));
      expect(await check.verify(h.id)).toMatchObject({ result: 'failed', kind: 'bad_checkpoint' });
      expect(await told()).toEqual([]);
      expect((await get(h.cookie, '/audit/status').expect(200)).body.broken).toBeNull();
      expect(await check.verify(h.id)).toMatchObject({ result: 'failed', kind: 'bad_checkpoint' });
      expect(await told()).toHaveLength(1);
      expect((await get(h.cookie, '/audit/status').expect(200)).body).toMatchObject({
        broken: { kind: 'bad_checkpoint' },
        lastCheck: { result: 'failed', signed: false },
      });
    });

    it('L4: an action or entity type is one word', async () => {
      await expect(
        bench.owner.db.insert(auditLog).values({ tenantId: b.id, action: 'sign_out\nentityType: user' }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(
        bench.owner.db.insert(auditLog).values({ tenantId: b.id, action: 'sign_out', entityType: 'user\nx' }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });

    it('L6: enabling again someone who holds policies.import names them to the others', async () => {
      const importer = await bench.createStaff(a, 'returning', { role: 'quality_officer', orgUnitId: null });
      await http().patch(`/users/${importer.id}`).set('Cookie', a.cookie).send({ status: 'disabled' }).expect(200);
      const before = (await bench.owner.db.select().from(notifications).where(and(eq(notifications.userId, quality.id), eq(notifications.kind, 'policies_import_granted')))).length;
      await http().patch(`/users/${importer.id}`).set('Cookie', a.cookie).send({ status: 'active' }).expect(200);
      const after = await bench.owner.db.select({ data: notifications.data }).from(notifications).where(and(eq(notifications.userId, quality.id), eq(notifications.kind, 'policies_import_granted')));
      expect(after).toHaveLength(before + 1);
      expect(after.map((n) => n.data.personId)).toContain(importer.id);
    });
  });

  describe('GET /audit/entries (step 4)', () => {
    let named: { id: string; reference: string };
    let anonymous: { id: string; reference: string };

    beforeAll(async () => {
      named = await report(reporter);
      anonymous = await report(reporter, { anonymous: true });
    });

    it('is refused without a session, without audit.view for the whole organization, and for bad input', async () => {
      await http().get('/audit/entries').expect(401);
      expect((await get(reporter.cookie, '/audit/entries').expect(403)).body).toMatchObject({ code: 'missing_permission', permission: 'audit.view' });
      await bench.createRole(a, 'unit_audit', ['audit.view']);
      const unitAuditor = await bench.createStaff(a, 'unitaudit', { role: 'unit_audit', orgUnitId: unit });
      await get(unitAuditor.cookie, '/audit/entries').expect(403);
      for (const query of [
        '?pageSize=0',
        '?pageSize=201',
        '?actions=not_an_action',
        '?area=nowhere',
        `?entityId=${a.id}`,
        '?from=2026-02-01&to=2026-01-01',
        '?before=not-a-cursor',
        '?other=1',
        `?reference=X&entityType=incident`,
      ]) {
        await get(a.cookie, `/audit/entries${query}`).expect(400);
      }
    });

    it('lists newest first by key, with every filter, and a capped total', async () => {
      const all = await entries(a.cookie, '?pageSize=200');
      expect(all.items.length).toBeGreaterThan(5);
      expect(all.total).toBe(all.items.length);
      expect(all.totalCapped).toBe(false);
      // Pages by key: no entry twice, none left out.
      const first = await entries(a.cookie, '?pageSize=3');
      expect(first.more).toBe(true);
      const second = await entries(a.cookie, `?pageSize=3&before=${first.next}`);
      expect([...first.items, ...second.items].map((e) => e.id)).toEqual(all.items.slice(0, 6).map((e) => e.id));
      // By record, as a reference.
      const byReference = await entries(a.cookie, `?reference=${named.reference}`);
      expect(byReference.items.map((e) => e.action)).toEqual(['incident_reported']);
      expect(byReference.items[0].entity).toMatchObject({ type: 'incident', id: named.id, label: named.reference, canOpen: true });
      // By record, by its type and id.
      expect((await entries(a.cookie, `?entityType=user&entityId=${reporter.id}`)).items.map((e) => e.action)).toEqual(
        expect.arrayContaining(['user_created', 'sign_in']),
      );
      // By area and action.
      const signIns = await entries(a.cookie, '?area=sign_in');
      expect(signIns.items.every((e) => ['sign_in', 'sign_in_failed', 'sign_out', 'password_set'].includes(e.action))).toBe(true);
      expect(signIns.items.find((e) => e.action === 'sign_in')?.ip).toEqual(expect.any(String));
      expect((await entries(a.cookie, '?actions=role_created,user_created')).items.every((e) => ['role_created', 'user_created'].includes(e.action))).toBe(true);
      // By person, and by day.
      expect((await entries(a.cookie, `?actorId=${quality.id}`)).items.every((e) => e.actor.id === quality.id)).toBe(true);
      const today = dayOf(new Date(), 'UTC');
      expect((await entries(a.cookie, `?from=${shiftDay(today, 1)}`)).items).toEqual([]);
      expect((await entries(a.cookie, `?from=${shiftDay(today, -1)}&to=${shiftDay(today, 1)}`)).items.length).toBe(all.items.length);
      // Each with its seal; none of a new client recorded before the seal.
      expect(all.items.every((e) => Number.isInteger(e.seq) && e.sealedLate === false)).toBe(true);
      // Another client's record names nothing here.
      expect((await entries(b.cookie, `?entityType=incident&entityId=${named.id}`)).items).toEqual([]);
      expect((await entries(b.cookie, `?reference=${named.reference}`)).items).toEqual([]);
    });

    it('shows the reporter, and whether a report was anonymous, only to those told the reporter', async () => {
      const told = (await entries(a.cookie, `?reference=${named.reference}`)).items[0];
      expect(told.actor).toMatchObject({ kind: 'person', id: reporter.id });
      expect(told.details).toMatchObject({ anonymous: false });
      const masked = (await entries(auditor.cookie, `?reference=${named.reference}`)).items[0];
      expect(masked.actor).toEqual({ kind: 'reporter' });
      expect(masked.details).not.toHaveProperty('anonymous');
      expect((await entries(a.cookie, `?reference=${anonymous.reference}`)).items[0].actor).toEqual({ kind: 'anonymous' });
      expect((await entries(auditor.cookie, `?reference=${anonymous.reference}`)).items[0].actor).toEqual({ kind: 'reporter' });
      // A person filter does not list what a colleague reported.
      const theirs = await entries(auditor.cookie, `?actorId=${reporter.id}`);
      expect(theirs.items.some((e) => e.action === 'incident_reported')).toBe(false);
      expect((await entries(a.cookie, `?actorId=${reporter.id}`)).items.some((e) => e.action === 'incident_reported')).toBe(true);
      // Nor does the auditor open the incident.
      expect(masked.entity).toMatchObject({ canOpen: false });
    });

    it('hides the entries of a module the client no longer has, and keeps them in the chain as seals', async () => {
      const c = await bench.createHospital('nomodule');
      const cUnit = await bench.createUnit(c, 'department', `C-${run}`, null);
      const cReporter = await bench.createStaff(c, 'creporter', { role: 'reporter', orgUnitId: null });
      const filed = await report(cReporter, {}, c, cUnit);
      const plan = (
        await http()
          .post('/platform/plans')
          .set('Cookie', bench.platform)
          .send({
            code: `${bench.prefix}-docs`,
            name: { en: 'Documents', ar: 'وثائق', fr: 'Documents' },
            modules: ['policies'],
            limits: { users: null, sites: null, storageMb: null, aiCreditsPerMonth: null },
            extras: { sso: false, publicReporting: false, clinicalAiSuggestions: false },
          })
          .expect(201)
      ).body as { id: string };
      await http().patch(`/platform/tenants/${c.id}/subscription`).set('Cookie', bench.platform).send({ planId: plan.id }).expect(200);
      const shown = await entries(c.cookie, '?pageSize=200');
      expect(shown.items.some((e) => e.action.startsWith('incident_'))).toBe(false);
      expect((await entries(c.cookie, `?reference=${filed.reference}`)).items).toEqual([]);
      const file = (await get(c.cookie, '/audit/exports/chain').expect(200)).text;
      const [seal] = await bench.owner.db.execute<{ seq: string }>(sql`
        select c.seq::text as seq from audit_chain c join audit_log a on a.id = c.entry_id
        where a.tenant_id = ${c.id} and a.action = 'incident_reported'`).then((r) => r.rows);
      const line = file.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.seq === Number(seal.seq));
      expect(line).toMatchObject({ type: 'entry', hash: expect.any(String) });
      expect(line).not.toHaveProperty('body');
    });
  });

  describe('exports (step 5)', () => {
    it('the trail as a CSV in the client’s language, refused as the viewer is, and audited', async () => {
      await http().get('/audit/exports/entries').expect(401);
      await get(reporter.cookie, '/audit/exports/entries').expect(403);
      expect((await get(a.cookie, '/audit/exports/entries?locale=fr').expect(400)).body).toEqual({ code: 'language_mismatch' });
      await get(a.cookie, '/audit/exports/entries?pageSize=3').expect(400);
      const res = await get(a.cookie, '/audit/exports/entries?area=accounts').expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('"No.","When","Who","Area","What","Record","Reference","Details","Address","Recorded before the trail was sealed"');
      expect(lines.some((l) => l.includes('"Accounts and roles","User added"'))).toBe(true);
      const [entry] = await bench.owner.db
        .select({ actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'audit_entries_exported')));
      expect(entry).toMatchObject({ actorId: a.adminId, changes: { filters: { area: 'accounts' }, locale: 'en', rows: lines.length - 1 } });
    });

    it('the chain file, checked by the published script against the published keys; a changed line fails it', async () => {
      await check.verify(a.id, { full: true });
      await http().get('/audit/exports/chain').expect(401);
      await get(auditor.cookie, '/audit/exports/chain?fromSeq=5&toSeq=2').expect(400);
      const res = await get(a.cookie, '/audit/exports/chain').expect(200);
      expect(res.headers['content-disposition']).toMatch(/audit-chain-.*\.jsonl/);
      const lines = res.text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ type: 'header', format: 'trustline-audit-chain', version: 1, tenant: a.id, firstSeq: 1 });
      expect(lines.some((l) => l.type === 'checkpoint')).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), 'trustline-chain-'));
      const file = join(dir, 'chain.jsonl');
      const keys = join(dir, 'keys.json');
      writeFileSync(file, res.text);
      writeFileSync(keys, JSON.stringify((await http().get('/audit/keys').expect(200)).body));
      const script = resolve(import.meta.dirname, '../scripts/verify-audit-chain.mjs');
      expect(execFileSync(process.execPath, [script, file, keys], { encoding: 'utf8' })).toContain('Every check held.');
      // One body changed: found.
      const changed = res.text.replace(/"body":"trustline-audit-entry-v1\\nid: ([0-9a-f-]+)/, '"body":"trustline-audit-entry-v1\\nid: $1x');
      expect(changed).not.toBe(res.text);
      writeFileSync(file, changed);
      expect(() => execFileSync(process.execPath, [script, file, keys], { encoding: 'utf8' })).toThrow();
      // Withheld for whoever may not see an entry in full: the reporter's.
      const masked = (await get(auditor.cookie, '/audit/exports/chain').expect(200)).text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const full = lines.filter((l) => l.type === 'entry' && typeof l.body === 'string' && (l.body as string).includes('action: incident_reported'));
      expect(full.length).toBeGreaterThan(0);
      for (const l of full) {
        expect(masked.find((m) => m.seq === l.seq)).not.toHaveProperty('body');
      }
      const exported = await bench.owner.db.select({ changes: auditLog.changes }).from(auditLog).where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'audit_chain_exported')));
      expect(exported.length).toBeGreaterThanOrEqual(2);
    });

    it('the signed checkpoints, as a JSON file, audited', async () => {
      await http().get('/audit/checkpoints').expect(401);
      await get(reporter.cookie, '/audit/checkpoints').expect(403);
      await get(a.cookie, '/audit/checkpoints?from=2026-02-01&to=2026-01-01').expect(400);
      const file = (await get(a.cookie, '/audit/checkpoints').expect(200)).body;
      expect(file).toMatchObject({ format: 'trustline-audit-checkpoints', tenant: a.id, publicKeys: [expect.objectContaining({ current: true })] });
      expect(file.checkpoints.length).toBeGreaterThan(0);
      expect(file.checkpoints[0]).toMatchObject({ tenant: a.id, keyId: expect.any(String), signature: expect.any(String) });
      const [entry] = await bench.owner.db.select({ changes: auditLog.changes }).from(auditLog).where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'audit_checkpoints_exported')));
      expect(entry.changes).toMatchObject({ checkpoints: file.checkpoints.length });
    });
  });

  describe('external reviewers (step 6)', () => {
    let zone: string;
    let today: string;
    let reviewer: { id: string; email: string; cookie: string };
    const grant = (cookie: string, body: Record<string, unknown>) => http().post('/users/external').set('Cookie', cookie).send(body);
    const body = (extra: Record<string, unknown> = {}) => ({
      name: { en: 'A. Surveyor' },
      email: `surveyor-${randomBytes(3).toString('hex')}-${run}@test.invalid`,
      organization: 'Accreditation body',
      purpose: 'Survey',
      from: today,
      until: shiftDay(today, 4),
      roleId: a.roles.external_reviewer,
      ...extra,
    });
    const codeFor = async (userId: string) => {
      const [mail] = await bench.owner.db
        .select({ text: emailOutbox.textBody })
        .from(emailOutbox)
        .innerJoin(emailQueue, eq(emailQueue.id, emailOutbox.queueId))
        .where(and(eq(emailQueue.userId, userId), eq(emailQueue.category, 'sign_in_code')))
        .orderBy(desc(emailOutbox.createdAt))
        .limit(1);
      return /\b(\d{6})\b/.exec(mail.text)![1];
    };
    const signIn = async (email: string) => {
      const first = (await http().post('/auth/login').send({ org: a.slug, email, password }).expect(200)).body;
      expect(first).toEqual({ code: 'one_time_code_sent', challenge: expect.any(String) });
      return first.challenge as string;
    };

    beforeAll(async () => {
      zone = (await http().get('/auth/me').set('Cookie', a.cookie).expect(200)).body.tenant.timeZone;
      today = dayOf(new Date(), zone);
    });

    it('is granted only by whoever manages users and reads the trail for the whole organization, with what only reads, for 30 days at most', async () => {
      await http().post('/users/external').send(body()).expect(401);
      expect((await grant(quality.cookie, body()).expect(403)).body).toMatchObject({ code: 'missing_permission' });
      for (const bad of [
        { ...body(), extra: 1 },
        { ...body(), email: 'not an email' },
        { ...body(), from: 'tomorrow' },
      ]) {
        await grant(a.cookie, bad).expect(400);
      }
      expect((await grant(a.cookie, body({ until: shiftDay(today, 30) })).expect(400)).body).toMatchObject({ code: 'access_too_long' });
      expect((await grant(a.cookie, body({ from: shiftDay(today, -1) })).expect(400)).body).toMatchObject({ code: 'access_in_past' });
      expect((await grant(a.cookie, body({ roleId: a.roles.quality_officer })).expect(400)).body).toMatchObject({ code: 'not_read_only' });
      await bench.createRole(a, 'peeker', ['incidents.view', 'incidents.see_reporter']);
      expect((await grant(a.cookie, body({ roleId: a.roles.peeker })).expect(400)).body).toMatchObject({ code: 'not_read_only', permissions: ['incidents.see_reporter'] });
      await grant(a.cookie, body({ roleId: b.roles.external_reviewer })).expect(404);
      await grant(a.cookie, body({ email: quality.email })).expect(409);
    });

    it('signs in with a password and a one-time code by email, is not a named user, and is told who granted it', async () => {
      const { ProvisioningService: _p } = { ProvisioningService };
      const named = () => bench.app.get(TenantDb).withTenant(a.id, (tx) => bench.app.get(ProvisioningService).countNamedUsers(tx));
      const before = await named();
      const second = await bench.createStaff(a, 'secondadmin', { role: 'administrator', orgUnitId: null });
      const granted = (await grant(a.cookie, body({ until: shiftDay(today, 29) })).expect(201)).body;
      expect(granted.reviewer).toMatchObject({ status: 'invited', organization: 'Accreditation body', from: today, until: shiftDay(today, 29), revision: 0, role: { code: 'external_reviewer' } });
      expect(await named()).toBe(before + 1); // the second administrator, not the reviewer
      await http().post('/auth/invite/accept').send({ org: a.slug, token: granted.invite.token, password }).expect(204);
      const challenge = await signIn(granted.reviewer.email);
      // A wrong code: refused, and recorded.
      await http().post('/auth/login/code').send({ org: a.slug, challenge, code: '000000' === (await codeFor(granted.reviewer.id)) ? '111111' : '000000' }).expect(401);
      const res = await http().post('/auth/login/code').send({ org: a.slug, challenge, code: await codeFor(granted.reviewer.id) }).expect(200);
      reviewer = { id: granted.reviewer.id, email: granted.reviewer.email, cookie: bench.cookieOf(res) };
      // Once only.
      await http().post('/auth/login/code').send({ org: a.slug, challenge, code: await codeFor(granted.reviewer.id) }).expect(401);
      const me = (await get(reviewer.cookie, '/auth/me').expect(200)).body;
      expect(me.user).toMatchObject({ kind: 'external_reviewer', access: { from: today, until: shiftDay(today, 29) } });
      expect(me.permissions).toEqual(['audit.view', 'incidents.view', 'policies.view_all', 'reports.view']);
      const audit = await bench.owner.db.select({ action: auditLog.action, changes: auditLog.changes }).from(auditLog).where(eq(auditLog.entityId, reviewer.id));
      expect(audit).toEqual(
        expect.arrayContaining([
          { action: 'external_access_granted', changes: expect.objectContaining({ organization: 'Accreditation body', purpose: 'Survey' }) },
          { action: 'sign_in_failed', changes: { locked: false, reason: 'wrong_code' } },
          { action: 'sign_in', changes: { client: 'web', secondFactor: 'email_code' } },
        ]),
      );
      expect(
        await bench.owner.db.select({ data: notifications.data }).from(notifications).where(and(eq(notifications.userId, second.id), eq(notifications.kind, 'external_access_changed'))),
      ).toEqual([{ data: { change: 'granted', personId: reviewer.id, serious: false } }]);
    });

    it('reads, never writes, never sees a reporter, and every record it opens is recorded', async () => {
      const filed = await report(reporter);
      // Every write refused, whatever the role says; signing out apart.
      expect((await http().post('/incidents').set('Cookie', reviewer.cookie).send({}).expect(403)).body).toEqual({ code: 'read_only_access' });
      expect((await http().post('/notifications/read-all').set('Cookie', reviewer.cookie).expect(403)).body).toEqual({ code: 'read_only_access' });
      const incident = (await get(reviewer.cookie, `/incidents/${filed.id}`).expect(200)).body;
      expect(JSON.stringify(incident)).not.toContain(reporter.id);
      const trail = await entries(reviewer.cookie, `?reference=${filed.reference}`);
      expect(trail.items[0].actor).toEqual({ kind: 'reporter' });
      const viewed = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.actorId, reviewer.id), eq(auditLog.action, 'external_reviewer_viewed')));
      expect(viewed.map((v) => v.changes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ recordType: 'incident', recordId: filed.id }),
          expect.objectContaining({ route: expect.stringContaining('audit/entries') }),
        ]),
      );
      // Staff routes do not change it.
      expect((await http().put(`/users/${reviewer.id}/roles`).set('Cookie', a.cookie).send({ roles: [] }).expect(409)).body).toEqual({ code: 'external_reviewer' });
      // Nobody else's reading is recorded.
      await get(a.cookie, `/incidents/${filed.id}`).expect(200);
      expect(await bench.owner.db.select().from(auditLog).where(and(eq(auditLog.actorId, a.adminId), eq(auditLog.action, 'external_reviewer_viewed')))).toEqual([]);
    });

    it('is extended once, with a reason, and ended, every step audited and told', async () => {
      const url = `/users/external/${reviewer.id}`;
      await http().patch(url).send({ end: true, revision: 0 }).expect(401);
      await http().patch(url).set('Cookie', quality.cookie).send({ end: true, revision: 0 }).expect(403);
      await http().patch(`/users/external/${quality.id}`).set('Cookie', a.cookie).send({ end: true, revision: 0 }).expect(404);
      await http().patch(url).set('Cookie', b.cookie).send({ end: true, revision: 0 }).expect(404);
      await http().patch(url).set('Cookie', a.cookie).send({ until: shiftDay(today, 31) }).expect(400);
      expect((await http().patch(url).set('Cookie', a.cookie).send({ until: shiftDay(today, 40), reason: 'More', revision: 1 }).expect(409)).body).toEqual({ code: 'stale_access' });
      expect((await http().patch(url).set('Cookie', a.cookie).send({ until: shiftDay(today, 60), reason: 'More', revision: 0 }).expect(400)).body).toMatchObject({ code: 'access_too_long' });
      const extended = (await http().patch(url).set('Cookie', a.cookie).send({ until: shiftDay(today, 40), reason: 'The survey runs on', revision: 0 }).expect(200)).body;
      expect(extended).toMatchObject({ until: shiftDay(today, 40), extensionReason: 'The survey runs on', revision: 1 });
      expect((await http().patch(url).set('Cookie', a.cookie).send({ until: shiftDay(today, 45), reason: 'Again', revision: 1 }).expect(409)).body).toEqual({ code: 'already_extended' });
      const list = (await get(a.cookie, '/users/external').expect(200)).body;
      expect(list.find((r: { id: string }) => r.id === reviewer.id)).toMatchObject({ until: shiftDay(today, 40) });
      await get(quality.cookie, '/users/external').expect(403);
      // Ended: signed out, and no sign-in after.
      const ended = (await http().patch(url).set('Cookie', a.cookie).send({ end: true, revision: 1 }).expect(200)).body;
      expect(ended).toMatchObject({ status: 'disabled', endedAt: expect.any(String) });
      await get(reviewer.cookie, '/auth/me').expect(401);
      await http().post('/auth/login').send({ org: a.slug, email: reviewer.email, password }).expect(401);
      const actions = (await bench.owner.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, reviewer.id))).map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(['external_access_extended', 'external_access_ended']));
    });

    it('is refused outside its days, and ended by the daily check when the last one has passed', async () => {
      const later = (await grant(a.cookie, body({ from: shiftDay(today, 2), until: shiftDay(today, 3) })).expect(201)).body;
      await http().post('/auth/invite/accept').send({ org: a.slug, token: later.invite.token, password }).expect(204);
      await http().post('/auth/login').send({ org: a.slug, email: later.reviewer.email, password }).expect(401);
      const [refused] = await bench.owner.db.select({ changes: auditLog.changes }).from(auditLog).where(and(eq(auditLog.entityId, later.reviewer.id), eq(auditLog.action, 'sign_in_failed')));
      expect(refused.changes).toEqual({ locked: false, reason: 'outside_access' });
      // A session left from before its last day is refused after it.
      const now = (await grant(a.cookie, body()).expect(201)).body;
      await http().post('/auth/invite/accept').send({ org: a.slug, token: now.invite.token, password }).expect(204);
      const challenge = await signIn(now.reviewer.email);
      const cookie = bench.cookieOf(await http().post('/auth/login/code').send({ org: a.slug, challenge, code: await codeFor(now.reviewer.id) }).expect(200));
      await bench.owner.db
        .update(users)
        .set({ accessFrom: shiftDay(today, -3), accessUntil: shiftDay(today, -1) })
        .where(eq(users.id, now.reviewer.id));
      await get(cookie, '/auth/me').expect(401);
      await check.run(new Date(), [a.id]);
      const [after] = await bench.owner.db.select({ status: users.status, endedAt: users.accessEndedAt }).from(users).where(eq(users.id, now.reviewer.id));
      expect(after).toMatchObject({ status: 'disabled', endedAt: expect.any(Date) });
      const [ended] = await bench.owner.db.select({ actorId: auditLog.actorId, changes: auditLog.changes }).from(auditLog).where(and(eq(auditLog.entityId, now.reviewer.id), eq(auditLog.action, 'external_access_ended')));
      expect(ended).toEqual({ actorId: null, changes: { by: 'period_over', until: shiftDay(today, -1) } });
    });
  });

  describe('Trustline’s actions on a client (step 7)', () => {
    it('are written in the client’s own log too, naming the staff member, never their address', async () => {
      const c = await bench.createHospital('mirror');
      await http().patch(`/platform/tenants/${c.id}`).set('Cookie', bench.platform).send({ timeZone: 'Asia/Tokyo' }).expect(200);
      const mirrored = await bench.owner.db
        .select({ action: auditLog.action, actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, c.id), sql`${auditLog.action} in ('client_created_by_platform', 'client_settings_changed_by_platform', 'administrator_created_by_platform')`));
      expect(mirrored).toEqual(
        expect.arrayContaining([
          { action: 'client_created_by_platform', actorId: null, changes: expect.objectContaining({ slug: c.slug, platformAdminName: 'Staff' }) },
          { action: 'client_settings_changed_by_platform', actorId: null, changes: { changes: { timeZone: { from: expect.any(String), to: 'Asia/Tokyo' } }, platformAdminId: expect.any(String), platformAdminName: 'Staff' } },
          { action: 'administrator_created_by_platform', actorId: null, changes: { platformAdminId: expect.any(String), platformAdminName: 'Staff' } },
        ]),
      );
      expect(JSON.stringify(mirrored)).not.toContain('@test.invalid');
      // Shown as Trustline staff, by name.
      const shown = await entries(c.cookie, '?area=trustline');
      expect(shown.items.map((e) => e.actor)).toEqual(expect.arrayContaining([{ kind: 'trustline_staff', name: 'Staff' }]));
    });
  });

  describe('the weekly head, and addresses kept two years', () => {
    it('emails the head to the Administrators once a week, which they cannot switch off', async () => {
      const h = await bench.createHospital('weekly');
      const zone = daytimeZone();
      await http().patch(`/platform/tenants/${h.id}`).set('Cookie', bench.platform).send({ timeZone: zone }).expect(200);
      await http().patch('/me/notification-preferences').set('Cookie', h.cookie).send({ immediate: false, digest: false }).expect(200);
      expect(await check.run(new Date(), [h.id])).toMatchObject({ checked: 1 });
      const [head] = await bench.owner.db.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, h.id));
      const told = () => bench.owner.db.select({ id: notifications.id, data: notifications.data }).from(notifications).where(and(eq(notifications.userId, h.adminId), eq(notifications.kind, 'audit_chain_head')));
      const [sent] = await told();
      expect(sent.data).toMatchObject({ seq: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{64}$/), serious: false });
      expect(sent.data.seq).toBeLessThanOrEqual(head.seq);
      await bench.app.get(EmailWorker).run(new Date(), [h.id]);
      const [mail] = await bench.owner.db
        .select({ subject: emailOutbox.subject, text: emailOutbox.textBody })
        .from(emailOutbox)
        .innerJoin(emailQueue, eq(emailQueue.id, emailOutbox.queueId))
        .where(eq(emailQueue.notificationId, sent.id));
      expect(mail.subject).toBe('This week’s seal of your audit trail');
      expect(mail.text).toContain(sent.data.hash as string);
      // Checked again within the week: not told again.
      await bench.owner.db.delete(auditChainVerifications).where(eq(auditChainVerifications.tenantId, h.id));
      await check.run(new Date(), [h.id]);
      expect(await told()).toHaveLength(1);
    });

    it('clears addresses older than two years, and the chain still holds; never a younger one', async () => {
      const h = await bench.createHospital('addresses');
      await bench.owner.db.execute(sql`
        insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, changes, ip_address, occurred_at)
        values (${h.id}, ${h.adminId}, 'sign_in', 'user', ${h.adminId}, '{"client":"web"}', '192.0.2.10', now() - interval '3 years')`);
      await check.run(new Date(), [h.id]);
      const kept = await bench.owner.db.select({ ip: auditLog.ipAddress, salt: auditLog.ipSalt, at: auditLog.occurredAt }).from(auditLog).where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, 'sign_in')));
      expect(kept.filter((r) => r.at.getTime() < Date.now() - 365 * 86_400_000)).toEqual([{ ip: null, salt: null, at: expect.any(Date) }]);
      expect(kept.some((r) => r.ip !== null)).toBe(true);
      const [cleared] = await bench.owner.db.select({ changes: auditLog.changes }).from(auditLog).where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, 'audit_addresses_cleared')));
      expect(cleared.changes).toMatchObject({ count: 1 });
      expect(await check.verify(h.id, { full: true })).toMatchObject({ result: 'passed' });
      const app = appDb();
      try {
        await expect(
          app.tenantDb.withTenant(h.id, (tx) => tx.execute(sql`select audit_log_forget_addresses(now() - interval '1 year')`)),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
      } finally {
        await app.pool.end();
      }
      expect(momentIn(new Date(), 'UTC')).toBeTruthy();
    });
  });
});
