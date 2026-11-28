"use client";

import { FileDown } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, download, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { documentPath, type PersonAcknowledgements } from "@/lib/policies";
import { versionStatusWord } from "./pills";
import type { PoliciesProps } from "./types";
import { useExplain } from "./use-explain";

const PAGE_SIZE = 50;

/**
 * One person's acknowledgement record, for those who manage documents
 * where they work: every version they were asked to acknowledge, newest
 * first, with when, and whether it was late. People who have left are
 * included. A document the reader may not open is not named.
 */
export function PersonAcknowledgementsView({ lang, t }: PoliciesProps) {
  const { userId } = useParams<{ userId: string }>();
  const session = useSession();
  const p = t.person;
  const [page, setPage] = useState(1);
  const [answer, setAnswer] = useState<{
    key: string;
    record: PersonAcknowledgements;
  } | null>(null);
  const [problem, setProblem] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(null);
  useLayoutEffect(() => () => setExported(null), []);
  const explainError = useExplain(t, lang);
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const key = `${userId}:${page}`;
  // The file is in the reader's language when the client uses it.
  const fileLocale = session.tenant.locales.includes(lang) ? lang : null;

  useEffect(() => {
    let current = true;
    api<PersonAcknowledgements>(
      `/policies/people/${userId}/acknowledgements?${new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      })}`,
    )
      .then((record) => current && setAnswer({ key: `${userId}:${page}`, record }))
      .catch(
        (err) =>
          current &&
          setProblem({
            key: `${userId}:${page}`,
            text: statusOf(err) === 404 ? p.notFound : t.loadError,
          }),
      );
    return () => {
      current = false;
    };
  }, [userId, page, p, t]);

  const record = answer?.key === key ? answer.record : null;
  const failed = problem?.key === key && !record ? problem.text : null;
  const pages = record ? Math.max(1, Math.ceil(record.total / PAGE_SIZE)) : 1;

  async function exportRecord() {
    setBusy(true);
    setExported(null);
    try {
      await download(
        `/policies/people/${userId}/acknowledgements/export${fileLocale ? `?locale=${fileLocale}` : ""}`,
      );
      setExported({ ok: true, text: t.export.done });
    } catch (err) {
      setExported({ ok: false, text: explainError(err) });
    }
    setBusy(false);
  }

  const person = record?.person;
  return (
    <>
      <PageHeader
        title={person ? <bdi>{inLang(person.name) || t.document.unknownPerson}</bdi> : p.title}
        description={
          person ? (
            <>
              {p.title}
              {person.orgUnit && (
                <>
                  {" · "}
                  <bdi>{inLang(person.orgUnit.name)}</bdi>
                </>
              )}
            </>
          ) : (
            p.description
          )
        }
        actions={
          record && record.total > 0 ? (
            <Button variant="secondary" disabled={busy} onClick={exportRecord}>
              <FileDown className="size-4" aria-hidden />
              {busy ? t.export.preparing : p.download}
            </Button>
          ) : null
        }
      />
      {person && person.status !== "active" && (
        <p className="mt-3 text-sm">
          <Pill tone="neutral">
            {person.status === "invited" ? p.invited : p.left}
          </Pill>
        </p>
      )}
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
          <Panel>
            <EmptyState>{failed}</EmptyState>
          </Panel>
        ) : !record ? (
          <Panel>
            <EmptyState>{t.loading}</EmptyState>
          </Panel>
        ) : record.items.length === 0 ? (
          <Panel>
            <EmptyState>{p.empty}</EmptyState>
          </Panel>
        ) : (
          <Panel>
            <ul>
              {record.items.map((item, i) => (
                <li
                  key={`${item.version?.id ?? "hidden"}-${i}`}
                  className="flex flex-col gap-1 border-b border-line px-4 py-3 text-sm last:border-b-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    {item.document && item.version ? (
                      <span>
                        <Link
                          href={`${documentPath(lang, item.document.id)}/versions/${item.version.id}`}
                          className="font-medium text-accent hover:underline"
                        >
                          <bdi dir="ltr" className="whitespace-nowrap">
                            {item.document.number}
                          </bdi>
                        </Link>{" "}
                        <span className="inline-block text-muted">
                          {"· "}
                          {fill(t.versionNumber, {
                            version: numbers.format(item.version.version),
                          })}
                          {" · "}
                          {versionStatusWord(t, item.version.status)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted">{t.overdue.documentHidden}</span>
                    )}
                    <span className="flex flex-wrap gap-1.5">
                      {item.state === "acknowledged" ? (
                        <Pill tone="ok">{p.state.acknowledged}</Pill>
                      ) : item.state === "overdue" ? (
                        <Pill tone="danger">{p.state.overdue}</Pill>
                      ) : (
                        <Pill tone="warn">{p.state.pending}</Pill>
                      )}
                      {item.late && item.state === "acknowledged" && (
                        <Pill tone="warn">{p.late}</Pill>
                      )}
                    </span>
                  </div>
                  {item.document && (
                    <p>
                      <bdi>{inLang(item.document.title)}</bdi>
                    </p>
                  )}
                  <p className="text-xs text-muted">
                    {fill(p.asked, {
                      date: moment.format(new Date(item.assignedAt)),
                    })}{" "}
                    <span className="inline-block">
                      {"· "}
                      {fill(p.due, { date: day(item.dueOn) ?? "" })}
                    </span>
                    {item.acknowledgedAt && (
                      <>
                        {" "}
                        <span className="inline-block">
                          {"· "}
                          {fill(p.acknowledgedAt, {
                            date: moment.format(new Date(item.acknowledgedAt)),
                          })}
                        </span>
                      </>
                    )}
                  </p>
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
                    {fill(t.list.total, { total: numbers.format(record.total) })}
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
