import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale, type LangParams } from "@/i18n/locale";

export default async function Page({ params }: { params: LangParams }) {
  const dict = await getDictionary(await resolveLocale(params));
  const d = dict.dashboard;

  return (
    <>
      <PageHeader title={d.title} description={d.description} />

      <dl className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Object.entries(d.tiles).map(([key, label]) => (
          <div key={key} className="rounded-lg border border-line p-4">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="mt-2 text-2xl font-semibold tabular-nums">
              <span aria-hidden>–</span>
              <span className="sr-only">{d.noData}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title={d.recentIncidents}>
          <EmptyState>{d.noData}</EmptyState>
        </Panel>
        <Panel title={d.myTasks}>
          <EmptyState>{d.noData}</EmptyState>
        </Panel>
      </div>
    </>
  );
}
