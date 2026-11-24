"use client";

import { Menu, Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button-link";
import type { Locale } from "@/i18n/config";
import { LanguageSwitcher } from "./language-switcher";
import { Sidebar, type SidebarLabels } from "./sidebar";

export type ShellLabels = SidebarLabels & {
  skipToContent: string;
  openMenu: string;
  reportIncident: string;
  switchLanguage: string;
};

export function AppShell({
  lang,
  labels,
  children,
}: {
  lang: Locale;
  labels: ShellLabels;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-accent-fg"
      >
        {labels.skipToContent}
      </a>

      <Sidebar
        lang={lang}
        pathname={pathname}
        labels={labels}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-background px-4 sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label={labels.openMenu}
            className="-ms-2 rounded-md p-2 text-muted hover:bg-surface hover:text-foreground lg:hidden"
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <span className="font-semibold tracking-tight lg:hidden">
            {labels.appName}
          </span>
          <div className="ms-auto flex items-center gap-2">
            <LanguageSwitcher
              lang={lang}
              pathname={pathname}
              label={labels.switchLanguage}
            />
            <ButtonLink href={`/${lang}/incidents/new`}>
              <Plus className="size-4" aria-hidden />
              <span className="max-sm:sr-only">{labels.reportIncident}</span>
            </ButtonLink>
          </div>
        </header>

        <main id="main" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
