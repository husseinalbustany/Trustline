import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { AUDIT_ACTIONS } from '../audit/actions.js';
import { TrailService } from '../audit/trail.service.js';
import { AUDIT_WORDING } from '../audit/wording/index.js';
import type { Database, Transaction } from '../database/client.js';
import type { WrittenRequest } from '../database/schema.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { pickText, SUPPORTED_LOCALES, type Locale, type Localized } from '../i18n/locales.js';
import { momentIn } from '../i18n/time-zones.js';
import type { AuthContext } from '../identity/auth.service.js';
import { PERMISSIONS } from '../identity/permissions.js';
import { csvCell, type Cell } from '../policies/csv.js';
import { languageStatus } from '../policies/languages.js';
import { REPORTS_WORDING } from '../reports/wording/index.js';
import { MODULES } from '../subscriptions/modules.js';
import { COVERAGE, CSV_FILES, CSV_PART_ROWS, type CsvAs, type Exported } from './coverage.js';
import { ExportKeys } from './export-keys.js';
import { versionHtml } from './html.js';
import { EXPORT_WORDING } from './wording/index.js';
import { ZipWriter } from './zip.js';

/** The archive's format, as its manifest and schemas say. */
export const EXPORT_FORMAT = { format: 'trustline-export', version: 1 } as const;
/** Rows read per statement: well within the application role's 15 seconds. */
const BATCH = 2_000;
const BOM = '﻿';

export type ArchiveJob = {
  id: string;
  tenantId: string;
  locale: Locale;
  reason: string;
  includePdfs: boolean;
  requestedBy: string;
  /** The client's second holder; null when Trustline approved (decision 3). */
  approvedBy: string | null;
  /** Trustline's approval, on the contract contact's written request. */
  trustline: { at: Date; writtenRequest: WrittenRequest } | null;
};

export type Phase = 'data' | 'documents' | 'archive';

type Column = { name: string; type: string; notNull: boolean; labels: string[] | null };
type Tenant = {
  id: string;
  slug: string;
  name: Localized;
  locales: string[];
  default_locale: string;
  time_zone: string;
  accreditation_standard: string;
  public_reporting: boolean;
  status: string;
  data_region: string | null;
  sign_in_method: string;
  created_at: string;
};

/** A file of lines, written as fast as the disk takes them. */
class Lines {
  private readonly out: WriteStream;
  rows = 0;
  constructor(path: string) {
    this.out = createWriteStream(path, { mode: 0o600 });
  }
  static async at(path: string) {
    await mkdir(dirname(path), { recursive: true });
    return new Lines(path);
  }
  async write(line: string) {
    this.rows += 1;
    if (!this.out.write(`${line}\n`)) await new Promise<void>((done) => this.out.once('drain', () => done()));
  }
  close() {
    return new Promise<void>((done, fail) => this.out.end((e?: Error | null) => (e ? fail(e) : done())));
  }
}

/** A CSV file in parts of at most a million rows (spec, "Formats"): `x.csv`, `x.part-2.csv`, … */
class CsvParts {
  private current: Lines | null = null;
  private part = 0;
  private constructor(
    private readonly base: string,
    private readonly headings: string[],
  ) {}
  static at(base: string, headings: string[]) {
    return new CsvParts(base, headings);
  }
  async write(cells: Cell[]) {
    if (!this.current || this.current.rows > CSV_PART_ROWS) {
      await this.current?.close();
      this.part += 1;
      this.current = await Lines.at(this.part === 1 ? `${this.base}.csv` : `${this.base}.part-${this.part}.csv`);
      // The BOM, then the headings: lines end CRLF, as every export's.
      await this.current.write(`${BOM}${this.headings.map(csvCell).join(',')}\r`);
    }
    await this.current.write(`${cells.map(csvCell).join(',')}\r`);
  }
  async close() {
    if (!this.current) await this.write([]).then(() => undefined);
    await this.current?.close();
  }
}

/** Every line of a JSON Lines file, parsed, with where it starts. */
async function* readLines(path: string): AsyncGenerator<{ row: Record<string, unknown>; at: number; length: number }> {
  let at = 0;
  const input = createReadStream(path, { encoding: 'utf8' });
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const length = Buffer.byteLength(line, 'utf8') + 1;
    if (line.length > 0) yield { row: JSON.parse(line) as Record<string, unknown>, at, length };
    at += length;
  }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const sha256File = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

