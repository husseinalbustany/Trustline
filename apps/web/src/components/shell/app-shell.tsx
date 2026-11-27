"use client";

import { Bell, LogOut, Menu, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ButtonLink } from "@/components/ui/button-link";
import type { Locale } from "@/i18n/config";
import { api, statusOf } from "@/lib/api";
import { fill, numberFormat } from "@/lib/format";
import type { Session } from "@/lib/identity";
import { pick } from "@/lib/localized";
import { LanguageSwitcher } from "./language-switcher";
import {
  can,
  SessionContext,
  SessionRefreshContext,
  UnreadContext,
} from "./session";
import { Sidebar, type SidebarLabels } from "./sidebar";
import { loadPage, signInFor } from "@/lib/navigate";

export type ShellLabels = SidebarLabels & {
  skipToContent: string;
  openMenu: string;
  reportIncident: string;
  signOut: string;
  signOutFailed: string;
  sessionError: string;
  language: string;
  notifications: string;
  notificationsUnread: string;
  unreadMany: string;
};

/**
 * How often the unread count is asked for again while the page is in view.
 * It is also asked for on every change of page, so this only has to catch
 * what arrives while someone stays on one screen.
 */
const UNREAD_EVERY_MS = 60_000;

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
        // Signed in again, the user comes back to the page they asked for.
        if (statusOf(err) === 401) loadPage(signInFor(loginPath));
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

  // The unread count on the bell. Only the answer to the latest question is
  // kept: one asked before a notification was marked read may arrive after.
  const [unread, setUnread] = useState<number | null>(null);
  const countAsked = useRef(0);
  const refreshUnread = useCallback(() => {
    const mine = ++countAsked.current;
    return (
      api<{ unread: number }>("/notifications/count")
        .then((counted) => {
          if (mine === countAsked.current) setUnread(counted.unread);
        })
        // The bell keeps what it showed; the next try may do better.
        .catch(() => {})
    );
  }, []);
  const signedIn = !!session;

  // Counted when the app opens and on every change of page.
  useEffect(() => {
    if (signedIn) void refreshUnread();
  }, [signedIn, pathname, refreshUnread]);

  // And at a modest interval while someone is looking: a tab left in the
  // background asks for nothing, and asks once when it is looked at again.
  useEffect(() => {
    if (!signedIn) return;
    const ask = () => {
      if (document.visibilityState === "visible") void refreshUnread();
    };
    const timer = setInterval(ask, UNREAD_EVERY_MS);
    document.addEventListener("visibilitychange", ask);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [signedIn, refreshUnread]);

  const unreadValue = useMemo(
    () => ({ unread, refresh: refreshUnread }),
    [unread, refreshUnread],
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

  const notificationsPath = `/${lang}/notifications`;
  const bellLabel = unread
    ? fill(labels.notificationsUnread, {
        count: numberFormat(lang).format(unread),
      })
    : labels.notifications;

  return (
    <SessionContext.Provider value={session}>
      <SessionRefreshContext.Provider value={refresh}>
        <UnreadContext.Provider value={unreadValue}>
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
              <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-background px-3 sm:gap-3 sm:px-6 lg:px-8 print:hidden">
                <button
                  type="button"
                  onClick={() => setMenuOpen(true)}
                  aria-label={labels.openMenu}
                  className="-ms-2 rounded-md p-2 text-muted hover:bg-surface hover:text-foreground lg:hidden"
                >
                  <Menu className="size-5" aria-hidden />
                </button>
                <span className="min-w-0 truncate font-semibold tracking-tight lg:hidden">
                  {labels.appName}
                </span>
                {/* Closer together on a phone, where the bar holds the menu,
                  the languages, the report button, the bell and the way
                  out in 390 pixels. */}
                <div className="ms-auto flex shrink-0 items-center gap-1 sm:gap-2">
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
                  {/* The count is in the link's name; the figure on the bell
                    is for the eye. */}
                  <Link
                    href={notificationsPath}
                    aria-label={bellLabel}
                    title={bellLabel}
                    aria-current={
                      pathname === notificationsPath ? "page" : undefined
                    }
                    className="relative rounded-md p-2 text-muted hover:bg-surface hover:text-foreground aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent"
                  >
                    <Bell className="size-4" aria-hidden />
                    {!!unread && (
                      // The offset follows the page's direction; only the
                      // figure inside is set left to right ("99+").
                      <span
                        aria-hidden
                        className="absolute -end-1 -top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[0.625rem] leading-4 font-semibold text-background tabular-nums"
                      >
                        <span dir="ltr">
                          {unread > 99
                            ? labels.unreadMany
                            : numberFormat(lang).format(unread)}
                        </span>
                      </span>
                    )}
                  </Link>
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
        </UnreadContext.Provider>
      </SessionRefreshContext.Provider>
    </SessionContext.Provider>
  );
}
