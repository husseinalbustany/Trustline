"use client";

import { FileDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { api, download, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { documentPath, type ImportRecord } from "@/lib/policies";
import type { PoliciesProps } from "./types";
import { useExplain } from "./use-explain";

const PAGE_SIZE = 100;

/**
 * The register of imports, for those who manage documents for the whole
 * organization: how the library was migrated, by whom, from which
 * originals, and what each signature covered (the batch and its list
 * fingerprint, the fingerprint of what was signed). Newest first, and as a
 * file for a spreadsheet.
 */
export function ImportRegister({ lang, t }: PoliciesProps) {
  const session = useSession();
  const everywhere = session.scope?.["policies.manage"] === "all";
  const r = t.importing.register;
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<{
    page: number;
    list: { items: ImportRecord[]; total: number };
  } | null>(null);
  const [problem, setProblem] = useState<{ page: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null);
  useLayoutEffect(() => () => setExported(null), []);
  const explainError = useExplain(t, lang);
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  // The file is in the reader's language when the client uses it.
  const fileLocale = session.tenant.locales.includes(lang) ? lang : null;

  useEffect(() => {
    if (!everywhere) return;
    let current = true;
    api<{ items: ImportRecord[]; total: number }>(
      `/policies/imports?${new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })}`,
    )
      .then((list) => current && setAnswer({ page, list }))
      .catch(
        (err) =>
          current &&
          setProblem({
            page,
            text: statusOf(err) === 403 ? t.importing.noAccess : t.loadError,
          }),
      );
    return () => {
      current = false;
    };
  }, [everywhere, page, t]);

  const list = answer?.page === page ? answer.list : null;
  const failed = problem?.page === page && !list ? problem.text : null;
  const pages = list ? Math.max(1, Math.ceil(list.total / PAGE_SIZE)) : 1;

  async function exportRegister() {
    setBusy(true);
    setExported(null);
    try {
      await download(`/policies/exports/imports${fileLocale ? `?locale=${fileLocale}` : ""}`);
      setExported({ ok: true, text: t.export.done });
    } catch (err) {
      setExported({ ok: false, text: explainError(err) });
    }
    setBusy(false);
  }

  const fingerprint = (value: string) => (
    <code dir="ltr" className="font-mono text-xs break-all">
      {value}
    </code>
  );

  return (
    <>
      <PageHeader
        title={r.title}
        description={r.description}
        actions={
          list && list.total > 0 ? (
            <Button variant="secondary" disabled={busy} onClick={exportRegister}>
              <FileDown className="size-4" aria-hidden />
              {busy ? t.export.preparing : r.download}
            </Button>
          ) : null
        }
      />
      {exported && (
        <p
          role={exported.ok ? "status" : "alert"}
          className={`mt-3 text-sm ${exported.ok ? "text-accent" : "text-danger"}`}
        >
          {exported.text}
        </p>
      )}
      <div className="mt-6">
        {!everywhere ? (
          <EmptyState>{t.importing.noAccess}</EmptyState>
        ) : failed ? (
          <Panel>
            <EmptyState>{failed}</EmptyState>
          </Panel>
        ) : !list ? (
          <Panel>
            <EmptyState>{t.loading}</EmptyState>
          </Panel>
        ) : list.items.length === 0 ? (
          <Panel>
            <EmptyState>{r.empty}</EmptyState>
          </Panel>
        ) : (
          <Panel>
            <ul>
              {list.items.map((item) => {
                const rows: [string, ReactNode][] = [
                  ...(item.numberAsGiven || item.revisionLabel
                    ? [
                        [
                          r.original,
                          <bdi key="o" dir="auto">
                            {[item.numberAsGiven, item.revisionLabel]
                              .filter(Boolean)
                              .join(" · ")}
                          </bdi>,
                        ] as [string, ReactNode],
                      ]
                    : []),
                  [
                    t.imported.approvedOn,
                    <span key="a">
                      {day(item.approvedOn)}
                      {" · "}
                      <bdi dir="auto">{item.approvedBy}</bdi>
                    </span>,
                  ],
                  ...(item.lastReviewedOn
                    ? [[t.imported.lastReviewedOn, day(item.lastReviewedOn) ?? ""] as [
                        string,
                        ReactNode,
                      ]]
                    : []),
                  [t.imported.originalKeptAt, <bdi key="k">{inLang(item.originalKeptAt)}</bdi>],
                  ...(item.differences
                    ? [[
                        t.imported.differences,
                        <span key="d" dir="auto" className="whitespace-pre-wrap">
                          {inLang(item.differences)}
                        </span>,
                      ] as [string, ReactNode]]
                    : []),
                  [
                    r.importedBy,
                    <span key="i">
                      <bdi>{inLang(item.importedBy.name) || t.document.unknownPerson}</bdi>
                      {" · "}
                      <span className="whitespace-nowrap">
                        {moment.format(new Date(item.importedAt))}
                      </span>
                    </span>,
                  ],
                  [
                    r.batch,
                    <span key="b" className="flex flex-col gap-0.5">
                      <span>
                        {fill(r.batchPlace, {
                          index: numbers.format(item.batch.index + 1),
                          size: numbers.format(item.batch.size),
                        })}
                      </span>
                      {fingerprint(item.batch.listHash)}
                    </span>,
                  ],
                  [r.signed, fingerprint(item.contentHash)],
                ];
                return (
                  <li
                    key={item.signatureId}
                    className="flex flex-col gap-2 border-b border-line px-4 py-3 text-sm last:border-b-0"
                  >
                    <p>
                      <Link
                        href={documentPath(lang, item.documentId)}
                        className="font-medium text-accent hover:underline"
                      >
                        <bdi dir="ltr" className="whitespace-nowrap">
                          {item.number}
                        </bdi>
                      </Link>{" "}
                      <bdi>{inLang(item.title)}</bdi>
                    </p>
                    <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                      {rows.map(([label, value]) => (
                        <div key={label} className="flex min-w-0 flex-col">
                          <dt className="text-xs text-muted">{label}</dt>
                          <dd className="min-w-0 break-words">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                );
              })}
            </ul>
            {pages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-sm text-muted">
                <span>
                  {fill(t.list.page, {
                    page: numbers.format(page),
                    pages: numbers.format(pages),
                  })}{" "}
                  <span className="inline-block">
                    {"· "}
                    {fill(t.list.total, { total: numbers.format(list.total) })}
                  </span>
                </span>
                <span className="flex gap-2">
                  <Button
                    variant="secondary"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    {t.list.previous}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={page >= pages}
                    onClick={() => setPage(page + 1)}
                  >
                    {t.list.next}
                  </Button>
                </span>
              </div>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}