/** A JSON Schema for a column, from its type in the database. */
function schemaOf(c: Column): Record<string, unknown> {
  const base = (type: string): Record<string, unknown> => {
    if (type.endsWith('[]')) return { type: 'array', items: base(type.slice(0, -2)) };
    if (c.labels && type === c.type) return { type: 'string', enum: c.labels };
    if (type === 'uuid') return { type: 'string', format: 'uuid' };
    if (type === 'integer' || type === 'bigint' || type === 'smallint') return { type: 'integer' };
    if (type === 'numeric' || type.startsWith('numeric(') || type === 'double precision' || type === 'real') return { type: 'number' };
    if (type === 'boolean') return { type: 'boolean' };
    if (type.startsWith('timestamp')) return { type: 'string', format: 'date-time' };
    if (type === 'date') return { type: 'string', format: 'date' };
    if (type === 'jsonb' || type === 'json') return {};
    return { type: 'string' };
  };
  const s = base(c.type);
  if (c.notNull || Object.keys(s).length === 0) return s;
  return { anyOf: [s, { type: 'null' }] };
}

/** A name for a folder from a document's number: letters, digits, dot, hyphen, underscore. */
const folderOf = (number: string) => number.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '-') || 'document';

/**
 * Makes a full data export's archive (docs/specs/data-export.md, "How it
 * is made"), in three phases:
 *
 * 1. **Data:** one `repeatable read, read only` transaction of the client
 *    (`withTenant`, so row-level security bounds every read), so that every
 *    file is of the same moment: each table of `coverage.ts`, by key, in
 *    batches, as JSON Lines with its JSON Schema; the audit trail's chain
 *    file and its worded CSV; then, through the platform role, what
 *    Trustline's staff recorded about the client (decision 7).
 * 2. **Documents** and **CSV files,** from the files of phase 1, outside
 *    the transaction: each version's `content.json` and a page in each of
 *    its languages; and the tables people open, in the language asked for.
 * 3. **Archive:** the READMEs, the manifest of every file with its size and
 *    SHA-256, its signature by Trustline's export key, and the ZIP.
 *
 * It sees everything: reporters' names, internal comments, restricted
 * documents, the whole trail, which the two people who asked and approved
 * were told. Never a secret: what `coverage.ts` leaves out is never read.
 */
