import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { incidentHarmLevel, incidentType } from '../database/schema.js';
import {
  CLOCK_TOLERANCE_MINUTES,
  EARLIEST_OCCURRED_AT,
} from './incidents.service.js';

// Control characters, other than the tab and the line breaks people type.
// A NUL cannot be stored at all, and none of the others belongs in words.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Whether text carries a control character other than a tab or line break. */
export const hasControlCharacter = (value: string) => CONTROL.test(value);

/**
 * Free text: trimmed, within its limits, and free of control characters, so
 * nothing reaches a query that the database would refuse or that could hide
 * in a log.
 */
export const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !hasControlCharacter(v));

export const optionalText = (max: number) =>
  text(0, max)
    .nullish()
    .transform((v) => v || null);

/**
 * What a report says, whoever sends it. The signed-in route and the public
 * one read the same fields with the same limits; only the first may add
 * whether to report anonymously.
 */
const reportFields = {
  type: z.enum(incidentType.enumValues),
  categoryId: z.uuid(),
  orgUnitId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  description: text(1, 5000),
  immediateAction: optionalText(2000),
  harmLevel: z.enum(incidentHarmLevel.enumValues),
  // When the reporter opened the form. Read leniently on purpose: a device
  // with a wrong clock, or one that writes the time oddly, must never have
  // its report refused over a measurement. What cannot be used is dropped.
  startedAt: z.string().max(64).nullish(),
};

export const reportSchema = z.strictObject({
  ...reportFields,
  anonymous: z.boolean(),
});

/** A public report is always anonymous, so it may not say either way. */
export const publicReportSchema = z.strictObject(reportFields);

const isoMoment = z.iso.datetime({ offset: true });

/**
 * Checks a report against one of the schemas above and against the clock.
 * 400 if it is not valid, with a `code` where the form shows its own message.
 */
export function parseReport<
  T extends { occurredAt: Date; startedAt?: unknown },
>(
  schema: z.ZodType<T>,
  body: unknown,
): Omit<T, 'startedAt'> & { startedAt?: Date } {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException();
  const { startedAt, ...input } = parsed.data;
  const latest = Date.now() + CLOCK_TOLERANCE_MINUTES * 60_000;
  if (input.occurredAt.getTime() > latest) {
    throw new BadRequestException({ code: 'occurred_in_future' });
  }
  if (input.occurredAt.getTime() < EARLIEST_OCCURRED_AT.getTime()) {
    throw new BadRequestException({ code: 'occurred_too_long_ago' });
  }
  const started = isoMoment.safeParse(startedAt);
  return {
    ...input,
    ...(started.success && { startedAt: new Date(started.data) }),
  };
}
