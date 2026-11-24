import { redirect } from "next/navigation";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Home({ params }: { params: LangParams }) {
  redirect(`/${await resolveLocale(params)}/dashboard`);
}
