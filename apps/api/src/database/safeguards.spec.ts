import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { createDatabase, type Transaction } from './client.js';
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

// Marks what this file creates, so it can be removed without touching
// anything else the demo tenants hold.
const TEST_REFERENCE = 'ZZSAFE-';

/** Postgres "insufficient_privilege": the role has no grant for this. */
const PERMISSION_DENIED = { cause: { code: '42501' } };
/** Postgres "check_violation". */
const CHECK_VIOLATION = { cause: { code: '23514' } };

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
        sql`update tenants set plan = 'enterprise', public_reporting = true`,
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
        .set({ plan: sql`${tenants.plan}` })
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
          // Applied twice: the second time must change nothing.
          for (const statement of [...statements, ...statements]) {
            await tx.execute(sql.raw(statement));
          }
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
