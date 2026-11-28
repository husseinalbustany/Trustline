import { z } from 'zod';
import { localeSchema } from '../i18n/locales.js';
import { text } from '../i18n/text.js';
import { createSchema } from '../policies/input.js';

const revision = z.number().int().min(1);

export const startSchema = z.strictObject({
  documentTypeId: z.uuid(),
  // What is needed, in the person's own words.
  request: text(1, 4000),
  // One of the client's languages; the person's own, else the client's main one.
  locale: localeSchema.optional(),
});

export const answerSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        questionId: z.string().regex(/^q\d{1,2}-\d{1,2}$/),
        // Null: "not decided", which the draft carries as a marked gap.
        answer: text(1, 2000).nullable(),
      }),
    )
    .min(1)
    .max(10),
  revision,
});

export const reviseSchema = z.strictObject({
  instruction: text(1, 2000),
  locale: localeSchema.optional(),
  revision,
});

export const editSchema = z.strictObject({
  content: z
    .partialRecord(localeSchema, z.record(z.string().max(40), z.string().max(30_000).nullable()))
    .refine((c) => Object.keys(c).length > 0),
  revision,
});

/** As `POST /policies/documents`, but the type is the draft's, and a version may be named. */
export const handOverSchema = createSchema.omit({ typeId: true }).extend({
  version: z.number().int().min(1).optional(),
  revision,
});

export const designQuery = z.strictObject({ documentTypeId: z.uuid().optional() });
