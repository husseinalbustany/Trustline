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

    await buildConcurrently(db);
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

/**
 * Indexes on tables that may already be large, built before the migrations
 * without holding writes back (CONCURRENTLY, which cannot run in the
 * transaction the migrations run in). The migration that needs each makes
 * it only if it is not there, so a new database, whose table is empty,
 * gets it from the migration. An index left invalid by a build that was
 * interrupted is dropped and built again.
 */
const CONCURRENT_INDEXES = [
  {
    // Migration 0050: the key email_queue_notification_fk points to it.
    name: 'notifications_tenant_id_id_key',
    table: 'notifications',
    create:
      'create unique index concurrently if not exists "notifications_tenant_id_id_key" on "notifications" using btree ("tenant_id", "id")',
  },
];

async function buildConcurrently(db: ReturnType<typeof createDatabase>['db']) {
  for (const index of CONCURRENT_INDEXES) {
    const { rows } = await db.execute<{ table: boolean; valid: boolean | null }>(sql`
      select to_regclass(${`public.${index.table}`}) is not null as table,
             (select i.indisvalid from pg_index i
               where i.indexrelid = to_regclass(${`public.${index.name}`})) as valid`);
    if (!rows[0].table) continue;
    if (rows[0].valid === false) {
      await db.execute(sql.raw(`drop index concurrently if exists "${index.name}"`));
    }
    if (rows[0].valid !== true) await db.execute(sql.raw(index.create));
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log('Migrations applied.');
}