@Injectable()
export class ArchiveBuilder {
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(PLATFORM_DATABASE) private readonly platform: Database,
    private readonly trail: TrailService,
    private readonly keys: ExportKeys,
  ) {}

  /** Builds the archive in `work`; its path, and what the record keeps of it. */
  async build(job: ArchiveJob, work: string, onPhase: (phase: Phase) => Promise<void>) {
    const files = join(work, 'files');
    await rm(files, { recursive: true, force: true });
    await mkdir(files, { recursive: true });

    await onPhase('data');
    const data = await this.tenantDb.withTenant(job.tenantId, (tx) => this.readData(tx, job, files), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    const zone = data.tenant.time_zone;
    await this.writeTrustlineRecords(job, files);

    await onPhase('documents');
    await this.writeCsvFiles(job, files, data.tenant);
    await this.writeDocuments(files, data.tenant);

    await onPhase('archive');
    const people = await this.namesOf(files, [job.requestedBy, ...(job.approvedBy ? [job.approvedBy] : [])]);
    const fileList = await this.listFiles(files);
    const manifestFiles = [];
    for (const path of fileList) {
      manifestFiles.push({ path, size: (await stat(join(files, path))).size, sha256: await sha256File(join(files, path)) });
    }
    const readmeLocales = [job.locale, ...data.tenant.locales.filter((l) => l !== job.locale)].filter((l): l is Locale =>
      (SUPPORTED_LOCALES as readonly string[]).includes(l),
    );
    const signer = this.keys.signer;
    const readmes = readmeLocales.map((locale) => ({
      path: `README.${locale}.txt`,
      body: Buffer.from(this.readme(locale, data.tenant, data.at, signer?.keyId ?? null), 'utf8'),
    }));
    const manifest = {
      ...EXPORT_FORMAT,
      exportId: job.id,
      organization: { id: data.tenant.id, identifier: data.tenant.slug, name: data.tenant.name },
      snapshotAt: data.at.toISOString(),
      madeAt: new Date().toISOString(),
      timeZone: zone,
      reason: job.reason,
      locale: job.locale,
      pdfs: { asked: job.includePdfs, included: false, reason: 'renderer_not_available' },
      requestedBy: { id: job.requestedBy, name: people.get(job.requestedBy) ?? null },
      approvedBy: job.approvedBy
        ? { id: job.approvedBy, name: people.get(job.approvedBy) ?? null }
        : { trustline: job.trustline ? { at: job.trustline.at.toISOString(), writtenRequest: job.trustline.writtenRequest } : null },
      auditChain: data.chain,
      counts: data.counts,
      signingKeyId: signer?.keyId ?? null,
      files: [
        ...readmes.map((r) => ({ path: r.path, size: r.body.length, sha256: createHash('sha256').update(r.body).digest('hex') })),
        ...manifestFiles,
      ],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const signature = this.keys.sign(manifestBytes);
    const zipPath = join(work, 'archive.zip');
    const zip = await ZipWriter.create(zipPath, data.at);
    try {
      for (const r of readmes) await zip.addBuffer(r.path, r.body);
      await zip.addBuffer('manifest.json', manifestBytes);
      if (signature) {
        await zip.addBuffer(
          'manifest.sig',
          Buffer.from(`${JSON.stringify({ algorithm: 'Ed25519', keyId: signature.keyId, signature: signature.signature }, null, 2)}\n`, 'utf8'),
        );
      }
      for (const path of fileList) await zip.addFile(path, join(files, path));
      await zip.close();
    } catch (error) {
      await zip.abort();
      throw error;
    }
    await rm(files, { recursive: true, force: true });
    return {
      zipPath,
      snapshotAt: data.at,
      counts: data.counts,
      sizeBytes: (await stat(zipPath)).size,
      archiveSha256: await sha256File(zipPath),
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    };
  }

  /** Phase 1, in the client's one-moment transaction. */
  private async readData(tx: Transaction, job: ArchiveJob, files: string) {
    const { rows: moment } = await tx.execute<{ at: Date }>(sql`select now() as at`);
    const at = new Date(moment[0].at);
    const { rows: tenants } = await tx.execute<Tenant>(sql`
      select id, slug, name, locales, default_locale, time_zone, accreditation_standard, public_reporting, status::text,
             data_region, sign_in_method::text, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
      from tenants where id = ${job.tenantId}`);
    const tenant = tenants[0];
    if (!tenant) throw new Error('client not found');
    const catalog = await this.catalogOf(tx);
    const counts: Record<string, number> = {};
    for (const [table, coverage] of Object.entries(COVERAGE)) {
      if (coverage.kind !== 'export') continue;
      const columns = catalog.columns.get(table);
      if (!columns) throw new Error(`table not found: ${table}`);
      counts[table] = await this.dumpTable(tx, table, coverage, columns, catalog.keys.get(table) ?? [], files);
    }
    // The organization itself.
    const organization = await Lines.at(join(files, 'organization/organization.jsonl'));
    await organization.write(JSON.stringify(tenant));
    await organization.close();
    await this.writeSchema(files, 'organization/organization', [
      ...['id', 'slug', 'default_locale', 'time_zone', 'accreditation_standard', 'status', 'sign_in_method'].map((name) => ({
        name,
        type: name === 'id' ? 'uuid' : 'text',
        notNull: true,
        labels: null,
      })),
      { name: 'name', type: 'jsonb', notNull: true, labels: null },
      { name: 'locales', type: 'text[]', notNull: true, labels: null },
      { name: 'public_reporting', type: 'boolean', notNull: true, labels: null },
      { name: 'data_region', type: 'text', notNull: false, labels: null },
      { name: 'created_at', type: 'timestamp with time zone', notNull: true, labels: null },
    ]);
    counts.organization = 1;
    // The plan the subscription is on: names and modules, never a price.
    const { rows: plans } = await tx.execute<Record<string, unknown>>(sql`
      select p.id, p.code, p.name, p.modules from plans p join subscriptions s on s.plan_id = p.id`);
    const plan = await Lines.at(join(files, 'organization/plan.jsonl'));
    for (const p of plans) await plan.write(JSON.stringify(p));
    await plan.close();

    // The audit trail as the viewer and its verifier have it, in full: an
    // export sees everything.
    const viewer = this.allSeeing(tenant, job.requestedBy);
    const chain = await Lines.at(join(files, 'audit/audit-chain.jsonl'));
    const chained = await this.trail.writeChainIn(tx, viewer, {}, (line) => chain.write(line));
    await chain.close();
    const worded = CsvParts.at(join(files, `audit/audit_log.${job.locale}`), this.trail.csvHeadings(job.locale, tenant.time_zone));
    await this.trail.writeWordedIn(tx, viewer, job.locale, (cells) => worded.write(cells));
    await worded.close();
    const { rows: heads } = await tx.execute<{ seq: string | null; hash: string | null }>(
      sql`select seq::text as seq, hash from audit_chain_heads`,
    );
    const { rows: checkpoints } = await tx.execute<{ seq: string; hash: string; at: Date; key_id: string | null; signature: string | null }>(
      sql`select seq::text as seq, hash, at, key_id, signature from audit_chain_checkpoints order by seq, at`,
    );
    const checkpointsFile = await Lines.at(join(files, 'audit/checkpoints.json'));
    await checkpointsFile.write(
      JSON.stringify(
        checkpoints.map((c) => ({ seq: Number(c.seq), hash: c.hash, at: new Date(c.at).toISOString(), keyId: c.key_id, signature: c.signature })),
        null,
        2,
      ),
    );
    await checkpointsFile.close();
    const latest = checkpoints.at(-1);
    return {
      at,
      tenant,
      counts,
      chain: {
        entries: chained.entries,
        headSeq: heads[0]?.seq ? Number(heads[0].seq) : 0,
        headHash: heads[0]?.hash ?? null,
        latestCheckpoint: latest
          ? { seq: Number(latest.seq), hash: latest.hash, at: new Date(latest.at).toISOString(), keyId: latest.key_id, signature: latest.signature }
          : null,
      },
    };
  }

  /** The columns, their types and primary keys of the public tables, from the catalogue. */
  private async catalogOf(tx: Transaction) {
    const { rows } = await tx.execute<{ table_name: string; name: string; type: string; not_null: boolean; labels: string[] | null; pk: number | null }>(sql`
      select c.relname as table_name, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
             (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid = a.atttypid) as labels,
             array_position(i.indkey::int2[], a.attnum) as pk
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      left join pg_index i on i.indrelid = c.oid and i.indisprimary
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname, a.attnum`);
    const columns = new Map<string, Column[]>();
    const keys = new Map<string, { name: string; type: string; at: number }[]>();
    for (const r of rows) {
      if (!columns.has(r.table_name)) columns.set(r.table_name, []);
      columns.get(r.table_name)!.push({ name: r.name, type: r.type, notNull: r.not_null, labels: r.labels });
      if (r.pk !== null) {
        if (!keys.has(r.table_name)) keys.set(r.table_name, []);
        keys.get(r.table_name)!.push({ name: r.name, type: r.type, at: r.pk });
      }
    }
    return {
      columns,
      keys: new Map([...keys].map(([t, k]) => [t, k.sort((a, b) => a.at - b.at).map(({ name, type }) => ({ name, type }))])),
    };
  }

  /** One table, by key, in batches, as JSON Lines, with its schema. Its rows. */
  private async dumpTable(
    tx: Transaction,
    table: string,
    coverage: Exported,
    all: Column[],
    key: { name: string; type: string }[],
    files: string,
  ) {
    if (key.length === 0) throw new Error(`no primary key: ${table}`);
    const columns = all.filter((c) => !Object.hasOwn(coverage.omit, c.name));
    const valueOf = (c: Column) =>
      c.type.startsWith('timestamp') && !c.type.endsWith('[]')
        ? `to_char(${quote(c.name)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        : c.type === 'date'
          ? `${quote(c.name)}::text`
          : quote(c.name);
    const pieces: string[] = [];
    for (let i = 0; i < columns.length; i += 40) {
      pieces.push(
        `jsonb_build_object(${columns
          .slice(i, i + 40)
          .map((c) => `'${c.name.replaceAll("'", "''")}', ${valueOf(c)}`)
          .join(', ')})`,
      );
    }
    const object = sql.raw(pieces.join(' || '));
    const keyList = sql.raw(key.map((k) => quote(k.name)).join(', '));
    const keyText = sql.raw(key.map((k, i) => `${quote(k.name)}::text as k${i}`).join(', '));
    const out = await Lines.at(join(files, `${coverage.file}.jsonl`));
    let after = null as string[] | null;
    for (;;) {
      const from: string[] | null = after;
      const { rows }: { rows: Record<string, string>[] } = await tx.execute<Record<string, string>>(sql`
        select (${object})::text as line, ${keyText} from ${sql.raw(quote(table))}
        ${from ? sql`where (${keyList}) > (${sql.join(from.map((v: string, i: number) => sql`${v}::${sql.raw(key[i].type)}`), sql`, `)})` : sql``}
        order by ${keyList} limit ${BATCH}`);
      for (const r of rows) await out.write(r.line);
      if (rows.length < BATCH) break;
      const last: Record<string, string> = rows.at(-1)!;
      after = key.map((_, i) => last[`k${i}`]);
    }
    await out.close();
    await this.writeSchema(files, coverage.file, columns);
    return out.rows;
  }

  private async writeSchema(files: string, file: string, columns: Column[]) {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${EXPORT_FORMAT.format}/${EXPORT_FORMAT.version}/${file}`,
      title: `${file}.jsonl: one object per line`,
      'x-format': EXPORT_FORMAT,
      type: 'object',
      properties: Object.fromEntries(columns.map((c) => [c.name, schemaOf(c)])),
      required: columns.filter((c) => c.notNull).map((c) => c.name),
      additionalProperties: false,
    };
    const out = await Lines.at(join(files, 'schema', `${file}.schema.json`));
    await out.write(JSON.stringify(schema, null, 2));
    await out.close();
  }

  /**
   * What Trustline's staff recorded about the client (decision 7): through
   * the platform role, the action, its time, the staff member's name and the
   * details, nothing else. Read after the client's moment, from Trustline's
   * own log.
   */
  private async writeTrustlineRecords(job: ArchiveJob, files: string) {
    const out = await Lines.at(join(files, 'organization/trustline_records.jsonl'));
    let after = null as { at: string; id: string } | null;
    type Record_ = { id: string; at: string; action: string; staff: string | null; details: unknown };
    for (;;) {
      const from: { at: string; id: string } | null = after;
      const { rows }: { rows: Record_[] } = await this.platform.execute<Record_>(sql`
        select l.id, to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, l.action, a.name as staff, l.details
        from platform_audit_log l left join platform_admins a on a.id = l.admin_id
        where l.target_tenant_id = ${job.tenantId}
          ${from ? sql`and (l.created_at, l.id) > (${from.at}::timestamptz, ${from.id}::uuid)` : sql``}
        order by l.created_at, l.id limit ${BATCH}`);
      for (const r of rows) await out.write(JSON.stringify({ action: r.action, at: r.at, staff: r.staff, details: r.details }));
      if (rows.length < BATCH) break;
      after = { at: rows.at(-1)!.at, id: rows.at(-1)!.id };
    }
    await out.close();
  }

  /** Who may see everything, for the audit trail's own writers: an export's viewer. */
  private allSeeing(tenant: Tenant, userId: string): AuthContext {
    return {
      token: '',
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        locales: tenant.locales,
        defaultLocale: tenant.default_locale,
        accreditationStandard: tenant.accreditation_standard,
        publicReporting: tenant.public_reporting,
        timeZone: tenant.time_zone,
        // Every module: a module switched off is still exported (spec).
        modules: [...MODULES],
        subscription: { status: 'active', notice: null },
        exit: null,
      },
      user: { id: userId, name: {}, email: '', orgUnitId: null, kind: 'staff', access: null },
      permissions: [...PERMISSIONS],
      scope: Object.fromEntries(PERMISSIONS.map((p) => [p, 'all' as const])),
    };
  }

  /** The tables people open, as CSV files in the language asked for. */
  private async writeCsvFiles(job: ArchiveJob, files: string, tenant: Tenant) {
    const locale = job.locale;
    const words = EXPORT_WORDING[locale];
    const audit = AUDIT_WORDING[locale];
    const names = new Map<string, Localized | string>();
    const label = async (table: string, value: (row: Record<string, unknown>) => Localized | string) => {
      const file = COVERAGE[table] as Exported;
      for await (const { row } of readLines(join(files, `${file.file}.jsonl`))) names.set(row.id as string, value(row));
    };
    await label('users', (r) => r.name as Localized);
    await label('org_units', (r) => r.name as Localized);
    await label('incident_categories', (r) => r.name as Localized);
    await label('document_types', (r) => r.name as Localized);
    await label('document_categories', (r) => r.name as Localized);
    await label('incidents', (r) => r.reference as string);
    await label('documents', (r) => r.number as string);
    const numbers = new Map<string, string>();
    for (const [id, v] of names) if (typeof v === 'string') numbers.set(id, v);
    await label('document_versions', (r) => `${numbers.get(r.document_id as string) ?? ''} v${r.version as number}`);
    const pick = (v: unknown) =>
      v === null || v === undefined ? null : typeof v === 'string' ? v : pickText(v as Localized, locale, tenant.default_locale);
    /** A value read from JSON as text: a scalar as written, anything else as JSON. */
    const asText = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v as string | number | boolean));
    const code = (v: unknown) => {
      if (v === null || v === undefined) return null;
      const c = asText(v);
      return words.values[c] ?? (audit.details.values as Record<string, string>)[c] ?? c;
    };
    const cell = (as: CsvAs, v: unknown, table: string): Cell => {
      switch (as) {
        case 'text':
          return v === null || v === undefined ? null : asText(v);
        case 'number':
          return v === null || v === undefined ? null : Number(v);
        case 'bool':
          return v === null || v === undefined ? null : v ? words.yes : words.no;
        case 'code':
          return code(v);
        case 'localized':
          return pick(v);
        case 'moment':
          return typeof v === 'string' ? momentIn(new Date(v), tenant.time_zone) : null;
        case 'day':
          return typeof v === 'string' ? v : null;
        case 'month':
          return typeof v === 'string' ? v.slice(0, 7) : null;
        case 'measure':
          return typeof v === 'string' ? ((REPORTS_WORDING[locale].measures as Record<string, string>)[v] ?? v) : null;
        default:
          if (v === null || v === undefined) return table === 'measure_snapshots' && as === 'unit' ? words.organization : null;
          return names.has(asText(v)) ? pick(names.get(asText(v))) : words.unknown;
      }
    };
    for (const [table, spec] of Object.entries(CSV_FILES)) {
      const file = COVERAGE[table] as Exported;
      const out = CsvParts.at(
        join(files, file.file),
        spec.columns.map((c) => words.csv[table][c.column]),
      );
      for await (const { row } of readLines(join(files, `${file.file}.jsonl`))) {
        await out.write(spec.columns.map((c) => cell(c.as, row[c.column], table)));
      }
      await out.close();
    }
  }

  /**
   * Each version of each document: `content.json` as stored, and a page in
   * each language it is written in or shown in (spec, "Documents"). Versions
   * are read one at a time from their file, in order within each document.
   */
  private async writeDocuments(files: string, tenant: Tenant) {
    const path = (table: string) => join(files, `${(COVERAGE[table] as Exported).file}.jsonl`);
    const people = new Map<string, Localized>();
    for await (const { row } of readLines(path('users'))) people.set(row.id as string, row.name as Localized);
    const units = new Map<string, Localized>();
    for await (const { row } of readLines(path('org_units'))) units.set(row.id as string, row.name as Localized);
    const documents = new Map<string, Record<string, unknown>>();
    for await (const { row } of readLines(path('documents'))) documents.set(row.id as string, row);
    const runs = new Map<string, string[]>();
    for await (const { row } of readLines(path('approval_runs'))) {
      if (row.subject_type !== 'document_version') continue;
      runs.set(row.id as string, [row.subject_id as string]);
    }
    const steps = new Map<string, { kind: string; by: string | null; at: string | null; position: number }[]>();
    for await (const { row } of readLines(path('approval_run_steps'))) {
      const version = runs.get(row.run_id as string)?.[0];
      if (!version || !row.decided_at) continue;
      if (!steps.has(version)) steps.set(version, []);
      steps.get(version)!.push({ kind: row.kind as string, by: row.decided_by as string | null, at: row.decided_at as string, position: row.position as number });
    }
    const signatures = new Map<string, { meaning: string; by: string; at: string; hash: string }[]>();
    for await (const { row } of readLines(path('signatures'))) {
      if (row.subject_type !== 'document_version') continue;
      const id = row.subject_id as string;
      if (!signatures.has(id)) signatures.set(id, []);
      signatures.get(id)!.push({ meaning: row.meaning as string, by: row.user_id as string, at: row.signed_at as string, hash: row.content_hash as string });
    }
    const imports = new Map<string, Record<string, unknown>>();
    for await (const { row } of readLines(path('document_imports'))) imports.set(row.version_id as string, row);
    // Where each version's line is, by document, in order.
    const index = new Map<string, { at: number; length: number; version: number }[]>();
    for await (const { row, at, length } of readLines(path('document_versions'))) {
      const doc = row.document_id as string;
      if (!index.has(doc)) index.set(doc, []);
      index.get(doc)!.push({ at, length, version: row.version as number });
    }
    const folders = new Map<string, number>();
    const handle = await open(path('document_versions'), 'r');
    try {
      for (const [docId, versions] of index) {
        const doc = documents.get(docId);
        if (!doc) continue;
        const base = folderOf(String(doc.number));
        const seen = folders.get(base) ?? 0;
        folders.set(base, seen + 1);
        const folder = seen === 0 ? base : `${base}-${docId.slice(0, 8)}`;
        let previous: { id: string; version: number; content: Record<string, Record<string, string>> } | null = null;
        for (const v of versions.sort((a, b) => a.version - b.version)) {
          const buffer = Buffer.alloc(v.length);
          await handle.read(buffer, 0, v.length, v.at);
          const version = JSON.parse(buffer.toString('utf8')) as Record<string, unknown>;
          await this.writeVersion(files, folder, tenant, doc, version, previous, {
            people,
            units,
            steps: steps.get(version.id as string) ?? [],
            signatures: signatures.get(version.id as string) ?? [],
            imported: imports.get(version.id as string) ?? null,
          });
          if (version.published_at) {
            previous = { id: version.id as string, version: version.version as number, content: version.content as Record<string, Record<string, string>> };
          }
        }
      }
    } finally {
      await handle.close();
    }
  }

  private async writeVersion(
    files: string,
    folder: string,
    tenant: Tenant,
    doc: Record<string, unknown>,
    v: Record<string, unknown>,
    previous: { id: string; version: number; content: Record<string, Record<string, string>> } | null,
    about: {
      people: Map<string, Localized>;
      units: Map<string, Localized>;
      steps: { kind: string; by: string | null; at: string | null; position: number }[];
      signatures: { meaning: string; by: string; at: string; hash: string }[];
      imported: Record<string, unknown> | null;
    },
  ) {
    const dir = join(files, 'documents', folder, `v${v.version as number}`);
    await mkdir(dir, { recursive: true });
    const content = (v.content ?? {}) as Record<string, Record<string, string>>;
    const sections = (v.sections ?? []) as { key: string; name: Localized; required: boolean }[];
    const json = await Lines.at(join(dir, 'content.json'));
    await json.write(
      JSON.stringify(
        {
          documentId: doc.id,
          number: doc.number,
          versionId: v.id,
          version: v.version,
          status: v.status,
          authoritativeLocale: v.authoritative_locale,
          sections,
          content,
          changeSummary: v.change_summary,
        },
        null,
        2,
      ),
    );
    await json.close();
    const authoritative = (v.authoritative_locale as string | null) ?? (doc.authoritative_locale as string | null) ?? tenant.default_locale;
    const written = Object.keys(content).filter((l) => Object.values(content[l] ?? {}).some((t) => t.trim()));
    const locales = [...new Set([authoritative, ...tenant.locales.filter((l) => written.includes(l)), ...written])].filter(
      (l): l is Locale => (SUPPORTED_LOCALES as readonly string[]).includes(l),
    );
    const status = languageStatus({ sections, content }, previous, locales, authoritative);
    for (const locale of locales) {
      const words = EXPORT_WORDING[locale];
      const audit = AUDIT_WORDING[locale];
      const name = (id: unknown) => {
        const n = typeof id === 'string' ? about.people.get(id) : undefined;
        return n ? pickText(n, locale, tenant.default_locale) : null;
      };
      const code = (c: string) => words.values[c] ?? (audit.details.values as Record<string, string>)[c] ?? c;
      const moment = (at: unknown) => (typeof at === 'string' ? momentIn(new Date(at), tenant.time_zone) : null);
      const unit = typeof doc.owner_unit_id === 'string' ? about.units.get(doc.owner_unit_id) : undefined;
      const html = versionHtml(
        {
          locale,
          defaultLocale: tenant.default_locale,
          organization: tenant.name,
          number: String(doc.number),
          title: doc.title as Localized,
          version: v.version as number,
          status: code(String(v.status)),
          owner: name(doc.owner_id),
          ownerUnit: unit ? pickText(unit, locale, tenant.default_locale) : null,
          effectiveOn: (v.effective_on as string | null) ?? null,
          authoritative,
          sections: sections.map((s) => ({
            key: s.key,
            name: s.name,
            state: status.sections.find((x) => x.key === s.key)?.locales[locale] ?? 'empty',
          })),
          content,
          changeSummary: (v.change_summary as Localized | null) ?? null,
          approvals: about.steps
            .sort((a, b) => a.position - b.position)
            .map((s) => ({ step: code(s.kind), by: name(s.by), at: moment(s.at) })),
          imported: about.imported
            ? {
                approvedOn: (about.imported.approved_on as string | null) ?? null,
                approvedBy: (about.imported.approved_by as string | null) ?? null,
                originalKeptAt: (about.imported.original_kept_at as Localized | null) ?? null,
                differences: about.imported.differences ?? null,
              }
            : null,
          signatures: about.signatures.map((s) => ({ meaning: code(s.meaning), by: name(s.by), at: moment(s.at) ?? '', contentHash: s.hash })),
          languageName: (l) => (words.languages as Record<string, string>)[l] ?? l,
        },
        words,
      );
      const page = await Lines.at(join(dir, `${locale}.html`));
      await page.write(html);
      await page.close();
    }
  }

  /** The names of the people who asked and approved, from the archive's own file. */
  private async namesOf(files: string, ids: string[]) {
    const out = new Map<string, Localized>();
    for await (const { row } of readLines(join(files, `${(COVERAGE.users as Exported).file}.jsonl`))) {
      if (ids.includes(row.id as string)) out.set(row.id as string, row.name as Localized);
    }
    return out;
  }

  /** Every file made, by its path in the archive, in order. */
  private async listFiles(root: string) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'))
      .sort();
  }

  /** The README in one language. */
  private readme(locale: Locale, tenant: Tenant, at: Date, keyId: string | null) {
    const w = EXPORT_WORDING[locale].readme;
    const organization = pickText(tenant.name, locale, tenant.default_locale);
    const fill = (t: string) => t.replace('{organization}', organization).replace('{moment}', momentIn(at, tenant.time_zone)).replace('{keyId}', keyId ?? '');
    return [
      fill(w.title),
      '',
      fill(w.intro),
      '',
      w.contents,
      ...Object.values(w.folders).map((f) => `- ${f}`),
      '',
      w.formatsTitle,
      ...w.formats.map((f) => `- ${f}`),
      '',
      w.pdfs,
      '',
      w.checkTitle,
      ...w.checks,
      keyId ? fill(w.signedBy) : w.unsigned,
      '',
      w.personalTitle,
      ...w.personal,
      '',
      w.notIncludedTitle,
      ...w.notIncluded.map((f) => `- ${f}`),
      '',
    ].join('\r\n');
  }
}

/** The actions an export writes: registered, for the audit registry's check. */
export const EXPORT_ACTIONS = Object.keys(AUDIT_ACTIONS).filter((a) => a.startsWith('data_export_'));
