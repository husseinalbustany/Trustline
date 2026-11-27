"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import { useSession, useUnread } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api } from "@/lib/api";
import {
  dateTimeFormat,
  fill,
  momentFrom,
  numberFormat,
  timeAgoFormat,
} from "@/lib/format";
import {
  sentenceFor,
  type Notification,
  type NotificationList,
} from "@/lib/notifications";

const PAGE_SIZE = 20;

/** The answer to one question, and when it came, to say how long ago. */
type Answer = { query: string; list: NotificationList; at: Date };

/** What the address asks for: unread only or all, and which page. */
function readQuery(params: { get(name: string): string | null }) {
  const page = Number(params.get("page"));
  return {
    unread: params.get("unread") === "true",
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

const queryOf = ({ unread, page }: { unread: boolean; page: number }) => {
  const query = new URLSearchParams();
  if (unread) query.set("unread", "true");
  if (page > 1) query.set("page", String(page));
  return query.toString();
};

/**
 * The reader's own notifications, newest first: a sentence each, how long
 * ago, and a way into the incident. Opening one marks it read.
 */
export function NotificationsView({
  lang,
  t,
  paging,
}: {
  lang: Locale;
  t: Dictionary["notifications"];
  /** The words of the page turner, shared with the incidents list. */
  paging: Pick<
    Dictionary["incidents"]["list"],
    "pagination" | "page" | "total" | "previous" | "next"
  >;
}) {
  const session = useSession();
  // The count on the bell, and the way to have it counted again.
  const { unread: unreadCount, refresh: refreshUnread } = useUnread();
  // What is asked for is in the address, and nowhere else.
  const asked = readQuery(useSearchParams());
  const query = queryOf(asked);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Raised to read the list again after "mark all as read".
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const numbers = numberFormat(lang);
  const ago = timeAgoFormat(lang);
  // On the hospital's clock, like every date its staff see.
  const dates = dateTimeFormat(lang, session.tenant.timeZone);
  const path = `/${lang}/notifications`;

  useEffect(() => {
    let current = true;
    api<NotificationList>(
      `/notifications?${new URLSearchParams({
        unread: String(asked.unread),
        page: String(asked.page),
        pageSize: String(PAGE_SIZE),
      })}`,
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
  }, [query, asked.unread, asked.page, round]);

  // Visited pages stay mounted: a refusal of the last attempt must not be
  // waiting here when the page is shown again.
  useLayoutEffect(() => () => setActionFailed(false), []);

  const data = answer?.query === query ? answer.list : null;
  const problem = !data && failed === query;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const pastTheEnd = !!data && data.total > 0 && asked.page > pages;

  const pathFor = (next: { unread: boolean; page: number }) => {
    const q = queryOf(next);
    return `${path}${q ? `?${q}` : ""}`;
  };
  // A page that no longer exists (the unread list got shorter as it was
  // read): go to the last one there is.
  const lastPage = pastTheEnd ? pathFor({ ...asked, page: pages }) : null;
  useEffect(() => {
    if (lastPage) window.history.replaceState(null, "", lastPage);
  }, [lastPage]);

  // A filter replaces the address and starts at page 1; turning a page adds
  // one, so the browser's back button returns to the page before.
  const show = (unread: boolean) =>
    window.history.replaceState(null, "", pathFor({ unread, page: 1 }));
  const turnTo = (page: number) =>
    window.history.pushState(null, "", pathFor({ ...asked, page }));

  /** Shown as read at once; the bell follows when the API has it. */
  const markRead = (id: string) => {
    const readAt = new Date().toISOString();
    setAnswer(
      (was) =>
        was && {
          ...was,
          list: {
            ...was.list,
            items: was.list.items.map((n) =>
              n.id === id ? { ...n, readAt: n.readAt ?? readAt } : n,
            ),
          },
        },
    );
    setActionFailed(false);
    return api(`/notifications/${id}/read`, { method: "POST" })
      .catch(() => setActionFailed(true))
      .finally(refreshUnread);
  };

  async function markAll() {
    setBusy(true);
    setActionFailed(false);
    try {
      await api("/notifications/read-all", { method: "POST" });
      setRound((n) => n + 1);
    } catch {
      setActionFailed(true);
    }
    await refreshUnread();
    setBusy(false);
  }

  const chip =
    "inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap";
  const chipTone = (on: boolean) =>
    on
      ? "border-accent bg-accent-soft font-medium text-accent"
      : "border-line text-muted hover:bg-surface hover:text-foreground";
  // Something is unread, here or on another page of the list.
  const anyUnread =
    (unreadCount ?? 0) > 0 || !!data?.items.some((n) => !n.readAt);

  const row = (n: Notification, at: Date) => {
    const reference = n.data?.reference ?? n.incident.reference;
    // The reference is one piece, left to right and never broken at its
    // hyphens: put in with the words, it would wrap as "INC-2026-" and
    // "00042", and in Arabic its parts would be reordered across the lines.
    const sentence = sentenceFor(t.kinds, n)
      .split("{reference}")
      .flatMap((words, i) =>
        i === 0
          ? [words]
          : [
              <bdi key={i} dir="ltr" className="whitespace-nowrap">
                {reference}
              </bdi>,
              words,
            ],
      );
    const created = momentFrom(n.createdAt);
    const unread = !n.readAt;
    return (
      <li
        key={n.id}
        className={`flex gap-3 border-b border-line py-3 pe-4 last:border-b-0 ${
          // A bar down the leading edge marks what has not been read.
          unread ? "border-s-4 border-s-accent ps-3" : "ps-4"
        }`}
      >
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${unread ? "font-medium" : ""}`}>
            {unread && <span className="sr-only">{t.unreadMark} </span>}
            {n.incident.canOpen ? (
              <Link
                href={`/${lang}/incidents/${n.incident.id}`}
                onClick={() => {
                  if (unread) void markRead(n.id);
                }}
                className="text-accent hover:underline"
              >
                {sentence}
              </Link>
            ) : (
              sentence
            )}
          </p>
          {!n.incident.canOpen && (
            <p className="mt-0.5 text-sm text-muted">{t.unavailable}</p>
          )}
          {created && (
            <p className="mt-1 text-xs text-muted">
              {ago(created, at) ?? t.justNow}{" "}
              <span className="inline-block">
                {"· "}
                <time dateTime={n.createdAt}>{dates.format(created)}</time>
              </span>
            </p>
          )}
        </div>
        {/* One that leads nowhere can still be put away. */}
        {unread && !n.incident.canOpen && (
          <Button
            variant="secondary"
            className="shrink-0"
            onClick={() => void markRead(n.id)}
          >
            {t.markRead}
          </Button>
        )}
      </li>
    );
  };

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <Button
            variant="secondary"
            disabled={busy || !anyUnread}
            onClick={markAll}
          >
            {t.markAll}
          </Button>
        }
      />

      <div
        role="group"
        aria-label={t.filterLabel}
        className="mt-6 flex flex-wrap gap-2"
      >
        {[false, true].map((unread) => (
          <button
            key={String(unread)}
            type="button"
            aria-pressed={asked.unread === unread}
            onClick={() => show(unread)}
            className={`${chip} ${chipTone(asked.unread === unread)}`}
          >
            {unread ? t.unread : t.all}
          </button>
        ))}
      </div>

      {actionFailed && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {t.actionError}
        </p>
      )}

      <div className="mt-4">
        <Panel>
          {problem ? (
            <EmptyState>{t.loadError}</EmptyState>
          ) : !data || !answer || pastTheEnd ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : data.items.length === 0 ? (
            <EmptyState>{asked.unread ? t.emptyUnread : t.empty}</EmptyState>
          ) : (
            <ul className="overflow-hidden rounded-lg">
              {data.items.map((n) => row(n, answer.at))}
            </ul>
          )}
        </Panel>
      </div>

      {data && data.total > 0 && !pastTheEnd && (
        <nav
          aria-label={paging.pagination}
          className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted"
        >
          <span>
            {fill(paging.page, {
              page: numbers.format(asked.page),
              pages: numbers.format(pages),
            })}{" "}
            <span className="inline-block">
              {"· "}
              {fill(paging.total, { total: numbers.format(data.total) })}
            </span>
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              disabled={asked.page <= 1}
              onClick={() => turnTo(asked.page - 1)}
            >
              {paging.previous}
            </Button>
            <Button
              variant="secondary"
              disabled={asked.page >= pages}
              onClick={() => turnTo(asked.page + 1)}
            >
              {paging.next}
            </Button>
          </span>
        </nav>
      )}
    </>
  );
}
