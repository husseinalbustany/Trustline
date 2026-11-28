"use client";

import { CheckCircle2, CircleDashed, Download, Settings, XCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, download, statusOf } from "@/lib/api";
import { dateTimeFormat, fill, numberFormat } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import { pick, type Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import { todayIn } from "@/lib/policies";
import {
  addMonths,
  defaultPeriod,
  monthOf,
  periods,
  type Measure,
  type MeasureDetails,
  type MeasureHistory,
  type MeasureMonth,
  type MeasureSeries,
} from "@/lib/reports";
import { TrendChart, type Point } from "./trend-chart";

export type ReportsText = Dictionary["reports"];

/** How the figures of one page are written: values, months, moments. */
export function useFigures(lang: string, t: ReportsText) {
  const session = useSession();
  const numbers = numberFormat(lang);
  const percent = new Intl.NumberFormat(new Intl.Locale(lang, { numberingSystem: "latn" }).toString(), {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const months = dateTimeFormat(lang, "UTC", { month: "short", year: "numeric" });
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const value = (unit: string, v: number | null | undefined) =>
    v === null || v === undefined
      ? "—"
      : unit === "percent"
        ? percent.format(v / 100)
        : unit === "seconds"
          ? fill(t.values.seconds, { value: numbers.format(v) })
          : numbers.format(v);
  return {
    numbers,
    value,
    /** A share the API gives as a whole percentage. */
    share: (v: number | null | undefined) =>
      v === null || v === undefined ? "—" : percent.format(v / 100),
    month: (m: string) => months.format(new Date(`${m}-01T00:00:00Z`)),
    moment: (iso: string) => moment.format(new Date(iso)),
  };
}

/** The measure's name and explanation, or its code for one this app does not know yet. */
const wordsOf = (t: ReportsText, code: string) =>
  (t.measures as Record<string, { name: string; help: string } | undefined>)[code] ?? {
    name: code,
    help: "",
  };

/** Met, not met, or not judged: in colour, with an icon and a word. */
export function MetPill({ t, met }: { t: ReportsText; met: boolean | null }) {
  return met === true ? (
    <Pill tone="ok" icon={<CheckCircle2 className="size-3.5 shrink-0" aria-hidden />}>
      {t.target.met}
    </Pill>
  ) : met === false ? (
    <Pill tone="danger" icon={<XCircle className="size-3.5 shrink-0" aria-hidden />}>
      {t.target.notMet}
    </Pill>
  ) : (
    <Pill tone="neutral" icon={<CircleDashed className="size-3.5 shrink-0" aria-hidden />}>
      {t.target.unknown}
    </Pill>
  );
}

/**
 * The measures the organization tracks, for the whole organization or a
 * unit within the reader's reach: each with the month so far against its
 * target, and month by month over the period chosen. The API says which
 * measures there are; none is assumed here.
 */
export function ReportsView({ lang, t }: { lang: string; t: ReportsText }) {
  const session = useSession();
  const params = useSearchParams();
  const reach = session.scope?.["reports.view"];
  const everywhere = reach === "all";
  const manages = session.scope?.["reports.manage"] === "all";
  const thisMonth = monthOf(todayIn(session.tenant.timeZone));
  const asked = Number(params.get("months"));
  const period = (periods as readonly number[]).includes(asked) ? asked : defaultPeriod;
  const from = addMonths(thisMonth, -(period - 1));
  const [units, setUnits] = useState<OrgUnit[] | null>(null);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);

  useEffect(() => {
    if (!reach) return;
    let current = true;
    api<OrgUnit[]>("/org-units").then(
      (list) => {
        if (current) setUnits(list);
      },
      () => {
        if (current) setUnits([]);
      },
    );
    return () => {
      current = false;
    };
  }, [reach]);

  // The units within reach: every one, or those the grant covers.
  const reachable = units?.filter((u) => everywhere || (Array.isArray(reach) && reach.includes(u.id))) ?? [];
  const options = unitOptions(reachable, (u) => inLang(u.name));
  // Someone who sees only some units always looks at one of them.
  const unitId = params.get("unit") ?? (everywhere ? "" : (options[0]?.id ?? ""));
  const waiting = !everywhere && !unitId;

  const query = new URLSearchParams({ from, to: thisMonth });
  if (unitId) query.set("unitId", unitId);
  const key = query.toString();
  const [answer, setAnswer] = useState<{ key: string; series: MeasureSeries } | null>(null);
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const [csvFailed, setCsvFailed] = useState(false);
  useLayoutEffect(() => () => setCsvFailed(false), []);

  useEffect(() => {
    if (!reach || waiting) return;
    let current = true;
    api<MeasureSeries>(`/reports/measures?${key}`).then(
      (series) => {
        if (current) setAnswer({ key, series });
      },
      (err) => {
        if (!current) return;
        const status = statusOf(err);
        setFailed({ key, text: status === 404 ? t.unitGone : status === 403 ? t.noAccess : t.loadError });
      },
    );
    return () => {
      current = false;
    };
  }, [reach, waiting, key, t]);

  const go = (next: { unit?: string; months?: number }) => {
    const q = new URLSearchParams();
    const u = next.unit ?? unitId;
    const m = next.months ?? period;
    if (u) q.set("unit", u);
    if (m !== defaultPeriod) q.set("months", String(m));
    window.history.pushState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}`);
  };

  const series = answer?.key === key ? answer.series : null;
  const problem = !series && failed?.key === key ? failed.text : null;
  // The file in the reader's language when the organization works in it.
  const locale = session.tenant.locales.includes(lang) ? lang : session.tenant.defaultLocale;

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          manages && (
            <Link
              href={`/${lang}/reports/settings`}
              className="inline-flex items-center gap-2 text-sm text-accent hover:underline"
            >
              <Settings className="size-4" aria-hidden />
              {t.settingsLink}
            </Link>
          )
        }
      />
      {!reach ? (
        <div className="mt-6">
          <Panel>
            <EmptyState>{t.noAccess}</EmptyState>
          </Panel>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-full sm:w-72">
              <Field label={t.unit} help={t.unitHelp}>
                <select
                  value={unitId}
                  onChange={(e) => go({ unit: e.target.value })}
                  className={inputClass}
                >
                  {everywhere && <option value="">{t.organization}</option>}
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="w-40">
              <Field label={t.period}>
                <select
                  value={period}
                  onChange={(e) => go({ months: Number(e.target.value) })}
                  className={inputClass}
                >
                  {periods.map((p) => (
                    <option key={p} value={p}>
                      {fill(t.monthsBack, { count: numberFormat(lang).format(p) })}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex flex-col gap-1 sm:ms-auto">
              <Button
                variant="secondary"
                disabled={!series}
                onClick={() => {
                  setCsvFailed(false);
                  const q = new URLSearchParams(query);
                  q.set("locale", locale);
                  download(`/reports/exports/measures?${q}`).catch(() => setCsvFailed(true));
                }}
              >
                <Download className="size-4" aria-hidden />
                {t.csv}
              </Button>
              {csvFailed && (
                <p role="alert" className="text-sm text-danger">
                  {t.csvFailed}
                </p>
              )}
            </div>
          </div>
          {problem ? (
            <Panel>
              <EmptyState>{problem}</EmptyState>
            </Panel>
          ) : !series || waiting ? (
            <Panel>
              <EmptyState>{t.loading}</EmptyState>
            </Panel>
          ) : series.measures.length === 0 ? (
            <Panel>
              <EmptyState>{t.noMeasures}</EmptyState>
            </Panel>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              {series.measures.map((m) => (
                <MeasurePanel
                  key={m.code}
                  lang={lang}
                  t={t}
                  measure={m}
                  from={from}
                  to={thisMonth}
                  unitId={unitId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** What explains a figure, when the API sends it. */
function DetailLines({
  lang,
  t,
  details,
}: {
  lang: string;
  t: ReportsText;
  details: MeasureDetails | null | undefined;
}) {
  const f = useFigures(lang, t);
  if (!details) return null;
  const d = t.details;
  const lines: string[] = [];
  if (typeof details.quickShare === "number") lines.push(fill(d.quickShare, { share: f.share(details.quickShare) }));
  if (typeof details.withStartTime === "number")
    lines.push(fill(d.withStartTime, { count: f.numbers.format(details.withStartTime) }));
  if (typeof details.pending === "number" && details.pending > 0)
    lines.push(fill(d.pending, { count: f.numbers.format(details.pending) }));
  if (typeof details.nearMissShare === "number")
    lines.push(fill(d.nearMissShare, { share: f.share(details.nearMissShare) }));
  const channel = details.channel;
  if (lines.length === 0 && !channel) return null;
  return (
    <div className="flex flex-col gap-1 text-sm text-muted">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {/* Only to those who may know how reports arrived. */}
      {channel && (
        <p>
          <span className="font-medium text-foreground">{d.channel}</span>
          {" · "}
          {fill(d.public, { count: f.numbers.format(channel.public) })}
          {" · "}
          {fill(d.anonymous, { count: f.numbers.format(channel.anonymous) })}
          {" · "}
          {fill(d.named, { count: f.numbers.format(channel.named) })}
        </p>
      )}
    </div>
  );
}

function MeasurePanel({
  lang,
  t,
  measure: m,
  from,
  to,
  unitId,
}: {
  lang: string;
  t: ReportsText;
  measure: Measure;
  from: string;
  to: string;
  unitId: string;
}) {
  const f = useFigures(lang, t);
  const words = wordsOf(t, m.code);
  const [history, setHistory] = useState<string | null>(null);
  const targetWords = t.target as Record<string, string>;
  const sources = t.targetSource as Record<string, string>;
  const targetText = (target: number | null) =>
    target === null
      ? t.target.none
      : fill(targetWords[m.direction] ?? t.target.at_least, { target: f.value(m.valueUnit, target) });
  const byMonth = new Map(m.months.map((x) => [x.month, x]));
  // Every month of the period, taken or not; the month so far is not one.
  const span: string[] = [];
  for (let mo = from; mo < to; mo = addMonths(mo, 1)) span.push(mo);
  const metWord = (met: boolean | null) =>
    met === true ? t.target.met : met === false ? t.target.notMet : t.target.unknown;
  const points: Point[] = span.map((mo) => {
    const x = byMonth.get(mo);
    return {
      month: mo,
      value: x?.value ?? null,
      met: x?.met ?? null,
      text: fill(t.trend.point, {
        month: f.month(mo),
        value: f.value(m.valueUnit, x?.value),
        met: metWord(x?.met ?? null),
      }),
    };
  });
  const taken = span.filter((mo) => byMonth.has(mo)).reverse();
  const c = m.current;

  return (
    <section aria-labelledby={`measure-${m.code}`} className="flex flex-col rounded-lg border border-line bg-background">
      <div className="border-b border-line px-4 py-3">
        <h2 id={`measure-${m.code}`} className="font-semibold">
          {words.name}
        </h2>
        {words.help && <p className="mt-1 text-sm text-muted">{words.help}</p>}
      </div>
      <div className="flex flex-col gap-4 p-4">
        {/* The month so far, against the target in force now. */}
        <div className="flex flex-col gap-2 rounded-md bg-surface p-3">
          <p className="text-xs font-medium text-muted uppercase">{t.current.title}</p>
          {c && c.value !== null ? (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-2xl font-semibold tabular-nums">{f.value(m.valueUnit, c.value)}</span>
                <MetPill t={t} met={c.met} />
                {c.provisional && <Pill tone="neutral">{t.current.provisional}</Pill>}
              </div>
              {c.denominator !== null && c.numerator !== null && (
                <p className="text-sm text-muted">
                  {fill(t.current.counted, {
                    numerator: f.numbers.format(c.numerator),
                    denominator: f.numbers.format(c.denominator),
                  })}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm">{t.current.noValue}</p>
          )}
          <p className="text-sm">
            {targetText(m.target)}
            {m.target !== null && m.targetSource && sources[m.targetSource] && (
              <span className="text-muted"> ({sources[m.targetSource]})</span>
            )}
          </p>
          {c && <DetailLines lang={lang} t={t} details={c.details} />}
          {c && <p className="text-xs text-muted">{fill(t.current.asOf, { time: f.moment(c.asOf) })}</p>}
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{t.trend.title}</h3>
          {taken.length === 0 ? (
            <p className="text-sm text-muted">{t.trend.none}</p>
          ) : (
            <>
              <TrendChart
                label={fill(t.trend.chart, {
                  measure: words.name,
                  first: f.month(span[0]),
                  last: f.month(span[span.length - 1]),
                })}
                points={points}
                target={m.target}
                targetLabel={t.trend.targetLine}
                ceiling={m.valueUnit === "percent" ? 100 : undefined}
              />
              <details className="text-sm">
                <summary className="cursor-pointer text-accent">{t.trend.figures}</summary>
                <MonthsTable
                  lang={lang}
                  t={t}
                  measure={m}
                  months={taken.map((mo) => byMonth.get(mo)!)}
                  open={history}
                  onOpen={setHistory}
                  unitId={unitId}
                />
              </details>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** Every month taken, newest first, with its marks and its revisions. */
function MonthsTable({
  lang,
  t,
  measure: m,
  months,
  open,
  onOpen,
  unitId,
}: {
  lang: string;
  t: ReportsText;
  measure: Measure;
  months: MeasureMonth[];
  open: string | null;
  onOpen: (month: string | null) => void;
  unitId: string;
}) {
  const f = useFigures(lang, t);
  const methods = t.method as Record<string, string>;
  const statuses = t.status as Record<string, string>;
  const tr = t.trend;
  return (
    <div className="mt-2 flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full text-start text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th scope="col" className="py-2 pe-3 text-start font-medium">{tr.month}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{tr.value}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{tr.counted}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{tr.target}</th>
              <th scope="col" className="py-2 pe-3 text-start font-medium">{tr.met}</th>
              <th scope="col" className="py-2 text-start font-medium">{tr.how}</th>
            </tr>
          </thead>
          <tbody>
            {months.map((x) => (
              <tr key={x.month} className="border-b border-line align-top last:border-b-0">
                <th scope="row" className="py-2 pe-3 text-start font-normal whitespace-nowrap">
                  {f.month(x.month)}
                </th>
                <td className="py-2 pe-3 whitespace-nowrap tabular-nums">{f.value(m.valueUnit, x.value)}</td>
                <td className="py-2 pe-3 whitespace-nowrap tabular-nums">
                  {x.numerator === null
                    ? "—"
                    : x.denominator === null
                      ? f.numbers.format(x.numerator)
                      : fill(t.current.counted, {
                          numerator: f.numbers.format(x.numerator),
                          denominator: f.numbers.format(x.denominator),
                        })}
                </td>
                <td className="py-2 pe-3 whitespace-nowrap tabular-nums">{f.value(m.valueUnit, x.target)}</td>
                <td className="py-2 pe-3">
                  <MetPill t={t} met={x.met} />
                </td>
                <td className="py-2">
                  <div className="flex flex-col items-start gap-1">
                    {x.method === "corrected" && x.correctedAt ? (
                      <Pill tone="warn">{fill(t.marks.corrected, { date: f.moment(x.correctedAt) })}</Pill>
                    ) : x.method === "reconstructed" ? (
                      <Pill tone="neutral">{t.marks.reconstructed}</Pill>
                    ) : (
                      <span className="text-muted">{methods[x.method] ?? x.method}</span>
                    )}
                    {x.status === "provisional" && <Pill tone="neutral">{statuses.provisional}</Pill>}
                    <button
                      type="button"
                      onClick={() => onOpen(open === x.month ? null : x.month)}
                      aria-expanded={open === x.month}
                      className="text-xs text-accent hover:underline"
                    >
                      {fill(tr.openRevisions, { month: f.month(x.month) })}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <Revisions lang={lang} t={t} measure={m} month={open} unitId={unitId} onClose={() => onOpen(null)} />}
    </div>
  );
}

/** Every figure a month has had, oldest first, with why it was corrected. */
function Revisions({
  lang,
  t,
  measure: m,
  month,
  unitId,
  onClose,
}: {
  lang: string;
  t: ReportsText;
  measure: Measure;
  month: string;
  unitId: string;
  onClose: () => void;
}) {
  const session = useSession();
  const f = useFigures(lang, t);
  const h = t.history;
  const methods = t.method as Record<string, string>;
  const statuses = t.status as Record<string, string>;
  const key = `${m.code}|${month}|${unitId}`;
  const [answer, setAnswer] = useState<{ key: string; history: MeasureHistory } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const q = new URLSearchParams({ month });
    if (unitId) q.set("unitId", unitId);
    api<MeasureHistory>(`/reports/measures/${encodeURIComponent(m.code)}/history?${q}`).then(
      (history) => {
        if (current) setAnswer({ key, history });
      },
      () => {
        if (current) setFailed(key);
      },
    );
    return () => {
      current = false;
    };
  }, [key, m.code, month, unitId]);

  const history = answer?.key === key ? answer.history : null;
  return (
    <div role="region" aria-label={fill(h.title, { month: f.month(month) })} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{fill(h.title, { month: f.month(month) })}</p>
        <button type="button" onClick={onClose} className="text-xs text-accent hover:underline">
          {h.close}
        </button>
      </div>
      {failed === key ? (
        <p className="text-danger">{h.loadError}</p>
      ) : !history ? (
        <p className="text-muted">{h.loading}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {history.revisions.map((r) => (
            <li key={r.revision} className="flex flex-col gap-0.5 border-s-2 border-line ps-3">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{fill(h.revision, { revision: f.numbers.format(r.revision) })}</span>
                <span className="tabular-nums">{f.value(m.valueUnit, r.value)}</span>
                <MetPill t={t} met={r.met} />
              </p>
              <p className="text-muted">
                {methods[r.method] ?? r.method}
                {" · "}
                {statuses[r.status] ?? r.status}
                {" · "}
                {fill(h.takenAt, { date: f.moment(r.takenAt) })}
              </p>
              {r.reason && (
                <p dir="auto">{fill(h.reason, { reason: r.reason })}</p>
              )}
              {r.requestedBy && (
                <p className="text-muted">
                  {fill(h.requestedBy, {
                    name: pick(r.requestedBy.name, lang, session.tenant.defaultLocale) || h.formerUser,
                  })}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
