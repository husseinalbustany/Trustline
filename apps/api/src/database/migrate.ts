import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';

// Login roles the API uses, and the variable holding each one's connection URL.
const ROLES = {
  // Tenant data, restricted by row-level security.
  trustline_app: 'APP_DATABASE_URL',
  // The admin portal: client records and platform staff, no tenant data.
  trustline_platform: 'PLATFORM_DATABASE_URL',
};

/**
 * Applies pending migrations as the owner role (DATABASE_URL).
 *
 * Also makes sure the API's roles exist, and lets each log in with the
 * password from its connection URL so a fresh database needs no manual step.
 */
export async function runMigrations() {
  const { pool, db } = createDatabase(requireEnv('DATABASE_URL'));
  try {
    for (const role of Object.keys(ROLES)) {
      await db.execute(
        sql.raw(`
          do $$ begin
            if not exists (select from pg_roles where rolname = '${role}') then
              create role ${role} nologin;
            end if;
          end $$`),
      );
    }

    await migrate(db, {
      migrationsFolder: resolve(import.meta.dirname, '../../drizzle'),
    });

    for (const [role, variable] of Object.entries(ROLES)) {
      const url = process.env[variable];
      if (!url) continue;
      const { username, password } = new URL(url);
      if (username !== role || !password) continue;
      const { rows } = await db.execute<{ stmt: string }>(
        sql`select format('alter role %I login password %L', ${role}::text, ${decodeURIComponent(password)}::text) as stmt`,
      );
      await db.execute(sql.raw(rows[0].stmt));
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log('Migrations applied.');
}
