import { ImportBatchPage } from "@/components/policies/import-batch";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Page({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  return <ImportBatchPage lang={lang} t={dict.policies} />;
}
