import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { DEFAULT_INCIDENT_CATEGORIES } from '../incidents/categories.js';
import { nextReference } from '../incidents/reference.js';
import { createDatabase, type Transaction } from './client.js';
import {
  incidentCategories,
  incidentComments,
  incidentEvents,
  incidents,
  orgUnits,
  referenceCounters,
  tenants,
} from './schema.js';
import { TenantDb } from './tenant-db.service.js';

// Marks what this file creates, so it can be removed without touching
// anything else the demo tenants hold.
const TEST_REFERENCE = 'ZZTEST-';
const TEST_PREFIX = 'ZZTEST';
const TEST_YEAR = 2026;

/** Postgres "insufficient_privilege": the role has no grant for this. */
const PERMISSION_DENIED = { cause: { code: '42501' } };

describe('incident tables', () => {
  // Connects as the application role, exactly as the running API does.
  const { pool, db } = createDatabase(requireEnv('APP_DATABASE_URL'));
  const tenantDb = new TenantDb(db);
  // The owner role, only to clean up: the application role cannot delete.
  const owner = createDatabase(requireEnv('DATABASE_URL'));
  const platform = createDatabase(requireEnv('PLATFORM_DATABASE_URL'));
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
    await owner.db
      .delete(referenceCounters)
      .where(eq(referenceCounters.prefix, TEST_PREFIX));
  };

  /** Reports an anonymous incident in the tenant's first org unit. */
  const report = async (tx: Transaction, tenantId: string, name: string) => {
    const [unit] = await tx.select().from(orgUnits).limit(1);
    const [category] = await tx
      .select()
      .from(incidentCategories)
      .where(eq(incidentCategories.code, 'other'));
    const [incident] = await tx
      .insert(incidents)
      .values({
        tenantId,
        reference: `${TEST_REFERENCE}${name}`,
        type: 'near_miss',
        categoryId: category.id,
        orgUnitId: unit.id,
        occurredAt: new Date(),
        description: 'Created by incidents.spec.ts',
        harmLevel: 'none',
      })
      .returning();
    const [event] = await tx
      .insert(incidentEvents)
      .values({
        tenantId,
        incidentId: incident.id,
        kind: 'reported',
        toStatus: 'new',
        visibleToReporter: true,
      })
      .returning();
    return { incident, event };
  };

  const numberOf = (reference: string) => Number(reference.split('-')[2]);

  beforeAll(async () => {
    const rows = await db.select().from(tenants);
    jci = rows.find((t) => t.slug === 'demo-jci')!.id;
    cbahi = rows.find((t) => t.slug === 'demo-cbahi')!.id;
    // Whatever an interrupted earlier run left behind.
    await removeTestRows();
  });

  afterAll(async () => {
    await removeTestRows();
    await Promise.all([pool.end(), owner.pool.end(), platform.pool.end()]);
  });

  it('gives every demo tenant the default categories in all languages', async () => {
    for (const tenantId of [jci, cbahi]) {
      const rows = await tenantDb.withTenant(tenantId, (tx) =>
        tx.select().from(incidentCategories),
      );
      expect(rows.map((c) => c.code).sort()).toEqual(
        DEFAULT_INCIDENT_CATEGORIES.map((c) => c.code).sort(),
      );
      for (const row of rows) {
        expect(Object.keys(row.name).sort()).toEqual(['ar', 'en', 'fr']);
        expect(row.active).toBe(true);
      }
    }
  });

  it('adds missing default categories without changing existing ones', async () => {
    const provisioning = new ProvisioningService();
    // Rolled back at the end, so the demo tenant keeps its own rows.
    const rollback = new Error('rollback');
    let result: { count: number; renamed: unknown } | undefined;
    await expect(
      tenantDb.withTenant(jci, async (tx) => {
        await tx
          .update(incidentCategories)
          .set({ name: { en: 'Renamed' }, active: false })
          .where(eq(incidentCategories.code, 'fall'));
        await provisioning.ensureIncidentCategories(tx, jci);
        await provisioning.ensureIncidentCategories(tx, jci);
        const rows = await tx.select().from(incidentCategories);
        const fall = rows.find((c) => c.code === 'fall')!;
        result = {
          count: rows.length,
          renamed: { name: fall.name, active: fall.active },
        };
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(result).toEqual({
      count: DEFAULT_INCIDENT_CATEGORIES.length,
      renamed: { name: { en: 'Renamed' }, active: false },
    });
  });

  it('lets the application add to the timeline but never change or delete it', async () => {
    const { event } = await tenantDb.withTenant(jci, (tx) =>
      report(tx, jci, 'timeline'),
    );
    await expect(
      tenantDb.withTenant(jci, (tx) =>
        tx
          .update(incidentEvents)
          .set({ visibleToReporter: false })
          .where(eq(incidentEvents.id, event.id)),
      ),
    ).rejects.toMatchObject(PERMISSION_DENIED);
    await expect(
      tenantDb.withTenant(jci, (tx) =>
        tx.delete(incidentEvents).where(eq(incidentEvents.id, event.id)),
      ),
    ).rejects.toMatchObject(PERMISSION_DENIED);
    const kept = await tenantDb.withTenant(jci, (tx) =>
      tx.select().from(incidentEvents).where(eq(incidentEvents.id, event.id)),
    );
    expect(kept).toEqual([event]);
  });

  it('lets the application update an incident but never delete it', async () => {
    const { incident } = await tenantDb.withTenant(jci, (tx) =>
      report(tx, jci, 'no-delete'),
    );
    const [updated] = await tenantDb.withTenant(jci, (tx) =>
      tx
        .update(incidents)
        .set({ status: 'triaged' })
        .where(eq(incidents.id, incident.id))
        .returning(),
    );
    expect(updated.status).toBe('triaged');
    await expect(
      tenantDb.withTenant(jci, (tx) =>
        tx.delete(incidents).where(eq(incidents.id, incident.id)),
      ),
    ).rejects.toMatchObject(PERMISSION_DENIED);
  });

  it('does not let the application change or delete comments or categories it may not', async () => {
    for (const statement of [
      sql`update incident_comments set body = 'changed'`,
      sql`delete from incident_comments`,
      sql`delete from incident_categories`,
      sql`delete from reference_counters`,
    ]) {
      await expect(
        tenantDb.withTenant(jci, (tx) => tx.execute(statement)),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it('gives the platform role nothing on the incident tables', async () => {
    for (const table of [
      'incident_categories',
      'incidents',
      'incident_events',
      'incident_comments',
      'reference_counters',
    ]) {
      await expect(
        platform.db.execute(sql.raw(`select 1 from ${table} limit 1`)),
      ).rejects.toMatchObject(PERMISSION_DENIED);
    }
  });

  it("hides another tenant's incidents and their timeline", async () => {
    const theirs = await tenantDb.withTenant(cbahi, (tx) =>
      report(tx, cbahi, 'hidden'),
    );
    const seen = await tenantDb.withTenant(jci, async (tx) => ({
      byId: await tx
        .select()
        .from(incidents)
        .where(eq(incidents.id, theirs.incident.id)),
      all: await tx.select().from(incidents),
      events: await tx
        .select()
        .from(incidentEvents)
        .where(eq(incidentEvents.incidentId, theirs.incident.id)),
      updated: await tx
        .update(incidents)
        .set({ description: 'Hijacked' })
        .where(eq(incidents.id, theirs.incident.id))
        .returning(),
    }));
    expect(seen.byId).toEqual([]);
    expect(seen.events).toEqual([]);
    expect(seen.updated).toEqual([]);
    expect(seen.all.every((i) => i.tenantId === jci)).toBe(true);

    // With no tenant set, nothing at all.
    expect(await db.select().from(incidents)).toEqual([]);
    expect(await db.select().from(incidentEvents)).toEqual([]);

    // Its own tenant still sees it, unchanged.
    const own = await tenantDb.withTenant(cbahi, (tx) =>
      tx.select().from(incidents).where(eq(incidents.id, theirs.incident.id)),
    );
    expect(own).toEqual([theirs.incident]);
  });

  it('cannot file an incident under another tenant or point it at their records', async () => {
    const [theirUnit] = await tenantDb.withTenant(cbahi, (tx) =>
      tx.select().from(orgUnits).limit(1),
    );
    const [ourCategory] = await tenantDb.withTenant(jci, (tx) =>
      tx.select().from(incidentCategories).limit(1),
    );
    const [ourUnit] = await tenantDb.withTenant(jci, (tx) =>
      tx.select().from(orgUnits).limit(1),
    );
    const values = {
      reference: `${TEST_REFERENCE}intruder`,
      type: 'hazard' as const,
      categoryId: ourCategory.id,
      occurredAt: new Date(),
      description: 'Created by incidents.spec.ts',
      harmLevel: 'none' as const,
    };
    // Row-level security: the row itself may not belong to another tenant.
    await expect(
      tenantDb.withTenant(jci, (tx) =>
        tx
          .insert(incidents)
          .values({ ...values, tenantId: cbahi, orgUnitId: ourUnit.id }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // Composite foreign key: our row may not point at their org unit.
    await expect(
      tenantDb.withTenant(jci, (tx) =>
        tx
          .insert(incidents)
          .values({ ...values, tenantId: jci, orgUnitId: theirUnit.id }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('gives 20 reports at the same moment 20 distinct consecutive numbers', async () => {
    const references = await Promise.all(
      Array.from({ length: 20 }, () =>
        tenantDb.withTenant(jci, (tx) =>
          nextReference(tx, jci, TEST_PREFIX, TEST_YEAR),
        ),
      ),
    );
    for (const reference of references) {
      expect(reference).toMatch(/^ZZTEST-2026-\d{5}$/);
    }
    expect(references.map(numberOf).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(references).toContain('ZZTEST-2026-00001');
    expect(references).toContain('ZZTEST-2026-00020');
  });

  it('numbers each tenant, and each year, on its own', async () => {
    // Runs after the test above, so the first tenant is already at 20.
    const next = (tenantId: string, year: number) =>
      tenantDb.withTenant(tenantId, (tx) =>
        nextReference(tx, tenantId, TEST_PREFIX, year),
      );
    expect(await next(cbahi, TEST_YEAR)).toBe('ZZTEST-2026-00001');
    expect(await next(cbahi, TEST_YEAR)).toBe('ZZTEST-2026-00002');
    expect(await next(jci, TEST_YEAR)).toBe('ZZTEST-2026-00021');
    expect(await next(jci, TEST_YEAR + 1)).toBe('ZZTEST-2027-00001');
    expect(await next(cbahi, TEST_YEAR)).toBe('ZZTEST-2026-00003');

    const counters = await tenantDb.withTenant(cbahi, (tx) =>
      tx
        .select()
        .from(referenceCounters)
        .where(eq(referenceCounters.prefix, TEST_PREFIX)),
    );
    expect(counters).toEqual([
      { tenantId: cbahi, prefix: TEST_PREFIX, year: TEST_YEAR, lastNumber: 3 },
    ]);
  });

  it('gives a number back when the report is not saved, leaving no gap', async () => {
    const failure = new Error('report failed');
    await expect(
      tenantDb.withTenant(jci, async (tx) => {
        await nextReference(tx, jci, TEST_PREFIX, TEST_YEAR);
        throw failure;
      }),
    ).rejects.toBe(failure);
    const [counter] = await tenantDb.withTenant(jci, (tx) =>
      tx
        .select()
        .from(referenceCounters)
        .where(
          and(
            eq(referenceCounters.prefix, TEST_PREFIX),
            eq(referenceCounters.year, TEST_YEAR),
          ),
        ),
    );
    expect(counter.lastNumber).toBe(21);
  });

  it('refuses a prefix or year that would make a malformed reference', async () => {
    await tenantDb.withTenant(jci, async (tx) => {
      await expect(nextReference(tx, jci, 'inc', TEST_YEAR)).rejects.toThrow();
      await expect(nextReference(tx, jci, 'INC', 26.5)).rejects.toThrow();
    });
  });
});
