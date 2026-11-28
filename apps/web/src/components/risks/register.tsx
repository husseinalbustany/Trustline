"use client";

import { Plus, Search, SlidersHorizontal } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { fill, numberFormat } from "@/lib/format";
import { isReviewer, type OrgUnit } from "@/lib/identity";
import { unitOptions } from "@/lib/org-units";
import {
  bands,
  noRegisterFilters,
  readRegisterFilters,
  registerPath,
  registerQuery,
  registerSorts,
  riskStatuses,
  type PickerPerson,
  type RegisterFilters,
  type RiskList,
} from "@/lib/risks";
import { RiskRow, useBandWord, usePick, useRiskSettings } from "./bits";
import type { RisksProps } from "./types";

const PAGE_SIZE = 20;

type Answer = { query: string; list: RiskList };

/**
 * The register: every risk the reader may read, with search, filters and
 * an order, all held in the address. Owners may hold no permission: an
 * empty list is a valid answer for them.
 */
export function Register({ lang, t }: RisksProps) {
  const session = useSession();
  const filters = readRegisterFilters(useSearchParams());
  const query = registerQuery(filters);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [people, setPeople] = useState<PickerPerson[]>([]);
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const { settings } = useRiskSettings();
  const word = useBandWord(t, lang, settings?.matrix);
  const inLang = usePick(lang);
  const numbers = numberFormat(lang);
  const l = t.list;
  const manages = can(session, "risks.manage") && !isReviewer(session);

  useEffect(() => {
    let current = true;
    api<RiskList>(
      `/risks?${new URLSearchParams([
        ...new URLSearchParams(query),
        ["pageSize", String(PAGE_SIZE)],
      ])}`,
    )
      .then((list) => {
        if (!current) return;
        setAnswer({ query, list });
        setFailed(null);
      })
      .catch(() => current && setFailed(query));
    return () => {
      current = false;
    };
  }, [query]);

  // What to filter by. The list works without them.
  useEffect(() => {
    let current = true;
    api<OrgUnit[]>("/org-units")
      .then((list) => current && setUnits(list))
      .catch(() => {});
    if (can(session, "risks.manage")) {
      api<PickerPerson[]>("/risks/people")
        .then((list) => current && setPeople(list))
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [session]);

  useEffect(() => {
    if (searchInput.current) searchInput.current.value = filters.q;
  }, [filters.q]);

  const data = answer?.query === query ? answer.list : null;
  const problem = !data && failed === query;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const pastTheEnd = !!data && data.total > 0 && filters.page > pages;
  const lastPage = pastTheEnd ? registerPath(lang, { ...filters, page: pages }) : null;
  useEffect(() => {
    if (lastPage) window.history.replaceState(null, "", lastPage);
  }, [lastPage]);

  const ask = (next: Partial<RegisterFilters>) => {
    const to = { ...filters, page: 1, ...next };
    if (registerQuery(to) === query) return;
    window.history.pushState(null, "", registerPath(lang, to));
  };

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    ask({ q: (searchInput.current?.value ?? "").trim() });
  }

  const inUse = [
    filters.unitId,
    filters.categoryId,
    filters.ownerId,
    filters.committeeId,
    filters.band,
    filters.review,
  ].filter(Boolean).length;
  const showMore = moreOpen ?? inUse > 0;
  const narrowed = registerQuery({ ...filters, sort: "score", page: 1 }) !== "";
  const unitChoices = unitOptions(units, (u) => inLang(u.name));
  // The owner chosen in the address, named from the list when not a choice.
  const ownerChoices = people.some((p) => p.id === filters.ownerId) || !filters.ownerId
    ? people
    : [
        ...people,
        { id: filters.ownerId, name: data?.people[filters.ownerId] ?? {}, orgUnitId: null },
      ];

  const chip =
    "inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap";
  const chipTone = (on: boolean) =>
    on
      ? "border-accent bg-accent-soft font-medium text-accent"
      : "border-line text-muted hover:bg-surface hover:text-foreground";
  const check = "flex min-h-9 items-center gap-2 text-sm";
  const tool =
    "inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap hover:bg-surface";

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          manages && (
            <ButtonLink href={`/${lang}/risks/new`}>
              <Plus className="size-4" aria-hidden />
              {t.newRisk}
            </ButtonLink>
          )
        }
      />

      <div className="mt-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div role="group" aria-label={l.statusLabel} className="flex flex-wrap gap-2">
            {(["", ...riskStatuses] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filters.status === value}
                onClick={() => ask({ status: value })}
                className={`${chip} ${chipTone(filters.status === value)}`}
              >
                {value ? t.status[value] : l.current}
              </button>
            ))}
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
                checked={filters.aboveTolerance}
                onChange={(e) => ask({ aboveTolerance: e.target.checked })}
              />
              {l.aboveTolerance}
            </label>
            <label className={check}>
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={filters.notAddressed}
                onChange={(e) => ask({ notAddressed: e.target.checked })}
              />
              {l.notAddressed}
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
          <form
            role="search"
            onSubmit={search}
            className="flex min-w-0 flex-1 basis-72 items-end gap-2 sm:max-w-md"
          >
            <div className="min-w-0 flex-1">
              <Field label={l.search}>
                <input
                  ref={searchInput}
                  type="search"
                  enterKeyHint="search"
                  dir="auto"
                  maxLength={200}
                  autoComplete="off"
                  defaultValue={filters.q}
                  placeholder={l.searchExample}
                  className={`${inputClass} placeholder-shown:[direction:inherit]`}
                />
              </Field>
            </div>
            <button
              type="submit"
              aria-label={l.searchButton}
              title={l.searchButton}
              className={`${tool} border border-line`}
            >
              <Search className="size-4" aria-hidden />
            </button>
          </form>
          <div className="min-w-0 flex-1 basis-40 sm:max-w-56">
            <Field label={l.sortLabel}>
              <select
                value={filters.sort}
                onChange={(e) => ask({ sort: e.target.value as RegisterFilters["sort"] })}
                className={inputClass}
              >
                {registerSorts.map((order) => (
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
            {inUse > 0 ? fill(l.filtersCount, { count: numbers.format(inUse) }) : l.filters}
          </button>
          {narrowed && (
            <button
              type="button"
              onClick={() => ask({ ...noRegisterFilters, sort: filters.sort })}
              className={`${tool} text-accent`}
            >
              {l.clear}
            </button>
          )}
        </div>

        {showMore && (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-surface p-3 min-[30rem]:grid-cols-2 sm:p-4 lg:grid-cols-3">
            <Field label={l.unit} help={l.unitHelp}>
              <select
                value={filters.unitId}
                onChange={(e) => ask({ unitId: e.target.value })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                <option value="whole">{t.wholeOrganization}</option>
                {unitChoices.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l.category}>
              <select
                value={filters.categoryId}
                onChange={(e) => ask({ categoryId: e.target.value })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {(settings?.categories ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {inLang(c.name)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l.band}>
              <select
                value={filters.band}
                onChange={(e) => ask({ band: e.target.value as RegisterFilters["band"] })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {bands.map((b) => (
                  <option key={b} value={b}>
                    {word(b)}
                  </option>
                ))}
              </select>
            </Field>
            {ownerChoices.length > 0 && (
              <Field label={l.ownerLabel}>
                <select
                  value={filters.ownerId}
                  onChange={(e) => ask({ ownerId: e.target.value })}
                  className={inputClass}
                >
                  <option value="">{l.all}</option>
                  {ownerChoices.map((p) => (
                    <option key={p.id} value={p.id}>
                      {inLang(p.name) || t.someone}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={l.committee}>
              <select
                value={filters.committeeId}
                onChange={(e) => ask({ committeeId: e.target.value })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {(settings?.committees ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {inLang(c.name)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l.reviewLabel}>
              <select
                value={filters.review}
                onChange={(e) => ask({ review: e.target.value as RegisterFilters["review"] })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                <option value="due">{t.review.due}</option>
                <option value="overdue">{t.review.overdue}</option>
              </select>
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
              {data.items.map((risk) => (
                <RiskRow
                  key={risk.id}
                  t={t}
                  lang={lang}
                  risk={risk}
                  names={data}
                  word={word}
                />
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
