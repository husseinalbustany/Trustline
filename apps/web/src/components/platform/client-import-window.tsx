"use client";

import {
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { codeOf, detailsOf, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill } from "@/lib/format";
import { platformApi } from "@/lib/platform-api";
import { deviceTime } from "@/lib/time-zone";
import type { PlatformProps } from "./types";

/** A client's window for importing documents approved before Trustline. */
type ImportWindow = {
  /** The first day of the documents module; null if it never had it. */
  startedOn: string | null;
  /** The last day imports are accepted. */
  closesOn: string | null;
  /** The day before the first: the latest approval day an import may have. */
  latestApprovedOn: string | null;
  open: boolean;
  setByTrustline: boolean;
  reason: string | null;
  setAt: string | null;
};

type Message = { kind: "ok" | "error"; text: string };

/**
 * When a client may import its existing documents, for Trustline staff:
 * from the first day of its documents module, until the day set here (90
 * days by default). Moving that day is a decision with a reason, kept in
 * both audit logs; the earliest day closes the window from its start.
 */
export function ClientImportWindow({
  lang,
  t,
  tenantId,
  onChanged,
}: PlatformProps & {
  tenantId: string;
  /** Called after a change, for the client's activity to be read again. */
  onChanged: () => void;
}) {
  const w = t.importWindow;
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, deviceTime);
  const [shown, setShown] = useState<ImportWindow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    let current = true;
    platformApi<ImportWindow>(`/tenants/${tenantId}/import-window`)
      .then((loaded) => {
        if (!current) return;
        setShown(loaded);
        setProblem(null);
      })
      .catch((err) => current && setProblem(statusOf(err) === 404 ? t.notFound : t.loadError));
    return () => {
      current = false;
    };
  }, [tenantId, t]);

  // Visited pages stay mounted: a message does not wait there.
  useLayoutEffect(() => () => setMessage(null), []);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const data = new FormData(el);
    setBusy(true);
    setMessage(null);
    try {
      const saved = await platformApi<ImportWindow>(
        `/tenants/${tenantId}/import-window`,
        {
          method: "PUT",
          body: {
            closesOn: String(data.get("closesOn") ?? ""),
            reason: String(data.get("reason") ?? "").replace(/\s+/g, " ").trim(),
          },
        },
      );
      setShown(saved);
      // Visited pages stay mounted: the next change starts empty.
      el.reset();
      setMessage({
        kind: "ok",
        text: saved.open
          ? fill(w.savedOpen, { date: day(saved.closesOn) ?? "" })
          : w.savedClosed,
      });
      onChanged();
    } catch (err) {
      const code = codeOf(err);
      const details = detailsOf(err);
      setMessage({
        kind: "error",
        text:
          code === "invalid_closes_on"
            ? fill(w.errors.invalidClosesOn, {
                earliest: day(String(details.earliest ?? "")) ?? "",
                latest: day(String(details.latest ?? "")) ?? "",
              })
            : code === "policies_never_on"
              ? w.neverOn
              : statusOf(err) === 404
                ? t.notFound
                : statusOf(err) === 400
                  ? w.errors.invalid
                  : w.errors.generic,
      });
    }
    setBusy(false);
  }

  if (problem || !shown) {
    return (
      <Panel title={w.title}>
        <EmptyState>{problem ?? t.loading}</EmptyState>
      </Panel>
    );
  }

  if (!shown.startedOn) {
    return (
      <Panel title={w.title}>
        <p className="p-4 text-sm text-muted">{w.neverOn}</p>
      </Panel>
    );
  }

  const rows: [string, string][] = [
    [w.startedOn, day(shown.startedOn) ?? ""],
    [shown.open ? w.closesOn : w.newClosesOn, day(shown.closesOn) ?? ""],
    [w.latestApprovedOn, day(shown.latestApprovedOn) ?? ""],
  ];

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">{w.title}</h2>
        <Pill tone={shown.open ? "ok" : "neutral"}>
          {shown.open ? w.open : w.closed}
        </Pill>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted">{w.what}</p>
        <dl className="flex flex-col gap-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-wrap gap-x-2">
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm">
          {shown.setByTrustline && shown.setAt
            ? fill(w.setByTrustline, {
                date: moment.format(new Date(shown.setAt)),
                reason: shown.reason ?? "",
              })
            : w.byDefault}
        </p>

        <form
          onSubmit={save}
          className="flex flex-col gap-4 border-t border-line pt-4"
        >
          <h3 className="text-sm font-medium">{w.change}</h3>
          <div className="max-w-56">
            <Field
              label={w.newClosesOn}
              help={fill(w.newClosesOnHelp, {
                earliest: day(shown.latestApprovedOn) ?? "",
              })}
            >
              <input
                name="closesOn"
                type="date"
                required
                dir="ltr"
                min={shown.latestApprovedOn ?? undefined}
                defaultValue={shown.closesOn ?? ""}
                className={inputClass}
              />
            </Field>
          </div>
          <Field label={w.reason} help={w.reasonHelp}>
            <input
              name="reason"
              required
              maxLength={500}
              dir="auto"
              autoComplete="off"
              className={inputClass}
            />
          </Field>
          {message && (
            <p
              role={message.kind === "error" ? "alert" : "status"}
              className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
            >
              {message.text}
            </p>
          )}
          <div>
            <Button type="submit" variant="secondary" disabled={busy}>
              {w.save}
            </Button>
          </div>
        </form>
      </div>
    </Panel>
  );
}
