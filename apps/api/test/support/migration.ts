import { sql } from 'drizzle-orm';
import type { Transaction } from '../../src/database/client.js';

/** A value written into SQL that cannot take parameters, such as a view. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** `column = 'value'`, or `column in ('a', 'b')` for several. */
export const among = (column: string, values: string[]) =>
  `"${column}" in (${values.map(literal).join(', ')})`;

/** `column like 'prefix%'`, for a prefix with no `%` or `_` of its own. */
export const startsWith = (column: string, prefix: string) => {
  if (/[%_\\]/.test(prefix)) {
    throw new Error(`startsWith: "${prefix}" would be read as a pattern`);
  }
  return `"${column}" like ${literal(`${prefix}%`)}`;
};

/**
 * Applies a data migration twice (the second time must change nothing)
 * inside `tx`, with its text unchanged and on the real tables, but with each
 * table named in `only` narrowed to the rows that condition picks.
 *
 * A data migration reads and writes every hospital's rows. The test suite
 * runs its files in parallel on one database, so run as it is, a migration
 * would update and lock rows that other test files (or anyone else using the
 * database) are working on at that moment: it waits for any row someone else
 * holds, without limit, as the owner role does, and holds every row it
 * touched until the test rolls back. safeguards.spec.ts holds one of its
 * incidents for five seconds on purpose, and deadlines.spec.ts timed out
 * whenever its migration ran during those five seconds.
 *
 * So each table in `only` is shadowed, for this transaction only, by a
 * temporary view of the same name: Postgres looks for an unqualified name
 * among the session's temporary objects first. Such a view is updatable, so
 * every UPDATE, INSERT and DELETE of the migration still runs against the
 * real table, with its constraints, triggers and foreign keys, but on no row
 * outside the view; a row it never matches, it never waits for or locks.
 * Tables the migration only reads, or inserts into for rows the shadowed
 * tables select, need no view. The views are dropped before this returns,
 * so what the test reads afterwards is the real table.
 *
 * A wait for somebody else's lock fails at once rather than when the test
 * runs out of time, which is what the statements would do if the views ever
 * stopped applying.
 */
export async function applyToOwnRows(
  tx: Transaction,
  statements: string[],
  only: Record<string, string>,
) {
  await tx.execute(sql`set local lock_timeout = '1s'`);
  for (const [table, condition] of Object.entries(only)) {
    await tx.execute(
      sql.raw(
        `create temporary view "${table}" as select * from public."${table}" where ${condition}`,
      ),
    );
    // The name the migration uses now means the view, not the table.
    const { rows } = await tx.execute<{ shadowed: boolean }>(
      sql`select relnamespace = pg_my_temp_schema() as shadowed from pg_class where oid = to_regclass(${`"${table}"`})`,
    );
    if (!rows[0]?.shadowed) {
      throw new Error(`applyToOwnRows: "${table}" is not narrowed`);
    }
  }
  for (const statement of [...statements, ...statements]) {
    await tx.execute(sql.raw(statement));
  }
  for (const table of Object.keys(only)) {
    await tx.execute(sql.raw(`drop view pg_temp."${table}"`));
  }
}
