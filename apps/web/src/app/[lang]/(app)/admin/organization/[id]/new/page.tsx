import { Suspense } from "react";
import { OrgUnitForm } from "@/components/admin/org-unit-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/locale";

type Params = Promise<{ lang: string; id: string }>;

async function Content({ params }: { params: Params }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  const { id } = await params;
  return <OrgUnitForm lang={lang} t={dict.admin} mode="new" id={id} />;
}

// Adds under the unit named in the route: a department in a facility, a unit
// in a department. The id is only known at request time, so this streams in.
export default function Page({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
