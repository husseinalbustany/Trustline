import { Languages } from "lucide-react";
import Link from "next/link";
import { localeNames, locales, type Locale } from "@/i18n/config";

/** Links to the same page in each of the other languages. */
export function LanguageSwitcher({
  lang,
  pathname,
  label,
  query = "",
  roomy = false,
}: {
  lang: Locale;
  pathname: string;
  /** Names the group for screen readers, e.g. "Language". */
  label: string;
  /** What follows the path and must be kept, such as `?unit=…`. */
  query?: string;
  /** Larger links, for the pages built for a phone first. */
  roomy?: boolean;
}) {
  const rest = pathname.split("/").slice(2).join("/");

  return (
    <nav aria-label={label} className="flex items-center text-sm text-muted">
      {/* Decoration: the names say it. Left out of the app's bar on a
          phone, where the room goes to the names themselves. */}
      <Languages
        className={`mx-1 size-4 shrink-0 ${roomy ? "" : "max-sm:hidden"}`}
        aria-hidden
      />
      {locales
        .filter((other) => other !== lang)
        .map((other) => (
          <Link
            key={other}
            href={`/${other}/${rest}${query}`}
            lang={other}
            className={`inline-flex items-center rounded-md hover:bg-surface hover:text-foreground ${roomy ? "h-11 px-3" : "h-9 px-1.5 sm:px-2"}`}
          >
            {localeNames[other]}
          </Link>
        ))}
    </nav>
  );
}
