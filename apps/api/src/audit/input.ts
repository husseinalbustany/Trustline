import { z } from 'zod';
import { localeSchema } from '../i18n/locales.js';
import { line } from '../i18n/text.js';
import { AUDIT_ACTIONS, AUDIT_AREAS, type AuditAction } from './actions.js';

/** Empty values in a query are left out, as if not given. */
const blankAsUnset = (query: unknown) =>
  query && typeof query === 'object'
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''))
    : query;

const day = z.iso.date();
const ENTITY_TYPES = [
  'user',
  'role',
  'tenant',
  'org_unit',
  'incident',
  'document',
  'document_type',
  'document_category',
  'approval_route',
  'subscription',
] as const;

/** Registered actions, comma-separated: `sign_in,sign_out`. */
const actionList = z
  .string()
  .max(4000)
  .transform((v) => v.split(',').map((a) => a.trim()).filter(Boolean))
  .pipe(
    z
      .array(z.enum(Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]]))
      .min(1)
      .max(100),
  );

const filters = {
  from: day.optional(),
  to: day.optional(),
  actorId: z.uuid().optional(),
  actions: actionList.optional(),
  area: z.enum(AUDIT_AREAS).optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  entityId: z.uuid().optional(),
  // An incident's reference or a document's number, as written.
  reference: line(1, 100).optional(),
};

/** A record by its id needs its type; dates in order. */
const consistent = <T extends { entityId?: string; entityType?: string; from?: string; to?: string; reference?: string }>(
  q: T,
) =>
  (!q.entityId || !!q.entityType) &&
  !(q.reference && q.entityType) &&
  (!q.from || !q.to || q.from <= q.to);

export const entriesQuery = z.preprocess(
  blankAsUnset,
  z
    .strictObject({
      ...filters,
      before: z.string().min(1).max(200).optional(),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      // The language of `detailLines`: one of the client's.
      locale: localeSchema.optional(),
    })
    .refine(consistent),
);

export const entriesExportQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({ ...filters, locale: localeSchema.optional() }).refine(consistent),
);

const seq = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const chainQuery = z.preprocess(
  blankAsUnset,
  z
    .strictObject({ fromSeq: seq.optional(), toSeq: seq.optional() })
    .refine((q) => !q.fromSeq || !q.toSeq || q.fromSeq <= q.toSeq),
);

export const checkpointsQuery = z.preprocess(
  blankAsUnset,
  z
    .strictObject({ from: day.optional(), to: day.optional() })
    .refine((q) => !q.from || !q.to || q.from <= q.to),
);
