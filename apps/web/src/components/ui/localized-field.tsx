import { direction, hasLocale, localeNames } from "@/i18n/config";
import type { Localized } from "@/lib/localized";
import { Field, inputClass } from "./field";

/**
 * One input per language the client works in, for a name or a description.
 * The form receives them as `name.en`, `name.fr`, and so on.
 */
export function LocalizedField({
  label,
  name,
  locales,
  required,
  value,
  maxLength = 200,
  readOnly = false,
}: {
  label: string;
  name: string;
  /** The client's languages, in its own order. */
  locales: string[];
  /**
   * The language that must be filled in: the client's default; `true` for
   * every one of them.
   */
  required?: string | true;
  value?: Localized | null;
  maxLength?: number;
  /** Shown and sent as it is, but not editable. */
  readOnly?: boolean;
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {locales.map((locale) => (
        <Field
          key={locale}
          label={
            locales.length > 1 && hasLocale(locale)
              ? `${label} · ${localeNames[locale]}`
              : label
          }
        >
          <input
            name={`${name}.${locale}`}
            required={required === true || locale === required}
            maxLength={maxLength}
            lang={locale}
            dir={direction(locale)}
            defaultValue={value?.[locale] ?? ""}
            readOnly={readOnly}
            className={`${inputClass} read-only:bg-surface read-only:text-muted`}
          />
        </Field>
      ))}
    </div>
  );
}
