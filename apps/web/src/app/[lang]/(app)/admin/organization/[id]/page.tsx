import { Suspense } from "react";
import { OrgUnitForm } from "@/components/admin/org-unit-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/locale";

type Params = Promise<{ lang: string; id: string }>;

async function Content({ params }: { params: Params }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  const { id } = await params;
  return <OrgUnitForm lang={lang} t={dict.admin} mode="edit" id={id} />;
}

// The id is only known at request time, so this page streams in.
export default function Page({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
