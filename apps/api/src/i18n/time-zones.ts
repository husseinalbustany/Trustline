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

/** What the name of a time zone looks like: Area/Location, or one more part. */
const ZONE_NAME = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/;
/** Each part as IANA writes it: starting with a capital letter or a digit. */
const CAPITALISED = /^[A-Z][^/]*(\/[A-Z0-9][^/]*)+$/;

/**
 * The name a hospital's time zone is stored under, or null if `name` is not
 * one a hospital can have. `UTC`, or an IANA name of the form Area/Location
 * that the runtime knows.
 *
 * Refused although the runtime would take them, because they do not say
 * where the hospital is and so cannot follow its summer time: offsets
 * (`+03:00`), abbreviations (`EST`), and the whole `Etc/` area, whose names
 * are offsets under another spelling (`Etc/GMT+3`) or UTC, which is written
 * `UTC`.
 *
 * The runtime reads names in any letter case; what is stored is the name as
 * IANA writes it. Where the runtime says how (`asia/riyadh` is
 * `Asia/Riyadh`), that is what comes back. For a name it knows only as
 * another spelling of a zone (`Asia/Kolkata`, where it lists
 * `Asia/Calcutta`), it cannot say: such a name is kept exactly as written,
 * and taken only if each of its parts starts with a capital letter, as
 * every IANA name does.
 */
export function canonicalTimeZone(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  if (name === 'UTC') return name;
  if (!ZONE_NAME.test(name) || /^etc\//i.test(name)) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en', {
      timeZone: name,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  // The same name back, in the runtime's own letter case.
  if (resolved.toLowerCase() === name.toLowerCase()) return resolved;
  return CAPITALISED.test(name) ? name : null;
}

/**
 * Whether this is, letter for letter, a name a hospital's time zone can be
 * stored under: see `canonicalTimeZone`.
 */
export function isTimeZone(name: unknown): name is string {
  return typeof name === 'string' && canonicalTimeZone(name) === name;
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
  const shows = (moment: number) => wallTime(moment, timeZone) === wall;
  // The clock's offset a day before and a day after: the same, unless the
  // clock changes in between. Counting with the earlier one first gives the
  // first of two moments where there are two.
  const before = wall - offsetAt(wall - DAY_MS);
  if (shows(before)) return before;
  const after = wall - offsetAt(wall + DAY_MS);
  if (shows(after)) return after;
  // No moment shows it: the clock skips it. Counted on as if it had not been
  // put forward yet, which lands the length of the skip later.
  return before;
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

/**
 * The day `months` calendar months after this one. A day the shorter month
 * does not have becomes its last: 31 January plus one month is 28 (or 29)
 * February, as a review date "a year after 29 February" is 28 February.
 */
export function addMonths(day: Day, months: number): Day {
  const [year, month, date] = day.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return formatDay(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(date, last),
    ),
  );
}

/** How many days from one day to another (negative when it is before). */
export function daysBetween(from: Day, to: Day): number {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS);
}

/** The wall-clock date and time in this time zone, as `YYYY-MM-DD HH:MM`. */
export function momentIn(moment: Date, timeZone: string): string {
  return new Date(wallTime(moment.getTime(), timeZone))
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

/**
 * The ISO 8601 week a day is in, as `2026-W48`: weeks start on Monday, and
 * the first week of a year is the one with its first Thursday.
 */
export function isoWeekOf(day: Day): string {
  const date = parseDay(day);
  const weekday = (new Date(date).getUTCDay() + 6) % 7;
  // The Thursday of the same week decides the year.
  const thursday = date + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, '0')}`;
}
