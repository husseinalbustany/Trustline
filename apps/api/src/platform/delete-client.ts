import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { createDatabase, type Database } from '../database/client.js';
import { dayOf } from '../i18n/time-zones.js';
import { ExportKeys } from '../exports/export-keys.js';
import { ExportStorage } from '../exports/storage.js';
import { refusalOf } from './platform-contract.controller.js';

/** The certificate's format, as it says itself. */
export const CERTIFICATE_FORMAT = { format: 'trustline-deletion-certificate', version: 1 } as const;
/** What a certificate's signature is of: this, then the certificate's exact bytes. */
export const CERTIFICATE_PREFIX = Buffer.from('trustline-deletion-certificate-v1\n', 'utf8');

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Deletes a client's data after its contract's retention date
 * (docs/specs/data-export.md, "After the exit window"), as the owner role,
 * for a deletion asked for by one member of Trustline's staff and approved
 * by another in the portal. In one transaction:
 *
 * - it refuses, as the portal does, before the retention date, and when no
 *   export was downloaded unless the client's written instruction is
 *   recorded; and for a deletion not approved;
 * - it records the audit chain's last checkpoint, then deletes every row of
 *   every table with `tenant_id` of the client, counting each table's;
 * - it keeps the client's row as a stub: its identifier and id, status
 *   `deleted`, no name, so that Trustline's log keeps its reference and the
 *   identifier is never reused;
 * - it writes the deletion certificate (the client, the day, the rows
 *   deleted from each table, the chain's last checkpoint, the day the last
 *   backup holding the data expires), signed with Trustline's export key,
 *   into the deletion's record and Trustline's log.
 *
 * Then the client's archives left in storage are removed. Nothing here can
 * run without a signing key: a deletion unsigned proves nothing.
 */
