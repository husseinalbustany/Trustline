import { z } from 'zod';

/**
 * What text a client may write, anywhere in the API. Every name, code and
 * free text is checked here before it reaches a query, so that nothing is
 * sent to the database that it would refuse (a NUL is answered with an error
 * there, which a caller sees as a 500), and nothing is stored that could hide
 * in a log or on a screen.
 *
 * Refused are control characters only: the C0 and C1 ranges and DEL. What
 * Arabic and French are written with is not among them and passes: the
 * zero-width joiner and non-joiner (U+200D, U+200C), the direction marks
 * (U+200E, U+200F, U+061C), and the non-breaking spaces (U+00A0, U+202F).
 */

// Free text keeps the tab and the line breaks people type. The C1 range is
// let through here on purpose: it is what a report pasted from a wrongly
// decoded document carries, and a report is never refused for its looks.
// eslint-disable-next-line no-control-regex
const CONTROL_IN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// A name is one line: no control character at all, the tab and every kind of
// line break included (U+2028 and U+2029 are line breaks too).
// eslint-disable-next-line no-control-regex
const CONTROL_IN_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Whether text carries a control character other than a tab or line break. */
export const hasControlCharacter = (value: string) =>
  CONTROL_IN_TEXT.test(value);

/**
 * Whether one line of text (a name, a title, an identifier) carries any
 * control character, a tab or a line break among them.
 */
export const hasControlOrLineBreak = (value: string) =>
  CONTROL_IN_LINE.test(value);

/**
 * Free text of several lines: trimmed, within its limits, and free of
 * control characters other than the tab and line breaks.
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
 * One line of text: trimmed, within its limits, and free of every control
 * character and line break.
 */
export const line = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !hasControlOrLineBreak(v));

export const optionalLine = (max: number) =>
  line(0, max)
    .nullish()
    .transform((v) => v || null);

/**
 * What someone types to say who they are before they are signed in: the
 * organization's identifier, an email address. Not trimmed or otherwise
 * changed here, only refused when it carries a control character: such a
 * value can belong to nobody, and must be turned away as malformed before
 * any lookup, the same whether or not what it names exists.
 */
export const identifier = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // Spaces and line ends around it are dropped where it is looked up, as
    // they always were: a value pasted with its line end is not malformed.
    .refine((v) => !hasControlOrLineBreak(v.trim()));
