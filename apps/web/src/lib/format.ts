import { usableZone, type TimeZone } from "./time-zone";

/**
 * Dates and numbers in the reader's language, always with Western digits
 * (0-9), which is what clinical staff here read in every language.
 */
const withWesternDigits = (lang: string) =>
  new Intl.Locale(lang, { numberingSystem: "latn" }).toString();

/**
 * Dates and times in the reader's language, on the clock of `timeZone`: the
 * hospital's for everything its staff see, `deviceTime` for the pages that
 * belong to no hospital's staff. It is asked for every time, so that no
 * screen falls back to the browser's zone by forgetting it.
 */
export const dateTimeFormat = (
  lang: string,
  timeZone: TimeZone,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
) =>
  new Intl.DateTimeFormat(withWesternDigits(lang), {
    ...options,
    timeZone: usableZone(timeZone),
  });

/**
 * A moment the API sent, as a date, or null when there is none or it cannot
 * be read: a missing deadline is shown as nothing, never "Invalid Date".
 */
export function momentFrom(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const numberFormat = (lang: string) =>
  new Intl.NumberFormat(withWesternDigits(lang));

/**
 * How long ago a moment was, in the reader's words: "3 days ago". Counted in
 * days for the first three months, because that is how a waiting report is
 * talked about; then in months and years. Null for less than a minute ago:
 * the dictionary has its own words for "just now".
 */
export function timeAgoFormat(lang: string) {
  const counted = new Intl.RelativeTimeFormat(withWesternDigits(lang), {
    numeric: "always",
  });
  return (then: Date, now: Date) => {
    const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
    if (minutes < 1) return null;
    if (minutes < 60) return counted.format(-minutes, "minute");
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return counted.format(-hours, "hour");
    const days = Math.floor(hours / 24);
    if (days < 90) return counted.format(-days, "day");
    return days < 730
      ? counted.format(-Math.floor(days / 30), "month")
      : counted.format(-Math.floor(days / 365), "year");
  };
}

/**
 * How far away a deadline is, in the reader's words, either side of it:
 * "in 5 hours", "2 days ago". The whole phrase comes from `Intl`, which
 * knows each language's plural forms (Arabic has six); the dictionary
 * writes its sentence around the phrase. Counted in minutes for the first
 * hour, in hours for the first two days, then in days, and always rounded
 * towards the deadline: "in 5 hours" means at least five.
 */
export function deadlineFormat(lang: string) {
  const counted = new Intl.RelativeTimeFormat(withWesternDigits(lang), {
    numeric: "always",
  });
  return (due: Date, now: Date) => {
    const late = due.getTime() < now.getTime();
    const sign = late ? -1 : 1;
    // Never "in 0 minutes": the last minute is still a minute.
    const minutes = Math.max(
      1,
      Math.floor(Math.abs(due.getTime() - now.getTime()) / 60_000),
    );
    if (minutes < 60) return counted.format(sign * minutes, "minute");
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return counted.format(sign * hours, "hour");
    return counted.format(sign * Math.floor(hours / 24), "day");
  };
}

/** A whole percentage as the reader's language writes it: "83%", "83 %". */
export const percentFormat = (lang: string) => {
  const percent = new Intl.NumberFormat(withWesternDigits(lang), {
    style: "percent",
    maximumFractionDigits: 0,
  });
  return (wholePercentage: number) => percent.format(wholePercentage / 100);
};

/**
 * The time on the clock a number of seconds from now, as the reader's
 * language writes it: "14:32", "2:32 PM". Rounded up to the minute, so
 * "after 14:32" is never too early. A clock time and not "in 12 minutes":
 * it needs no plural form, and cannot be read as "during".
 *
 * On the clock of `timeZone`, asked for every time as `dateTimeFormat`
 * asks for it: the organization's whenever the page knows it, so the time
 * agrees with the page's note on which clock its times are on, and
 * `deviceTime` on a page that does not know it yet (and says nothing
 * about clocks).
 *
 * `withDay` is for a wait that can run past midnight (a limit counted over
 * a day): the time is then given with its day of the week when it is not
 * today on that clock, "Thursday 14:32", so "after 14:32" is not read as
 * this afternoon.
 */
export function clockTimeIn(
  lang: string,
  timeZone: TimeZone,
  options: { withDay?: boolean } = {},
) {
  const at = clockTimeAt(lang, timeZone, options);
  return (seconds: number) => at(new Date(Date.now() + seconds * 1000));
}

/**
 * The same, for a moment already worked out: one kept on a page that is
 * drawn again later, which must not move forward each time it is.
 */
export function clockTimeAt(
  lang: string,
  timeZone: TimeZone,
  { withDay = false } = {},
) {
  const hour = { hour: "numeric", minute: "2-digit" } as const;
  const clock = dateTimeFormat(lang, timeZone, hour);
  const dayAndClock = dateTimeFormat(lang, timeZone, {
    weekday: "long",
    ...hour,
  });
  const day = dateTimeFormat("en", timeZone, { dateStyle: "short" });
  return (moment: Date) => {
    const then = new Date(Math.ceil(moment.getTime() / 60_000) * 60_000);
    const today = day.format(then) === day.format(new Date());
    return (withDay && !today ? dayAndClock : clock).format(then);
  };
}

/**
 * A length of time as a clock figure, the same in every language: 96 seconds
 * is `1:36` in minutes, and from an hour up `1:05` in hours. The dictionary
 * names the unit beside it ("1:36 min").
 */
export function clockOf(totalSeconds: number): {
  unit: "minutes" | "hours";
  time: string;
} {
  const total = Math.max(0, Math.round(totalSeconds));
  const two = (n: number) => String(n).padStart(2, "0");
  return total < 3600
    ? { unit: "minutes", time: `${Math.floor(total / 60)}:${two(total % 60)}` }
    : {
        unit: "hours",
        time: `${Math.floor(total / 3600)}:${two(Math.floor((total % 3600) / 60))}`,
      };
}

/**
 * Puts values into a sentence from the dictionary: "Page {page} of {pages}".
 * Each value is wrapped in a bidi isolate (U+2068 … U+2069), so a name or a
 * date written in the other direction cannot reorder the text around it.
 */
export const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? `\u2068${values[key]}\u2069` : whole,
  );
