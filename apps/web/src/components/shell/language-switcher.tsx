import { Languages } from "lucide-react";
import Link from "next/link";
import type { Locale } from "@/i18n/config";

/** Links to the same page in the other language. */
export function LanguageSwitcher({
  lang,
  pathname,
  label,
}: {
  lang: Locale;
  pathname: string;
  label: string;
}) {
  const other: Locale = lang === "ar" ? "en" : "ar";
  const rest = pathname.split("/").slice(2).join("/");

  return (
    <Link
      href={`/${other}/${rest}`}
      lang={other}
      className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted hover:bg-surface hover:text-foreground"
    >
      <Languages className="size-4" aria-hidden />
      {label}
    </Link>
  );
}
