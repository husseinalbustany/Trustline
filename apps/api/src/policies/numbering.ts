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

const SERIES_NUMBER = /^([A-Z][A-Z0-9]{1,5}-[A-Z][A-Z0-9]{1,5})-(\d+)$/;

/**
 * The series of Trustline's own numbering a number belongs to, and its
 * place in it, if it has their shape (`<prefix>-<category code>-<digits>`,
 * in any capitals: `pol-gov-7` is 7 of `POL-GOV`), whatever type or
 * category of the client it names: a prefix or a category made later would
 * carry on that series. Null for a number of any other shape, which
 * Trustline never gives. `tooLong` for one whose place has more than nine
 * digits once its leading zeros are set aside, which a counter cannot hold.
 */
export function seriesOf(
  number: string,
): { series: string; n: number } | 'tooLong' | null {
  const match = SERIES_NUMBER.exec(number.toUpperCase());
  if (!match) return null;
  const digits = match[2].replace(/^0+(?=\d)/, '');
  if (digits.length > 9) return 'tooLong';
  return { series: match[1], n: Number(digits) };
}

/**
 * Raises a series' counter to at least `n`, so that the numbers Trustline
 * gives from then on come after it, and holds the counter's row until the
 * transaction ends (as `nextDocumentNumber` does). Returns its last number
 * before and after.
 *
 * `tx` must come from TenantDb.withTenant() for the same tenant.
 */
export async function advanceSeries(
  tx: Transaction,
  tenantId: string,
  series: string,
  n: number,
): Promise<{ from: number; to: number }> {
  const [held] = await tx
    .select({ lastNumber: referenceCounters.lastNumber })
    .from(referenceCounters)
    .where(
      sql`${referenceCounters.prefix} = ${series} and ${referenceCounters.year} = ${DOCUMENT_SERIES_YEAR}`,
    )
    .for('update');
  const [{ to }] = await tx
    .insert(referenceCounters)
    .values({
      tenantId,
      prefix: series,
      year: DOCUMENT_SERIES_YEAR,
      lastNumber: n,
    })
    .onConflictDoUpdate({
      target: [
        referenceCounters.tenantId,
        referenceCounters.prefix,
        referenceCounters.year,
      ],
      set: { lastNumber: sql`greatest(${referenceCounters.lastNumber}, ${n})` },
    })
    .returning({ to: referenceCounters.lastNumber });
  return { from: held?.lastNumber ?? 0, to };
}
