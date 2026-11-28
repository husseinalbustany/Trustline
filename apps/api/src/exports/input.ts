import { z } from 'zod';
import { localeSchema } from '../i18n/locales.js';
import { optionalText, text } from '../i18n/text.js';

/** The password again, as for a signature: never stored, logged or audited. */
const password = z.string().min(1).max(1024);
const revision = z.number().int().min(1);

export const listQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const requestSchema = z.strictObject({
  reason: z.enum(['contract_end', 'on_request']),
  note: optionalText(1000),
  // The CSV files' language and the README's first: one of the client's.
  locale: localeSchema.optional(),
  includePdfs: z.boolean().optional(),
  password,
});

export const approveSchema = z.strictObject({ password, revision });
export const refuseSchema = z.strictObject({ reason: text(1, 1000), revision });
export const cancelSchema = z.strictObject({ revision });
export const downloadSchema = z.strictObject({ password });
