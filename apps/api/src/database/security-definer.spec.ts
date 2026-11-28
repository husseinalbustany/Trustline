import { sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';

/**
 * The functions that run with their owner's rights (SECURITY DEFINER), and
 * so do what the application role alone could not: each fixes its
 * search_path, and ends it with pg_temp. When pg_temp is not named,
 * PostgreSQL looks there first for tables, so a temporary table of the
 * calling session could stand in for a real one (security review 13, M1).
 */
describe('functions that run with their owner’s rights', () => {
  const { pool, db } = createDatabase(requireEnv('DATABASE_URL'));
  afterAll(() => pool.end());

  /**
   * The audit chain's functions of migration 0058, which the main branch is
   * fixing in its own migration (security review 13). Remove this list when
   * this branch is rebased on that fix.
   */
  const FIXED_ON_MAIN = ['audit_chain_report_break', 'audit_chain_seal_entry', 'audit_log_seal'];

  it('each fix a search_path that ends with pg_temp', async () => {
    const { rows } = await db.execute<{ name: string; config: string[] | null }>(sql`
      select p.proname as name, p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname = 'public'
      order by 1`);
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(['ai_platform_spend_this_month', 'ai_report_spending_limit']));
    const wrong = rows
      .filter((r) => !FIXED_ON_MAIN.includes(r.name))
      .filter((r) => {
        const path = (r.config ?? []).find((c) => c.startsWith('search_path='));
        return !path || !/(^|,)\s*pg_temp$/.test(path.slice('search_path='.length));
      })
      .map((r) => r.name);
    expect(wrong).toEqual([]);
  });

  it('give the platform’s spend for this month only, whatever a session puts in its way', async () => {
    const app = createDatabase(requireEnv('APP_DATABASE_URL'));
    try {
      const spent = await app.db.transaction(async (tx) => {
        // A temporary table of the same name, as an injection could make.
        await tx.execute(sql`create temporary table ai_requests (cost_micro_usd bigint, created_at timestamptz, outcome text) on commit drop`);
        await tx.execute(sql`insert into ai_requests values (123456789, now(), 'succeeded')`);
        const { rows } = await tx.execute<{ spent: string }>(sql`select public.ai_platform_spend_this_month() as spent`);
        return Number(rows[0].spent);
      });
      expect(spent).not.toBe(123456789);
      // The moment is the function's own: it takes none.
      await expect(app.db.execute(sql`select public.ai_platform_spend_since(now())`)).rejects.toThrow();
    } finally {
      await app.pool.end();
    }
  });
});
