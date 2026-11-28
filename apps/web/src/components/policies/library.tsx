"use client";

import {
  FileDown,
  FileUp,
  ListChecks,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
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
import { api, download } from "@/lib/api";
import { dayFormat, fill, languageNameIn, numberFormat } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import { pick, type Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import {
  categoriesInOrder,
  documentPath,
  documentStatuses,
  libraryPath,
  documentsExportPath,
  importPath,
  libraryQuery,
  librarySorts,
  noLibraryFilters,
  readLibraryFilters,
  todayIn,
  type DocumentCategory,
  type DocumentList,
  type DocumentType,
  type LibraryFilters,
  type PolicySettings,
} from "@/lib/policies";
import {
  DocumentStatusPill,
  ImportedPill,
  RestrictedPill,
  ReviewPill,
  versionStatusWord,
} from "./pills";
import { importWindowOf, windowClosed } from "./import-form";
import type { PoliciesProps } from "./types";
import { useExplain } from "./use-explain";

const PAGE_SIZE = 20;

type Answer = { query: string; list: DocumentList };

/**
 * The library: every document the reader may open, with search, filters
 * and an order, all held in the address.
 */
export function Library({ lang, t }: PoliciesProps) {
  const session = useSession();
  const filters = readLibraryFilters(useSearchParams());
  const query = libraryQuery(filters);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [types, setTypes] = useState<DocumentType[]>([]);
  const [categories, setCategories] = useState<DocumentCategory[]>([]);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  // Importing is offered only while the organization's window is open.
  const importer = session.scope?.["policies.manage"] === "all";
  const [importOpen, setImportOpen] = useState(false);
  useEffect(() => {
    if (!importer) return;
    let current = true;
    api<PolicySettings>("/policies/settings")
      .then(
        (settings) =>
          current &&
          setImportOpen(
            !windowClosed(importWindowOf(settings), todayIn(session.tenant.timeZone)),
          ),
      )
      .catch(() => {
        // Without the settings the link is left out; the page says why.
      });
    return () => {
      current = false;
    };
  }, [importer, session.tenant.timeZone]);
  const searchInput = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  useLayoutEffect(() => () => setExported(null), []);
  const explainError = useExplain(t, lang);
  const l = t.list;
  // The file is in the reader's language when the client uses it.
  const fileLocale = session.tenant.locales.includes(lang) ? lang : null;

  async function exportList() {
    setExporting(true);
    setExported(null);
    try {
      await download(documentsExportPath(filters, fileLocale));
      setExported({ ok: true, text: t.export.done });
    } catch (err) {
      setExported({ ok: false, text: explainError(err) });
    }
    setExporting(false);
  }
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const day = dayFormat(lang);
  const numbers = numberFormat(lang);
  // Drafts and retired documents are for those who look after documents.
  const looksAfter =
    can(session, "policies.manage") || can(session, "policies.view_all");

  useEffect(() => {
    let current = true;
    api<DocumentList>(
      `/policies/documents?${new URLSearchParams([
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
    api<DocumentType[]>("/policies/types")
      .then((list) => current && setTypes(list))
      .catch(() => {});
    api<DocumentCategory[]>("/policies/categories")
      .then((list) => current && setCategories(list))
      .catch(() => {});
    api<OrgUnit[]>("/org-units")
      .then((list) => current && setUnits(list))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (searchInput.current) searchInput.current.value = filters.q;
  }, [filters.q]);

  const data = answer?.query === query ? answer.list : null;
  const problem = !data && failed === query;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const pastTheEnd = !!data && data.total > 0 && filters.page > pages;
  const lastPage = pastTheEnd
    ? libraryPath(lang, { ...filters, page: pages })
    : null;
  useEffect(() => {
    if (lastPage) window.history.replaceState(null, "", lastPage);
  }, [lastPage]);

  const ask = (next: Partial<LibraryFilters>) => {
    const to = { ...filters, page: 1, ...next };
    if (libraryQuery(to) === query) return;
    window.history.pushState(null, "", libraryPath(lang, to));
  };

  function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    ask({ q: (searchInput.current?.value ?? "").trim() });
  }

  const inUse = [
    filters.typeId,
    filters.categoryId,
    filters.ownerUnitId,
    filters.review,
    filters.source,
    filters.reissueDue,
  ].filter(Boolean).length;
  const showMore = moreOpen ?? inUse > 0;
  const narrowed =
    libraryQuery({ ...filters, sort: "number", page: 1 }) !== "";
  const unitChoices = unitOptions(
    units,
    (u) => inLang(u.name),
    filters.ownerUnitId ? { id: filters.ownerUnitId, label: l.inactive } : null,
  );

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
          can(session, "policies.manage") && (
            <div className="flex flex-wrap gap-2">
              {/* Importing is for those who manage documents for all of it. */}
              {/* The register stays, whatever the import window. */}
              {importer && (
                <ButtonLink variant="secondary" href={importPath(lang, "register")}>
                  <ListChecks className="size-4" aria-hidden />
                  {t.importing.register.open}
                </ButtonLink>
              )}
              {session.scope?.["policies.manage"] === "all" && importOpen && (
                <ButtonLink variant="secondary" href={importPath(lang)}>
                  <FileUp className="size-4" aria-hidden />
                  {t.importing.open}
                </ButtonLink>
              )}
              <ButtonLink href={`/${lang}/policies/new`}>
                <Plus className="size-4" aria-hidden />
                {t.newDocument}
              </ButtonLink>
            </div>
          )
        }
      />

      <div className="mt-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {looksAfter && (
            <div
              role="group"
              aria-label={l.statusLabel}
              className="flex flex-wrap gap-2"
            >
              {(["", ...documentStatuses] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filters.status === value}
                  onClick={() => ask({ status: value })}
                  className={`${chip} ${chipTone(filters.status === value)}`}
                >
                  {value ? t.status[value] : l.all}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-x-6">
            <label className={check}>
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={filters.appliesToMe}
                onChange={(e) => ask({ appliesToMe: e.target.checked })}
              />
              {l.appliesToMe}
            </label>
            <label className={check}>
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={filters.awaitingMyAcknowledgement}
                onChange={(e) =>
                  ask({ awaitingMyAcknowledgement: e.target.checked })
                }
              />
              {l.awaitingMe}
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
                  // Empty, it takes the page's direction, so the example
                  // starts where the reader starts; typed in, its own.
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
                onChange={(e) =>
                  ask({ sort: e.target.value as LibraryFilters["sort"] })
                }
                className={inputClass}
              >
                {librarySorts.map((order) => (
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
              onClick={() => ask({ ...noLibraryFilters, sort: filters.sort })}
              className={`${tool} text-accent`}
            >
              {l.clear}
            </button>
          )}
        </div>

        {showMore && (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-line bg-surface p-3 min-[30rem]:grid-cols-2 sm:p-4 lg:grid-cols-4">
            <Field label={l.type}>
              <select
                value={filters.typeId}
                onChange={(e) => ask({ typeId: e.target.value })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {inLang(type.name)}
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
                {categoriesInOrder(categories).map(({ category, depth }) => (
                  <option key={category.id} value={category.id}>
                    {`${"— ".repeat(depth)}${inLang(category.name)}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l.ownerUnit} help={l.ownerUnitHelp}>
              <select
                value={filters.ownerUnitId}
                onChange={(e) => ask({ ownerUnitId: e.target.value })}
                className={inputClass}
              >
                <option value="">{l.all}</option>
                {unitChoices.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={l.reviewLabel}>
              <select
                value={filters.review}
                onChange={(e) =>
                  ask({ review: e.target.value as LibraryFilters["review"] })
                }
                className={inputClass}
              >
                <option value="">{l.all}</option>
                <option value="due">{l.reviewDue}</option>
                <option value="overdue">{l.reviewOverdue}</option>
              </select>
            </Field>
            <Field label={l.sourceLabel}>
              <select
                value={filters.source}
                onChange={(e) =>
                  ask({ source: e.target.value as LibraryFilters["source"] })
                }
                className={inputClass}
              >
                <option value="">{l.all}</option>
                <option value="imported">{l.sourceImported}</option>
                <option value="written">{l.sourceWritten}</option>
              </select>
            </Field>
            <label className={`${check} min-[30rem]:col-span-2 lg:col-span-4`}>
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={filters.reissueDue}
                onChange={(e) => ask({ reissueDue: e.target.checked })}
              />
              {l.reissueDue}
            </label>
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
                const ack = item.myAcknowledgement;
                return (
                  <li
                    key={item.id}
                    className={`border-b border-line py-3 pe-4 last:border-b-0 ${
                      ack ? "border-s-4 border-s-accent ps-3" : "ps-4"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <Link
                        href={documentPath(lang, item.id)}
                        className="font-medium text-accent hover:underline"
                      >
                        <bdi dir="ltr" className="whitespace-nowrap">
                          {item.number}
                        </bdi>
                      </Link>
                      <Pill tone="neutral">{inLang(item.type.name)}</Pill>
                      {item.status !== "active" && (
                        <DocumentStatusPill t={t} status={item.status} />
                      )}
                      <ReviewPill t={t} review={item.review} />
                      {item.source === "imported" && <ImportedPill t={t} />}
                      {item.confidentiality === "restricted" && (
                        <RestrictedPill t={t} />
                      )}
                      {ack && (
                        <Pill tone={ack.overdue ? "danger" : "ok"}>
                          {ack.overdue ? l.acknowledgeOverdue : l.acknowledge}
                        </Pill>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm font-medium break-words">
                      <Link
                        href={documentPath(lang, item.id)}
                        className="hover:underline"
                      >
                        <bdi>{inLang(item.title)}</bdi>
                      </Link>
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      <bdi>{inLang(item.ownerUnit.name)}</bdi>{" "}
                      <span className="inline-block">
                        {"· "}
                        <bdi>{inLang(item.category.name)}</bdi>
                      </span>{" "}
                      <span className="inline-block">
                        {"· "}
                        {item.status === "retired"
                          ? t.status.retired
                          : item.version === null
                          ? l.notPublished
                          : fill(l.versionEffective, {
                              version: numbers.format(item.version),
                              date: day(item.effectiveOn) ?? "",
                            })}
                      </span>
                      {item.nextReviewOn && item.status === "active" && (
                        <>
                          {" "}
                          <span className="inline-block">
                            {"· "}
                            {fill(l.nextReview, {
                              date: day(item.nextReviewOn) ?? "",
                            })}
                          </span>
                        </>
                      )}
                    </p>
                    {item.inProgress && (
                      <p className="mt-1 text-xs text-muted">
                        {fill(l.inProgress, {
                          version: numbers.format(item.inProgress.version),
                          status: versionStatusWord(t, item.inProgress.status),
                        })}
                      </p>
                    )}
                    {ack?.dueOn && (
                      <p
                        className={`mt-1 text-xs font-medium ${ack.overdue ? "text-danger" : ""}`}
                      >
                        {fill(ack.overdue ? l.ackWasDue : l.ackDue, {
                          date: day(ack.dueOn) ?? "",
                        })}
                      </p>
                    )}
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

      {data && data.total > 0 && (
        <div className="mt-6 flex flex-col items-start gap-1 print:hidden">
          <Button variant="secondary"
                // A long label in some languages: it wraps on a phone.
                className="h-auto! min-h-9 py-1.5 text-start whitespace-normal!" disabled={exporting} onClick={exportList}>
            <FileDown className="size-4" aria-hidden />
            {exporting ? t.export.preparing : t.export.list}
          </Button>
          <p className="max-w-md text-xs text-muted">
            {fill(t.export.listHelp, {
              language: languageNameIn(lang)(
                fileLocale ?? session.tenant.defaultLocale,
              ),
            })}
          </p>
          {exported && (
            <p
              role={exported.ok ? "status" : "alert"}
              className={`text-xs ${exported.ok ? "text-accent" : "text-danger"}`}
            >
              {exported.text}
            </p>
          )}
        </div>
      )}
    </>
  );
}
