import { Suspense } from "react";
import { AuditViewer } from "@/components/audit/audit-viewer";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

async function Content({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  return <AuditViewer lang={lang} t={dict.audit} />;
}

// The filters are in the address, which is only known at request time, so
// this page streams in.
export default function Page({ params }: { params: LangParams }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
