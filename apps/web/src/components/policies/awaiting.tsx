"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { can, useSession } from "@/components/shell/session";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import {
  documentPath,
  versionPath,
  type ApprovalItem,
  type DocumentList,
  type ReviewItem,
} from "@/lib/policies";
import type { PoliciesProps } from "./types";

type Part<T> = T | "failed" | null;

/** What waits for this person: steps to decide, documents to acknowledge, reviews due. */
export function Awaiting({ lang, t }: PoliciesProps) {
  const session = useSession();
  const approves = can(session, "policies.approve");
  const [approvals, setApprovals] = useState<Part<ApprovalItem[]>>(null);
  const [acks, setAcks] = useState<Part<DocumentList>>(null);
  const [reviews, setReviews] = useState<Part<ReviewItem[]>>(null);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const day = dayFormat(lang);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const numbers = numberFormat(lang);
  const a = t.awaiting;

  useEffect(() => {
    let current = true;
    if (approves) {
      api<{ items: ApprovalItem[] }>("/policies/approvals")
        .then((r) => current && setApprovals(r.items))
        .catch(() => current && setApprovals("failed"));
    }
    api<DocumentList>(
      "/policies/documents?awaitingMyAcknowledgement=true&pageSize=100",
    )
      .then((r) => current && setAcks(r))
      .catch(() => current && setAcks("failed"));
    api<{ items: ReviewItem[] }>("/policies/reviews")
      .then((r) => current && setReviews(r.items))
      .catch(() => current && setReviews("failed"));
    return () => {
      current = false;
    };
  }, [approves]);

  const state = <T,>(part: Part<T>, empty: (v: T) => boolean, none: string) =>
    part === "failed" ? (
      <EmptyState>{t.loadError}</EmptyState>
    ) : part === null ? (
      <EmptyState>{t.loading}</EmptyState>
    ) : empty(part) ? (
      <EmptyState>{none}</EmptyState>
    ) : null;

  const number = (value: string) => (
    <bdi dir="ltr" className="whitespace-nowrap">
      {value}
    </bdi>
  );

  return (
    <>
      <PageHeader title={a.title} description={a.description} />
      <div className="mt-6 flex flex-col gap-6">
        {approves && (
          <Panel title={a.approvals}>
            {state(approvals, (v) => v.length === 0, a.noApprovals) ?? (
              <ul>
                {(approvals as ApprovalItem[]).map((item) => (
                  <li
                    key={item.stepId}
                    className={`border-b border-line py-3 pe-4 last:border-b-0 ${
                      item.overdue ? "border-s-4 border-s-danger ps-3" : "ps-4"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Link
                        href={versionPath(lang, item.document.id, item.version.id)}
                        className="font-medium text-accent hover:underline"
                      >
                        {number(item.document.number)}
                      </Link>
                      <Pill tone="neutral">{t.stepKind[item.kind]}</Pill>
                      {item.overdue && <Pill tone="danger">{t.review.stepOverdue}</Pill>}
                    </div>
                    <p className="mt-1 text-sm">
                      <bdi>{inLang(item.document.title)}</bdi>{" "}
                      <span className="inline-block text-muted">
                        {"· "}
                        {fill(t.versionNumber, {
                          version: numbers.format(item.version.version),
                        })}
                      </span>
                    </p>
                    {item.dueAt && (
                      <p
                        className={`mt-1 text-xs ${item.overdue ? "font-medium text-danger" : "text-muted"}`}
                      >
                        {fill(t.review.dueBy, {
                          date: moments.format(new Date(item.dueAt)),
                        })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}

        <Panel title={a.acknowledgements}>
          {state(acks, (v) => v.items.length === 0, a.noAcknowledgements) ?? (
            <ul>
              {(acks as DocumentList).items.map((item) => (
                <li
                  key={item.id}
                  className={`border-b border-line py-3 pe-4 last:border-b-0 ${
                    item.myAcknowledgement?.overdue
                      ? "border-s-4 border-s-danger ps-3"
                      : "ps-4"
                  }`}
                >
                  <Link
                    href={documentPath(lang, item.id)}
                    className="font-medium text-accent hover:underline"
                  >
                    {number(item.number)}
                  </Link>
                  <p className="mt-1 text-sm">
                    <bdi>{inLang(item.title)}</bdi>
                  </p>
                  {item.myAcknowledgement?.dueOn && (
                    <p
                      className={`mt-1 text-xs ${item.myAcknowledgement.overdue ? "font-medium text-danger" : "text-muted"}`}
                    >
                      {fill(
                        item.myAcknowledgement.overdue ? t.list.ackWasDue : t.list.ackDue,
                        { date: day(item.myAcknowledgement.dueOn) ?? "" },
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={a.reviews}>
          <p className="px-4 pt-3 text-xs text-muted">{a.reviewsHelp}</p>
          {state(reviews, (v) => v.length === 0, a.noReviews) ?? (
            <ul>
              {(reviews as ReviewItem[]).map((item) => (
                <li
                  key={item.id}
                  className={`border-b border-line py-3 pe-4 last:border-b-0 ${
                    item.state === "overdue" ? "border-s-4 border-s-danger ps-3" : "ps-4"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link
                      href={documentPath(lang, item.id)}
                      className="font-medium text-accent hover:underline"
                    >
                      {number(item.number)}
                    </Link>
                    <Pill tone={item.state === "overdue" ? "danger" : "warn"}>
                      {t.reviewState[item.state]}
                    </Pill>
                    {item.reissue && <Pill tone="warn">{t.reissue.pill}</Pill>}
                    {item.mine && <Pill tone="ok">{a.youOwn}</Pill>}
                  </div>
                  <p className="mt-1 text-sm">
                    <bdi>{inLang(item.title)}</bdi>{" "}
                    <span className="inline-block text-muted">
                      {"· "}
                      <bdi>{inLang(item.ownerUnit.name)}</bdi>
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {fill(item.reissue ? t.reissue.byDate : t.list.nextReview, {
                      date: day(item.nextReviewOn) ?? "",
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
