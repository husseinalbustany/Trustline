import { eq, sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';
import { orgUnits, tenants } from './schema.js';
import { TenantDb } from './tenant-db.service.js';

describe('tenant isolation', () => {
  // Connects as the application role, exactly as the running API does.
  const { pool, db } = createDatabase(requireEnv('APP_DATABASE_URL'));
  const tenantDb = new TenantDb(db);
  let jci: string;
  let cbahi: string;

  beforeAll(async () => {
    const rows = await db.select().from(tenants);
    jci = rows.find((t) => t.slug === 'demo-jci')!.id;
    cbahi = rows.find((t) => t.slug === 'demo-cbahi')!.id;
  });

  afterAll(() => pool.end());

  it('connects as a role that cannot bypass row-level security', async () => {
    const { rows } = await db.execute<{ bypass: boolean }>(
      sql`select rolsuper or rolbypassrls as bypass from pg_roles where rolname = current_user`,
    );
    expect(rows[0].bypass).toBe(false);
  });

  it('shows a tenant only its own rows', async () => {
    const seen = await tenantDb.withTenant(jci, (tx) =>
      tx.select().from(orgUnits),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((u) => u.tenantId === jci)).toBe(true);
  });

  it('shows no rows when no tenant is set', async () => {
    expect(await db.select().from(orgUnits)).toEqual([]);
  });

  it("cannot read another tenant's row by id", async () => {
    const [theirs] = await tenantDb.withTenant(cbahi, (tx) =>
      tx.select().from(orgUnits).limit(1),
    );
    const found = await tenantDb.withTenant(jci, (tx) =>
      tx.select().from(orgUnits).where(eq(orgUnits.id, theirs.id)),
    );
    expect(found).toEqual([]);
  });

  it('cannot insert a row for another tenant', async () => {
    await expect(
      tenantDb.withTenant(jci, (tx) =>
        tx.insert(orgUnits).values({
          tenantId: cbahi,
          type: 'department',
          code: 'INTRUDER',
          name: { en: 'Intruder', ar: 'دخيل' },
        }),
      ),
    ).rejects.toThrow();
  });

  it("cannot update or delete another tenant's rows", async () => {
    const changed = await tenantDb.withTenant(jci, async (tx) => {
      const updated = await tx
        .update(orgUnits)
        .set({ name: { en: 'Hijacked' } })
        .where(eq(orgUnits.tenantId, cbahi))
        .returning();
      const deleted = await tx
        .delete(orgUnits)
        .where(eq(orgUnits.tenantId, cbahi))
        .returning();
      return updated.length + deleted.length;
    });
    expect(changed).toBe(0);
  });

  it('does not leak the tenant setting to the next query on the connection', async () => {
    await tenantDb.withTenant(jci, (tx) => tx.select().from(orgUnits));
    const { rows } = await db.execute<{ tenant: string | null }>(
      sql`select nullif(current_setting('app.tenant_id', true), '') as tenant`,
    );
    expect(rows[0].tenant).toBeNull();
  });

  it('has an isolation policy on every table that holds tenant data', async () => {
    const { rows } = await db.execute<{ table_name: string }>(sql`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id'
      where n.nspname = 'public' and c.relkind = 'r' and not a.attisdropped
        and not (c.relrowsecurity and exists (
          select from pg_policy p
          where p.polrelid = c.oid and p.polname = 'tenant_isolation'))`);
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
