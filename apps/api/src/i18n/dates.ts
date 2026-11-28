import type { Locale } from './locales.js';

/** The language's own digits are Latin in every product language (language review 7, E16). */
const tag = (locale: Locale) => new Intl.Locale(locale, { numberingSystem: 'latn' }).toString();

/**
 * A calendar day ("2026-11-28") as the web app writes it in this language:
 * medium style, Latin digits, on no clock (the day is already the
 * organization's). Anything else is given back as it is.
 */
export function wordDay(day: string, locale: Locale): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(tag(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}

/** A month ("2026-10" or its first day) as the web app writes it: "October 2026". */
export function wordMonth(month: string, locale: Locale): string {
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(month);
  if (!m) return month;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  if (Number.isNaN(date.getTime())) return month;
  return new Intl.DateTimeFormat(tag(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}
