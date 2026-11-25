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
 * talked about; then in months and years.
 */
export function timeAgoFormat(lang: string) {
  const locale = withWesternDigits(lang);
  const counted = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  const worded = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return (then: Date, now: Date) => {
    const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
    if (minutes < 1) return worded.format(0, "second");
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

/** A length of time, short: "45 sec", "1 min 24 sec", "2 hr 5 min". */
export function durationFormat(lang: string) {
  const locale = withWesternDigits(lang);
  const part = (unit: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "short",
    });
  const [hours, minutes, seconds] = [
    part("hour"),
    part("minute"),
    part("second"),
  ];
  const joined = new Intl.ListFormat(locale, { style: "narrow", type: "unit" });
  return (totalSeconds: number) => {
    const total = Math.max(0, Math.round(totalSeconds));
    const [h, m, s] = [
      Math.floor(total / 3600),
      Math.floor((total % 3600) / 60),
      total % 60,
    ];
    if (h > 0) {
      return joined.format([hours.format(h), ...(m ? [minutes.format(m)] : [])]);
    }
    if (m > 0) {
      return joined.format([
        minutes.format(m),
        ...(s ? [seconds.format(s)] : []),
      ]);
    }
    return seconds.format(s);
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
