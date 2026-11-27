"use client";

import { Clock, Plus, Search, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { tellHandOff, useHandOff } from "@/lib/hand-off";
import {
  dateTimeFormat,
  deadlineFormat,
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
  liveDeadline,
  sortOrders,
  type IncidentCategory,
  type IncidentList,
  type IncidentListItem,
} from "@/lib/incidents";
import { pick, type Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import { zoneLabel } from "@/lib/time-zone";
import { IncidentPills } from "./pills";
import { forReporter, type IncidentsProps } from "./types";

const PAGE_SIZE = 20;
const statusChips = ["", "open", ...incidentStatuses] as const;

/** The answer to one question, and when it came, to say how long ago. */
type Answer = { query: string; list: IncidentList; at: Date };

export function IncidentsList({ lang, t }: IncidentsProps) {
  const session = useSession();
  // How a report arrived is told only to those who may see who reported
  // it, somewhere: nobody else is offered a filter the API would refuse.
  const seesReporters = can(session, "incidents.see_reporter");
  // What is asked for is in the address, and nowhere else. An address that
  // asks for the way reports arrived, from someone who may not ask (an old
  // bookmark, a link from a colleague), is read without it.
  const asked = readFilters(useSearchParams());
  const filters = seesReporters ? asked : { ...asked, channel: "" as const };
  const query = filtersQuery(filters);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [categories, setCategories] = useState<IncidentCategory[]>([]);
  // Opened or closed by hand; until then, open when one of its filters is on.
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  // An incident just handed out of this user's sight, from its own page:
  // said here once, and gone when this list is left (visited pages stay
  // mounted, and it is not news the next time).
  const handOff = useHandOff();
  useLayoutEffect(() => () => tellHandOff(null), []);
  const l = t.list;
  const inLang = (text: Localized) =>
    pick(text, lang, session.tenant.defaultLocale);
  // Every date here is on the hospital's clock, not this device's.
  const { timeZone } = session.tenant;
  const dates = dateTimeFormat(lang, timeZone);
  const numbers = numberFormat(lang);
  const ago = timeAgoFormat(lang);
  const untilDue = deadlineFormat(lang);
  // Deadlines are for the people who handle incidents: someone who only
  // reports is sent none, so is not offered a filter that finds nothing.
  const handles =
    can(session, "incidents.triage") || can(session, "incidents.view");
  // Someone who only reports sees every incident here as its reporter, and
  // reads its status in plain words: the filter says them too.
  const chipWords = handles ? t : forReporter(t);

  // How long a report has waited, counted from when the list was fetched.
  const reportedAgo = (reportedAt: string) => {
    const then = new Date(reportedAt);
    const span = ago(then, answer?.at ?? then);
    return span ? fill(l.reportedAgo, { ago: span }) : l.reportedJustNow;
  };

  // The deadline an incident is held to now, in words, counted from when
  // the list was fetched. Null where there is none to show: the incident
  // has ended, or the reader sees it only as its reporter.
  const deadlineOf = (item: IncidentListItem) => {
    const live = answer && liveDeadline(item, answer.at);
    if (!live) return null;
    return {
      late: live.late,
      due: live.due,
      text: fill(t.deadline[live.late ? "late" : "due"][live.kind], {
        when: untilDue(live.due, answer.at),
      }),
    };
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

  // The departments and categories to filter by. The list works without
  // them.
  useEffect(() => {
    let current = true;
    api<OrgUnit[]>("/org-units")
      .then((list) => current && setUnits(list))
      .catch(() => {});
    api<IncidentCategory[]>("/incident-categories")
      .then((list) => current && setCategories(list))
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
   * page 1. Each question, a filter or a page, adds an entry to the
   * history, so the browser's back button undoes the last one instead of
   * leaving the list.
   */
  const ask = (next: Partial<IncidentFilters>) => {
    const to = { ...filters, page: 1, ...next };
    if (filtersQuery(to) === query) return;
    window.history.pushState(null, "", incidentsPath(lang, to));
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
  // Likewise a category in the address that is no longer offered.
  const categoryOptions = categories.map((c) => ({
    id: c.id,
    label: inLang(c.name),
  }));
  if (
    filters.categoryId &&
    !categoryOptions.some((c) => c.id === filters.categoryId)
  ) {
    categoryOptions.unshift({
      id: filters.categoryId,
      label: l.inactiveCategory,
    });
  }

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

      {handOff && (
        <p
          role="status"
          className="mt-4 rounded-md bg-accent-soft px-3 py-2 text-sm"
        >
          {/* The reference is kept whole and left to right, as in the
              list; the department's name keeps its own direction. */}
          {l.handedOff.split("{reference}").map((part, index) => (
            <span key={index}>
              {index > 0 && (
                <bdi dir="ltr" className="whitespace-nowrap">
                  {handOff.reference}
                </bdi>
              )}
              {fill(part, { unit: inLang(handOff.unit) })}
            </span>
          ))}
        </p>
      )}

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
                  {value === "open"
                    ? l.open
                    : value
                      ? chipWords.status[value]
                      : l.all}
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
            {/* Still shown to anyone whose address asks for it, so that it
                can be taken off again. */}
            {(handles || filters.overdue) && (
              <label className="flex min-h-9 flex-wrap items-center gap-x-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={filters.overdue}
                  onChange={(e) => ask({ overdue: e.target.checked })}
                />
                {l.overdue}
                <span className="text-xs text-muted">{l.overdueHelp}</span>
              </label>
            )}
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
                {sortOrders
                  .filter(
                    (order) =>
                      order !== "due" || handles || filters.sort === "due",
                  )
                  .map((order) => (
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
            <Field label={l.category}>
              <select
                value={filters.categoryId}
                onChange={(e) => ask({ categoryId: e.target.value })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            {seesReporters && (
              <Field label={l.channel} help={l.channelHelp}>
                <select
                  value={filters.channel}
                  onChange={(e) =>
                    ask({
                      channel: e.target.value as IncidentFilters["channel"],
                    })
                  }
                  className={inputClass}
                >
                  <option value="">{l.all}</option>
                  <option value="app">{l.channelApp}</option>
                  <option value="public">{l.channelPublic}</option>
                </select>
              </Field>
            )}
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
            {/* A day begins and ends on the hospital's clock. */}
            <p className="col-span-full text-xs text-muted">
              {fill(l.hospitalDays, { zone: zoneLabel(lang, timeZone) })}
            </p>
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
              {data.items.map((item) => {
                const deadline = deadlineOf(item);
                // Someone who sees it only as its reporter reads plain
                // words for where it stands, as on the incident itself.
                const words = item.access === "reporter" ? forReporter(t) : t;
                return (
                  <li
                    key={item.id}
                    className={`border-b border-line py-3 pe-4 last:border-b-0 ${
                      // A bar down the leading edge, with the solid marks, so a
                      // severe, fatal or sentinel report is seen when scanning.
                      isSerious(item)
                        ? "border-s-4 border-s-danger ps-3"
                        : "ps-4"
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
                        t={words}
                        status={item.status}
                        harmLevel={item.harmLevel}
                        isSentinel={item.isSentinel}
                      />
                      {deadline?.late && (
                        <Pill
                          tone="danger"
                          icon={
                            <Clock className="size-3 shrink-0" aria-hidden />
                          }
                        >
                          {t.deadline.overdue}
                        </Pill>
                      )}
                      {item.assignedToMe && (
                        <Pill tone="ok">{l.assignedToYou}</Pill>
                      )}
                      {/* Only to those told who reported it. */}
                      {item.channel === "public" && (
                        <Pill tone="neutral">{l.publicLink}</Pill>
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
                    <p
                      dir="auto"
                      className="mt-1 text-sm break-words text-muted"
                    >
                      {item.descriptionExcerpt}
                    </p>
                    {/* What it is waiting for and by when, in words; the date
                      itself beside it. */}
                    {deadline && (
                      <p
                        className={`mt-1.5 text-sm font-medium ${deadline.late ? "text-danger" : ""}`}
                      >
                        {deadline.text}{" "}
                        <span className="inline-block text-xs font-normal text-muted">
                          {"· "}
                          <time dateTime={deadline.due.toISOString()}>
                            {dates.format(deadline.due)}
                          </time>
                        </span>
                      </p>
                    )}
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
                            {words.timeline.changed.ownerUnitId}{" "}
                            <bdi>{inLang(item.ownerUnit.name)}</bdi>
                          </span>
                        </>
                      )}
                    </p>
                  </li>
                );
              })}
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
