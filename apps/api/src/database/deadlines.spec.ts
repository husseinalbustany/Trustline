import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { createDatabase, type Transaction } from './client.js';
import {
  auditLog,
  incidentCategories,
  incidentComments,
  incidentEvents,
  incidentResponseRules,
  incidents,
  notifications,
  orgUnits,
  tenants,
  users,
} from './schema.js';
import { TenantDb } from './tenant-db.service.js';

// Marks what this file creates, so it can be removed without touching
// anything else the demo tenants hold.
const TEST_REFERENCE = 'ZZDEAD-';
const TEST_EMAIL = 'zzdead-';

/** Postgres "insufficient_privilege": the role has no grant for this. */
const PERMISSION_DENIED = { cause: { code: '42501' } };
/** Postgres "check_violation". */
const CHECK_VIOLATION = { cause: { code: '23514' } };
/** Postgres "unique_violation". */
const UNIQUE_VIOLATION = { cause: { code: '23505' } };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const migration = (name: string) =>
  readFileSync(
    resolve(import.meta.dirname, `../../drizzle/${name}.sql`),
    'utf8',
  ).split('--> statement-breakpoint');

describe('what the database itself enforces for deadlines and notifications', () => {
  // Connects as the application role, exactly as the running API does.
  const { pool, db } = createDatabase(requireEnv('APP_DATABASE_URL'));
  const tenantDb = new TenantDb(db);
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  const platform = createDatabase(requireEnv('PLATFORM_DATABASE_URL'));
  const rollback = new Error('rollback');
  let jci: string;
  let cbahi: string;
  /** One user and one incident in each of the two demo hospitals. */
  const made: Record<string, { userId: string; incidentId: string }> = {};

  const removeTestRows = async () => {
    const mine = owner.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(like(incidents.reference, `${TEST_REFERENCE}%`));
    await owner.db
      .delete(notifications)
      .where(inArray(notifications.incidentId, mine));
    await owner.db
      .delete(incidentEvents)
      .where(inArray(incidentEvents.incidentId, mine));
    await owner.db
      .delete(incidentComments)
      .where(inArray(incidentComments.incidentId, mine));
    await owner.db
      .delete(incidents)
      .where(like(incidents.reference, `${TEST_REFERENCE}%`));
    await owner.db.delete(users).where(like(users.email, `${TEST_EMAIL}%`));
  };

  /** What a report needs, in the tenant's first org unit. */
  const reportValues = async (
    tx: Transaction,
    tenantId: string,
    name: string,
  ) => {
    const [unit] = await tx
      .select()
      .from(orgUnits)
      .where(eq(orgUnits.tenantId, tenantId))
      .limit(1);
    const [category] = await tx
      .select()
      .from(incidentCategories)
      .where(
        and(
          eq(incidentCategories.tenantId, tenantId),
          eq(incidentCategories.code, 'other'),
        ),
      );
    return {
      tenantId,
      reference: `${TEST_REFERENCE}${name}`,
      type: 'incident' as const,
      categoryId: category.id,
      orgUnitId: unit.id,
      occurredAt: new Date(),
      description: 'Created by deadlines.spec.ts',
      harmLevel: 'none' as const,
    };
  };

  beforeAll(async () => {
    const rows = await db.select().from(tenants);
    jci = rows.find((t) => t.slug === 'demo-jci')!.id;
    cbahi = rows.find((t) => t.slug === 'demo-cbahi')!.id;
    await removeTestRows();
    for (const [name, tenantId] of [
      ['jci', jci],
      ['cbahi', cbahi],
    ]) {
      const [user] = await owner.db
        .insert(users)
        .values({
          tenantId,
          name: { en: 'Deadline spec' },
          email: `${TEST_EMAIL}${name}@test.invalid`,
          status: 'active',
        })
        .returning({ id: users.id });
      const [incident] = await owner.db
        .insert(incidents)
        .values(
          await owner.db.transaction((tx) => reportValues(tx, tenantId, name)),
        )
        .returning({ id: incidents.id });
      made[tenantId] = { userId: user.id, incidentId: incident.id };
    }
  });

  afterAll(async () => {
    await removeTestRows();
    await Promise.all([pool.end(), owner.pool.end(), platform.pool.end()]);
  });

  describe('a notification', () => {
    const add = (tx: Transaction, tenantId: string, forTenant = tenantId) =>
      tx
        .insert(notifications)
        .values({
          tenantId,
          userId: made[forTenant].userId,
          incidentId: made[forTenant].incidentId,
          kind: 'overdue',
          data: { reference: 'x', deadline: 'triage' },
        })
        .returning({ id: notifications.id });

    it('can be written and read by the application for the hospital it acts for, and no other', async () => {
      const [mine] = await tenantDb.withTenant(jci, (tx) => add(tx, jci));
      const [theirs] = await tenantDb.withTenant(cbahi, (tx) => add(tx, cbahi));
      const seen = await tenantDb.withTenant(jci, (tx) =>
        tx
          .select({ id: notifications.id, tenantId: notifications.tenantId })
          .from(notifications)
          .where(inArray(notifications.id, [mine.id, theirs.id])),
      );
      expect(seen).toEqual([{ id: mine.id, tenantId: jci }]);
      // With no hospital set, none at all.
      expect(await db.select().from(notifications)).toEqual([]);
      // Not written into another hospital, in any combination.
      await expect(
        tenantDb.withTenant(jci, (tx) => add(tx, cbahi)),
      ).rejects.toThrow();
      // A user or an incident of another hospital cannot be pointed at.
      await expect(
        tenantDb.withTenant(jci, (tx) =>
          tx.insert(notifications).values({
            tenantId: jci,
            userId: made[cbahi].userId,
            incidentId: made[jci].incidentId,
            kind: 'overdue',
            data: {},
          }),
        ),
      ).rejects.toThrow();
      await expect(
        tenantDb.withTenant(jci, (tx) =>
          tx.insert(notifications).values({
            tenantId: jci,
            userId: made[jci].userId,
            incidentId: made[cbahi].incidentId,
            kind: 'overdue',
            data: {},
          }),
        ),
      ).rejects.toThrow();
    });

    it('can be marked read, and changed in no other way or removed', async () => {
      const [mine] = await tenantDb.withTenant(jci, (tx) => add(tx, jci));
      const [theirs] = await tenantDb.withTenant(cbahi, (tx) => add(tx, cbahi));
      const read = await tenantDb.withTenant(jci, (tx) =>
        tx
          .update(notifications)
          .set({ readAt: new Date() })
          // No condition on the hospital: every row the role may change.
          .where(inArray(notifications.id, [mine.id, theirs.id]))
          .returning({ id: notifications.id }),
      );
      expect(read).toEqual([{ id: mine.id }]);
      for (const change of [
        { userId: made[jci].userId },
        { kind: 'due_soon' as const },
        { data: { reference: 'y' } },
        { incidentId: made[jci].incidentId },
        { createdAt: new Date() },
        { readAt: null, kind: 'due_soon' as const },
      ]) {
        await expect(
          tenantDb.withTenant(jci, (tx) =>
            tx
              .update(notifications)
              .set(change)
              .where(eq(notifications.id, mine.id)),
          ),
        ).rejects.toMatchObject(PERMISSION_DENIED);
      }
      await expect(
        tenantDb.withTenant(jci, (tx) =>
          tx.delete(notifications).where(eq(notifications.id, mine.id)),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      const [kept] = await owner.db
        .select()
        .from(notifications)
        .where(eq(notifications.id, theirs.id));
      expect(kept.readAt).toBeNull();
    });

    it('is out of reach of the admin portal', async () => {
      await expect(
        platform.db.select().from(notifications),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      await expect(
        platform.db.select().from(incidentResponseRules),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    });
  });

  describe('the response rules', () => {
    it('can be changed by the application for its own hospital, within the limits, and never removed', async () => {
      let changed: string[] = [];
      await expect(
        tenantDb.withTenant(jci, async (tx) => {
          const rows = await tx
            .update(incidentResponseRules)
            .set({ triageWithinHours: 5 })
            .returning({ tenantId: incidentResponseRules.tenantId });
          changed = rows.map((r) => r.tenantId);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      // All five of its own, and none of anyone else's.
      expect(changed).toEqual([jci, jci, jci, jci, jci]);
      for (const outOfRange of [
        { triageWithinHours: 0 },
        { triageWithinHours: 721 },
        { closeWithinDays: 0 },
        { closeWithinDays: 366 },
      ]) {
        await expect(
          tenantDb.withTenant(jci, (tx) =>
            tx.update(incidentResponseRules).set(outOfRange),
          ),
        ).rejects.toMatchObject(CHECK_VIOLATION);
      }
      await expect(
        tenantDb.withTenant(jci, (tx) => tx.delete(incidentResponseRules)),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      await expect(
        tenantDb.withTenant(jci, (tx) =>
          tx.insert(incidentResponseRules).values({
            tenantId: cbahi,
            harmLevel: 'none',
            triageWithinHours: 1,
            closeWithinDays: 1,
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe("a hospital's time zone", () => {
    it('cannot be changed by the application, not even for the hospital it acts for', async () => {
      await expect(
        tenantDb.withTenant(jci, (tx) =>
          tx
            .update(tenants)
            .set({ timeZone: 'Asia/Dubai' })
            .where(eq(tenants.id, jci)),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      // Not smuggled in next to the one setting it may change.
      await expect(
        tenantDb.withTenant(jci, (tx) =>
          tx
            .update(tenants)
            .set({ publicReporting: false, timeZone: 'Asia/Dubai' })
            .where(eq(tenants.id, jci)),
        ),
      ).rejects.toMatchObject(PERMISSION_DENIED);
      const zones = await db
        .select({ timeZone: tenants.timeZone })
        .from(tenants)
        .where(eq(tenants.id, jci));
      expect(zones).toEqual([{ timeZone: 'UTC' }]);
    });

    it('is set by the admin portal, which needed no new grant for it', async () => {
      let after = '';
      await expect(
        platform.db.transaction(async (tx) => {
          const [row] = await tx
            .update(tenants)
            .set({ timeZone: 'Asia/Dubai' })
            .where(eq(tenants.id, jci))
            .returning({ timeZone: tenants.timeZone });
          after = row.timeZone;
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(after).toBe('Asia/Dubai');
      // It holds the whole table, so a new column is covered.
      const { rows } = await owner.db.execute<{ privilege_type: string }>(
        sql`select privilege_type from information_schema.table_privileges where table_name = 'tenants' and grantee = 'trustline_platform' order by 1`,
      );
      expect(rows.map((r) => r.privilege_type)).toEqual([
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);
    });
  });

  describe('what the security review asked of the tables', () => {
    it('lets no two reports of a hospital share a follow-up code', async () => {
      const hash = 'a'.repeat(64);
      await expect(
        owner.db.transaction(async (tx) => {
          const values = await reportValues(tx, jci, 'code-1');
          await tx.insert(incidents).values({
            ...values,
            followUpCodeHash: hash,
          });
          // The same in another hospital is another code.
          await tx.insert(incidents).values({
            ...(await reportValues(tx, cbahi, 'code-2')),
            followUpCodeHash: hash,
          });
          // Any number of reports have none.
          await tx.insert(incidents).values({
            ...values,
            reference: `${TEST_REFERENCE}code-3`,
          });
          await tx.insert(incidents).values({
            ...values,
            reference: `${TEST_REFERENCE}code-4`,
            followUpCodeHash: hash,
          });
        }),
      ).rejects.toMatchObject(UNIQUE_VIOLATION);
    });

    it('lets a comment be written as the reporter or as a handler, never as both', async () => {
      const comment = (capacity: { byReporter: boolean; asHandler: boolean }) =>
        owner.db.transaction(async (tx) => {
          await tx.insert(incidentComments).values({
            tenantId: jci,
            incidentId: made[jci].incidentId,
            authorId: made[jci].userId,
            body: 'x',
            visibility: 'everyone',
            ...capacity,
          });
          throw rollback;
        });
      await expect(
        comment({ byReporter: true, asHandler: true }),
      ).rejects.toMatchObject(CHECK_VIOLATION);
      for (const capacity of [
        { byReporter: true, asHandler: false },
        { byReporter: false, asHandler: true },
        // As a release that knows of neither would store it.
        { byReporter: false, asHandler: false },
      ]) {
        await expect(comment(capacity)).rejects.toBe(rollback);
      }
    });
  });

  describe('the migration that gives existing incidents their deadlines', () => {
    const statements = migration('0023_deadlines_for_existing_hospitals');

    it('fills in both deadlines from the starting values, and announces nothing that is already old', async () => {
      type Stored = {
        triageHours: number | null;
        closeDays: number | null;
        firstTriagedHours: number | null;
        sent: string;
      };
      const result: Record<string, Stored> = {};
      let rules = 0;
      await expect(
        owner.db.transaction(async (tx) => {
          // A hospital as it was before this release: no rules, and
          // incidents with no deadlines.
          await tx
            .delete(incidentResponseRules)
            .where(eq(incidentResponseRules.tenantId, jci));
          const ago = (ms: number) => new Date(Date.now() - ms);
          const base = await reportValues(tx, jci, '');
          const old = async (
            name: string,
            values: Partial<typeof incidents.$inferInsert>,
          ) => {
            const [row] = await tx
              .insert(incidents)
              .values({
                ...base,
                reference: `${TEST_REFERENCE}m-${name}`,
                ...values,
              })
              .returning({ id: incidents.id });
            return row.id;
          };
          // New, 100 hours old: its 72 hours have passed.
          await old('late', { reportedAt: ago(100 * HOUR) });
          // New, 60 hours old: in the last quarter of its 72 hours.
          await old('soon', { reportedAt: ago(60 * HOUR) });
          // New, an hour old.
          await old('fresh', { reportedAt: ago(HOUR) });
          // Reported with no harm 50 days ago, triaged after 10 hours, and
          // raised to severe 20 days ago: 45 days to close, which are over.
          const raised = await old('raised', {
            reportedAt: ago(50 * DAY),
            harmLevel: 'severe',
            status: 'triaged',
            triagedAt: ago(20 * DAY),
          });
          await tx.insert(incidentEvents).values([
            {
              tenantId: jci,
              incidentId: raised,
              kind: 'triaged',
              fromStatus: 'new',
              toStatus: 'triaged',
              occurredAt: ago(50 * DAY - 10 * HOUR),
              details: {},
            },
            {
              tenantId: jci,
              incidentId: raised,
              kind: 'triaged',
              fromStatus: 'triaged',
              toStatus: 'triaged',
              occurredAt: ago(20 * DAY),
              details: { harmLevel: { from: 'none', to: 'severe' } },
            },
          ]);
          // Mild, made a sentinel event at triage 39 days ago: the rule for
          // a death, 45 days, of which the last quarter has begun.
          const flagged = await old('sentinel', {
            reportedAt: ago(40 * DAY),
            harmLevel: 'mild',
            isSentinel: true,
            status: 'in_progress',
            triagedAt: ago(39 * DAY),
          });
          await tx.insert(incidentEvents).values({
            tenantId: jci,
            incidentId: flagged,
            kind: 'triaged',
            fromStatus: 'new',
            toStatus: 'triaged',
            occurredAt: ago(39 * DAY),
            details: { isSentinel: { from: false, to: true } },
          });
          // Closed long ago.
          await old('closed', {
            reportedAt: ago(200 * DAY),
            status: 'closed',
            closedAt: ago(190 * DAY),
          });
          await tx
            .update(incidents)
            .set({
              triageDueAt: null,
              closeDueAt: null,
              firstTriagedAt: null,
              triageDueSoonAt: null,
              triageOverdueAt: null,
              closeDueSoonAt: null,
              closeOverdueAt: null,
            })
            .where(like(incidents.reference, `${TEST_REFERENCE}m-%`));

          // Applied twice: the second time must change nothing.
          for (const statement of [...statements, ...statements]) {
            await tx.execute(sql.raw(statement));
          }

          rules = (
            await tx
              .select()
              .from(incidentResponseRules)
              .where(eq(incidentResponseRules.tenantId, jci))
          ).length;
          const { rows } = await tx.execute<Record<string, string | null>>(sql`
            select reference,
              round(extract(epoch from triage_due_at - reported_at) / 3600) as triage_hours,
              round(extract(epoch from close_due_at - reported_at) / 86400) as close_days,
              round(extract(epoch from first_triaged_at - reported_at) / 3600) as first_triaged_hours,
              concat_ws(',',
                case when triage_due_soon_at is not null then 'triage soon' end,
                case when triage_overdue_at is not null then 'triage overdue' end,
                case when close_due_soon_at is not null then 'close soon' end,
                case when close_overdue_at is not null then 'close overdue' end) as sent
            from incidents where reference like ${`${TEST_REFERENCE}m-%`}`);
          for (const row of rows) {
            const number = (value: string | null) =>
              value === null ? null : Number(value);
            result[row.reference!.replace(`${TEST_REFERENCE}m-`, '')] = {
              triageHours: number(row.triage_hours),
              closeDays: number(row.close_days),
              firstTriagedHours: number(row.first_triaged_hours),
              sent: row.sent!,
            };
          }
          throw rollback;
        }),
      ).rejects.toBe(rollback);

      expect(rules).toBe(5);
      expect(result).toEqual({
        // Overdue already: shown as overdue when read, announced to nobody.
        late: {
          triageHours: 72,
          closeDays: 30,
          firstTriagedHours: null,
          sent: 'triage soon,triage overdue',
        },
        // In its last quarter: that is not announced; missing it will be.
        soon: {
          triageHours: 72,
          closeDays: 30,
          firstTriagedHours: null,
          sent: 'triage soon',
        },
        // Everything about this one is still to come.
        fresh: {
          triageHours: 72,
          closeDays: 30,
          firstTriagedHours: null,
          sent: '',
        },
        // Triage by what the reporter gave, closing by what it is now.
        raised: {
          triageHours: 72,
          closeDays: 45,
          firstTriagedHours: 10,
          sent: 'triage soon,triage overdue,close soon,close overdue',
        },
        sentinel: {
          triageHours: 72,
          closeDays: 45,
          firstTriagedHours: 24,
          sent: 'triage soon,triage overdue,close soon',
        },
        closed: {
          triageHours: 72,
          closeDays: 30,
          firstTriagedHours: null,
          sent: 'triage soon,triage overdue,close soon,close overdue',
        },
      });
    });

    it('has left no incident without its two deadlines, apart from any a test is working on', async () => {
      const { rows } = await owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from incidents i join tenants t on t.id = i.tenant_id
            where t.slug like 'demo-%' and (i.triage_due_at is null or i.close_due_at is null)
              and i.reference not like ${`${TEST_REFERENCE}%`} and i.reference not like 'ZZ%'`,
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('the migration that applies the decisions of the security review to what is stored', () => {
    const statements = migration('0025_security_review_backfill');

    it('keeps the second signature for what was ever a sentinel event or a death, marks stored comments of reporters, and records the role change of 0020', async () => {
      const needed: Record<string, boolean> = {};
      let comments: {
        body: string;
        byReporter: boolean;
        asHandler: boolean;
      }[] = [];
      let audit: {
        tenantId: string;
        actorId: string | null;
        entityType: string | null;
        changes: unknown;
      }[] = [];
      await expect(
        owner.db.transaction(async (tx) => {
          const base = await reportValues(tx, jci, '');
          const old = async (
            name: string,
            values: Partial<typeof incidents.$inferInsert>,
            triages: Record<string, unknown>[] = [],
          ) => {
            const [row] = await tx
              .insert(incidents)
              .values({
                ...base,
                reference: `${TEST_REFERENCE}s-${name}`,
                ...values,
              })
              .returning({ id: incidents.id });
            for (const details of triages) {
              await tx.insert(incidentEvents).values({
                tenantId: jci,
                incidentId: row.id,
                kind: 'triaged',
                details,
              });
            }
            return row.id;
          };
          await old('plain', { harmLevel: 'severe' });
          await old('raised', { harmLevel: 'severe' }, [
            { harmLevel: { from: 'mild', to: 'severe' } },
          ]);
          await old('sentinel', { isSentinel: true });
          await old('death', { harmLevel: 'death' });
          await old('was-sentinel', { harmLevel: 'severe' }, [
            { isSentinel: { from: false, to: true } },
            { isSentinel: { from: true, to: false } },
          ]);
          await old('was-death', { harmLevel: 'mild' }, [
            { harmLevel: { from: 'death', to: 'mild' } },
          ]);
          const named = await old('named', { reportedBy: made[jci].userId });
          const [other] = await tx
            .insert(users)
            .values({
              tenantId: jci,
              name: { en: 'Another' },
              email: `${TEST_EMAIL}other@test.invalid`,
            })
            .returning({ id: users.id });
          await tx.insert(incidentComments).values([
            {
              tenantId: jci,
              incidentId: named,
              authorId: made[jci].userId,
              body: 'by the reporter',
              visibility: 'everyone',
            },
            {
              tenantId: jci,
              incidentId: named,
              authorId: made[jci].userId,
              body: 'by the reporter, internal',
              visibility: 'internal',
            },
            {
              tenantId: jci,
              incidentId: named,
              authorId: other.id,
              body: 'by someone else',
              visibility: 'everyone',
            },
            {
              tenantId: jci,
              incidentId: named,
              authorId: made[jci].userId,
              asHandler: true,
              body: 'by the reporter as a handler, already recorded',
              visibility: 'internal',
            },
          ]);
          await tx
            .delete(auditLog)
            .where(eq(auditLog.action, 'built_in_roles_changed_by_system'));

          // Applied twice: the second time must change nothing.
          for (const statement of [...statements, ...statements]) {
            await tx.execute(sql.raw(statement));
          }

          for (const row of await tx
            .select({
              reference: incidents.reference,
              signOffNeeded: incidents.signOffNeeded,
            })
            .from(incidents)
            .where(like(incidents.reference, `${TEST_REFERENCE}s-%`))) {
            needed[row.reference.replace(`${TEST_REFERENCE}s-`, '')] =
              row.signOffNeeded;
          }
          comments = await tx
            .select({
              body: incidentComments.body,
              byReporter: incidentComments.byReporter,
              asHandler: incidentComments.asHandler,
            })
            .from(incidentComments)
            .where(eq(incidentComments.incidentId, named));
          comments.sort((x, y) => (x.body < y.body ? -1 : 1));
          audit = await tx
            .select({
              tenantId: auditLog.tenantId,
              actorId: auditLog.actorId,
              entityType: auditLog.entityType,
              changes: auditLog.changes,
            })
            .from(auditLog)
            .where(
              and(
                eq(auditLog.action, 'built_in_roles_changed_by_system'),
                inArray(auditLog.tenantId, [jci, cbahi]),
              ),
            );
          throw rollback;
        }),
      ).rejects.toBe(rollback);

      expect(needed).toEqual({
        plain: false,
        raised: false,
        sentinel: true,
        death: true,
        'was-sentinel': true,
        'was-death': true,
        named: false,
      });
      // As each reader has been shown them so far: the reporter's own are
      // the reporter's, whatever they could see when writing.
      expect(comments).toEqual([
        { body: 'by someone else', byReporter: false, asHandler: false },
        { body: 'by the reporter', byReporter: true, asHandler: false },
        {
          body: 'by the reporter as a handler, already recorded',
          byReporter: false,
          asHandler: true,
        },
        {
          body: 'by the reporter, internal',
          byReporter: true,
          asHandler: false,
        },
      ]);
      // One entry for each client, whoever ran it: no actor.
      const entry = {
        actorId: null,
        entityType: 'tenant',
        changes: {
          migration: '0020_built_in_roles_reporter_and_sign_off',
          roles: ['administrator', 'quality_officer'],
          permissionsAdded: ['incidents.see_reporter', 'incidents.sign_off'],
        },
      };
      expect(
        [...audit].sort((x, y) => x.tenantId.localeCompare(y.tenantId)),
      ).toEqual(
        [jci, cbahi]
          .sort((x, y) => x.localeCompare(y))
          .map((tenantId) => ({ tenantId, ...entry })),
      );
    });
  });
});
