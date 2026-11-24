import { Languages } from "lucide-react";
import Link from "next/link";
import { localeNames, locales, type Locale } from "@/i18n/config";

/** Links to the same page in each of the other languages. */
export function LanguageSwitcher({
  lang,
  pathname,
  label,
}: {
  lang: Locale;
  pathname: string;
  /** Names the group for screen readers, e.g. "Language". */
  label: string;
}) {
  const rest = pathname.split("/").slice(2).join("/");

  return (
    <nav aria-label={label} className="flex items-center text-sm text-muted">
      <Languages className="mx-1 size-4 shrink-0" aria-hidden />
      {locales
        .filter((other) => other !== lang)
        .map((other) => (
          <Link
            key={other}
            href={`/${other}/${rest}`}
            lang={other}
            className="inline-flex h-9 items-center rounded-md px-2 hover:bg-surface hover:text-foreground"
          >
            {localeNames[other]}
          </Link>
        ))}
    </nav>
  );
}
