import type { ReactNode } from "react";
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

  return (
    <AppShell
      lang={lang}
      labels={{ appName: dict.app.name, ...dict.shell, ...dict.nav }}
    >
      {children}
    </AppShell>
  );
}
