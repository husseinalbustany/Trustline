import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import {
  CONNECTION_TIMEOUT_MS,
  createDatabase,
  type Transaction,
} from './client.js';
import {
  incidentCategories,
  incidentComments,
  incidentEvents,
  incidents,
  orgUnits,
  roles,
  tenants,
} from './schema.js';
import { TenantDb } from './tenant-db.service.js';
import { among, applyToOwnRows } from '../../test/support/migration.js';

// Marks what this file creates, so it can be removed without touching
// anything else the demo tenants hold.
const TEST_REFERENCE = 'ZZSAFE-';

/** Postgres "insufficient_privilege": the role has no grant for this. */
const PERMISSION_DENIED = { cause: { code: '42501' } };
/** Postgres "check_violation". */
const CHECK_VIOLATION = { cause: { code: '23514' } };
/** Postgres "lock_not_available": the wait for a lock ran out. */
const LOCK_TIMEOUT = { cause: { code: '55P03' } };

describe('what the database itself enforces for the incident safeguards', () => {
  // Connects as the application role, exactly as the running API does.
  const { pool, db } = createDatabase(requireEnv('APP_DATABASE_URL'));
  const tenantDb = new TenantDb(db);
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  const platform = createDatabase(requireEnv('PLATFORM_DATABASE_URL'));
  const rollback = new Error('rollback');
  let jci: string;
  let cbahi: string;

  const removeTestRows = async () => {
    const mine = owner.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(like(incidents.reference, `${TEST_REFERENCE}%`));
    await owner.db
      .delete(incidentEvents)
      .where(inArray(incidentEvents.incidentId, mine));
    await owner.db
      .delete(incidentComments)
      .where(inArray(incidentComments.incidentId, mine));
    await owner.db
      .delete(incidents)
      .where(like(incidents.reference, `${TEST_REFERENCE}%`));
  };

  /** What an anonymous report needs, in the tenant's first org unit. */
  const reportValues = async (
    tx: Transaction,
    tenantId: string,
    name: string,
  ) => {
    const [unit] = await tx.select().from(orgUnits).limit(1);
    const [category] = await tx
      .select()
      .from(incidentCategories)
      .where(eq(incidentCategories.code, 'other'));
    return {
      tenantId,
      reference: `${TEST_REFERENCE}${name}`,
      type: 'near_miss' as const,
      categoryId: category.id,
      orgUnitId: unit.id,
      occurredAt: new Date(),
      description: 'Created by safeguards.spec.ts',
      harmLevel: 'none' as const,
    };
  };

  const publicReporting = async () =>
    Object.fromEntries(
      (
        await owner.db
          .select({ id: tenants.id, on: tenants.publicReporting })
          .from(tenants)
          .where(inArray(tenants.id, [jci, cbahi]))
      ).map((t) => [t.id, t.on]),
    );

  beforeAll(async () => {
    const rows = await db.select().from(tenants);
    jci = rows.find((t) => t.slug === 'demo-jci')!.id;
    cbahi = rows.find((t) => t.slug === 'demo-cbahi')!.id;
    await removeTestRows();
  });

  afterAll(async () => {
    await removeTestRows();
    await Promise.all([pool.end(), owner.pool.end(), platform.pool.end()]);
  });

  describe('the client record', () => {
    it('can still be read by the application, to find a hospital by its identifier', async () => {
      const slugs = (await db.select().from(tenants)).map((t) => t.slug);
      expect(slugs).toEqual(expect.arrayContaining(['demo-jci', 'demo-cbahi']));
    });

    it('lets the application switch public reporting for the hospital it acts for, and no other', async () => {
      const before = await publicReporting();
      let changed: string[] = [];
      await expect(
        tenantDb.withTenant(jci, async (tx) => {
          // No condition at all: every row the role is allowed to change.
          const rows = await tx
            .update(tenants)
            .set({ publicReporting: sql`not ${tenants.publicReporting}` })
            .returning({ id: tenants.id });
          changed = rows.map((r) => r.id);
          // Aimed at another hospital: nothing.
          const theirs = await tx
            .update(tenants)
            .set({ publicReporting: true })
            .where(eq(tenants.id, cbahi))
            .returning({ id: tenants.id });
          expect(theirs).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(changed).toEqual([jci]);
      expect(await publicReporting()).toEqual(before);
    });

    it('lets the application switch it for nobody when it acts for no hospital', async () => {
      const before = await publicReporting();
      const rows = await db
        .update(tenants)
        .set({ publicReporting: true })
        .returning({ id: tenants.id });
      expect(rows).toEqual([]);
      expect(await publicReporting()).toEqual(before);
    });

    it('lets the application change nothing else on it, not even its own', async () => {
      for (const statement of [
        sql`update tenants set status = 'suspended'`,
        sql`update tenants set slug = 'taken-over'`,
        sql`update tenants set name = '{"en": "Renamed"}'`,
        sql`update tenants set data_region = 'elsewhere', public_reporting = true`,
        // Clearing it would bring back the sessions and links a suspension
        // ended.
        sql`update tenants set access_reset_at = null`,
        sql`update tenants set sign_in_method = 'sso'`,
        sql`delete from tenants`,
        sql`insert into tenants (slug, name, accreditation_standard) values ('made-up', '{"en": "Made up"}', 'JCI')`,
      ]) {
        await expect(
          tenantDb.withTenant(jci, (tx) => tx.execute(statement)),
        ).rejects.toMatchObject(PERMISSION_DENIED);
      }
    });

    it('is still fully in the hands of the admin portal', async () => {
      const seen = await platform.db.select().from(tenants);
      expect(seen.map((t) => t.id)).toEqual(
        expect.arrayContaining([jci, cbahi]),
      );
      // A change that changes nothing, to prove the right without a trace.
      const [same] = await platform.db
        .update(tenants)
        .set({ accessResetAt: sql`${tenants.accessResetAt}` })
        .where(eq(tenants.id, jci))
        .returning({ id: tenants.id });
      expect(same.id).toBe(jci);
    });
  });

  describe('an anonymous report', () => {
    it('cannot arrive through the public link with a reporter', async () => {
      await expect(
        tenantDb.withTenant(jci, async (tx) =>
          tx.insert(incidents).values({
            ...(await reportValues(tx, jci, 'public-named')),
            channel: 'public',
            reportedBy: randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({
        cause: {
          ...CHECK_VIOLATION.cause,
          constraint: 'incidents_public_is_anonymous',
        },
      });
    });

    it('cannot have both a follow-up code and a reporter', async () => {
      await expect(
        tenantDb.withTenant(jci, async (tx) =>
          tx.insert(incidents).values({
            ...(await reportValues(tx, jci, 'code-named')),
            followUpCodeHash: 'a'.repeat(64),
            reportedBy: randomUUID(),
          }),
        ),
      ).rejects.toMatchObject({
        cause: {
          ...CHECK_VIOLATION.cause,
          constraint: 'incidents_follow_up_code_is_anonymous',
        },
      });
    });

    it('is from the signed-in app unless said otherwise, with no code and no closure request', async () => {
      const [incident] = await tenantDb.withTenant(jci, async (tx) =>
        tx
          .insert(incidents)
          .values(await reportValues(tx, jci, 'defaults'))
          .returning(),
      );
      expect(incident).toMatchObject({
        channel: 'app',
        followUpCodeHash: null,
        reportedBy: null,
        closureRequestedBy: null,
        closureRequestedAt: null,
      });
    });

    it("takes a comment with no author only when it is marked as the reporter's", async () => {
      const [incident] = await tenantDb.withTenant(jci, async (tx) =>
        tx
          .insert(incidents)
          .values(await reportValues(tx, jci, 'comments'))
          .returning(),
      );
      const values = {
        tenantId: jci,
        incidentId: incident.id,
        body: 'Created by safeguards.spec.ts',
        visibility: 'everyone' as const,
      };
      await expect(
        tenantDb.withTenant(jci, (tx) =>
          tx.insert(incidentComments).values(values),
        ),
      ).rejects.toMatchObject({
        cause: {
          ...CHECK_VIOLATION.cause,
          constraint: 'incident_comments_has_writer',
        },
      });
      const [comment] = await tenantDb.withTenant(jci, (tx) =>
        tx
          .insert(incidentComments)
          .values({ ...values, byReporter: true })
          .returning(),
      );
      expect(comment).toMatchObject({ authorId: null, byReporter: true });
      // Like any comment, it cannot be changed afterwards: not to name someone.
      await expect(
        tenantDb.withTenant(jci, (tx) =>
          tx
            .update(incidentComments)
            .set({ authorId: randomUUID() })
            .where(eq(incidentComments.id, comment.id)),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    });
  });

  describe('the second signature', () => {
    // What a sentinel event or a death is stored with: an incident proper.
    const grave = async (tx: Transaction, name: string) => ({
      ...(await reportValues(tx, jci, `sign-${name}`)),
      type: 'incident' as const,
    });
    const flagOf = async (id: string) =>
      (
        await owner.db
          .select({ needed: incidents.signOffNeeded })
          .from(incidents)
          .where(eq(incidents.id, id))
      )[0].needed;
    /** Stored through the application role, as the API stores it. */
    const store = async (
      name: string,
      values: Partial<typeof incidents.$inferInsert> = {},
    ) => {
      const [incident] = await tenantDb.withTenant(jci, async (tx) =>
        tx
          .insert(incidents)
          .values({ ...(await grave(tx, name)), ...values })
          .returning({ id: incidents.id, needed: incidents.signOffNeeded }),
      );
      return incident;
    };
    const change = (
      id: string,
      values: Partial<typeof incidents.$inferInsert>,
    ) =>
      tenantDb.withTenant(jci, (tx) =>
        tx.update(incidents).set(values).where(eq(incidents.id, id)),
      );

    it('is needed from the moment a sentinel event or a death is stored, whoever stores it', async () => {
      // Nothing said about the flag, as a release that does not know of it.
      expect((await store('sentinel', { isSentinel: true })).needed).toBe(true);
      expect((await store('death', { harmLevel: 'death' })).needed).toBe(true);
      // Said to be false, by mistake: it is not.
      expect(
        (
          await store('wrong', {
            harmLevel: 'death',
            isSentinel: true,
            signOffNeeded: false,
          })
        ).needed,
      ).toBe(true);
      // Anything less is stored as it is said to be.
      expect((await store('severe', { harmLevel: 'severe' })).needed).toBe(
        false,
      );
      expect((await store('plain')).needed).toBe(false);
      expect((await store('said', { signOffNeeded: true })).needed).toBe(true);
    });

    it('is needed once triage makes it a sentinel event or a death, with nothing said about it', async () => {
      const made = await store('raised', { harmLevel: 'mild' });
      expect(made.needed).toBe(false);
      // An update that touches something else leaves it alone.
      await change(made.id, { status: 'triaged' });
      expect(await flagOf(made.id)).toBe(false);
      await change(made.id, { isSentinel: true });
      expect(await flagOf(made.id)).toBe(true);
      const fatal = await store('fatal', { harmLevel: 'severe' });
      await change(fatal.id, { harmLevel: 'death' });
      expect(await flagOf(fatal.id)).toBe(true);
    });

    it('never falls again, whatever is written, and by whomever', async () => {
      const { id } = await store('kept', { isSentinel: true });
      // Called something else, and the flag cleared in the same breath.
      await change(id, {
        isSentinel: false,
        harmLevel: 'none',
        signOffNeeded: false,
      });
      expect(await flagOf(id)).toBe(true);
      // Cleared on its own, when nothing else says it was ever needed.
      await change(id, { signOffNeeded: false });
      expect(await flagOf(id)).toBe(true);
      // By a statement written by hand, and for every row at once.
      await tenantDb.withTenant(jci, (tx) =>
        tx.execute(
          sql`update incidents set sign_off_needed = false where reference like ${`${TEST_REFERENCE}sign-%`}`,
        ),
      );
      expect(await flagOf(id)).toBe(true);
      // Not even by the role that owns the table.
      await owner.db
        .update(incidents)
        .set({ signOffNeeded: false })
        .where(eq(incidents.id, id));
      expect(await flagOf(id)).toBe(true);
      // The change is not refused: whatever else it carries is stored.
      await change(id, { signOffNeeded: false, status: 'in_progress' });
      const [row] = await owner.db
        .select({ status: incidents.status, needed: incidents.signOffNeeded })
        .from(incidents)
        .where(eq(incidents.id, id));
      expect(row).toEqual({ status: 'in_progress', needed: true });
    });

    it('is kept by a release that knows nothing of it, through a whole life of an incident', async () => {
      // Every statement here leaves the column out, as the release before
      // it existed would.
      const values = await tenantDb.withTenant(jci, (tx) => grave(tx, 'old'));
      const made = await tenantDb.withTenant(jci, (tx) =>
        tx.execute<{ id: string }>(
          sql`insert into incidents (tenant_id, reference, type, category_id, org_unit_id, occurred_at, description, harm_level)
              values (${jci}, ${values.reference}, 'incident', ${values.categoryId}, ${values.orgUnitId}, now(), 'Created by safeguards.spec.ts', 'severe')
              returning id`,
        ),
      );
      const { id } = made.rows[0];
      expect(await flagOf(id)).toBe(false);
      const triage = (assignments: ReturnType<typeof sql>) =>
        tenantDb.withTenant(jci, (tx) =>
          tx.execute(
            sql`update incidents set ${assignments}, revision = revision + 1 where id = ${id}`,
          ),
        );
      await triage(sql`is_sentinel = true, status = 'triaged'`);
      expect(await flagOf(id)).toBe(true);
      // Lowered again by that same release: what it was until then counts.
      await triage(sql`is_sentinel = false, harm_level = 'mild'`);
      expect(await flagOf(id)).toBe(true);
      await triage(sql`harm_level = 'none'`);
      expect(await flagOf(id)).toBe(true);
    });
  });

  describe("the application role's sessions", () => {
    const setting = async (
      database: ReturnType<typeof createDatabase>['db'],
      name: string,
    ) =>
      (
        await database.execute<{ value: string }>(
          sql`select current_setting(${name}) as value`,
        )
      ).rows[0].value;

    it('give up a statement, a wait for a lock and an idle transaction after a while', async () => {
      expect(await setting(db, 'statement_timeout')).toBe('15s');
      expect(await setting(db, 'lock_timeout')).toBe('5s');
      expect(await setting(db, 'idle_in_transaction_session_timeout')).toBe(
        '1min',
      );
      // Inside a hospital's transaction too: that is where the API works.
      expect(
        await tenantDb.withTenant(
          jci,
          async (tx) =>
            (
              await tx.execute<{ value: string }>(
                sql`select current_setting('statement_timeout') as value`,
              )
            ).rows[0].value,
        ),
      ).toBe('15s');
    });

    it('leave migrations, the seed and the admin portal as they were', async () => {
      for (const database of [owner.db, platform.db]) {
        expect(await setting(database, 'statement_timeout')).toBe('0');
        expect(await setting(database, 'lock_timeout')).toBe('0');
        expect(
          await setting(database, 'idle_in_transaction_session_timeout'),
        ).toBe('0');
      }
    });

    it('do not wait for ever for a row somebody else holds', async () => {
      const [incident] = await tenantDb.withTenant(jci, async (tx) =>
        tx
          .insert(incidents)
          .values(await reportValues(tx, jci, 'held'))
          .returning({ id: incidents.id }),
      );
      const holder = await owner.pool.connect();
      try {
        await holder.query('begin');
        await holder.query('select 1 from incidents where id = $1 for update', [
          incident.id,
        ]);
        const began = Date.now();
        await expect(
          tenantDb.withTenant(jci, (tx) =>
            tx
              .update(incidents)
              .set({ description: 'Changed by safeguards.spec.ts' })
              .where(eq(incidents.id, incident.id)),
          ),
        ).rejects.toMatchObject(LOCK_TIMEOUT);
        const waited = Date.now() - began;
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(12_000);
      } finally {
        await holder.query('rollback');
        holder.release();
      }
    }, 30_000);

    it('wait only so long for a connection when all are in use', () => {
      for (const { options } of [pool, owner.pool, platform.pool]) {
        expect(options.connectionTimeoutMillis).toBe(CONNECTION_TIMEOUT_MS);
      }
      expect(CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
      expect(CONNECTION_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    });
  });

  describe('the migration that brings the built-in roles of existing clients up to date', () => {
    const NEW = ['incidents.see_reporter', 'incidents.sign_off'];
    const statements = readFileSync(
      resolve(
        import.meta.dirname,
        '../../drizzle/0020_built_in_roles_reporter_and_sign_off.sql',
      ),
      'utf8',
    ).split('--> statement-breakpoint');

    it('adds the two rights to the administrator and the quality officer, once, and to no other role', async () => {
      let result: Record<string, string[]> = {};
      await expect(
        owner.db.transaction(async (tx) => {
          // A client as it was before this release, with a role of its own.
          await tx
            .update(roles)
            .set({
              permissions: sql`array_remove(array_remove(${roles.permissions}, ${NEW[0]}), ${NEW[1]})`,
            })
            .where(eq(roles.tenantId, jci));
          await tx.insert(roles).values({
            tenantId: jci,
            code: 'zz_own_role',
            name: { en: 'Own role' },
            permissions: ['incidents.view', 'incidents.triage'],
          });
          const before = await tx
            .select({ permissions: roles.permissions })
            .from(roles)
            .where(eq(roles.tenantId, jci));
          expect(before.flatMap((r) => r.permissions)).not.toEqual(
            expect.arrayContaining(NEW),
          );
          // On this hospital's roles only: see applyToOwnRows.
          await applyToOwnRows(tx, statements, {
            roles: among('tenant_id', [jci]),
          });
          const after = await tx
            .select({ code: roles.code, permissions: roles.permissions })
            .from(roles)
            .where(eq(roles.tenantId, jci));
          result = Object.fromEntries(
            after.map((r) => [
              r.code,
              r.permissions.filter((p) => NEW.includes(p)).sort(),
            ]),
          );
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(result).toEqual({
        administrator: NEW,
        quality_officer: NEW,
        department_manager: [],
        // Built in since migration 0045; this one gives it neither.
        approving_authority: [],
        reporter: [],
        zz_own_role: [],
      });
    });

    it('has left every built-in role of the demo hospitals as the code defines it', async () => {
      const { SYSTEM_ROLES } = await import('../identity/permissions.js');
      for (const tenantId of [jci, cbahi]) {
        const rows = await tenantDb.withTenant(tenantId, (tx) =>
          tx.select().from(roles).where(eq(roles.isSystem, true)),
        );
        expect(
          Object.fromEntries(
            rows.map((r) => [r.code, [...r.permissions].sort()]),
          ),
        ).toEqual(
          Object.fromEntries(
            SYSTEM_ROLES.map((r) => [r.code, [...r.permissions].sort()]),
          ),
        );
      }
    });
  });
});
