/**
 * The languages the interface is available in. To add one: add it here, add
 * its dictionary file, and add it to the API's list of supported languages.
 */
export const locales = ["en", "ar", "fr"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/** Each language's name, written in that language. */
export const localeNames: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
  fr: "Français",
};

const rightToLeft: ReadonlySet<string> = new Set(["ar"]);

export const hasLocale = (value: string): value is Locale =>
  (locales as readonly string[]).includes(value);

export const direction = (locale: string) =>
  rightToLeft.has(locale) ? "rtl" : "ltr";
