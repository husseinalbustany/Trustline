import { ImportLayout } from "@/components/policies/import-layout";
import { locales } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Page({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  // The example file has a column per language the client uses, each
  // written in its own language: every dictionary's example words.
  const all = await Promise.all(locales.map((l) => getDictionary(l)));
  const examples = Object.fromEntries(
    locales.map((l, i) => [l, all[i].policies.importing.layout.example]),
  );
  return <ImportLayout lang={lang} t={dict.policies} examples={examples} />;
}
