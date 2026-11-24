"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IncidentPills } from "@/components/incidents/pills";
import type { IncidentsText } from "@/components/incidents/types";
import { useSession } from "@/components/shell/session";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api } from "@/lib/api";
import { dateTimeFormat, fill, numberFormat } from "@/lib/format";
import type { IncidentList, IncidentSummary } from "@/lib/incidents";
import { pick } from "@/lib/localized";

type Loaded = { summary: IncidentSummary; recent: IncidentList };

/** The dashboard. Incident figures are live; the rest is not built yet. */
export function DashboardView({
  lang,
  t,
  i,
}: {
  lang: Locale;
  t: Dictionary["dashboard"];
  i: IncidentsText;
}) {
  const session = useSession();
  const [data, setData] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState(false);
  const numbers = numberFormat(lang);
  const dates = dateTimeFormat(lang);

  useEffect(() => {
    let current = true;
    Promise.all([
      api<IncidentSummary>("/incidents/summary"),
      api<IncidentList>("/incidents?page=1&pageSize=5"),
    ])
      .then(([summary, recent]) => {
        if (!current) return;
        setData({ summary, recent });
        setProblem(false);
      })
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, []);

  const live: Record<string, number | undefined> = {
    openIncidents: data?.summary.open,
    awaitingTriage: data?.summary.awaitingTriage,
  };
  // While a live figure is on its way, or could not be fetched.
  const pending = problem ? t.loadError : i.loading;

  return (
    <>
      <PageHeader title={t.title} description={t.description} />

      <dl className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Object.entries(t.tiles).map(([key, label]) => {
          const figure = live[key];
          return (
            <div key={key} className="rounded-lg border border-line p-4">
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="mt-2 text-2xl font-semibold tabular-nums">
                {figure !== undefined ? (
                  numbers.format(figure)
                ) : (
                  <>
                    <span aria-hidden>–</span>
                    <span className="sr-only">
                      {key in live ? pending : t.noData}
                    </span>
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        <Panel title={t.recentIncidents}>
          {problem ? (
            <EmptyState>{t.loadError}</EmptyState>
          ) : !data ? (
            <EmptyState>{i.loading}</EmptyState>
          ) : data.recent.items.length === 0 ? (
            <EmptyState>{t.noIncidents}</EmptyState>
          ) : (
            <>
              <ul>
                {data.recent.items.map((item) => (
                  <li key={item.id} className="border-b border-line px-4 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <Link
                        href={`/${lang}/incidents/${item.id}`}
                        className="font-medium text-accent hover:underline"
                      >
                        <bdi dir="ltr">{item.reference}</bdi>
                      </Link>
                      <IncidentPills
                        t={i}
                        status={item.status}
                        harmLevel={item.harmLevel}
                        isSentinel={item.isSentinel}
                      />
                    </div>
                    <p className="mt-1 text-sm">
                      {i.type[item.type]}
                      <span className="text-muted"> · </span>
                      <bdi>
                        {pick(
                          item.orgUnit.name,
                          lang,
                          session.tenant.defaultLocale,
                        )}
                      </bdi>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {fill(i.list.reported, {
                        date: dates.format(new Date(item.reportedAt)),
                      })}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="px-4 py-3 text-sm">
                <Link
                  href={`/${lang}/incidents`}
                  className="text-accent hover:underline"
                >
                  {t.viewAll}
                </Link>
              </p>
            </>
          )}
        </Panel>
        <Panel title={t.myTasks}>
          <EmptyState>{t.noData}</EmptyState>
        </Panel>
      </div>
    </>
  );
}
