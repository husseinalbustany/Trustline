import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';

const APP_ROLE = 'trustline_app';

/**
 * Applies pending migrations as the owner role (DATABASE_URL).
 *
 * Also makes sure the application role exists, and lets it log in with the
 * password from APP_DATABASE_URL so a fresh database needs no manual step.
 */
export async function runMigrations() {
  const { pool, db } = createDatabase(requireEnv('DATABASE_URL'));
  try {
    await db.execute(
      sql.raw(`
        do $$ begin
          if not exists (select from pg_roles where rolname = '${APP_ROLE}') then
            create role ${APP_ROLE} nologin;
          end if;
        end $$`),
    );

    await migrate(db, {
      migrationsFolder: resolve(import.meta.dirname, '../../drizzle'),
    });

    const appUrl = process.env.APP_DATABASE_URL;
    if (appUrl) {
      const { username, password } = new URL(appUrl);
      if (username === APP_ROLE && password) {
        const { rows } = await db.execute<{ stmt: string }>(
          sql`select format('alter role %I login password %L', ${APP_ROLE}::text, ${decodeURIComponent(password)}::text) as stmt`,
        );
        await db.execute(sql.raw(rows[0].stmt));
      }
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log('Migrations applied.');
}
