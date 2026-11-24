import { Suspense, type ReactNode } from "react";
import { PortalFrame } from "@/components/platform/portal-frame";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function PortalLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: LangParams;
}) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  // The frame reads the current URL, which pages with a client id only know
  // at request time.
  return (
    <Suspense>
      <PortalFrame
        lang={lang}
        t={dict.platform}
        language={dict.shell.language}
        signOutFailed={dict.shell.signOutFailed}
        sessionError={dict.shell.sessionError}
      >
        {children}
      </PortalFrame>
    </Suspense>
  );
}
