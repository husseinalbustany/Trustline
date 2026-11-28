import { readFileSync } from 'node:fs';
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
  // One run at a time (security review 9, finding 4): a second waits here
  // until the first has finished, so that two never build or drop the same
  // index, or apply the same migration, together. Held on a connection of
  // its own for the whole run, and released however the run ends.
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
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
    await migrate(db, { migrationsFolder: MIGRATIONS });

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
    await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    lock.release();
    await pool.end();
  }
}

const MIGRATIONS = resolve(import.meta.dirname, '../../drizzle');

/** The key of the advisory lock every migration run takes. */
const MIGRATION_LOCK = 724_002_050;

/**
 * Whether a migration is applied: drizzle records each by the moment in
 * its journal (`created_at`).
 */
async function applied(db: ReturnType<typeof createDatabase>['db'], tag: string) {
  const journal = JSON.parse(
    readFileSync(resolve(MIGRATIONS, 'meta/_journal.json'), 'utf8'),
  ) as { entries: { tag: string; when: number }[] };
  const entry = journal.entries.find((e) => e.tag === tag);
  if (!entry) return false;
  const { rows } = await db.execute<{ table: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as table`,
  );
  if (!rows[0].table) return false;
  const found = await db.execute(
    sql`select 1 from drizzle.__drizzle_migrations where created_at = ${entry.when}`,
  );
  return found.rows.length > 0;
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
    // Only while 0050 is not applied (security review 9, finding 4): once
    // it is, the index is the migrations' to keep, rename or drop.
    before: '0050_email_review_fixes',
    name: 'notifications_tenant_id_id_key',
    table: 'notifications',
    create:
      'create unique index concurrently if not exists "notifications_tenant_id_id_key" on "notifications" using btree ("tenant_id", "id")',
  },
];

async function buildConcurrently(db: ReturnType<typeof createDatabase>['db']) {
  for (const index of CONCURRENT_INDEXES) {
    if (await applied(db, index.before)) continue;
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
