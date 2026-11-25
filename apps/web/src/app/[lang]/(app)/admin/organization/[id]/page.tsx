import { Suspense } from "react";
import { OrgUnitForm } from "@/components/admin/org-unit-form";
import { locales } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/locale";

type Params = Promise<{ lang: string; id: string }>;

async function Content({ params }: { params: Params }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  const { id } = await params;
  // The poster with a unit's QR code is written in the hospital's languages,
  // whichever one the person printing it reads the app in.
  const posterLines = Object.fromEntries(
    await Promise.all(
      locales.map(
        async (locale) =>
          [locale, (await getDictionary(locale)).publicReport.poster] as const,
      ),
    ),
  );
  return (
    <OrgUnitForm
      lang={lang}
      t={dict.admin}
      mode="edit"
      id={id}
      posterLines={posterLines}
    />
  );
}

// The id is only known at request time, so this page streams in.
export default function Page({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
