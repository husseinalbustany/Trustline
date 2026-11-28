import { Suspense } from "react";
import { RiskForm } from "@/components/risks/risk-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

async function Content({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  return <RiskForm lang={lang} t={dict.risks} mode="new" />;
}

// The incident a risk is raised from is in the address, known at request time, so this page streams in.
export default function Page({ params }: { params: LangParams }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
