import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  documentConfidentiality,
  documentStatus,
} from '../database/schema.js';
import {
  localeSchema,
  localizedText,
  optionalLocalizedText,
} from '../i18n/locales.js';
import { line, optionalText, text } from '../i18n/text.js';

/**
 * What the routes of the policies module take. Every body is a strict
 * object (an unknown field is refused), every text is checked for control
 * characters, and nothing reaches a query before it has passed here.
 */

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

/** The revision of the record the caller was looking at. Required. */
const revision = z.number().int().min(1);

/** Re-entered for a signature. Never trimmed, logged or stored. */
const password = z.string().min(1).max(1024);

// An empty value in the address (`?status=`) means the filter is not set.
const blankAsUnset = (query: unknown) =>
  query && typeof query === 'object'
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ''))
    : query;

const page = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

/** What the library is filtered and ordered by, on screen and exported. */
const libraryFilters = {
  // Number, title in any language, keywords, and the text of the
  // versions the caller may read.
  q: line(1, 200).optional(),
  typeId: z.uuid().optional(),
  // With the categories beneath it.
  categoryId: z.uuid().optional(),
  // With the units beneath it.
  ownerUnitId: z.uuid().optional(),
  status: z.enum(documentStatus.enumValues).optional(),
  // `due`: the next review is within 30 days; `overdue`: it has passed.
  review: z.enum(['due', 'overdue']).optional(),
  appliesToMe: flag.default(false),
  awaitingMyAcknowledgement: flag.default(false),
  sort: z
    .enum(['number', 'title', 'next_review', 'recently_published'])
    .default('number'),
};

export const listSchema = z.preprocess(
  blankAsUnset,
  z.strictObject({ ...libraryFilters, ...page }),
);
export type ListInput = z.infer<typeof listSchema>;
export type LibraryFilters = Omit<ListInput, 'page' | 'pageSize'>;

/**
 * The language a file is written in: one of the client's, checked by the
 * service. None: the caller's own language, or else the client's default.
 */
const exportLocale = { locale: localeSchema.optional() };

/** The library as a file: its filters, every page. */
export const documentExportQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({ ...libraryFilters, ...exportLocale }),
);

export const acknowledgementExportQuery = z.preprocess(
  blankAsUnset,
  z.strictObject(exportLocale),
);

const keyword = line(1, 60);
const reference = line(1, 120);

const audienceSchema = z.strictObject({
  // None: the whole organization. Each unit covers those beneath it.
  orgUnitIds: z.array(z.uuid()).max(50).default([]),
  // None: anyone in those units. Otherwise only people holding one of them.
  roleIds: z.array(z.uuid()).max(20).default([]),
});
export type AudienceInput = z.infer<typeof audienceSchema>;

const metadata = {
  title: localizedText(300),
  ownerId: z.uuid(),
  ownerUnitId: z.uuid(),
  audience: audienceSchema,
  confidentiality: z.enum(documentConfidentiality.enumValues),
  keywords: z.array(keyword).max(30),
  references: z.array(reference).max(30),
  reviewMonths: z.number().int().min(1).max(120),
};

export const createSchema = z.strictObject({
  typeId: z.uuid(),
  categoryId: z.uuid(),
  ...metadata,
  audience: audienceSchema.default({ orgUnitIds: [], roleIds: [] }),
  confidentiality: metadata.confidentiality.default('all_staff'),
  keywords: metadata.keywords.default([]),
  references: metadata.references.default([]),
  // From the type unless given.
  reviewMonths: metadata.reviewMonths.optional(),
  acknowledgementRequired: z.boolean().default(false),
  acknowledgeWithinDays: z.number().int().min(1).max(365).default(14),
});
export type CreateInput = z.infer<typeof createSchema>;

export const updateSchema = z
  .strictObject({
    // A document keeps its type, and with it its number, for life.
    categoryId: z.uuid().optional(),
    // Why: required when the review period changes, kept in the
    // document's history of changes.
    reason: text(1, 1000).optional(),
    title: metadata.title.optional(),
    ownerId: metadata.ownerId.optional(),
    ownerUnitId: metadata.ownerUnitId.optional(),
    audience: audienceSchema.optional(),
    confidentiality: metadata.confidentiality.optional(),
    keywords: metadata.keywords.optional(),
    references: metadata.references.optional(),
    reviewMonths: metadata.reviewMonths.optional(),
    revision,
  })
  .refine((v) => Object.keys(v).length > 1);
export type UpdateInput = z.infer<typeof updateSchema>;

export const retireSchema = z.strictObject({
  reason: text(1, 1000),
  revision,
});

export const reviewSchema = z.strictObject({
  password,
  // Required: what was looked at, for whoever reads the review later.
  comment: text(1, 1000),
  revision,
});

