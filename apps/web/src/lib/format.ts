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

/** Puts values into a sentence from the dictionary: "Page {page} of {pages}". */
export const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
