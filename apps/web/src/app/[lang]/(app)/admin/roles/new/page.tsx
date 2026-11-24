import { RoleForm } from "@/components/admin/role-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Page({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  return <RoleForm lang={lang} t={dict.admin} mode="new" />;
}
