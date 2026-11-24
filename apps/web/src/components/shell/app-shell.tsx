"use client";

import { LogOut, Menu, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button-link";
import type { Locale } from "@/i18n/config";
import { api } from "@/lib/api";
import type { Session } from "@/lib/identity";
import { LanguageSwitcher } from "./language-switcher";
import { SessionContext } from "./session";
import { Sidebar, type SidebarLabels } from "./sidebar";

export type ShellLabels = SidebarLabels & {
  skipToContent: string;
  openMenu: string;
  reportIncident: string;
  switchLanguage: string;
  signOut: string;
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
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const loginPath = `/${lang}/login`;

  // Nothing in the app is shown until the session is confirmed.
  useEffect(() => {
    api<Session>("/auth/me")
      .then(setSession)
      .catch(() => {
        setSession(null);
        router.replace(loginPath);
      });
  }, [router, loginPath]);

  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setSession(null);
    router.replace(loginPath);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!session) return null;
  const ar = lang === "ar";

  return (
    <SessionContext.Provider value={session}>
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
          organization={ar ? session.tenant.nameAr : session.tenant.nameEn}
          permissions={session.permissions}
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
              <span className="ms-2 text-sm text-muted max-md:hidden">
                {ar ? session.user.nameAr : session.user.nameEn}
              </span>
              <button
                type="button"
                onClick={signOut}
                aria-label={labels.signOut}
                title={labels.signOut}
                className="rounded-md p-2 text-muted hover:bg-surface hover:text-foreground"
              >
                <LogOut className="size-4 rtl:-scale-x-100" aria-hidden />
              </button>
            </div>
          </header>

          <main id="main" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
            <div className="mx-auto w-full max-w-6xl">{children}</div>
          </main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}
