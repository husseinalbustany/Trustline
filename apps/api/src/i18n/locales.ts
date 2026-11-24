import { z } from 'zod';

/**
 * The languages the product can be used in. Adding one means adding it here
 * and adding its dictionary file in the web app; no table changes.
 */
export const SUPPORTED_LOCALES = ['en', 'ar', 'fr'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const localeSchema = z.enum(SUPPORTED_LOCALES);

/**
 * Text kept once per language, for example `{ en: "Pharmacy", fr: "Pharmacie" }`.
 * Every name and description a client can write is stored this way.
 */
export type Localized = Partial<Record<Locale, string>>;

/** Validates localized text: known languages only, blanks dropped, not empty. */
export const localizedText = (max: number) =>
  z
    .partialRecord(localeSchema, z.string().trim().max(max))
    .transform((text) => {
      const kept: Localized = {};
      for (const locale of SUPPORTED_LOCALES) {
        if (text[locale]) kept[locale] = text[locale];
      }
      return kept;
    })
    .refine((text) => Object.keys(text).length > 0);

/** The same, but the whole value may be left out or empty. */
export const optionalLocalizedText = (max: number) =>
  z
    .partialRecord(localeSchema, z.string().trim().max(max))
    .nullish()
    .transform((text) => {
      const kept: Localized = {};
      for (const locale of SUPPORTED_LOCALES) {
        if (text?.[locale]) kept[locale] = text[locale];
      }
      return Object.keys(kept).length > 0 ? kept : null;
    });

export type LanguageSettings = { locales: string[]; defaultLocale: string };

/**
 * Whether a client's text fits its language settings: written in its default
 * language, and in no language the client has not switched on.
 */
export function fitsLanguages(
  text: Localized | null | undefined,
  { locales, defaultLocale }: LanguageSettings,
  { required = true } = {},
): boolean {
  if (!text) return !required;
  const used = Object.keys(text);
  return (
    used.every((locale) => locales.includes(locale)) &&
    (!required || used.includes(defaultLocale))
  );
}
