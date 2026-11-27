import { BadRequestException } from '@nestjs/common';
import type { Transaction } from '../database/client.js';
import { documentSettings } from '../database/schema.js';

/**
 * The longest review period a document may have, in months, until a client
 * sets its own (quality review condition 7): 36 months suits JCI and CBAHI
 * practice. A client with no `document_settings` row has this.
 */
export const DEFAULT_MAX_REVIEW_MONTHS = 36;

/**
 * The client's settings of the module, in the caller's transaction: locked
 * to change them (`true` or `'update'`), or held unchanged until the
 * caller's transaction ends (`'share'`).
 */
export async function documentSettingsOf(
  tx: Transaction,
  lock: boolean | 'update' | 'share' = false,
) {
  const query = tx
    .select({
      maxReviewMonths: documentSettings.maxReviewMonths,
      revision: documentSettings.revision,
      updatedAt: documentSettings.updatedAt,
    })
    .from(documentSettings);
  const [row] =
    lock === 'share'
      ? await query.for('share')
      : lock
        ? await query.for('update')
        : await query;
  return (
    row ?? {
      maxReviewMonths: DEFAULT_MAX_REVIEW_MONTHS,
      revision: 1,
      updatedAt: null,
    }
  );
}

/**
 * 400 `review_period_too_long`, with the `max`, past the client's maximum.
 * With `hold`, the maximum is held until the caller's transaction ends, so
 * that it is not lowered under a type being switched on or lengthened
 * (the lowering checks the active types).
 */
export async function assertReviewPeriod(
  tx: Transaction,
  months: number,
  hold = false,
) {
  const { maxReviewMonths } = await documentSettingsOf(
    tx,
    hold ? 'share' : false,
  );
  if (months > maxReviewMonths) {
    throw new BadRequestException({
      code: 'review_period_too_long',
      max: maxReviewMonths,
    });
  }
}
