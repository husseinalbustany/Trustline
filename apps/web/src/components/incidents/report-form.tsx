"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState } from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/panel";
import { api } from "@/lib/api";
import type { OrgUnit } from "@/lib/identity";
import type { IncidentCategory, ReportSent } from "@/lib/incidents";
import { FollowUpCode } from "./follow-up-code";
import { ReportFields, useReportClock, type ReportBody } from "./report-fields";
import { explain, type IncidentsProps } from "./types";

type Lists = { categories: IncidentCategory[]; units: OrgUnit[] };

/** The report form for someone who is signed in. */
export function ReportForm({
  lang,
  t,
  heading,
}: IncidentsProps & { heading: { title: string; description: string } }) {
  const session = useSession();
  const allowed = can(session, "incidents.report");
  const [lists, setLists] = useState<Lists | null>(null);
  const [problem, setProblem] = useState(false);
  // What the API answered, follow-up code included: kept here and nowhere
  // else, and only until this page is left.
  const [sent, setSent] = useState<ReportSent | null>(null);
  const clock = useReportClock();
  const { shown, start } = clock;
  const f = t.form;
  const listPath = `/${lang}/incidents`;

  useEffect(() => {
    if (!allowed) return;
    Promise.all([
      api<IncidentCategory[]>("/incident-categories"),
      api<OrgUnit[]>("/org-units"),
    ])
      .then(([categories, units]) => {
        setLists({ categories, units });
        shown();
        setProblem(false);
      })
      .catch(() => setProblem(true));
  }, [allowed, shown]);

  const startAgain = () => {
    setSent(null);
    start();
  };

  // The page stays mounted when the reporter leaves by the menu or the back
  // button. A return visit starts with an empty form: the last report's
  // reference, and above all its follow-up code, are gone for good (the
  // form itself was emptied when it was sent).
  useLayoutEffect(() => () => setSent(null), []);

  async function send(body: ReportBody, anonymous: boolean) {
    setSent(
      await api<ReportSent>("/incidents", {
        method: "POST",
        body: { ...body, anonymous },
      }),
    );
  }

  const header = (
    <PageHeader title={heading.title} description={heading.description} />
  );
  const state = (text: string) => (
    <>
      {header}
      <EmptyState>{text}</EmptyState>
    </>
  );
  if (!allowed) return state(f.noPermission);
  if (problem) return state(f.loadError);
  if (!lists) return state(t.loading);
  if (lists.units.length === 0) return state(f.noUnits);

  if (sent) {
    return (
      <>
        <PageHeader title={f.doneTitle} />
        <div className="mt-6 flex max-w-xl flex-col gap-4">
          <div
            role="status"
            className="flex flex-col gap-4 rounded-lg border border-accent bg-accent-soft p-4 sm:p-6"
          >
            <p className="text-sm">{f.doneHelp}</p>
            {sent.reference && (
              <p
                dir="ltr"
                className="text-center text-3xl font-semibold tracking-tight break-all tabular-nums select-all"
              >
                {sent.reference}
              </p>
            )}
          </div>
          {sent.followUpCode && (
            <FollowUpCode
              t={t.code}
              code={sent.followUpCode}
              followUpHref={`/${lang}/follow-up/${session.tenant.slug}`}
            />
          )}
          <div className="flex flex-wrap gap-2">
            {/* An anonymous report is not linked to this account: there is
                nothing of it to open from here. */}
            {sent.id && !sent.followUpCode && (
              <Link
                href={`${listPath}/${sent.id}`}
                onClick={startAgain}
                className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
              >
                {f.view}
              </Link>
            )}
            <Button
              variant="secondary"
              className="h-10 px-4"
              onClick={startAgain}
            >
              {f.another}
            </Button>
          </div>
        </div>
      </>
    );
  }

  // Most reports are about the reporter's own unit: start there when it can
  // be chosen. It is only a starting point; the reporter can change it.
  const ownUnit =
    lists.units.find((u) => u.id === session.user.orgUnitId)?.id ?? "";

  return (
    <>
      {header}
      <p className="mt-4 text-sm text-muted">{f.intro}</p>
      <div className="mt-6 max-w-2xl">
        <ReportFields
          lang={lang}
          t={t}
          categories={lists.categories}
          units={lists.units}
          defaultLocale={session.tenant.defaultLocale}
          startUnit={ownUnit}
          clock={clock}
          anonymousChoice
          privacy={(anonymous) =>
            anonymous ? f.anonymousWarning : f.whoSeesName
          }
          send={send}
          explain={(err) => explain(err, t.errors)}
          cancel={
            <Link
              href={listPath}
              className="inline-flex h-11 items-center rounded-md px-3 text-sm text-muted hover:bg-surface hover:text-foreground max-sm:w-full max-sm:justify-center"
            >
              {f.cancel}
            </Link>
          }
        />
      </div>
    </>
  );
}
