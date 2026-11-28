"use client";

import { FileDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";
import { canIn, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, download, statusOf } from "@/lib/api";
import { dayFormat, durationFormat, fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { documentPath, personPath, type OverdueList } from "@/lib/policies";
import type { PoliciesProps } from "./types";
import { useExplain } from "./use-explain";

const PAGE_SIZE = 50;

/**
 * Acknowledgements past their due date among the people whose figures the
 * reader sees, most overdue first: where the weekly digest leads. A
 * document the reader may not open is named by its number only.
 */
export function OverdueAcknowledgements({ lang, t }: PoliciesProps) {
  const session = useSession();
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<{ page: number; list: OverdueList } | null>(
    null,
  );
  const [problem, setProblem] = useState<{ page: number; text: string } | null>(
    null,
  );
  const o = t.overdue;
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);
  const days = durationFormat(lang);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const explainError = useExplain(t, lang);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null);
  useLayoutEffect(() => () => setExported(null), []);
  // The file is in the reader's language when the client uses it.
  const fileLocale = session.tenant.locales.includes(lang) ? lang : null;
  // A person's own record is for those who manage documents where they work.
  const opensPerson = (orgUnitId: string | null | undefined) =>
    orgUnitId
      ? canIn(session, "policies.manage", orgUnitId)
      : session.scope?.["policies.manage"] === "all";

  async function exportList() {
    setBusy(true);
    setExported(null);
    try {
      await download(
        `/policies/exports/acknowledgements/overdue${fileLocale ? `?locale=${fileLocale}` : ""}`,
      );
      setExported({ ok: true, text: t.export.done });
    } catch (err) {
      setExported({ ok: false, text: explainError(err) });
    }
    setBusy(false);
  }

  useEffect(() => {
    let current = true;
    api<OverdueList>(
      `/policies/acknowledgements/overdue?${new URLSearchParams({
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
            text: statusOf(err) === 403 ? o.noAccess : t.loadError,
          }),
      );
    return () => {
      current = false;
    };
  }, [page, o, t]);

  const list = answer?.page === page ? answer.list : null;
  const failed = problem?.page === page && !list ? problem.text : null;
  const pages = list ? Math.max(1, Math.ceil(list.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader
        title={o.title}
        description={o.description}
        actions={
          list && list.items.length > 0 ? (
            <Button variant="secondary" disabled={busy} onClick={exportList}>
              <FileDown className="size-4" aria-hidden />
              {busy ? t.export.preparing : o.download}
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
        {failed ? (
          <EmptyState>{failed}</EmptyState>
        ) : !list ? (
          <EmptyState>{t.loading}</EmptyState>
        ) : list.items.length === 0 ? (
          <Panel>
            <EmptyState>{o.empty}</EmptyState>
          </Panel>
        ) : (
          <Panel>
            <ul>
              {list.items.map((item, i) => (
                <li
                  key={`${item.user.id}:${item.version?.id ?? `hidden-${i}`}`}
                  className="flex flex-col gap-1 border-b border-line px-4 py-3 text-sm last:border-b-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span>
                      {opensPerson(item.orgUnit?.id) ? (
                        <Link
                          href={personPath(lang, item.user.id)}
                          className="font-medium text-accent hover:underline"
                        >
                          <bdi>{inLang(item.user.name) || t.document.unknownPerson}</bdi>
                        </Link>
                      ) : (
                        <bdi className="font-medium">
                          {inLang(item.user.name) || t.document.unknownPerson}
                        </bdi>
                      )}
                      {item.orgUnit && (
                        <span className="text-muted">
                          {" · "}
                          <bdi>{inLang(item.orgUnit.name)}</bdi>
                        </span>
                      )}
                    </span>
                    <Pill tone="danger">
                      {fill(o.late, {
                        date: day(item.dueOn) ?? "",
                        days: days(item.daysOverdue, "day"),
                      })}
                    </Pill>
                  </div>
                  {item.document ? (
                    <>
                      <p>
                        {item.document.canOpen ? (
                          <Link
                            href={documentPath(lang, item.document.id)}
                            className="text-accent hover:underline"
                          >
                            <bdi dir="ltr" className="whitespace-nowrap">
                              {item.document.number}
                            </bdi>
                          </Link>
                        ) : (
                          <bdi dir="ltr" className="whitespace-nowrap">
                            {item.document.number}
                          </bdi>
                        )}
                        {item.version && " "}
                        {item.version && (
                          <span className="inline-block text-muted">
                            {"· "}
                            {fill(t.versionNumber, {
                              version: numbers.format(item.version.version),
                            })}
                          </span>
                        )}
                      </p>
                      <p className="text-muted">
                        {item.document.title ? (
                          <bdi>{inLang(item.document.title)}</bdi>
                        ) : (
                          o.documentHidden
                        )}
                      </p>
                    </>
                  ) : (
                    <p className="text-muted">{o.documentHidden}</p>
                  )}
                </li>
              ))}
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
