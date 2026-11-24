import { sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { referenceCounters } from '../database/schema.js';

/**
 * Takes the next number of a tenant's yearly series and returns it as a
 * reference, for example `nextReference(tx, id, 'INC', 2026)` gives
 * "INC-2026-00042".
 *
 * One statement adds the counter or raises it, and holds its row until the
 * transaction ends, so two reports at the same moment queue up and can never
 * get the same number. Call it in the transaction that saves the record: if
 * that fails, the number goes back with it and the series has no gap.
 *
 * `tx` must come from TenantDb.withTenant() for the same tenant.
 */
export async function nextReference(
  tx: Transaction,
  tenantId: string,
  prefix: string,
  year: number,
): Promise<string> {
  if (!/^[A-Z]{2,6}$/.test(prefix)) {
    throw new Error(`Invalid reference prefix: ${prefix}`);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error(`Invalid reference year: ${year}`);
  }
  const [{ number }] = await tx
    .insert(referenceCounters)
    .values({ tenantId, prefix, year, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [
        referenceCounters.tenantId,
        referenceCounters.prefix,
        referenceCounters.year,
      ],
      set: { lastNumber: sql`${referenceCounters.lastNumber} + 1` },
    })
    .returning({ number: referenceCounters.lastNumber });
  return `${prefix}-${year}-${String(number).padStart(5, '0')}`;
}
