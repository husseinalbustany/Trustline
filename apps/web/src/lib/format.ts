/**
 * Dates and numbers in the reader's language, always with Western digits
 * (0-9), which is what clinical staff here read in every language.
 */
const withWesternDigits = (lang: string) =>
  new Intl.Locale(lang, { numberingSystem: "latn" }).toString();

export const dateTimeFormat = (
  lang: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
) => new Intl.DateTimeFormat(withWesternDigits(lang), options);

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

/** How long from now, in the reader's words: "in 12 minutes", "in 1 hour". */
export function timeUntilFormat(lang: string) {
  const counted = new Intl.RelativeTimeFormat(withWesternDigits(lang), {
    numeric: "always",
  });
  return (seconds: number) => {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return minutes < 60
      ? counted.format(minutes, "minute")
      : counted.format(Math.ceil(minutes / 60), "hour");
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
