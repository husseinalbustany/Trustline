"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { IncidentPills } from "@/components/incidents/pills";
import type { IncidentsText } from "@/components/incidents/types";
import { can, useSession } from "@/components/shell/session";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api } from "@/lib/api";
import { clockOf, dateTimeFormat, fill, numberFormat } from "@/lib/format";
import { incidentsPath } from "@/lib/incident-filters";
import type { IncidentList, IncidentSummary } from "@/lib/incidents";
import { pick } from "@/lib/localized";

type Loaded = { summary: IncidentSummary; recent: IncidentList };

type Tile = {
  key: keyof Dictionary["dashboard"]["tiles"];
  /** What a live tile shows once loaded; null when there is nothing to show. */
  figure?: string | null;
  /** Live: its figure comes from the API. The others are not built yet. */
  live?: boolean;
  /** What the figure counts, when the label alone does not say. */
  help?: string;
  /** Where the incidents behind the figure are listed. */
  href?: string;
  /** Drawn so it cannot be missed. */
  alert?: boolean;
};

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
  // A clock figure with its unit beside it: "1:36 min".
  const duration = (seconds: number) => {
    const { unit, time } = clockOf(seconds);
    return fill(t.clock[unit], { time });
  };

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

  const summary = data?.summary;
  const count = (n: number | undefined) =>
    n === undefined ? undefined : numbers.format(n);
  const median = summary?.medianSecondsToReport;
  // How long reporting takes says something about the form, not about one
  // person's own reports: it is for the people who handle incidents.
  const handles =
    can(session, "incidents.triage") || can(session, "incidents.view");

  const tiles: Tile[] = [
    // Each count links to the list of exactly the incidents it counts.
    {
      key: "openIncidents",
      live: true,
      figure: count(summary?.open),
      href: incidentsPath(lang, { open: true }),
    },
    {
      key: "awaitingTriage",
      live: true,
      figure: count(summary?.awaitingTriage),
      // The ones that have waited longest come first.
      href: incidentsPath(lang, { status: "new", sort: "oldest" }),
    },
    {
      key: "seriousOpen",
      live: true,
      figure: count(summary?.serious),
      help: t.seriousHelp,
      href: incidentsPath(lang, { open: true, serious: true, sort: "harm" }),
      alert: !!summary && summary.serious > 0,
    },
    ...(handles
      ? [
          {
            key: "timeToReport" as const,
            live: true,
            figure:
              median === undefined
                ? undefined
                : median === null
                  ? null
                  : duration(median),
            help: t.timeToReportHelp,
          },
        ]
      : []),
    { key: "overdueActions" },
    { key: "policiesDue" },
  ];
  // While a live figure is on its way, or could not be fetched.
  const pending = problem ? t.loadError : i.loading;

  return (
    <>
      <PageHeader title={t.title} description={t.description} />

      <dl className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
        {tiles.map(({ key, figure, live, help, href, alert }) => (
          <div
            key={key}
            className={`relative rounded-lg border p-4 ${
              alert ? "border-danger bg-danger-soft" : "border-line"
            } ${href && !alert ? "hover:bg-surface" : ""}`}
          >
            <dt className="text-sm text-muted">
              {href ? (
                // The whole tile is the link; its name is the label.
                <Link
                  href={href}
                  className="after:absolute after:inset-0 after:rounded-lg hover:underline"
                >
                  {t.tiles[key]}
                </Link>
              ) : (
                t.tiles[key]
              )}
            </dt>
            <dd
              className={`mt-2 flex flex-wrap items-center gap-2 text-2xl font-semibold tabular-nums ${
                alert ? "text-danger" : ""
              }`}
            >
              {alert && <TriangleAlert className="size-5" aria-hidden />}
              {figure ?? (
                <>
                  <span aria-hidden>–</span>
                  <span className="sr-only">
                    {live && figure === undefined ? pending : t.noData}
                  </span>
                </>
              )}
            </dd>
            {help && <dd className="mt-1 text-xs text-muted">{help}</dd>}
          </div>
        ))}
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
                  href={incidentsPath(lang)}
                  className="text-accent hover:underline"
                >
                  {t.viewAll}
                </Link>
              </p>
            </>
          )}
        </Panel>

        {/* What is waiting for this person: the open incidents assigned to
            them. Actions and reviews will join it when they are built. */}
        <Panel title={t.myTasks}>
          {problem ? (
            <EmptyState>{t.loadError}</EmptyState>
          ) : !summary ? (
            <EmptyState>{i.loading}</EmptyState>
          ) : summary.assignedToMe === 0 ? (
            <EmptyState>{t.noTasks}</EmptyState>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <p className="flex items-baseline gap-3">
                <span className="text-2xl font-semibold tabular-nums">
                  {numbers.format(summary.assignedToMe)}
                </span>
                <span className="text-sm text-muted">{t.assignedToMe}</span>
              </p>
              <p className="text-sm">
                <Link
                  href={incidentsPath(lang, { open: true, assignedToMe: true })}
                  className="text-accent hover:underline"
                >
                  {t.viewTasks}
                </Link>
              </p>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
