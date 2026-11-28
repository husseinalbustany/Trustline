import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { AuditChainCheck } from '../src/audit/chain-check.service.js';
import { bodyOf, checkpointMessage, GENESIS_HASH, ipCommitmentOf, linkHash, sha256 } from '../src/audit/chain.js';
import { createDatabase } from '../src/database/client.js';
import {
  auditChain,
  auditChainCheckpoints,
  auditChainHeads,
  auditChainVerifications,
  auditLog,
  notifications,
  platformAuditLog,
  tenants,
} from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { requireEnv } from '../src/env.js';
import { momentIn, startOfDay } from '../src/i18n/time-zones.js';
import { daytimeZone, testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

/**
 * The audit trail's seal (docs/specs/audit-trail.md, "Tamper evidence"):
 * every entry chained by the database at commit, whoever wrote it; the
 * daily check that finds each kind of tampering done as the owner role;
 * signed checkpoints; the notices of a break; and the status route.
 */
describe('the audit chain', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  let check: AuditChainCheck;
  let a: Hospital;
  let b: Hospital;
  let quality: Staff;
  let reporter: Staff;
  const http = () => bench.http();
  const status = (cookie: string, query = '') => http().get(`/audit/status${query}`).set('Cookie', cookie);

  /** A hospital of its own for each tampering, so that each break is its own. */
  const fresh = (suffix: string) => bench.createHospital(suffix);

  const chainOf = (tenantId: string) =>
    bench.owner.db
      .select()
      .from(auditChain)
      .where(eq(auditChain.tenantId, tenantId))
      .orderBy(asc(auditChain.seq));

  const entriesOf = (tenantId: string) =>
    bench.owner.db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));

  const told = (userId: string) =>
    bench.owner.db
      .select({ data: notifications.data })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.kind, 'audit_chain_broken')));

  beforeAll(async () => {
    bench = await testBench('aud', run);
    check = bench.app.get(AuditChainCheck);
    a = await bench.createHospital('a');
    b = await bench.createHospital('b');
    quality = await bench.createStaff(a, 'quality', { role: 'quality_officer', orgUnitId: null });
    reporter = await bench.createStaff(a, 'reporter', { role: 'reporter', orgUnitId: null });
  }, 60_000);

  afterAll(() => bench.close());

  describe('sealing', () => {
    it('chains every entry at commit, from 1 with no gaps, the body the same in the database and here', async () => {
      // An entry of the admin portal's, written in raw SQL by the platform role.
      await http()
        .patch(`/platform/tenants/${a.id}/subscription`)
        .set('Cookie', bench.platform)
        .send({ limitOverrides: { sites: 40 } })
        .expect(200);
      const chain = await chainOf(a.id);
      const entries = await entriesOf(a.id);
      expect(chain.length).toBe(entries.length);
      expect(chain.map((c) => c.seq)).toEqual(entries.map((_, i) => i + 1));
      expect(new Set(chain.map((c) => c.entryId))).toEqual(new Set(entries.map((e) => e.id)));
      expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['sign_in', 'user_created', 'subscription_changed']));
      const [head] = await bench.owner.db.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, a.id));
      expect(head).toMatchObject({ seq: chain.length, hash: chain.at(-1)!.hash });

      // Rebuilt here as the database built it, link by link.
      const { rows } = await bench.owner.db.execute<{
        seq: string;
        body: string;
        id: string;
        occurred_at: string;
        actor_id: string | null;
        action: string;
        entity_type: string | null;
        entity_id: string | null;
        changes: string | null;
        ip_address: string | null;
        ip_salt: string | null;
        ip_commitment: string | null;
      }>(sql`
        select c.seq::text as seq, audit_chain_body(e, c.seq, c.ip_commitment) as body, e.id,
               to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
               e.actor_id, e.action, e.entity_type, e.entity_id, e.changes::text as changes,
               e.ip_address, e.ip_salt, c.ip_commitment
        from audit_chain c join audit_log e on e.id = c.entry_id
        where c.tenant_id = ${a.id} order by c.seq`);
      let prev = GENESIS_HASH;
      for (const [i, row] of rows.entries()) {
        const seq = Number(row.seq);
        const body = bodyOf(
          {
            id: row.id,
            tenantId: a.id,
            occurredAt: row.occurred_at,
            actorId: row.actor_id,
            action: row.action,
            entityType: row.entity_type,
            entityId: row.entity_id,
            changes: row.changes,
          },
          seq,
          row.ip_commitment,
        );
        expect(body).toBe(row.body);
        expect(chain[i]).toMatchObject({
          prevHash: prev,
          bodyHash: sha256(body),
          hash: linkHash(seq, prev, sha256(body)),
          sealedLate: false,
        });
        prev = chain[i].hash;
        // An address is kept with its salt, and the body holds only the
        // commitment to it.
        if (row.ip_address !== null) {
          expect(row.ip_salt).toMatch(/^[0-9a-f]{64}$/);
          expect(row.ip_commitment).toBe(ipCommitmentOf(row.ip_salt, row.ip_address));
          expect(body).not.toContain(row.ip_address);
        } else {
          expect(row.ip_commitment).toBeNull();
        }
      }
      expect(rows.some((r) => r.action === 'sign_in' && r.ip_address !== null)).toBe(true);
    });

    it('seals nothing of a transaction that is rolled back, nor of a savepoint undone', async () => {
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      const tenantDb = new TenantDb(app.db);
      const before = (await chainOf(a.id)).length;
      const undone = new Error('undone');
      try {
        await expect(
          tenantDb.withTenant(a.id, async (tx) => {
            await tx.insert(auditLog).values({ tenantId: a.id, action: 'sign_out', entityType: 'user', entityId: a.adminId });
            throw undone;
          }),
        ).rejects.toBe(undone);
        await tenantDb.withTenant(a.id, async (tx) => {
          await tx
            .transaction(async (sp) => {
              await sp.insert(auditLog).values({ tenantId: a.id, action: 'sign_out', entityType: 'user', entityId: a.adminId });
              throw undone;
            })
            .catch(() => undefined);
          await tx.insert(auditLog).values({ tenantId: a.id, action: 'sign_out', entityType: 'user', entityId: quality.id });
        });
      } finally {
        await app.pool.end();
      }
      const chain = await chainOf(a.id);
      expect(chain.length).toBe(before + 1);
      const [last] = await bench.owner.db.select().from(auditLog).where(eq(auditLog.id, chain.at(-1)!.entryId));
      expect(last).toMatchObject({ action: 'sign_out', entityId: quality.id });
      expect((await entriesOf(a.id)).length).toBe(chain.length);
    });

    it('cannot be written by the application, nor read by the admin portal beyond the results', async () => {
      const app = createDatabase(requireEnv('APP_DATABASE_URL'));
      const platform = createDatabase(requireEnv('PLATFORM_DATABASE_URL'));
      const tenantDb = new TenantDb(app.db);
      const denied = { cause: { code: '42501' } };
      try {
        const [first] = await chainOf(a.id);
        const attempts = [
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) =>
            tx.insert(auditChain).values({ ...first, seq: 999_999, entryId: a.id }),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.update(auditChain).set({ hash: GENESIS_HASH }),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.delete(auditChain),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.update(auditChainHeads).set({ seq: 1 }),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.update(auditChainCheckpoints).set({ seq: 1 }),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) => tx.delete(auditChainVerifications),
          (tx: Parameters<Parameters<TenantDb['withTenant']>[1]>[0]) =>
            tx.execute(sql`select audit_chain_seal_entry(e, false) from audit_log e limit 1`),
        ];
        for (const attempt of attempts) {
          await expect(tenantDb.withTenant(a.id, attempt)).rejects.toMatchObject(denied);
        }
        // The break notice to Trustline's log: for its own client only.
        await expect(
          tenantDb.withTenant(a.id, (tx) =>
            tx.execute(sql`select audit_chain_report_break(${b.id}::uuid, 'gap', 1, null)`),
          ),
        ).rejects.toMatchObject(denied);
        await expect(platform.db.select().from(auditChain)).rejects.toMatchObject(denied);
        await expect(platform.db.select().from(auditLog)).rejects.toMatchObject(denied);
        await platform.db.select().from(auditChainVerifications).limit(1);
        // Another client's chain is not seen.
        expect(await tenantDb.withTenant(a.id, (tx) => tx.select().from(auditChain).where(eq(auditChain.tenantId, b.id)))).toEqual([]);
      } finally {
        await app.pool.end();
        await platform.pool.end();
      }
    });
  });

  describe('the daily verification', () => {
    it('passes an unbroken chain and signs its head with the published key', async () => {
      const result = await check.verify(a.id, { full: true });
      const [head] = await bench.owner.db.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, a.id));
      expect(result).toMatchObject({ result: 'passed', full: true, fromSeq: 1, toSeq: head.seq, signed: true, kind: null });
      const [cp] = await bench.owner.db
        .select()
        .from(auditChainCheckpoints)
        .where(eq(auditChainCheckpoints.tenantId, a.id));
      expect(cp).toMatchObject({ seq: head.seq, hash: head.hash, keyId: expect.stringMatching(/^ed25519-[0-9a-f]{16}$/) });
      // Anyone can check it with the key Trustline publishes, signed in or not.
      const keys = (await http().get('/audit/keys').expect(200)).body.keys as { keyId: string; publicKey: string; current: boolean }[];
      const key = keys.find((k) => k.keyId === cp.keyId)!;
      expect(key).toMatchObject({ algorithm: 'Ed25519', current: true });
      const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
      expect(verify(null, Buffer.from(checkpointMessage({ ...cp, tenantId: a.id })), publicKey, Buffer.from(cp.signature!, 'base64'))).toBe(true);
      // And daily, from that checkpoint on.
      const second = bench.cookieOf(await bench.login(a.slug, reporter.email).expect(200));
      await http().post('/auth/logout').set('Cookie', second).expect(204);
      const daily = await check.verify(a.id);
      expect(daily).toMatchObject({ result: 'passed', full: false, fromSeq: head.seq, toSeq: head.seq + 2 });
    });

    it('runs once a day per client, from 02:00 on its calendar, the first one in full', async () => {
      const h = await fresh('daily');
      // A time zone where it is now between 03:00 and 22:00: the check runs
      // at the database's time, which it records (security review 12, M1).
      const zone = daytimeZone();
      await http().patch(`/platform/tenants/${h.id}`).set('Cookie', bench.platform).send({ timeZone: zone }).expect(200);
      const today = momentIn(new Date(), zone).slice(0, 10);
      const one = new Date(startOfDay(today, zone).getTime() + 3_600_000);
      const runs = () => bench.owner.db.select().from(auditChainVerifications).where(eq(auditChainVerifications.tenantId, h.id));
      expect(await check.run(one, [h.id])).toMatchObject({ checked: 0 });
      expect(await runs()).toEqual([]);
      expect(await check.run(new Date(), [h.id])).toMatchObject({ checked: 1, broken: 0 });
      expect(await check.run(new Date(Date.now() + 60_000), [h.id])).toMatchObject({ checked: 0 });
      expect(await runs()).toEqual([expect.objectContaining({ result: 'passed', full: true })]);
    });

    describe('finds tampering done as the owner role', () => {
      const broken = async (h: Hospital, full = true) => (await check.verify(h.id, { full }))!;

      it('an entry changed', async () => {
        const h = await fresh('changed');
        const [entry] = await bench.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, 'sign_in')));
        const [seal] = await bench.owner.db.select().from(auditChain).where(eq(auditChain.entryId, entry.id));
        await bench.owner.db.update(auditLog).set({ changes: { client: 'elsewhere' } }).where(eq(auditLog.id, entry.id));
        expect(await broken(h)).toMatchObject({ result: 'failed', kind: 'content_changed', firstBadSeq: seal.seq, firstBadEntryId: entry.id });
      });

      it('an entry deleted', async () => {
        const h = await fresh('deleted');
        const [entry] = await bench.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, 'user_created')));
        const [seal] = await bench.owner.db.select().from(auditChain).where(eq(auditChain.entryId, entry.id));
        await bench.owner.db.delete(auditLog).where(eq(auditLog.id, entry.id));
        expect(await broken(h)).toMatchObject({ kind: 'missing_entry', firstBadSeq: seal.seq });
      });

      it('an entry added with the triggers disabled', async () => {
        const h = await fresh('replica');
        await bench.owner.db.transaction(async (tx) => {
          await tx.execute(sql`set local session_replication_role = replica`);
          await tx.execute(sql`
            insert into audit_log (tenant_id, action, entity_type, entity_id, occurred_at)
            values (${h.id}, 'sign_out', 'user', ${h.adminId}, now() - interval '20 minutes')`);
        });
        const [unsealed] = await bench.owner.db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(and(eq(auditLog.tenantId, h.id), sql`not exists (select from audit_chain c where c.entry_id = ${auditLog.id})`));
        expect(await broken(h)).toMatchObject({ kind: 'missing_seal', firstBadSeq: null, firstBadEntryId: unsealed.id });
      });

      it('the end of the chain cut off, against a checkpoint', async () => {
        const h = await fresh('rewound');
        expect(await check.verify(h.id)).toMatchObject({ result: 'passed', signed: true });
        const [head] = await bench.owner.db.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, h.id));
        const [last] = await bench.owner.db
          .select()
          .from(auditChain)
          .where(and(eq(auditChain.tenantId, h.id), eq(auditChain.seq, head.seq)));
        await bench.owner.db.delete(auditChain).where(and(eq(auditChain.tenantId, h.id), eq(auditChain.seq, head.seq)));
        await bench.owner.db.delete(auditLog).where(eq(auditLog.id, last.entryId));
        await bench.owner.db
          .update(auditChainHeads)
          .set({ seq: head.seq - 1, hash: last.prevHash })
          .where(eq(auditChainHeads.tenantId, h.id));
        expect(await broken(h, false)).toMatchObject({ kind: 'head_rewound', firstBadSeq: head.seq });
      });

      it('an entry dated before the checkpoint it follows', async () => {
        const h = await fresh('backdated');
        expect(await check.verify(h.id)).toMatchObject({ result: 'passed' });
        // Sealed as any other, by the trigger: only its time gives it away.
        await bench.owner.db.execute(sql`
          insert into audit_log (tenant_id, action, entity_type, entity_id, occurred_at)
          values (${h.id}, 'sign_out', 'user', ${h.adminId}, now() - interval '1 day')`);
        const [head] = await bench.owner.db.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, h.id));
        expect(await broken(h, false)).toMatchObject({ kind: 'backdated', firstBadSeq: head.seq });
      });

      it('a checkpoint changed', async () => {
        const h = await fresh('checkpoint');
        expect(await check.verify(h.id)).toMatchObject({ result: 'passed' });
        await bench.owner.db.update(auditChainCheckpoints).set({ hash: GENESIS_HASH }).where(eq(auditChainCheckpoints.tenantId, h.id));
        expect(await broken(h)).toMatchObject({ kind: 'bad_checkpoint' });
      });
    });

    it('says a break at once: in the result, in Trustline’s log, and to those who may see the trail, once', async () => {
      const h = await fresh('told');
      const hQuality = await bench.createStaff(h, 'hquality', { role: 'quality_officer', orgUnitId: null });
      const hReporter = await bench.createStaff(h, 'hreporter', { role: 'reporter', orgUnitId: null });
      const [entry] = await bench.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, h.id), eq(auditLog.action, 'sign_in')));
      await bench.owner.db.update(auditLog).set({ action: 'sign_out' }).where(eq(auditLog.id, entry.id));
      const found = (await check.verify(h.id, { full: true }))!;
      expect(found).toMatchObject({ result: 'failed', kind: 'content_changed' });
      const [logged] = await bench.owner.db
        .select()
        .from(platformAuditLog)
        .where(and(eq(platformAuditLog.targetTenantId, h.id), eq(platformAuditLog.action, 'audit_chain_broken')));
      expect(logged).toMatchObject({ adminId: null, details: { kind: 'content_changed', firstBadSeq: found.firstBadSeq, firstBadEntryId: entry.id } });
      // The Administrator (audit.view, settings.manage) and the Quality
      // officer (audit.view); not someone who holds neither.
      for (const who of [h.adminId, hQuality.id]) {
        expect(await told(who)).toEqual([{ data: { kind: 'content_changed', firstBadSeq: found.firstBadSeq!, serious: true } }]);
      }
      expect(await told(hReporter.id)).toEqual([]);
      // Found again the next day: recorded, not told again.
      expect(await check.verify(h.id, { full: true })).toMatchObject({ result: 'failed' });
      expect(await told(h.adminId)).toHaveLength(1);
      // Shown on the status, and kept there.
      expect((await status(h.cookie).expect(200)).body).toMatchObject({
        lastCheck: { result: 'failed', kind: 'content_changed', firstBadSeq: found.firstBadSeq },
        broken: { kind: 'content_changed', firstBadSeq: found.firstBadSeq, firstBadEntryId: entry.id },
      });
      // Another client's trail knows nothing of it.
      expect((await status(b.cookie).expect(200)).body.broken).toBeNull();
    });
  });

  describe('GET /audit/status', () => {
    it('is refused without a session, without audit.view for the whole organization, and with any query', async () => {
      await http().get('/audit/status').expect(401);
      expect((await status(reporter.cookie).expect(403)).body).toMatchObject({ code: 'missing_permission', permission: 'audit.view' });
      // Granted for one unit only: a unit's trail would still name what
      // lies outside it.
      const unit = await bench.createUnit(a, 'department', `AUD-${run}`, null);
      await bench.createRole(a, 'unit_auditor', ['audit.view']);
      const unitAuditor = await bench.createStaff(a, 'unitauditor', { role: 'unit_auditor', orgUnitId: unit });
      await status(unitAuditor.cookie).expect(403);
      await status(a.cookie, '?full=true').expect(400);
    });

    it('shows the head, the last check, where the seal began, and whether checkpoints are signed', async () => {
      const h = await fresh('status');
      const empty = (await status(h.cookie).expect(200)).body;
      expect(empty).toMatchObject({ lastCheck: null, broken: null, sealedOn: null, sealedBefore: 0, signing: 'signed' });
      await check.verify(h.id, { full: true });
      const [head] = await bench.owner.db.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, h.id));
      const body = (await status(h.cookie).expect(200)).body;
      expect(body).toMatchObject({
        head: { seq: head.seq, at: expect.any(String) },
        lastCheck: { result: 'passed', full: true, fromSeq: 1, toSeq: head.seq, kind: null, signed: true },
        broken: null,
      });
      // The Quality officer may read it too.
      await status(quality.cookie).expect(200);
    });

    it('says, for a client that existed before the seal, how many entries were recorded before it', async () => {
      const [demo] = await bench.owner.db
        .select({ changes: auditLog.changes, tenantId: auditLog.tenantId })
        .from(auditLog)
        .innerJoin(tenants, eq(tenants.id, auditLog.tenantId))
        .where(and(eq(tenants.slug, 'demo-jci'), eq(auditLog.action, 'audit_chain_started')));
      expect(demo.changes).toMatchObject({ migration: '0058_audit_chain_seal', sealedBefore: expect.any(Number), sealedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      const late = await bench.owner.db
        .select({ seq: auditChain.seq })
        .from(auditChain)
        .where(and(eq(auditChain.tenantId, demo.tenantId), eq(auditChain.sealedLate, true)));
      expect(late.map((r) => r.seq)).toEqual(
        Array.from({ length: (demo.changes as { sealedBefore: number }).sealedBefore }, (_, i) => i + 1),
      );
    });
  });

  describe('audit.view', () => {
    it('is held by the Administrator and the Quality officer, existing clients included, and the grant was audited', async () => {
      for (const cookie of [a.cookie, quality.cookie]) {
        expect((await http().get('/auth/me').set('Cookie', cookie).expect(200)).body.permissions).toContain('audit.view');
      }
      expect((await http().get('/auth/me').set('Cookie', reporter.cookie).expect(200)).body.permissions).not.toContain('audit.view');
      const { rows } = await bench.owner.db.execute<{ slug: string; permissions: string[] }>(sql`
        select t.slug, r.permissions from roles r join tenants t on t.id = r.tenant_id
        where t.slug like 'demo-%' and r.is_system and r.code in ('administrator', 'quality_officer')`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => !r.permissions.includes('audit.view'))).toEqual([]);
      const { rows: audited } = await bench.owner.db.execute<{ n: number }>(sql`
        select count(distinct a.tenant_id)::int as n from audit_log a join tenants t on t.id = a.tenant_id
        where t.slug like 'demo-%' and a.action = 'built_in_roles_changed_by_system'
          and a.changes ->> 'migration' = '0059_audit_view_for_existing_clients'`);
      const { rows: demos } = await bench.owner.db.execute<{ n: number }>(sql`select count(*)::int as n from tenants where slug like 'demo-%'`);
      expect(audited[0].n).toBe(demos[0].n);
    });
  });

  describe('given policies.import', () => {
    const importNotices = (userId: string) =>
      bench.owner.db
        .select({ data: notifications.data })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.kind, 'policies_import_granted')));

    it('by a role, tells the other Quality officers and Administrators, not the one who gave it nor the one given it', async () => {
      const second = await bench.createStaff(a, 'secondadmin', { role: 'administrator', orgUnitId: null });
      const person = await bench.createStaff(a, 'importer', { role: 'reporter', orgUnitId: null });
      await http()
        .put(`/users/${person.id}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [{ roleId: a.roles.quality_officer, orgUnitId: null }] })
        .expect(200);
      for (const who of [quality.id, second.id]) {
        expect(await importNotices(who)).toEqual(
          expect.arrayContaining([{ data: { personId: person.id, serious: false } }]),
        );
      }
      for (const who of [a.adminId, person.id, reporter.id]) {
        expect((await importNotices(who)).filter((n) => n.data.personId === person.id)).toEqual([]);
      }
      // Shown with the person's name.
      const shown = (await http().get('/notifications').set('Cookie', quality.cookie).expect(200)).body.items;
      expect(shown.find((n: { kind: string }) => n.kind === 'policies_import_granted')).toMatchObject({
        person: { id: person.id, name: { en: 'Person importer' } },
        document: null,
        incident: null,
      });
      // Given the same again: nobody is told twice.
      const before = (await importNotices(quality.id)).length;
      await http()
        .put(`/users/${person.id}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [{ roleId: a.roles.quality_officer, orgUnitId: null }, { roleId: a.roles.reporter, orgUnitId: null }] })
        .expect(200);
      expect(await importNotices(quality.id)).toHaveLength(before);
    });

    it('by a role it is added to, tells the same of each of its holders', async () => {
      await bench.createRole(a, 'doc_keeper', ['policies.view']);
      const keeper = await bench.createStaff(a, 'keeper', { role: 'doc_keeper', orgUnitId: null });
      const [role] = (await http().get('/roles').set('Cookie', a.cookie).expect(200)).body.roles.filter(
        (r: { code: string }) => r.code === 'doc_keeper',
      );
      await http()
        .patch(`/roles/${role.id}`)
        .set('Cookie', a.cookie)
        .send({ permissions: ['policies.view', 'policies.import'] })
        .expect(200);
      expect(await importNotices(quality.id)).toEqual(
        expect.arrayContaining([{ data: { personId: keeper.id, serious: false } }]),
      );
      expect((await importNotices(a.adminId)).filter((n) => n.data.personId === keeper.id)).toEqual([]);
    });
  });

  describe('new entries', () => {
    it('keep no email address of a new user, and keep the roles a user held before', async () => {
      const person = await bench.createStaff(a, 'roles', { role: 'reporter', orgUnitId: null });
      const [created] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, person.id), eq(auditLog.action, 'user_created')));
      expect(created.changes).toBeNull();
      await http()
        .put(`/users/${person.id}/roles`)
        .set('Cookie', a.cookie)
        .send({ roles: [{ roleId: a.roles.quality_officer, orgUnitId: null }] })
        .expect(200);
      const [changed] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, person.id), eq(auditLog.action, 'user_roles_changed')));
      expect(changed.changes).toEqual({
        before: [{ roleId: a.roles.reporter, orgUnitId: null }],
        roles: [{ roleId: a.roles.quality_officer, orgUnitId: null }],
      });
    });
  });
});
