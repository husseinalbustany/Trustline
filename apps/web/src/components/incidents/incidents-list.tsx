"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { dateTimeFormat, fill, numberFormat } from "@/lib/format";
import type { IncidentList, IncidentStatus } from "@/lib/incidents";
import { pick, type Localized } from "@/lib/localized";
import { IncidentPills } from "./pills";
import type { IncidentsProps } from "./types";

const PAGE_SIZE = 20;
const filters = ["", "new", "triaged", "in_progress", "closed"] as const;
type Filter = "" | IncidentStatus;

export function IncidentsList({ lang, t }: IncidentsProps) {
  const session = useSession();
  const [status, setStatus] = useState<Filter>("");
  const [mine, setMine] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<IncidentList | null>(null);
  const [problem, setProblem] = useState(false);
  const inLang = (text: Localized) =>
    pick(text, lang, session.tenant.defaultLocale);
  const dates = dateTimeFormat(lang);
  const numbers = numberFormat(lang);

  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({
      status,
      mine: String(mine),
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    api<IncidentList>(`/incidents?${query}`)
      .then((list) => {
        if (!current) return;
        setData(list);
        setProblem(false);
      })
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, [status, mine, page]);

  // A new question: show "loading" rather than the previous answer.
  const ask = (next: { status?: Filter; mine?: boolean; page?: number }) => {
    setData(null);
    setProblem(false);
    setStatus(next.status ?? status);
    setMine(next.mine ?? mine);
    setPage(next.page ?? 1);
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const chip =
    "inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap";
  const chipTone = (on: boolean) =>
    on
      ? "border-accent bg-accent-soft font-medium text-accent"
      : "border-line text-muted hover:bg-surface hover:text-foreground";

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          can(session, "incidents.report") && (
            <ButtonLink href={`/${lang}/incidents/new`}>
              <Plus className="size-4" aria-hidden />
              {t.report}
            </ButtonLink>
          )
        }
      />

      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <div
          role="group"
          aria-label={t.list.filterLabel}
          className="flex flex-wrap gap-2"
        >
          {filters.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => ask({ status: value })}
              className={`${chip} ${chipTone(status === value)}`}
            >
              {value ? t.status[value] : t.list.all}
            </button>
          ))}
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={mine}
            onChange={(e) => ask({ mine: e.target.checked })}
          />
          {t.list.mine}
        </label>
      </div>

      <div className="mt-4">
        <Panel>
          {problem ? (
            <EmptyState>{t.loadError}</EmptyState>
          ) : !data ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : data.items.length === 0 ? (
            <EmptyState>
              {status || mine || page > 1 ? t.list.emptyFiltered : t.list.empty}
            </EmptyState>
          ) : (
            <ul>
              {data.items.map((item) => (
                <li
                  key={item.id}
                  className="border-b border-line px-4 py-3 last:border-0"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Link
                      href={`/${lang}/incidents/${item.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      <bdi dir="ltr">{item.reference}</bdi>
                    </Link>
                    <IncidentPills
                      t={t}
                      status={item.status}
                      harmLevel={item.harmLevel}
                      isSentinel={item.isSentinel}
                    />
                  </div>
                  <p className="mt-1.5 text-sm">
                    {t.type[item.type]}
                    <span className="text-muted"> · </span>
                    {inLang(item.category.name)}
                    <span className="text-muted"> · </span>
                    {inLang(item.orgUnit.name)}
                  </p>
                  <p dir="auto" className="mt-1 text-sm break-words text-muted">
                    {item.descriptionExcerpt}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {fill(t.list.reported, {
                      date: dates.format(new Date(item.reportedAt)),
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {data && data.total > 0 && (
        <nav
          aria-label={t.list.pagination}
          className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted"
        >
          <span>
            {fill(t.list.page, {
              page: numbers.format(page),
              pages: numbers.format(pages),
            })}
            {" · "}
            {fill(t.list.total, { total: numbers.format(data.total) })}
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1}
              onClick={() => ask({ page: page - 1 })}
            >
              {t.list.previous}
            </Button>
            <Button
              variant="secondary"
              disabled={page >= pages}
              onClick={() => ask({ page: page + 1 })}
            >
              {t.list.next}
            </Button>
          </span>
        </nav>
      )}
    </>
  );
}
