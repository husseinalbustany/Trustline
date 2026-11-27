import { BadRequestException } from '@nestjs/common';
import type { Transaction } from '../database/client.js';
import { documentSettings } from '../database/schema.js';

/**
 * The longest review period a document may have, in months, until a client
 * sets its own (quality review condition 7): 36 months suits JCI and CBAHI
 * practice. A client with no `document_settings` row has this.
 */
export const DEFAULT_MAX_REVIEW_MONTHS = 36;

/** The client's settings of the module, in the caller's transaction. */
export async function documentSettingsOf(tx: Transaction, lock = false) {
  const query = tx
    .select({
      maxReviewMonths: documentSettings.maxReviewMonths,
      revision: documentSettings.revision,
      updatedAt: documentSettings.updatedAt,
    })
    .from(documentSettings);
  const [row] = lock ? await query.for('update') : await query;
  return (
    row ?? {
      maxReviewMonths: DEFAULT_MAX_REVIEW_MONTHS,
      revision: 1,
      updatedAt: null,
    }
  );
}

/** 400 `review_period_too_long`, with the `max`, past the client's maximum. */
export async function assertReviewPeriod(tx: Transaction, months: number) {
  const { maxReviewMonths } = await documentSettingsOf(tx);
  if (months > maxReviewMonths) {
    throw new BadRequestException({
      code: 'review_period_too_long',
      max: maxReviewMonths,
    });
  }
}
