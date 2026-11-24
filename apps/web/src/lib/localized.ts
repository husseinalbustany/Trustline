/**
 * Text a client wrote, kept once per language: `{ en: "Pharmacy", fr: "Pharmacie" }`.
 */
export type Localized = Partial<Record<string, string>>;

/**
 * The text in the reader's language, or failing that in the client's default
 * language, or failing that in whichever language it was written.
 */
export function pick(
  text: Localized | null | undefined,
  lang: string,
  fallback?: string,
): string {
  if (!text) return "";
  return (
    text[lang] ??
    (fallback ? text[fallback] : undefined) ??
    Object.values(text).find(Boolean) ??
    ""
  );
}

/**
 * Reads a form into an object. A field named `name.fr` becomes
 * `{ name: { fr: ... } }`, which is how per-language inputs are collected.
 */
export function readForm(form: HTMLFormElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new FormData(form)) {
    const [field, locale] = key.split(".");
    if (locale) {
      out[field] = { ...(out[field] as object), [locale]: value };
    } else {
      out[key] = value;
    }
  }
  return out;
}
