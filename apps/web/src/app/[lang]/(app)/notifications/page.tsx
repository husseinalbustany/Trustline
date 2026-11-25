import { Suspense } from "react";
import { NotificationsView } from "@/components/notifications/notifications-view";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

async function Content({ params }: { params: LangParams }) {
  const lang = await resolveLocale(params);
  const dict = await getDictionary(lang);
  // The page turner says what the incidents list's says.
  const { pagination, page, total, previous, next } = dict.incidents.list;
  return (
    <NotificationsView
      lang={lang}
      t={dict.notifications}
      paging={{ pagination, page, total, previous, next }}
    />
  );
}

// The list reads its filter and its page from the address, which is only
// known at request time, so this page streams in.
export default function Page({ params }: { params: LangParams }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
