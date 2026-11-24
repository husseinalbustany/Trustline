"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { LanguageSwitcher } from "@/components/shell/language-switcher";
import { Button } from "@/components/ui/button";
import { platformApi, type Admin } from "@/lib/platform-api";
import type { PlatformProps } from "./types";

/** The admin portal's frame. Shows nothing until the session is confirmed. */
export function PortalFrame({
  lang,
  t,
  switchLanguage,
  children,
}: PlatformProps & { switchLanguage: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [admin, setAdmin] = useState<Admin | null>(null);
  const loginPath = `/${lang}/platform/login`;

  useEffect(() => {
    platformApi<Admin>("/auth/me")
      .then(setAdmin)
      .catch(() => {
        setAdmin(null);
        router.replace(loginPath);
      });
  }, [router, loginPath]);

  async function signOut() {
    await platformApi("/auth/logout", { method: "POST" }).catch(() => {});
    setAdmin(null);
    router.replace(loginPath);
  }

  if (!admin) return null;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link
            href={`/${lang}/platform/clients`}
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <span
              className="flex size-7 items-center justify-center rounded-md bg-accent text-sm text-accent-fg"
              aria-hidden
            >
              T
            </span>
            {t.title}
          </Link>
          <div className="ms-auto flex items-center gap-2">
            <span className="text-sm text-muted max-sm:hidden">
              {admin.name}
            </span>
            <LanguageSwitcher
              lang={lang}
              pathname={pathname}
              label={switchLanguage}
            />
            <Button variant="secondary" onClick={signOut}>
              {t.signOut}
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1 px-4 py-6 sm:px-6">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
