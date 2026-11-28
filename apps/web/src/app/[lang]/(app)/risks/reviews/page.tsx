import { Suspense } from "react";
import { ReviewsDue } from "@/components/risks/lists";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

async function Content({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  return <ReviewsDue lang={lang} t={dict.risks} />;
}

// What is due is read at request time, so this page streams in.
export default function Page({ params }: { params: LangParams }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
