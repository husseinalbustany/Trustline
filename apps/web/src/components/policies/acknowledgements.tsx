"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, codeOf, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import {
  documentPath,
  type AcknowledgementFigures,
  type PolicyDocument,
} from "@/lib/policies";
import type { PoliciesProps } from "./types";

const PAGE_SIZE = 100;
const states = ["", "pending", "overdue", "acknowledged"] as const;
type State = (typeof states)[number];

/** A share as the reader's language writes it, to one decimal: "83.5%". */
export function percentOf(lang: string, value: number | null) {
  if (value === null) return null;
  return new Intl.NumberFormat(
    new Intl.Locale(lang, { numberingSystem: "latn" }).toString(),
    { style: "percent", maximumFractionDigits: 1 },
  ).format(value / 100);
}

/**
 * Who has acknowledged the published version and who has not, by unit and
 * by person. For those with full sight of the document only.
 */
export function Acknowledgements({ lang, t }: PoliciesProps) {
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const [doc, setDoc] = useState<PolicyDocument | null>(null);
  const [state, setState] = useState<State>("");
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<{
    key: string;
    figures: AcknowledgementFigures;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const k = t.acknowledgements;
  const key = `${id}:${state}:${page}`;

  useEffect(() => {
    let current = true;
    api<PolicyDocument>(`/policies/documents/${id}`)
      .then(async (d) => {
        if (!current) return;
        setDoc(d);
        if (!d.published) return setProblem(k.notPublished);
        const query = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          ...(state ? { state } : {}),
        });
        const figures = await api<AcknowledgementFigures>(
          `/policies/documents/${id}/versions/${d.published.id}/acknowledgements?${query}`,
        );
        if (!current) return;
        setAnswer({ key, figures });
        setProblem(null);
      })
      .catch((err) => {
        if (!current) return;
        setProblem(
          codeOf(err) === "missing_permission"
            ? k.noAccess
            : statusOf(err) === 404
              ? t.notFound
              : t.loadError,
        );
      });
    return () => {
      current = false;
    };
  }, [id, state, page, key, k, t]);

  const figures = answer?.key === key ? answer.figures : null;
  const shownDoc = doc?.id === id ? doc : null;

  const chip = (on: boolean) =>
    `inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap ${
      on
        ? "border-accent bg-accent-soft font-medium text-accent"
        : "border-line text-muted hover:bg-surface hover:text-foreground"
    }`;
  const pages = figures
    ? Math.max(1, Math.ceil(figures.people.total / PAGE_SIZE))
    : 1;

  return (
    <>
      <PageHeader
        title={k.title}
        description={
          shownDoc ? (
            <>
              <bdi dir="ltr" className="whitespace-nowrap">
                {shownDoc.number}
              </bdi>{" "}
              <span className="inline-block">
                {"· "}
                <bdi>{inLang(shownDoc.title)}</bdi>
              </span>
            </>
          ) : undefined
        }
      />
      {problem ? (
        <EmptyState>{problem}</EmptyState>
      ) : !figures ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {!figures.acknowledgementRequired && (
            <p className="text-sm text-muted">{k.notRequired}</p>
          )}
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(
              [
                [k.targeted, numbers.format(figures.targeted)],
                [k.acknowledged, numbers.format(figures.acknowledged)],
                [k.pending, numbers.format(figures.pending)],
                [k.overdue, numbers.format(figures.overdue)],
              ] as const
            ).map(([label, value], i) => (
              <div
                key={label}
                className={`rounded-lg border p-4 ${
                  i === 3 && figures.overdue > 0
                    ? "border-danger bg-danger-soft"
                    : "border-line"
                }`}
              >
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="mt-2 text-2xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            {fill(k.completion, {
              percent: percentOf(lang, figures.percent) ?? "–",
              version: numbers.format(figures.version),
            })}
          </p>

          <Panel title={k.byUnit}>
            {figures.byUnit.length === 0 ? (
              <EmptyState>{k.nobody}</EmptyState>
            ) : (
              <ul>
                {figures.byUnit.map((row, i) => (
                  <li
                    key={row.orgUnit?.id ?? `none-${i}`}
                    className="flex flex-col gap-1.5 border-b border-line px-4 py-3 text-sm last:border-b-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <bdi className="font-medium">
                        {row.orgUnit ? inLang(row.orgUnit.name) : k.noUnit}
                      </bdi>
                      <span className="tabular-nums">
                        {fill(k.unitFigures, {
                          acknowledged: numbers.format(row.acknowledged),
                          targeted: numbers.format(row.targeted),
                          percent: percentOf(lang, row.percent) ?? "–",
                        })}
                      </span>
                    </div>
                    <div
                      aria-hidden
                      className="h-2 overflow-hidden rounded-full border border-line bg-surface"
                    >
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${row.percent ?? 0}%` }}
                      />
                    </div>
                    {row.overdue > 0 && (
                      <p className="text-xs font-medium text-danger">
                        {fill(k.unitOverdue, { count: numbers.format(row.overdue) })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={k.people}>
            <div
              role="group"
              aria-label={k.filterLabel}
              className="flex flex-wrap gap-2 px-4 pt-3"
            >
              {states.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={state === s}
                  onClick={() => {
                    setState(s);
                    setPage(1);
                  }}
                  className={chip(state === s)}
                >
                  {s ? k.states[s] : k.all}
                </button>
              ))}
            </div>
            {figures.people.items.length === 0 ? (
              <EmptyState>{k.nobodyHere}</EmptyState>
            ) : (
              <ul className="mt-3">
                {figures.people.items.map((p) => (
                  <li
                    key={p.user.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-sm"
                  >
                    <span>
                      <bdi className="font-medium">
                        {inLang(p.user.name) || t.document.unknownPerson}
                      </bdi>
                      {p.orgUnit && (
                        <span className="text-muted">
                          {" · "}
                          <bdi>{inLang(p.orgUnit.name)}</bdi>
                        </span>
                      )}
                    </span>
                    {p.acknowledgedAt ? (
                      <Pill tone="ok">
                        {fill(k.acknowledgedOn, {
                          date: moments.format(new Date(p.acknowledgedAt)),
                        })}
                      </Pill>
                    ) : (
                      <Pill tone={p.overdue ? "danger" : "neutral"}>
                        {fill(p.overdue ? k.wasDue : k.dueOn, {
                          date: day(p.dueOn) ?? "",
                        })}
                      </Pill>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {pages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-sm text-muted">
                <span>
                  {fill(t.list.page, {
                    page: numbers.format(page),
                    pages: numbers.format(pages),
                  })}
                </span>
                <span className="flex gap-2">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                    {t.list.previous}
                  </Button>
                  <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                    {t.list.next}
                  </Button>
                </span>
              </div>
            )}
          </Panel>
        </div>
      )}
      <p className="mt-6 text-sm">
        <Link href={documentPath(lang, id)} className="text-accent hover:underline">
          {t.review.backToDocument}
        </Link>
      </p>
    </>
  );
}
