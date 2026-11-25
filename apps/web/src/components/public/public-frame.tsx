"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/shell/language-switcher";
import type { Locale } from "@/i18n/config";

/**
 * The frame of the pages open to everyone: reporting without sign-in and
 * following up a report. No menu, no account, nothing to sign in to: the
 * hospital's name when it is known, the languages, and the page.
 */
export function PublicFrame({
  lang,
  heading,
  languageLabel,
  query,
  languages = true,
  children,
}: {
  lang: Locale;
  /** The hospital's name, or the product's when the hospital is not known. */
  heading: ReactNode;
  languageLabel: string;
  /** What follows the path and must survive a change of language. */
  query?: string;
  /**
   * False while something is on the page that a change of language would
   * lose for good, such as a follow-up code.
   */
  languages?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-surface print:bg-background">
      <header className="border-b border-line bg-background print:hidden">
        <div className="mx-auto flex min-h-14 w-full max-w-2xl flex-wrap items-center justify-between gap-x-3 px-4 py-1">
          <p className="min-w-0 py-2 text-base font-semibold break-words">
            {heading}
          </p>
          {languages && (
            <LanguageSwitcher
              lang={lang}
              pathname={pathname}
              label={languageLabel}
              query={query}
              roomy
            />
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
