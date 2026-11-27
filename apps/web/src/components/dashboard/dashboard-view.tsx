"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { IncidentPills } from "@/components/incidents/pills";
import type { IncidentsText } from "@/components/incidents/types";
import { can, useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import {
  dashboardPanels,
  dashboardTiles,
  type DashboardTileKey,
} from "@/config/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api } from "@/lib/api";
import {
  clockOf,
  dateTimeFormat,
  fill,
  numberFormat,
  percentFormat,
} from "@/lib/format";
import { incidentsPath } from "@/lib/incident-filters";
import type { IncidentList, IncidentSummary } from "@/lib/incidents";
import { libraryPath, type PolicySummary } from "@/lib/policies";
import { pick } from "@/lib/localized";

type Loaded = { summary: IncidentSummary; recent: IncidentList };

type Tile = {
  key: DashboardTileKey;
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
  /** Where the figure stands against the target the business set. */
  measure?: { met: boolean | null; text: string };
};

/**
 * The dashboard. Incident figures are live; the rest is not built yet.
 * Each tile and panel shows only while its module is on.
 */
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
  const percent = percentFormat(lang);
  // On the hospital's clock, not this device's.
  const dates = dateTimeFormat(lang, session.tenant.timeZone);
  // A clock figure with its unit beside it: "1:36 min".
  const duration = (seconds: number) => {
    const { unit, time } = clockOf(seconds);
    return fill(t.clock[unit], { time });
  };

  const incidentsOn = hasModule(session, "incidents");
  const policiesOn = hasModule(session, "policies");
  const [policies, setPolicies] = useState<PolicySummary | null>(null);
  const [policiesProblem, setPoliciesProblem] = useState(false);

  useEffect(() => {
    if (!policiesOn) return;
    let current = true;
    api<PolicySummary>("/policies/summary")
      .then((next) => {
        if (!current) return;
        setPolicies(next);
        setPoliciesProblem(false);
      })
      .catch(() => current && setPoliciesProblem(true));
    return () => {
      current = false;
    };
  }, [policiesOn]);

  useEffect(() => {
    // Nothing to ask for when the client has no incidents.
    if (!incidentsOn) return;
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
  }, [incidentsOn]);

  const summary = data?.summary;
  const count = (n: number | undefined) =>
    n === undefined ? undefined : numbers.format(n);
  const median = summary?.medianSecondsToReport;
  const onTime = summary?.triagedOnTime;
  // "The last 30 days" as the API counted them: days on the hospital's
  // calendar. The list takes the same two days, so a figure and the list
  // behind it cover the same reports.
  const last30Days = summary?.last30Days
    ? incidentsPath(lang, summary.last30Days)
    : undefined;
  // How long reporting takes says something about the form, not about one
  // person's own reports: it is for the people who handle incidents.
  const handles =
    can(session, "incidents.triage") || can(session, "incidents.view");
  const looksAfterDocuments =
    can(session, "policies.manage") || can(session, "policies.view_all");
  // The API's shares come to one decimal place: "4.5%".
  const share = (value: number) =>
    new Intl.NumberFormat(
      new Intl.Locale(lang, { numberingSystem: "latn" }).toString(),
      { style: "percent", maximumFractionDigits: 1 },
    ).format(value / 100);

  const drawn: Tile[] = [
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
    // Deadlines and how reporting goes are for the people who handle
    // incidents: someone who only reports is sent no deadline at all.
    ...(handles
      ? [
          {
            key: "overdueIncidents" as const,
            live: true,
            figure: count(summary?.overdue),
            help: t.overdueHelp,
            // The most overdue first.
            href: incidentsPath(lang, { overdue: true, sort: "due" }),
            alert: !!summary && summary.overdue > 0,
          },
          {
            key: "triagedOnTime" as const,
            live: true,
            // Null when nothing reported in those days has been triaged.
            figure:
              onTime === undefined
                ? undefined
                : onTime === null
                  ? null
                  : percent(onTime),
            help: t.triagedOnTimeHelp,
            href: last30Days,
          },
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
            href: last30Days,
          },
        ]
      : []),
    { key: "overdueActions" },
    // Review dates are for those who look after documents; what awaits a
    // person is for everyone.
    ...(looksAfterDocuments
      ? [
          {
            key: "documentsPastReview" as const,
            live: true,
            figure: count(policies?.pastReview.count),
            help: policies
              ? fill(t.pastReviewHelp, {
                  percent: policies.pastReview.percent === null ? "–" : share(policies.pastReview.percent),
                  of: numbers.format(policies.pastReview.of),
                })
              : undefined,
            href: libraryPath(lang, { review: "overdue", sort: "next_review" }),
            alert: !!policies && policies.pastReview.met === false,
            measure: policies
              ? {
                  met: policies.pastReview.met,
                  text: fill(t.pastReviewTarget, {
                    target: share(policies.pastReview.target),
                  }),
                }
              : undefined,
          },
          {
            key: "policiesDue" as const,
            live: true,
            figure: count(policies?.dueWithin30Days),
            help: t.policiesDueHelp,
            href: libraryPath(lang, { review: "due", sort: "next_review" }),
          },
        ]
      : []),
    ...(can(session, "policies.approve")
      ? [
          {
            key: "awaitingMyApproval" as const,
            live: true,
            figure: count(policies?.awaitingMyApproval),
            href: `/${lang}/policies/awaiting`,
          },
        ]
      : []),
    {
      key: "awaitingMyAcknowledgement",
      live: true,
      figure: count(policies?.awaitingMyAcknowledgement),
      href: libraryPath(lang, { awaitingMyAcknowledgement: true }),
    },
    // The share of people asked who have acknowledged, for those who may
    // see acknowledgement figures.
    ...(policies?.acknowledgement
      ? [
          {
            key: "acknowledgementCompletion" as const,
            live: true,
            figure:
              policies.acknowledgement.percent === null
                ? null
                : share(policies.acknowledgement.percent),
            // Over the acknowledgements already due; today's figure over
            // everyone asked comes second.
            help: fill(t.acknowledgementHelp, {
              acknowledged: numbers.format(policies.acknowledgement.acknowledged),
              targeted: numbers.format(policies.acknowledgement.targeted),
              live:
                policies.acknowledgement.live.percent === null
                  ? "–"
                  : share(policies.acknowledgement.live.percent),
            }),
            href: `/${lang}/policies/overdue`,
            alert: policies.acknowledgement.met === false,
            measure: {
              met: policies.acknowledgement.met,
              text: fill(t.acknowledgementTarget, {
                target: share(policies.acknowledgement.target),
              }),
            },
          },
        ]
      : []),
  ];
  // In the order the configuration gives, for the modules the client has.
  const tiles = dashboardTiles
    .filter(({ module }) => hasModule(session, module))
    .flatMap(({ key }) => drawn.filter((tile) => tile.key === key));
  const showRecent = hasModule(session, dashboardPanels.recentIncidents);
  const showTasks = hasModule(session, dashboardPanels.myTasks);
  // While a live figure is on its way, or could not be fetched.
  const pending = problem ? t.loadError : i.loading;
  const policiesPending = policiesProblem ? t.policiesLoadError : i.loading;

  return (
    <>
      <PageHeader title={t.title} description={t.description} />

      {tiles.length === 0 && !showRecent && !showTasks && (
        <EmptyState>{t.nothing}</EmptyState>
      )}

      {tiles.length > 0 && (
        <dl className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-3">
          {tiles.map(({ key, figure, live, help, href, alert, measure }) => (
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
                      {live && figure === undefined
                        ? dashboardTiles.find((x) => x.key === key)?.module === "policies"
                          ? policiesPending
                          : pending
                        : t.noData}
                    </span>
                  </>
                )}
              </dd>
              {help && <dd className="mt-1 text-xs text-muted">{help}</dd>}
              {measure && (
                <dd
                  className={`mt-1 text-xs font-medium ${
                    measure.met === false ? "text-danger" : measure.met ? "text-accent" : "text-muted"
                  }`}
                >
                  {measure.text}{" "}
                  <span className="inline-block">
                    {"· "}
                    {measure.met === null
                      ? t.measureNone
                      : measure.met
                        ? t.measureMet
                        : t.measureMissed}
                  </span>
                </dd>
              )}
            </div>
          ))}
        </dl>
      )}

      {(showRecent || showTasks) && (
        <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
          {showRecent && (
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
                      <li
                        key={item.id}
                        className="border-b border-line px-4 py-3"
                      >
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
          )}

          {/* What is waiting for this person: the open incidents assigned to
            them. Actions and reviews will join it when they are built. */}
          {showTasks && (
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
                      href={incidentsPath(lang, {
                        open: true,
                        assignedToMe: true,
                      })}
                      className="text-accent hover:underline"
                    >
                      {t.viewTasks}
                    </Link>
                  </p>
                </div>
              )}
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
