import { sql } from 'drizzle-orm';
import { createDatabase } from '../database/client.js';
import { requireEnv } from '../env.js';
import { COVERAGE, CSV_FILES, SECRET_LIKE } from './coverage.js';

/**
 * Every table holding a client's data is in the export or left out of it
 * for a stated reason (docs/specs/data-export.md, "Every module's
 * records"), as `tenant-isolation.spec.ts` holds every such table to its
 * policy. A failure here names what to add to `coverage.ts`.
 */
describe('export coverage', () => {
  const { pool, db } = createDatabase(requireEnv('DATABASE_URL'));
  let columns: Map<string, string[]>;

  beforeAll(async () => {
    const { rows } = await db.execute<{ table_name: string; columns: string[] }>(sql`
      select c.relname as table_name, array_agg(a.attname::text order by a.attnum) as columns
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
        and exists (select from pg_attribute t where t.attrelid = c.oid and t.attname = 'tenant_id' and not t.attisdropped)
      group by c.relname`);
    columns = new Map(rows.map((r) => [r.table_name, r.columns]));
  });

  afterAll(() => pool.end());

  it('names every table with tenant_id, exported or excluded with a reason', () => {
    const missing = [...columns.keys()].filter((t) => !Object.hasOwn(COVERAGE, t)).sort();
    expect(missing, 'tables to add to src/exports/coverage.ts').toEqual([]);
  });

  it('names no table that is not there', () => {
    expect(Object.keys(COVERAGE).filter((t) => !columns.has(t)).sort()).toEqual([]);
  });

  it('gives every exclusion, and every column left out or kept, its reason', () => {
    for (const [table, c] of Object.entries(COVERAGE)) {
      if (c.kind === 'exclude') {
        expect(`${table}: ${c.reason.trim().length > 10}`).toBe(`${table}: true`);
        continue;
      }
      for (const [column, reason] of [...Object.entries(c.omit), ...Object.entries(c.keep)]) {
        expect(`${table}.${column}: ${reason.trim().length > 10}`).toBe(`${table}.${column}: true`);
      }
    }
  });

  it('leaves out or keeps, with a reason, every column that looks like a secret', () => {
    const unexplained: string[] = [];
    for (const [table, names] of columns) {
      const c = COVERAGE[table];
      if (!c || c.kind === 'exclude') continue;
      for (const name of names) {
        if (SECRET_LIKE.test(name) && !Object.hasOwn(c.omit, name) && !Object.hasOwn(c.keep, name)) {
          unexplained.push(`${table}.${name}`);
        }
      }
    }
    expect(unexplained, 'columns to omit or keep in src/exports/coverage.ts').toEqual([]);
  });

  it('leaves out or keeps only columns that are there', () => {
    const unknown: string[] = [];
    for (const [table, c] of Object.entries(COVERAGE)) {
      if (c.kind === 'exclude') continue;
      for (const name of [...Object.keys(c.omit), ...Object.keys(c.keep)]) {
        if (!columns.get(table)?.includes(name)) unknown.push(`${table}.${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('makes CSV files only of exported tables, of columns they export', () => {
    for (const [table, spec] of Object.entries(CSV_FILES)) {
      const c = COVERAGE[table];
      expect(c?.kind).toBe('export');
      for (const { column } of spec.columns) {
        expect(`${table}.${column}: ${columns.get(table)?.includes(column) && !(c as { omit: object }).omit[column as never]}`).toBe(
          `${table}.${column}: true`,
        );
      }
    }
  });

  it('never exports the secrets the spec names', () => {
    const out = (table: string, column: string) => {
      const c = COVERAGE[table];
      return c.kind === 'exclude' || Object.hasOwn(c.omit, column);
    };
    for (const t of ['sessions', 'user_tokens', 'sign_in_codes', 'email_queue', 'email_outbox', 'audit_chain_heads']) {
      expect(`${t}: ${COVERAGE[t].kind}`).toBe(`${t}: exclude`);
    }
    for (const [t, column] of [
      ['users', 'password_hash'],
      ['users', 'signing_pin_hash'],
      ['users', 'failed_attempts'],
      ['users', 'locked_until'],
      ['incidents', 'follow_up_code_hash'],
      ['data_exports', 'wrapped_key'],
      ['subscriptions', 'note'],
    ]) {
      expect(`${t}.${column}: ${out(t, column)}`).toBe(`${t}.${column}: true`);
    }
  });
});
