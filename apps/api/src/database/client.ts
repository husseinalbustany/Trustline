import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

/**
 * How long a request waits for a connection when all of a pool's are in use
 * (or the database does not answer), in milliseconds. Without a limit it
 * would wait for ever: a flood that holds every connection would leave each
 * later request hanging instead of failing, and the requests behind it
 * piling up. Long enough to ride out a burst, short enough that a caller is
 * answered.
 */
export const CONNECTION_TIMEOUT_MS = 10_000;

export function createDatabase(connectionString: string) {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { pool, db };
}

export type Database = ReturnType<typeof createDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
