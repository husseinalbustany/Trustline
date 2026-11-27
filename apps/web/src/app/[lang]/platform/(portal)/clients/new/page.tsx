import { ClientForm } from "@/components/platform/client-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Page({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  return (
    <ClientForm
      lang={lang}
      t={dict.platform}
      mode="new"
      moduleNames={dict.moduleNames}
    />
  );
}
