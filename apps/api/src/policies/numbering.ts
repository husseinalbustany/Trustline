import { sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { referenceCounters } from '../database/schema.js';

/**
 * The year a document series is kept under in `reference_counters`. A
 * document's number does not start again each year, so its series has no
 * year: 0 stands for that, and no incident series can have it.
 */
export const DOCUMENT_SERIES_YEAR = 0;

/**
 * Takes the next number of a client's series for one type prefix and one
 * category, for example `PRC-SAF-014`: at least three digits, more once the
 * series passes 999.
 *
 * One statement adds the counter or raises it, and holds its row until the
 * transaction ends, so two documents created at the same moment queue up
 * and can never get the same number. A number is given to one document
 * only: documents are never deleted, and a counter never goes down. If the
 * transaction that took it fails, it goes back with it, and the series has
 * no gap.
 *
 * The series is that of the text the number starts with, so two types
 * sharing a prefix share it, and a prefix changed later starts or carries
 * on the series of the new text.
 *
 * `tx` must come from TenantDb.withTenant() for the same tenant.
 */
export async function nextDocumentNumber(
  tx: Transaction,
  tenantId: string,
  prefix: string,
  categoryCode: string,
): Promise<string> {
  const shape = /^[A-Z][A-Z0-9]{1,5}$/;
  if (!shape.test(prefix) || !shape.test(categoryCode)) {
    throw new Error(`Invalid document series: ${prefix}-${categoryCode}`);
  }
  const series = `${prefix}-${categoryCode}`;
  const [{ number }] = await tx
    .insert(referenceCounters)
    .values({
      tenantId,
      prefix: series,
      year: DOCUMENT_SERIES_YEAR,
      lastNumber: 1,
    })
    .onConflictDoUpdate({
      target: [
        referenceCounters.tenantId,
        referenceCounters.prefix,
        referenceCounters.year,
      ],
      set: { lastNumber: sql`${referenceCounters.lastNumber} + 1` },
    })
    .returning({ number: referenceCounters.lastNumber });
  return `${series}-${String(number).padStart(3, '0')}`;
}
