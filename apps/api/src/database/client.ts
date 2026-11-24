import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { pool, db };
}

export type Database = ReturnType<typeof createDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
