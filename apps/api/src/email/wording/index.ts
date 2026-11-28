import { SUPPORTED_LOCALES, type Locale } from '../../i18n/locales.js';
import { ar } from './ar.js';
import { en } from './en.js';
import { fr } from './fr.js';
import type { Wording } from './types.js';

export type { Wording } from './types.js';

/** The wording of every language the product has. */
export const WORDING: Record<Locale, Wording> = { en, ar, fr };

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' &&
  (SUPPORTED_LOCALES as readonly string[]).includes(value);

/**
 * The language an email to this person is written in: theirs, if the
 * organization works in it; otherwise the organization's default; English
 * if neither is a language the product has.
 */
export function localeFor(
  preferred: string | null | undefined,
  organization: { locales: string[]; defaultLocale: string },
): Locale {
  if (isLocale(preferred) && organization.locales.includes(preferred)) {
    return preferred;
  }
  return isLocale(organization.defaultLocale) ? organization.defaultLocale : 'en';
}

/** A text with its placeholders filled in. */
export function fill(
  text: string,
  values: Record<string, string | number> = {},
): string {
  return text.replace(/\{([a-z]+)\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}
