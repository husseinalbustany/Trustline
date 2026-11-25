import { Suspense } from "react";
import { FollowUp } from "@/components/public/follow-up";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/locale";

type Params = Promise<{ lang: string; slug: string }>;

async function Content({ params }: { params: Params }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  const { slug } = await params;
  return (
    <FollowUp
      lang={lang}
      appName={dict.app.name}
      languageLabel={dict.shell.language}
      t={dict.incidents}
      u={dict.followUp}
      slug={slug}
    />
  );
}

// Coming back to a report with its follow-up code: outside the app shell,
// open to everyone, signed in or not. The hospital is only known at request
// time, so this page streams in.
export default function Page({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
