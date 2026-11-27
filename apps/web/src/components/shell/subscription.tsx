"use client";

import { Info, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { moduleOn, type ModuleKey } from "@/config/modules";
import type { Dictionary } from "@/i18n/dictionaries";
import { codeOf, limitOf } from "@/lib/api";
import { fill, numberFormat } from "@/lib/format";
import type { Session } from "@/lib/identity";
import { SessionContext, useRefreshSession } from "./session";

export type SubscriptionText = Dictionary["subscription"];

/** The words about the subscription, set once by the app shell. */
export const SubscriptionTextContext = createContext<{
  lang: string;
  t: SubscriptionText;
} | null>(null);

/** Whether the client has a module; core always. */
export const hasModule = (session: Session, module: ModuleKey) =>
  moduleOn(session.tenant.modules, module);

/**
 * Whether the organization's account is read-only: its subscription is
 * suspended. Everything that writes is refused then, except reporting an
 * incident, signing out and marking notifications read.
 */
export const isReadOnly = (session: Session) =>
  session.tenant.subscription?.status === "suspended";

/** The same, for a screen inside the app shell. */
export function useReadOnly() {
  const session = useContext(SessionContext);
  return !!session && isReadOnly(session);
}

/**
 * What to say when the API refuses a change because of the subscription:
 * the account is read-only, or a limit of the plan is reached. Null for any
 * other refusal, which the screen words itself. A refusal for being
 * read-only also reads the session again, so the banner and the screens
 * follow at once.
 */
export function useSubscriptionRefusal() {
  const words = useContext(SubscriptionTextContext);
  const refreshSession = useRefreshSession();
  return useCallback(
    (err: unknown): string | null => {
      if (!words) return null;
      const { lang, t } = words;
      if (codeOf(err) === "subscription_suspended") {
        void refreshSession();
        return t.refused;
      }
      const reached = limitOf(err);
      if (reached) {
        return fill(t.limit[reached.limit], {
          max: numberFormat(lang).format(reached.max),
        });
      }
      return null;
    },
    [words, refreshSession],
  );
}

/**
 * Controls that change something, disabled while the account is read-only.
 * It draws no box of its own.
 */
export function ReadOnlyFieldset({ children }: { children: ReactNode }) {
  const readOnly = useReadOnly();
  return (
    <fieldset disabled={readOnly} className="contents">
      {children}
    </fieldset>
  );
}

/**
 * The notice at the top of every page: to the administrators while a
 * payment is past due, quiet; to everyone while the account is read-only.
 */
export function SubscriptionBanner({
  session,
  t,
}: {
  session: Session;
  t: SubscriptionText;
}) {
  const notice = session.tenant.subscription?.notice;
  if (notice === "past_due") {
    return (
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm print:hidden">
        <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <p>{t.pastDue}</p>
      </div>
    );
  }
  if (notice === "suspended") {
    // Reporting an incident is never closed by a billing matter; it is
    // only mentioned to a client that has incidents.
    const reports = hasModule(session, "incidents");
    return (
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm print:hidden">
        <LockKeyhole className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t.suspendedTitle}</p>
          <p>{reports ? t.suspended : t.suspendedNoReporting}</p>
        </div>
      </div>
    );
  }
  return null;
}

/** What a page of a module the client does not have shows instead. */
export function NotInSubscription({
  lang,
  t,
}: {
  lang: string;
  t: SubscriptionText;
}) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-xl font-semibold ltr:tracking-tight">
        {t.notIncluded.title}
      </h1>
      <p className="text-sm text-muted">{t.notIncluded.body}</p>
      <Link
        href={`/${lang}/dashboard`}
        className="mt-2 text-sm text-accent hover:underline"
      >
        {t.notIncluded.back}
      </Link>
    </div>
  );
}
