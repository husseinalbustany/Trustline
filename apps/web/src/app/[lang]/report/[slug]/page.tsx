import { Suspense } from "react";
import { PublicReport } from "@/components/public/public-report";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/locale";

type Props = {
  params: Promise<{ lang: string; slug: string }>;
  searchParams: Promise<{ unit?: string | string[] }>;
};

async function Content({ params, searchParams }: Props) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  const { slug } = await params;
  const { unit } = await searchParams;
  return (
    <PublicReport
      lang={lang}
      appName={dict.app.name}
      languageLabel={dict.shell.language}
      t={dict.incidents}
      p={dict.publicReport}
      slug={slug}
      unit={typeof unit === "string" ? unit : undefined}
    />
  );
}

// Reporting without signing in: outside the app shell, open to everyone.
// The hospital and the unit are only known at request time, so this page
// streams in.
export default function Page(props: Props) {
  return (
    <Suspense>
      <Content {...props} />
    </Suspense>
  );
}
