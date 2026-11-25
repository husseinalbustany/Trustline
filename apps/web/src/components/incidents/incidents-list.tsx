"use client";

import { Plus, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import {
  dateTimeFormat,
  fill,
  numberFormat,
  timeAgoFormat,
} from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import {
  canBeReference,
  filtersQuery,
  incidentsPath,
  isNarrowed,
  moreFiltersInUse,
  noFilters,
  readFilters,
  type IncidentFilters,
} from "@/lib/incident-filters";
import {
  harmLevels,
  incidentStatuses,
  incidentTypes,
  isSerious,
  sortOrders,
  type IncidentList,
} from "@/lib/incidents";
import { pick, type Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import { IncidentPills } from "./pills";
import type { IncidentsProps } from "./types";

const PAGE_SIZE = 20;
const statusChips = ["", "open", ...incidentStatuses] as const;

/** The answer to one question, and when it came, to say how long ago. */
type Answer = { query: string; list: IncidentList; at: Date };

export function IncidentsList({ lang, t }: IncidentsProps) {
  const session = useSession();
  // What is asked for is in the address, and nowhere else.
  const filters = readFilters(useSearchParams());
  const query = filtersQuery(filters);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  // Opened or closed by hand; until then, open when one of its filters is on.
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const l = t.list;
  const inLang = (text: Localized) =>
    pick(text, lang, session.tenant.defaultLocale);
  const dates = dateTimeFormat(lang);
  const numbers = numberFormat(lang);
  const ago = timeAgoFormat(lang);

  // How long a report has waited, counted from when the list was fetched.
  const reportedAgo = (reportedAt: string) => {
    const then = new Date(reportedAt);
    const span = ago(then, answer?.at ?? then);
    return span ? fill(l.reportedAgo, { ago: span }) : l.reportedJustNow;
  };

  // Text that cannot begin a reference finds nothing: no need to ask.
  const findsNothing = !canBeReference(filters.reference);

  useEffect(() => {
    if (findsNothing) return;
    let current = true;
    api<IncidentList>(
      `/incidents?${new URLSearchParams([
        ...new URLSearchParams(query),
        ["pageSize", String(PAGE_SIZE)],
      ])}`,
    )
      .then((list) => {
        if (!current) return;
        setAnswer({ query, list, at: new Date() });
        setFailed(null);
      })
      .catch(() => current && setFailed(query));
    return () => {
      current = false;
    };
  }, [query, findsNothing]);

  // The departments to filter by. The list works without them.
  useEffect(() => {
    let current = true;
    api<OrgUnit[]>("/org-units")
      .then((list) => current && setUnits(list))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  // The address is the source: when it changes from outside this box (back,
  // "Clear filters"), the box follows.
  useEffect(() => {
    if (referenceInput.current) {
      referenceInput.current.value = filters.reference;
    }
  }, [filters.reference]);

  // Only the answer to the question now asked is shown; while it is on its
  // way the list says "loading", never the answer to the previous one.
  const data: IncidentList | null = findsNothing
    ? { items: [], total: 0 }
    : answer?.query === query
      ? answer.list
      : null;
  const problem = !findsNothing && !data && failed === query;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const pastTheEnd = !!data && data.total > 0 && filters.page > pages;

  // A page that no longer exists (the list got shorter, or the address was
  // typed): go to the last one there is.
  const lastPage = pastTheEnd
    ? incidentsPath(lang, { ...filters, page: pages })
    : null;
  useEffect(() => {
    if (lastPage) window.history.replaceState(null, "", lastPage);
  }, [lastPage]);

  /**
   * Asks a new question by changing the address. A filter starts again at
   * page 1 and replaces the address; turning a page adds one, so the
   * browser's back button returns to the page before.
   */
  const ask = (next: Partial<IncidentFilters>) => {
    const to = { ...filters, page: 1, ...next };
    if (filtersQuery(to) === query) return;
    window.history[next.page ? "pushState" : "replaceState"](
      null,
      "",
      incidentsPath(lang, to),
    );
  };

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    ask({ reference: (referenceInput.current?.value ?? "").trim() });
  }

  const inUse = moreFiltersInUse(filters);
  const showMore = moreOpen ?? inUse > 0;
  const narrowed = isNarrowed(filters);
  // A department in the address that can no longer be chosen is still
  // shown as what the list is narrowed to.
  const departments = unitOptions(
    units,
    (u) => inLang(u.name),
    filters.orgUnitId ? { id: filters.orgUnitId, label: t.inactiveUnit } : null,
  );

  const chip =
    "inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap";
  const chipTone = (on: boolean) =>
    on
      ? "border-accent bg-accent-soft font-medium text-accent"
      : "border-line text-muted hover:bg-surface hover:text-foreground";
  const check = "flex h-9 items-center gap-2 text-sm";
  // As tall as the fields it sits beside.
  const tool =
    "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap hover:bg-surface";

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

      <div className="mt-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div
            role="group"
            aria-label={l.filterLabel}
            className="flex flex-wrap gap-2"
          >
            {statusChips.map((value) => {
              // "Open" is not one status but every one that is not an
              // ending, as the dashboard counts them. One chip is on at a
              // time: choosing a status leaves "Open", and the reverse.
              const on =
                value === "open"
                  ? filters.open
                  : !filters.open && filters.status === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    ask(
                      value === "open"
                        ? { open: true, status: "" }
                        : { open: false, status: value },
                    )
                  }
                  className={`${chip} ${chipTone(on)}`}
                >
                  {value === "open" ? l.open : value ? t.status[value] : l.all}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-6">
            <label className={check}>
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={filters.mine}
                onChange={(e) => ask({ mine: e.target.checked })}
              />
              {l.mine}
            </label>
            <label className={check}>
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={filters.assignedToMe}
                onChange={(e) => ask({ assignedToMe: e.target.checked })}
              />
              {l.assignedToMe}
            </label>
            {/* What "serious" covers is written out: a tooltip is never
                seen on a phone or from the keyboard. */}
            <label className="flex min-h-9 flex-wrap items-center gap-x-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={filters.serious}
                onChange={(e) => ask({ serious: e.target.checked })}
              />
              {l.serious}
              <span className="text-xs text-muted">{l.seriousHelp}</span>
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
          <form
            role="search"
            onSubmit={search}
            className="flex min-w-0 flex-1 basis-72 items-end gap-2 sm:max-w-sm"
          >
            <div className="min-w-0 flex-1">
              <Field label={l.reference}>
                <input
                  ref={referenceInput}
                  type="search"
                  enterKeyHint="search"
                  dir="ltr"
                  maxLength={20}
                  autoComplete="off"
                  autoCapitalize="characters"
                  defaultValue={filters.reference}
                  placeholder={l.referenceExample}
                  className={inputClass}
                />
              </Field>
            </div>
            <button
              type="submit"
              aria-label={l.search}
              title={l.search}
              className={`${tool} border border-line`}
            >
              <Search className="size-4" aria-hidden />
            </button>
          </form>
          <div className="min-w-0 flex-1 basis-40 sm:max-w-56">
            <Field label={l.sortLabel}>
              <select
                value={filters.sort}
                onChange={(e) =>
                  ask({ sort: e.target.value as IncidentFilters["sort"] })
                }
                className={inputClass}
              >
                {sortOrders.map((order) => (
                  <option key={order} value={order}>
                    {l.sort[order]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button
            type="button"
            aria-expanded={showMore}
            onClick={() => setMoreOpen(!showMore)}
            className={`${tool} border border-line aria-expanded:bg-surface`}
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            {inUse > 0
              ? fill(l.filtersCount, { count: numbers.format(inUse) })
              : l.filters}
          </button>
          {narrowed && (
            <button
              type="button"
              onClick={() => ask({ ...noFilters, sort: filters.sort })}
              className={`${tool} text-accent`}
            >
              {l.clear}
            </button>
          )}
        </div>

        {showMore && (
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-3 sm:gap-4 sm:p-4">
            <Field label={t.detail.type}>
              <select
                value={filters.type}
                onChange={(e) =>
                  ask({ type: e.target.value as IncidentFilters["type"] })
                }
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {incidentTypes.map((type) => (
                  <option key={type} value={type}>
                    {t.type[type]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.detail.harmLevel}>
              <select
                value={filters.harmLevel}
                onChange={(e) =>
                  ask({
                    harmLevel: e.target.value as IncidentFilters["harmLevel"],
                  })
                }
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {harmLevels.map((level) => (
                  <option key={level} value={level}>
                    {t.harm[level]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.sentinel}>
              <select
                value={filters.sentinel}
                onChange={(e) =>
                  ask({
                    sentinel: e.target.value as IncidentFilters["sentinel"],
                  })
                }
                className={inputClass}
              >
                <option value="">{l.all}</option>
                <option value="true">{t.yes}</option>
                <option value="false">{t.no}</option>
              </select>
            </Field>
            <Field label={l.department} help={l.departmentHelp}>
              <select
                value={filters.orgUnitId}
                onChange={(e) => ask({ orgUnitId: e.target.value })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {departments.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l.from}>
              <input
                type="date"
                dir="ltr"
                max={filters.to || undefined}
                value={filters.from}
                onChange={(e) => ask({ from: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label={l.to}>
              <input
                type="date"
                dir="ltr"
                min={filters.from || undefined}
                value={filters.to}
                onChange={(e) => ask({ to: e.target.value })}
                className={inputClass}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="mt-4">
        <Panel>
          {problem ? (
            <EmptyState>{t.loadError}</EmptyState>
          ) : !data || pastTheEnd ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : data.items.length === 0 ? (
            <EmptyState>{narrowed ? l.emptyFiltered : l.empty}</EmptyState>
          ) : (
            <ul className="overflow-hidden rounded-lg">
              {data.items.map((item) => (
                <li
                  key={item.id}
                  className={`border-b border-line py-3 pe-4 last:border-b-0 ${
                    // A bar down the leading edge, with the solid marks, so a
                    // severe, fatal or sentinel report is seen when scanning.
                    isSerious(item) ? "border-s-4 border-s-danger ps-3" : "ps-4"
                  }`}
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
                    {item.assignedToMe && (
                      <Pill tone="ok">{l.assignedToYou}</Pill>
                    )}
                  </div>
                  {/* Each dot stays with the piece after it when the line
                      breaks, so none is left alone at the end of a line. */}
                  <p className="mt-1.5 text-sm">
                    {t.type[item.type]}{" "}
                    <span className="inline-block">
                      <span className="text-muted">· </span>
                      {/* Names a client wrote: each keeps its own direction. */}
                      <bdi>{inLang(item.category.name)}</bdi>
                    </span>{" "}
                    <span className="inline-block">
                      <span className="text-muted">· </span>
                      <bdi>{inLang(item.orgUnit.name)}</bdi>
                    </span>
                  </p>
                  <p dir="auto" className="mt-1 text-sm break-words text-muted">
                    {item.descriptionExcerpt}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    <span className="font-medium text-foreground">
                      {reportedAgo(item.reportedAt)}
                    </span>{" "}
                    <span className="inline-block">
                      {"· "}
                      <time dateTime={item.reportedAt}>
                        {dates.format(new Date(item.reportedAt))}
                      </time>
                    </span>
                    {/* Who has it, when it has been handed on: the
                        department filter finds an incident by this too.
                        Kept together, dot included, when the line has to
                        break. */}
                    {item.ownerUnit && (
                      <>
                        {" "}
                        <span className="inline-block">
                          {"· "}
                          {t.timeline.changed.ownerUnitId}{" "}
                          <bdi>{inLang(item.ownerUnit.name)}</bdi>
                        </span>
                      </>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {data && data.total > 0 && !pastTheEnd && (
        <nav
          aria-label={l.pagination}
          className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted"
        >
          <span>
            {fill(l.page, {
              page: numbers.format(filters.page),
              pages: numbers.format(pages),
            })}{" "}
            <span className="inline-block">
              {"· "}
              {fill(l.total, { total: numbers.format(data.total) })}
            </span>
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={filters.page <= 1}
              onClick={() => ask({ page: filters.page - 1 })}
            >
              {l.previous}
            </Button>
            <Button
              variant="secondary"
              disabled={filters.page >= pages}
              onClick={() => ask({ page: filters.page + 1 })}
            >
              {l.next}
            </Button>
          </span>
        </nav>
      )}
    </>
  );
}