export async function deleteClient(
  db: Database,
  input: { deletionId: string; backupsExpireOn: string },
  keys: ExportKeys,
  storage: ExportStorage,
) {
  if (!keys.signer) throw new Error('EXPORT_SIGNING_KEY must hold a valid Ed25519 private key: a certificate is signed');
  // A real day (security review 20, L6): today or later, checked in the
  // client's calendar below.
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.backupsExpireOn);
  const asDate = day ? new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))) : null;
  if (!day || !asDate || asDate.toISOString().slice(0, 10) !== input.backupsExpireOn) {
    throw new Error('backupsExpireOn must be a real day (YYYY-MM-DD)');
  }
  // Where the archives are, named: never a temporary directory by default
  // (security review 20, L3).
  if (!storage.configured) throw new Error('EXPORT_STORAGE_DIR must name the storage of this deployment');
  const done = await db.transaction(async (tx) => {
    const { rows: found } = await tx.execute<{
      id: string;
      tenant_id: string;
      status: string;
      written_instruction: unknown;
      requested_by: string;
      approved_by: string | null;
      requester: string;
      approver: string | null;
    }>(sql`
      select d.id, d.target_tenant_id as tenant_id, d.status::text as status, d.written_instruction,
             d.requested_by, d.approved_by, r.name as requester, a.name as approver
      from client_deletions d
      join platform_admins r on r.id = d.requested_by
      left join platform_admins a on a.id = d.approved_by
      where d.id = ${input.deletionId}
      for update of d`);
    const deletion = found[0];
    if (!deletion) throw new Error('no such deletion');
    if (deletion.status !== 'approved' || !deletion.approved_by) throw new Error(`the deletion is ${deletion.status}, not approved`);
    const tenantId = deletion.tenant_id;
    const { rows: clients } = await tx.execute<{
      slug: string;
      status: string;
      time_zone: string;
      subscription: string;
      exit_until: string | null;
      retain_until: string | null;
      cancelled_at: Date | null;
    }>(sql`
      select t.slug, t.status::text as status, t.time_zone, s.status::text as subscription,
             s.exit_until::text as exit_until, s.retain_until::text as retain_until, s.access_reset_at as cancelled_at
      from tenants t join subscriptions s on s.tenant_id = t.id
      where t.id = ${tenantId}
      for update of t, s`);
    const client = clients[0];
    if (!client) throw new Error('no such client, or no subscription');
    const { rows: downloads } = await tx.execute<{ n: number }>(
      // Only an export downloaded since the cancellation (security review 20, M4).
      sql`select count(*)::int as n from data_exports where tenant_id = ${tenantId} and downloads > 0
        and last_downloaded_at >= ${client.cancelled_at ?? new Date(0)}`,
    );
    const today = dayOf(new Date(), client.time_zone);
    const refusal = refusalOf(
      {
        status: client.status,
        subscription: client.subscription,
        exitUntil: client.exit_until,
        retainUntil: client.retain_until,
        today,
        downloaded: downloads[0].n > 0,
      },
      !!deletion.written_instruction,
    );
    if (refusal) throw new Error(`refused: ${refusal}`);
    if (input.backupsExpireOn < today) throw new Error('backupsExpireOn is before today');
    // The archives first, here where the storage is (security review 20,
    // L3): what is removed is said in the certificate.
    const archivesRemoved = await storage.removeClient(tenantId);

    // What the chain stood at, before it goes.
    const { rows: heads } = await tx.execute<{ seq: string; hash: string }>(
      sql`select seq::text as seq, hash from audit_chain_heads where tenant_id = ${tenantId}`,
    );
    const { rows: checkpoints } = await tx.execute<{ seq: string; hash: string; at: Date; key_id: string | null; signature: string | null }>(sql`
      select seq::text as seq, hash, at, key_id, signature from audit_chain_checkpoints
      where tenant_id = ${tenantId} order by seq desc, at desc limit 1`);
    const exportIds = (
      await tx.execute<{ id: string }>(sql`select id from data_exports where tenant_id = ${tenantId}`)
    ).rows.map((r) => r.id);

    // Every table of the client's, from the catalogue: a new module's too.
    const { rows: tables } = await tx.execute<{ name: string }>(sql`
      select c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`);
    // No table without `tenant_id` may point at one with it: such a row
    // would be left pointing at nothing.
    const { rows: outside } = await tx.execute<{ name: string }>(sql`
      select distinct src.relname as name from pg_constraint k
      join pg_class src on src.oid = k.conrelid
      join pg_class dst on dst.oid = k.confrelid
      where k.contype = 'f'
        and exists (select from pg_attribute a where a.attrelid = dst.oid and a.attname = 'tenant_id' and not a.attisdropped)
        and not exists (select from pg_attribute a where a.attrelid = src.oid and a.attname = 'tenant_id' and not a.attisdropped)
        and dst.relname <> 'tenants'`);
    if (outside.length > 0) throw new Error(`tables outside the client's point into it: ${outside.map((r) => r.name).join(', ')}`);
    // The client's tables point at each other every way (a document and its
    // published version): their links are not checked while they all go,
    // within this transaction only.
    await tx.execute(sql`set local session_replication_role = replica`);
    const rowsDeleted: Record<string, number> = {};
    for (const { name } of tables) {
      const result = await tx.execute(sql`delete from ${sql.raw(`public.${quote(name)}`)} where tenant_id = ${tenantId}`);
      rowsDeleted[name] = result.rowCount ?? 0;
    }
    await tx.execute(sql`set local session_replication_role = origin`);
    // A stub: the identifier and status, no name.
    await tx.execute(sql`
      update tenants set status = 'deleted', name = '{}'::jsonb, access_reset_at = clock_timestamp() where id = ${tenantId}`);

    const latest = checkpoints[0];
    const certificate = {
      ...CERTIFICATE_FORMAT,
      deletionId: deletion.id,
      client: { id: tenantId, identifier: client.slug },
      deletedOn: today,
      deletedAt: new Date().toISOString(),
      rowsDeleted,
      rowsDeletedInAll: Object.values(rowsDeleted).reduce((a, b) => a + b, 0),
      auditChain: {
        headSeq: heads[0] ? Number(heads[0].seq) : 0,
        headHash: heads[0]?.hash ?? null,
        lastCheckpoint: latest
          ? { seq: Number(latest.seq), hash: latest.hash, at: new Date(latest.at).toISOString(), keyId: latest.key_id, signature: latest.signature }
          : null,
      },
      lastBackupExpiresOn: input.backupsExpireOn,
      archivesRemoved,
      // What is kept (security review 20, L5): the client's identifier and
      // id, as a stub; Trustline's own log of what its staff did about the
      // client, which names them and the contract contacts of its written
      // requests; and this certificate.
      kept: ['client identifier and id', 'Trustline log entries about the client', 'this certificate'],
      requestedBy: deletion.requester,
      approvedBy: deletion.approver,
      writtenInstruction: deletion.written_instruction ?? null,
    };
    const bytes = Buffer.from(`${JSON.stringify(certificate, null, 2)}\n`, 'utf8');
    // Signed with its own prefix, so that no signature of a manifest can
    // stand for a certificate's (security review 20, L9).
    const signed = keys.sign(Buffer.concat([CERTIFICATE_PREFIX, bytes]))!;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const signature = { algorithm: 'Ed25519' as const, keyId: signed.keyId, signature: signed.signature };
    await tx.execute(sql`
      update client_deletions set status = 'done', executed_at = now(), certificate = ${bytes.toString('utf8')}::jsonb,
        certificate_text = ${bytes.toString('utf8')},
        certificate_sha256 = ${sha256}, signature = ${JSON.stringify(signature)}::jsonb
      where id = ${deletion.id}`);
    await tx.execute(sql`
      insert into platform_audit_log (admin_id, action, target_tenant_id, details)
      values (${deletion.approved_by}, 'client_data_deleted', ${tenantId},
        ${JSON.stringify({ deletionId: deletion.id, certificateSha256: sha256, rowsDeletedInAll: certificate.rowsDeletedInAll })}::jsonb)`);
    return { tenantId, exportIds, certificate: bytes, sha256, signature };
  });
  return done;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      deletion: { type: 'string' },
      'backups-expire-on': { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.deletion || !values['backups-expire-on']) {
    console.error('usage: pnpm --filter api platform:delete-client --deletion <id> --backups-expire-on <YYYY-MM-DD> [--out certificate.json]');
    process.exit(2);
  }
  const { pool, db } = createDatabase(requireEnv('DATABASE_URL'));
  try {
    const done = await deleteClient(db, { deletionId: values.deletion, backupsExpireOn: values['backups-expire-on'] }, new ExportKeys(), new ExportStorage());
    const out = values.out ?? `deletion-certificate-${done.tenantId}.json`;
    await writeFile(out, done.certificate);
    await writeFile(`${out}.sig`, `${JSON.stringify(done.signature, null, 2)}\n`);
    console.log(`Client ${done.tenantId} deleted. Certificate: ${out} (SHA-256 ${done.sha256}), signature: ${out}.sig`);
  } finally {
    await pool.end();
  }
}
