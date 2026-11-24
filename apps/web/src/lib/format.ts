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
 * Puts values into a sentence from the dictionary: "Page {page} of {pages}".
 * Each value is wrapped in a bidi isolate (U+2068 … U+2069), so a name or a
 * date written in the other direction cannot reorder the text around it.
 */
export const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? `\u2068${values[key]}\u2069` : whole,
  );
