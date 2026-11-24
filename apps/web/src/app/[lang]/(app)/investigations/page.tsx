import { ModulePage } from "@/components/module-page";
import type { LangParams } from "@/i18n/locale";

export default function Page({ params }: { params: LangParams }) {
  return <ModulePage params={params} module="investigations" />;
}