/**
 * Sections to change, per language, per section key: text replaces what
 * was there, null or an empty text removes it. Checked against the
 * version's sections, the client's languages, and the markup rules in the
 * service.
 */
const contentPatch = z.record(
  z.string().max(10),
  z.record(z.string().max(40), z.string().max(40_000).nullable()),
);

export const editVersionSchema = z
  .strictObject({
    content: contentPatch.optional(),
    changeSummary: optionalLocalizedText(1000).optional(),
    acknowledgementRequired: z.boolean().optional(),
    acknowledgeWithinDays: z.number().int().min(1).max(365).optional(),
    revision,
  })
  .refine((v) => Object.keys(v).length > 1);
export type EditVersionInput = z.infer<typeof editVersionSchema>;

export const revisionOnly = z.strictObject({ revision });

export const approveSchema = z.strictObject({
  password,
  comment: optionalText(2000),
  revision,
});

export const returnSchema = z.strictObject({
  comment: text(1, 2000),
  revision,
});

export const publishSchema = z.strictObject({
  // A day on the client's calendar; today or none: now.
  effectiveOn: z.iso.date().optional(),
  revision,
});

export const withdrawSchema = z.strictObject({
  reason: text(1, 1000),
  revision,
});

export const acknowledgeSchema = z.strictObject({ password });

export const acknowledgementsQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({
    state: z.enum(['pending', 'acknowledged', 'overdue']).optional(),
    // People no longer active too, marked: the evidence of what they had
    // acknowledged. The figures count active people only either way.
    includeLeft: flag.default(false),
    ...page,
    pageSize: z.coerce.number().int().min(1).max(500).default(100),
  }),
);

export const overdueQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({
    ...page,
    pageSize: z.coerce.number().int().min(1).max(500).default(100),
  }),
);

/** A document's history of changes, newest first, a page at a time. */
export const changesQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({
    ...page,
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  }),
);

export const settingsSchema = z.strictObject({
  maxReviewMonths: z.number().int().min(1).max(120),
  revision,
});

export const peopleQuery = z.preprocess(
  blankAsUnset,
  z.strictObject({
    q: line(1, 100).optional(),
    // Only those who may be named in an approval step.
    approvers: flag.default(false),
  }),
);

// Settings.

const sectionSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: localizedText(120),
  required: z.boolean(),
});

const sectionsSchema = z
  .array(sectionSchema)
  .min(1)
  .max(30)
  .refine((list) => new Set(list.map((s) => s.key)).size === list.length);

const prefix = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/));

export const typeCreateSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: localizedText(120),
  numberPrefix: prefix,
  sections: sectionsSchema,
  defaultReviewMonths: z.number().int().min(1).max(120),
  position: z.number().int().min(0).max(10_000).default(0),
});

export const typeUpdateSchema = z
  .strictObject({
    name: localizedText(120).optional(),
    numberPrefix: prefix.optional(),
    sections: sectionsSchema.optional(),
    defaultReviewMonths: z.number().int().min(1).max(120).optional(),
    active: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    revision,
  })
  .refine((v) => Object.keys(v).length > 1);

export const categoryCreateSchema = z.strictObject({
  code: prefix,
  name: localizedText(120),
  parentId: z.uuid().nullable().default(null),
  position: z.number().int().min(0).max(10_000).default(0),
});

export const categoryUpdateSchema = z
  .strictObject({
    name: localizedText(120).optional(),
    parentId: z.uuid().nullable().optional(),
    active: z.boolean().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    revision,
  })
  .refine((v) => Object.keys(v).length > 1);

const stepSchema = z.strictObject({
  kind: z.enum(['review', 'approve']),
  // One of the two.
  userId: z.uuid().optional(),
  roleId: z.uuid().optional(),
  dueInDays: z.number().int().min(1).max(365),
});

const stepsSchema = z
  .array(stepSchema)
  .min(1)
  .max(10)
  .refine((steps) => steps.every((s) => !!s.userId !== !!s.roleId));

export const routeCreateSchema = z.strictObject({
  name: localizedText(200),
  // The type it is for; null: any type without a route of its own.
  documentTypeId: z.uuid().nullable(),
  active: z.boolean().default(true),
  steps: stepsSchema,
});

export const routeUpdateSchema = z
  .strictObject({
    name: localizedText(200).optional(),
    documentTypeId: z.uuid().nullable().optional(),
    active: z.boolean().optional(),
    steps: stepsSchema.optional(),
    revision,
  })
  .refine((v) => Object.keys(v).length > 1);

export type StepInput = z.infer<typeof stepSchema>;

/** Parses a body or a query, or answers 400. */
export function parse<T extends z.ZodType>(schema: T, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data as z.infer<T>;
}

/** An id in the address that is not one is a record that does not exist. */
export function parseId(id: string) {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundException();
  return parsed.data;
}
