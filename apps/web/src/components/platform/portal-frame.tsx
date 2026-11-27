"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { LanguageSwitcher } from "@/components/shell/language-switcher";
import { Button } from "@/components/ui/button";
import { statusOf } from "@/lib/api";
import { platformApi, type Admin } from "@/lib/platform-api";
import type { PlatformProps } from "./types";
import { loadPage, signInFor } from "@/lib/navigate";

/** The admin portal's frame. Shows nothing until the session is confirmed. */
export function PortalFrame({
  lang,
  t,
  language,
  children,
  signOutFailed,
  sessionError,
}: PlatformProps & {
  language: string;
  signOutFailed: string;
  sessionError: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [problem, setProblem] = useState<"session" | "signOut" | null>(null);
  const loginPath = `/${lang}/platform/login`;

  useEffect(() => {
    platformApi<Admin>("/auth/me")
      .then((a) => {
        setAdmin(a);
        setProblem(null);
      })
      .catch((err) => {
        setAdmin(null);
        // A full page load, so nothing of the previous session stays mounted.
        // Signed in again, the admin comes back to the page they asked for.
        if (statusOf(err) === 401) loadPage(signInFor(loginPath));
        else setProblem("session");
      });
  }, [loginPath]);

  async function signOut() {
    try {
      await platformApi("/auth/logout", { method: "POST" });
    } catch (err) {
      if (statusOf(err) !== 401) return setProblem("signOut");
    }
    loadPage(loginPath);
  }

  if (!admin) {
    return problem === "session" ? (
      <p role="alert" className="p-6 text-sm text-danger">
        {sessionError}
      </p>
    ) : null;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:gap-4 sm:px-6">
          {/* The title gives way on a phone, so the buttons stay on screen. */}
          <Link
            href={`/${lang}/platform/clients`}
            title={t.title}
            className="flex min-w-0 items-center gap-2 font-semibold ltr:tracking-tight"
          >
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-sm text-accent-fg"
              aria-hidden
            >
              T
            </span>
            <span className="truncate">{t.title}</span>
          </Link>
          <div className="ms-auto flex shrink-0 items-center gap-2">
            {problem === "signOut" && (
              <span role="alert" className="text-sm text-danger">
                {signOutFailed}
              </span>
            )}
            <span className="text-sm text-muted max-sm:hidden">
              {admin.name}
            </span>
            <LanguageSwitcher
              lang={lang}
              pathname={pathname}
              label={language}
            />
            <Button variant="secondary" onClick={signOut}>
              {t.signOut}
            </Button>
          </div>
        </div>
        <nav
          aria-label={t.nav.label}
          className="mx-auto flex w-full max-w-6xl gap-1 px-4 sm:px-6"
        >
          {(["clients", "plans"] as const).map((area) => {
            const href = `/${lang}/platform/${area}`;
            const current =
              pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={area}
                href={href}
                aria-current={current ? "page" : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  current
                    ? "border-accent font-medium text-accent"
                    : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {t.nav[area]}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="flex-1 px-4 py-6 sm:px-6">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
