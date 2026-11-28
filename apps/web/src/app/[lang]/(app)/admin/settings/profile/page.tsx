import { OrganizationProfile } from "@/components/admin/organization-profile";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Page({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  return <OrganizationProfile lang={lang} t={dict.profile} tabs={dict.admin.settings.tabs} />;
}
