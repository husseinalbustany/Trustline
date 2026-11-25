"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { can, useRefreshSession, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { CopyLink } from "@/components/ui/copy-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, statusOf } from "@/lib/api";
import { followUpUrl, publicReportUrl } from "@/lib/identity";
import type { AdminProps } from "./types";

type Reporting = { publicReporting: boolean; slug: string };
type Message = { kind: "ok" | "error"; text: string };

/**
 * The hospital's own settings. Each one is a panel of its own; so far there
 * is one, reporting without sign-in.
 */
export function SettingsView({ t }: AdminProps) {
  const session = useSession();
  const refreshSession = useRefreshSession();
  const allowed = can(session, "settings.manage");
  const [reporting, setReporting] = useState<Reporting | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const s = t.settings;
  const r = s.reporting;

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    api<Reporting>("/settings/reporting")
      .then((loaded) => {
        if (!current) return;
        setReporting(loaded);
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 403 ? s.wholeOrganization : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [allowed, s, t]);

  // Visited pages stay mounted: "Switched on." must not be waiting here
  // when the page is shown again.
  useLayoutEffect(() => () => setMessage(null), []);

  async function setOn(publicReporting: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      setReporting(
        await api<Reporting>("/settings/reporting", {
          method: "PUT",
          body: { publicReporting },
        }),
      );
      setMessage({
        kind: "ok",
        text: publicReporting ? r.switchedOn : r.switchedOff,
      });
      // The Organization pages show reporting links only while this is on.
      await refreshSession();
    } catch (err) {
      setMessage({
        kind: "error",
        text: statusOf(err) === 403 ? s.wholeOrganization : s.error,
      });
    }
    setBusy(false);
  }

  const header = <PageHeader title={s.title} description={s.description} />;
  const state = (text: string) => (
    <>
      {header}
      <EmptyState>{text}</EmptyState>
    </>
  );
  if (!allowed) return state(t.noAccess);
  if (problem) return state(problem);
  if (!reporting) return state(t.loading);

  const on = reporting.publicReporting;
  const copy = { copy: r.copy, copied: r.copied };

  return (
    <>
      {header}
      {/* One panel per setting, one under the other. */}
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-sm font-medium">{r.title}</h2>
            <Pill tone={on ? "ok" : "neutral"}>{on ? r.on : r.off}</Pill>
          </div>
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-2 text-sm">
              <p>{r.what}</p>
              <p className="text-muted">{r.shows}</p>
              <p className="text-muted">{on ? r.onHelp : r.offHelp}</p>
            </div>
            {message && (
              <p
                role={message.kind === "error" ? "alert" : "status"}
                className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
              >
                {message.text}
              </p>
            )}
            <div>
              <Button
                variant={on ? "secondary" : "primary"}
                disabled={busy}
                onClick={() => setOn(!on)}
              >
                {on ? r.switchOff : r.switchOn}
              </Button>
            </div>
            <div className="flex flex-col gap-5 border-t border-line pt-4">
              {on && (
                <CopyLink
                  label={r.link}
                  help={r.linkHelp}
                  url={publicReportUrl(reporting.slug)}
                  t={copy}
                />
              )}
              <CopyLink
                label={r.followUpLink}
                help={r.followUpHelp}
                url={followUpUrl(reporting.slug)}
                t={copy}
              />
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
