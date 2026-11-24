import '../src/env.js';
import { runMigrations } from '../src/database/migrate.js';
import { seed } from '../src/database/seed.js';

// Tests run against a real Postgres (DATABASE_URL), migrated and seeded with
// the demo tenants.
export default async function setup() {
  await runMigrations();
  await seed();
}
