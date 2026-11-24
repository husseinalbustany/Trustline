import { redirect } from "next/navigation";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Page({ params }: { params: LangParams }) {
  redirect(`/${await resolveLocale(params)}/platform/clients`);
}
