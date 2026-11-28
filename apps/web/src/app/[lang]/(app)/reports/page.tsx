import { Suspense } from "react";
import { ReportsView } from "@/components/reports/reports-view";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

async function Content({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  return <ReportsView lang={lang} t={dict.reports} />;
}

// The unit and the period are in the address, which is only known at
// request time, so this page streams in.
export default function Page({ params }: { params: LangParams }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
