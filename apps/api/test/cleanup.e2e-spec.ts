import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { like } from 'drizzle-orm';
import { createDatabase } from '../src/database/client.js';
import { platformAdmins, tenants } from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';
import { removeTestData } from './cleanup.js';

/**
 * The suite shares its database with hospitals it did not make. What it
 * removes when a run ends must be that run's own, named exactly.
 */
describe("removing a test run's data", () => {
  const run = randomBytes(4).toString('hex');
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  const slugs = async () =>
    (
      await owner.db
        .select({ slug: tenants.slug })
        .from(tenants)
        .where(like(tenants.slug, `c_-${run}%`))
        .orderBy(tenants.slug)
    ).map((t) => t.slug);
  const emails = async () =>
    (
      await owner.db
        .select({ email: platformAdmins.email })
        .from(platformAdmins)
        .where(like(platformAdmins.email, `%-${run}@test.invalid`))
        .orderBy(platformAdmins.email)
    ).map((a) => a.email);
  beforeAll(async () => {
    await owner.db.insert(tenants).values(
      [`cl-${run}-a`, `cl-${run}-b`, `cx-${run}-a`].map((slug) => ({
        slug,
        name: { en: 'Cleanup spec' },
        accreditationStandard: 'JCI' as const,
      })),
    );
    await owner.db.insert(platformAdmins).values(
      ['one', 'two'].map((name) => ({
        email: `${name}-${run}@test.invalid`,
        name: 'Cleanup spec',
        passwordHash: 'x',
      })),
    );
  });

  afterAll(async () => {
    await removeTestData(`cl-${run}`, `one-${run}@test.invalid`);
    await removeTestData(`cx-${run}`, `two-${run}@test.invalid`);
    await owner.pool.end();
  });

  it('refuses a prefix that could be anybody', async () => {
    for (const prefix of ['', '%', 'demo-', 'cl-', `cl-${run}`.slice(0, 7)]) {
      await expect(
        removeTestData(prefix, 'nobody@test.invalid'),
      ).rejects.toThrow(/too short/);
    }
    expect(await slugs()).toHaveLength(3);
  });

  it('reads the prefix and the email letter for letter, never as a pattern', async () => {
    // Each of these would have matched as a pattern: "_" for any one
    // character, "%" for any run of them.
    await removeTestData(`c_-${run}`, `%-${run}@test.invalid`);
    await removeTestData(`c%-${run}`, `___-${run}@test.invalid`);
    await removeTestData(`cl-${run}%`, `one-${run}@test.invali_`);
    expect(await slugs()).toEqual([
      `cl-${run}-a`,
      `cl-${run}-b`,
      `cx-${run}-a`,
    ]);
    expect(await emails()).toEqual([
      `one-${run}@test.invalid`,
      `two-${run}@test.invalid`,
    ]);
  });

  it("removes that run's own clients and admin, and no other", async () => {
    await removeTestData(`cl-${run}`, `one-${run}@test.invalid`);
    expect(await slugs()).toEqual([`cx-${run}-a`]);
    expect(await emails()).toEqual([`two-${run}@test.invalid`]);
  });
});
