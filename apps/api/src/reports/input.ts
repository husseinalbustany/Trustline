import { z } from 'zod';
import { localeSchema, localizedText } from '../i18n/locales.js';
import { text } from '../i18n/text.js';
import { BREAKDOWNS, HARM_LEVELS, INCIDENT_TYPES } from './breakdowns.js';
import { MEASURE_CODES, MEASURE_DEFINITIONS, type MeasureCode } from './measures.js';
import { MAX_MONTHS } from './reports.service.js';

const blankAsUnset = (query: unknown) =>
  query && typeof query === 'object'
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''))
    : query;

// Years from 2000 (security review 16, L7): no figure is older.
const month = z.string().regex(/^2\d{3}-(0[1-9]|1[0-2])$/);
const monthsApart = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5));

const measureList = z
  .string()
  .max(1000)
  .transform((v) => v.split(',').map((m) => m.trim()).filter(Boolean))
  .pipe(z.array(z.enum(MEASURE_CODES)).min(1).max(MEASURE_CODES.length));

const series = {
  from: month,
  to: month,
  unitId: z.uuid().optional(),
  measures: measureList.optional(),
};

/** From and to, in order, at most 120 months apart. */
const inRange = (q: { from: string; to: string }) => q.from <= q.to && monthsApart(q.from, q.to) < MAX_MONTHS;

export const seriesQuery = z.preprocess(blankAsUnset, z.strictObject(series).refine(inRange));
export const seriesExportQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({ ...series, locale: localeSchema.optional() }).refine(inRange),
);
const breakdown = {
  from: month,
  to: month,
  unitId: z.uuid().optional(),
  by: z.enum(BREAKDOWNS),
  type: z.enum(INCIDENT_TYPES).optional(),
  harmLevel: z.enum(HARM_LEVELS).optional(),
};
export const incidentsQuery = z.preprocess(blankAsUnset, z.strictObject(breakdown).refine(inRange));
export const incidentsExportQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({ ...breakdown, locale: localeSchema.optional() }).refine(inRange),
);
export const historyQuery = z.preprocess(blankAsUnset, z.strictObject({ month, unitId: z.uuid().optional() }));

export const correctionSchema = z.strictObject({
  month,
  measures: z.array(z.enum(MEASURE_CODES)).min(1).max(MEASURE_CODES.length),
  unitId: z.uuid().optional(),
  // Required: why the figures are wrong.
  reason: text(1, 1000),
});

/** A target in the measure's own terms: seconds, a share, a count. */
const targetOf = (code: MeasureCode) =>
  MEASURE_DEFINITIONS[code].valueUnit === 'seconds'
    ? z.number().int().min(1).max(3600)
    : z.number().min(0).max(100);

export const settingsSchema = z
  .strictObject({
    // The reporting volume's target is its baseline: not set here.
    targets: z
      .strictObject(
        Object.fromEntries(
          MEASURE_CODES.filter((c) => c !== 'incidents.reported').map((c) => [c, targetOf(c).nullable().optional()]),
        ) as Record<Exclude<MeasureCode, 'incidents.reported'>, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>,
      )
      .optional(),
    baseline: z
      .strictObject({
        monthlyAverage: z.number().min(0).max(1_000_000),
        // Where it comes from: "paper register, 2025".
        note: localizedText(500),
      })
      .nullable()
      .optional(),
    revision: z.number().int().min(0),
  })
  .refine((v) => v.targets !== undefined || v.baseline !== undefined);
