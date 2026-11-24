import { PageHeader } from "@/components/ui/page-header";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Page({ params }: { params: LangParams }) {
  const dict = await getDictionary(await resolveLocale(params));

  return (
    <>
      <PageHeader
        title={dict.reportIncident.title}
        description={dict.reportIncident.description}
      />
      <p className="mt-6 text-sm text-muted">{dict.modulePage.notBuilt}</p>
    </>
  );
}
