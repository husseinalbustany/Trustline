"use client";

import { LogOut, Menu, Plus } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button-link";
import type { Locale } from "@/i18n/config";
import { api, statusOf } from "@/lib/api";
import type { Session } from "@/lib/identity";
import { pick } from "@/lib/localized";
import { LanguageSwitcher } from "./language-switcher";
import { can, SessionContext, SessionRefreshContext } from "./session";
import { Sidebar, type SidebarLabels } from "./sidebar";
import { loadPage } from "@/lib/navigate";

export type ShellLabels = SidebarLabels & {
  skipToContent: string;
  openMenu: string;
  reportIncident: string;
  signOut: string;
  signOutFailed: string;
  sessionError: string;
  language: string;
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
  const [session, setSession] = useState<Session | null>(null);
  const [problem, setProblem] = useState<"session" | "signOut" | null>(null);
  const loginPath = `/${lang}/login`;

  // Nothing in the app is shown until the session is confirmed.
  useEffect(() => {
    api<Session>("/auth/me")
      .then((s) => {
        setSession(s);
        setProblem(null);
      })
      .catch((err) => {
        setSession(null);
        // A full page load, so nothing of the previous session stays mounted.
        if (statusOf(err) === 401) loadPage(loginPath);
        else setProblem("session");
      });
  }, [loginPath]);

  // After a change to something the session carries. A failure leaves the
  // session as it was: the screen that asked has already saved its change.
  const refresh = useCallback(
    () =>
      api<Session>("/auth/me")
        .then(setSession)
        .catch(() => {}),
    [],
  );

  async function signOut() {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch (err) {
      // Still signed in on the server: say so instead of pretending.
      if (statusOf(err) !== 401) return setProblem("signOut");
    }
    // A full page load, so nothing of this session stays mounted.
    loadPage(loginPath);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!session) {
    return problem === "session" ? (
      <p role="alert" className="p-6 text-sm text-danger">
        {labels.sessionError}
      </p>
    ) : null;
  }
  const inLang = (text: Session["user"]["name"]) =>
    pick(text, lang, session.tenant.defaultLocale);

  return (
    <SessionContext.Provider value={session}>
      <SessionRefreshContext.Provider value={refresh}>
        <div className="flex min-h-dvh">
          <a
            href="#main"
            className="sr-only print:hidden focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-accent-fg"
          >
            {labels.skipToContent}
          </a>

          <Sidebar
            lang={lang}
            pathname={pathname}
            labels={labels}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            organization={inLang(session.tenant.name)}
            permissions={session.permissions}
          />

          <div className="flex min-w-0 flex-1 flex-col">
            {/* Paper gets the page, not the menu or the bar above it. */}
            <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-background px-4 sm:px-6 lg:px-8 print:hidden">
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
                  label={labels.language}
                />
                {can(session, "incidents.report") && (
                  <ButtonLink href={`/${lang}/incidents/new`}>
                    <Plus className="size-4" aria-hidden />
                    <span className="max-sm:sr-only">
                      {labels.reportIncident}
                    </span>
                  </ButtonLink>
                )}
                {problem === "signOut" && (
                  <span role="alert" className="text-sm text-danger">
                    {labels.signOutFailed}
                  </span>
                )}
                <span className="ms-2 text-sm text-muted max-md:hidden">
                  {inLang(session.user.name)}
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

            <main
              id="main"
              className="flex-1 px-4 py-6 sm:px-6 lg:px-8 print:p-0"
            >
              <div className="mx-auto w-full max-w-6xl">{children}</div>
            </main>
          </div>
        </div>
      </SessionRefreshContext.Provider>
    </SessionContext.Provider>
  );
}
