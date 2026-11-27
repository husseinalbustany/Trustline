import { Suspense } from "react";
import { PlanForm } from "@/components/platform/plan-form";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/locale";

type Params = Promise<{ lang: string; id: string }>;

async function Content({ params }: { params: Params }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  const { id } = await params;
  return (
    <PlanForm
      lang={lang}
      t={dict.platform}
      moduleNames={dict.moduleNames}
      mode="edit"
      id={id}
    />
  );
}

// The plan's id is only known at request time, so this page streams in.
export default function Page({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
