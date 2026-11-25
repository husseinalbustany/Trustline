/**
 * A hospital's own calendar. Every "day" the API works out is a day on the
 * clock of the hospital it is working for (`tenants.time_zone`), never a day
 * in UTC and never one in a browser's time zone. This file is the only place
 * that turns a moment into a day, or a day into moments.
 *
 * A day is written `YYYY-MM-DD`. A time zone is an IANA name.
 */

/** A calendar day, `YYYY-MM-DD`. */
export type Day = string;

const DAY_MS = 86_400_000;

/**
 * Whether the runtime knows this as the IANA name of a time zone. `UTC`, or
 * a name of the form Area/Location. Offsets (`+03:00`) and abbreviations
 * (`EST`) are refused although the runtime would take them: they do not say
 * where the hospital is, so they cannot follow its summer time.
 */
export function isTimeZone(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (name === 'UTC') return true;
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The date and time a clock in this time zone shows at this moment. */
function wallClock(moment: number, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-u-ca-gregory-nu-latn', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(moment)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return parts as Record<
    'year' | 'month' | 'day' | 'hour' | 'minute' | 'second',
    number
  >;
}

/**
 * What that clock shows, written as if it were UTC: a number that can be
 * counted with, in milliseconds. Not a moment.
 */
function wallTime(moment: number, timeZone: string) {
  const whole = Math.floor(moment / 1000) * 1000;
  const c = wallClock(whole, timeZone);
  return (
    Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) +
    (moment - whole)
  );
}

/**
 * The moment at which a clock in this time zone shows the given wall time.
 * A time the clock skips when it is put forward gives the moment that much
 * later (00:30 on a night when midnight becomes 01:00 gives 01:30); a time it
 * shows twice when it is put back gives the first of the two.
 */
function momentOf(wall: number, timeZone: string) {
  const offsetAt = (moment: number) => wallTime(moment, timeZone) - moment;
  // Two steps: the offset at a first guess, then the offset where that lands.
  const guess = wall - offsetAt(wall);
  return wall - offsetAt(guess);
}

const parseDay = (day: Day) => {
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date);
};

const formatDay = (utc: number) => new Date(utc).toISOString().slice(0, 10);

/** The day it is in this time zone at this moment. */
export function dayOf(moment: Date, timeZone: string): Day {
  const wall = wallTime(moment.getTime(), timeZone);
  return formatDay(wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS));
}

/** The day `days` after this one (before it, when negative). */
export function shiftDay(day: Day, days: number): Day {
  return formatDay(parseDay(day) + days * DAY_MS);
}

/**
 * The first moment of a day in this time zone. Usually its midnight; where
 * the clock is put forward at midnight, the moment it jumps.
 */
export function startOfDay(day: Day, timeZone: string): Date {
  return new Date(momentOf(parseDay(day), timeZone));
}

/**
 * The same time of day, this many days later on this time zone's calendar.
 * Not always a multiple of 24 hours: a day on which the clock changes is an
 * hour shorter or longer.
 */
export function addDays(moment: Date, days: number, timeZone: string): Date {
  const wall = wallTime(moment.getTime(), timeZone);
  return new Date(momentOf(wall + days * DAY_MS, timeZone));
}

/**
 * "The last 30 days" (or however many) for a hospital: today on its calendar
 * and the days before it, whole days, the first and the last both included.
 * `since` is the first moment of the first of them.
 */
export function lastDays(count: number, timeZone: string, now = new Date()) {
  const to = dayOf(now, timeZone);
  const from = shiftDay(to, 1 - count);
  return { from, to, since: startOfDay(from, timeZone) };
}
