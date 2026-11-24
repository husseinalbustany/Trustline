import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function AppLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: LangParams;
}) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);

  // The shell reads the current URL, which pages with an id only know at
  // request time.
  return (
    <Suspense>
      <AppShell
        lang={lang}
        labels={{ appName: dict.app.name, ...dict.shell, ...dict.nav }}
      >
        {children}
      </AppShell>
    </Suspense>
  );
}
