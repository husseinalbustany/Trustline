"use client";

import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { codeOf, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, numberFormat } from "@/lib/format";
import { platformApi } from "@/lib/platform-api";
import { deviceTime } from "@/lib/time-zone";
import type { PlatformProps, PlatformText } from "./types";

type Deletion = {
  id: string;
  status: "requested" | "approved" | "done" | "cancelled" | (string & {});
  reason: string;
  writtenInstruction: string | null;
  requestedBy: { id: string; name: string } | null;
  requestedAt: string;
  approvedBy: { id: string; name: string } | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  executedAt: string | null;
  certificate: unknown;
  certificateSha256: string | null;
  signature: unknown;
};

type Contract = {
  tenantId: string;
  clientStatus: string;
  subscriptionStatus: string | null;
  endsOn: string | null;
  exitUntil: string | null;
  retainUntil: string | null;
  exitWindowOpen: boolean;
  exportDownloaded: boolean;
  /** Why it cannot be deleted yet; null when it can. */
  deletable: string | null;
  exports: {
    id: string;
    status: string;
    reason: string;
    requestedAt: string;
    approvedAt: string | null;
    trustlineApprovedAt: string | null;
    refusedAt: string | null;
    cancelledAt: string | null;
    readyAt: string | null;
    expiresAt: string | null;
    expiredAt: string | null;
    sizeBytes: number | null;
    downloads: number;
    lastDownloadedAt: string | null;
  }[];
  deletion: Deletion | null;
};

/** A refusal of the contract routes, in words. */
function explain(t: PlatformText, err: unknown): string {
  const c = t.contract;
  const code = codeOf(err);
  const e = c.errors as Record<string, string>;
  const why = c.deletable as Record<string, string>;
  if (code && Object.hasOwn(e, code)) return e[code];
  if (code && Object.hasOwn(why, code)) return why[code];
  return statusOf(err) === 400 ? c.errors.invalid : c.errors.generic;
}

/**
 * The end of a client's contract, for Trustline staff: its dates, its
 * exports (no names), approving one on the client's written request when
 * no second holder of theirs can, and deleting the client with two members
 * of staff, once its data was exported and its retention has passed.
 */
export function ClientContract({ lang, t, tenantId }: PlatformProps & { tenantId: string }) {
  const c = t.contract;
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, deviceTime);
  const numbers = numberFormat(lang);
  const [view, setView] = useState<Contract | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; at: string } | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  useLayoutEffect(() => () => setMessage(null), []);

  useEffect(() => {
    let current = true;
    platformApi<Contract>(`/tenants/${tenantId}/contract`).then(
      (v) => {
        if (current) setView(v);
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 404 ? t.notFound : t.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [tenantId, t]);

  async function send(at: string, method: string, path: string, body: unknown, done: string, form?: HTMLFormElement) {
    setBusy(true);
    setMessage(null);
    try {
      setView(await platformApi<Contract>(`/tenants/${tenantId}${path}`, { method, body }));
      form?.reset();
      setApproving(null);
      setMessage({ ok: true, text: done, at });
    } catch (err) {
      setMessage({ ok: false, text: explain(t, err), at });
    }
    setBusy(false);
  }

  const said = (at: string) =>
    message?.at === at && (
      <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>
        {message.text}
      </p>
    );

  if (problem || !view) {
    return (
      <Panel title={c.title}>
        <EmptyState>{problem ?? t.loading}</EmptyState>
      </Panel>
    );
  }

  const read = (form: HTMLFormElement, name: string) => String(new FormData(form).get(name) ?? "").trim();
  const statuses = c.exportStatus as Record<string, string>;
  const d = view.deletion;

  return (
    <Panel title={c.title}>
      <div className="flex flex-col gap-6 p-4 text-sm">
        <div className="flex flex-wrap gap-2">
          {view.exitWindowOpen && <Pill tone="warn">{c.exitOpen}</Pill>}
          <Pill tone={view.exportDownloaded ? "ok" : "neutral"}>
            {view.exportDownloaded ? c.exportDownloaded : c.noExportDownloaded}
          </Pill>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const v = (n: string) => read(form, n) || null;
            void send("dates", "PUT", "/contract", { endsOn: v("endsOn"), exitUntil: v("exitUntil"), retainUntil: v("retainUntil") }, c.datesSaved);
          }}
          className="flex flex-col gap-3"
        >
          <p className="font-medium">{c.dates}</p>
          <p className="text-muted">{c.datesHelp}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={c.endsOn}>
              <input type="date" name="endsOn" defaultValue={view.endsOn ?? ""} dir="ltr" className={inputClass} />
            </Field>
            <Field label={c.exitUntil}>
              <input type="date" name="exitUntil" defaultValue={view.exitUntil ?? ""} dir="ltr" className={inputClass} />
            </Field>
            <Field label={c.retainUntil}>
              <input type="date" name="retainUntil" defaultValue={view.retainUntil ?? ""} dir="ltr" className={inputClass} />
            </Field>
          </div>
          {said("dates")}
          <div>
            <Button type="submit" disabled={busy}>
              {c.saveDates}
            </Button>
          </div>
        </form>

        <div className="flex flex-col gap-2">
          <p className="font-medium">{c.exports}</p>
          {view.exports.length === 0 ? (
            <p className="text-muted">{c.noExports}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {view.exports.map((x) => (
                <li key={x.id} className="flex flex-col gap-1 rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{fill(c.requestedAt, { time: moment.format(new Date(x.requestedAt)) })}</span>
                    <Pill tone="neutral">{statuses[x.status] ?? x.status}</Pill>
                  </div>
                  {x.trustlineApprovedAt && (
                    <p className="text-muted">{fill(c.trustlineApproved, { time: moment.format(new Date(x.trustlineApprovedAt)) })}</p>
                  )}
                  {x.downloads > 0 && (
                    <p className="text-muted">
                      {fill(c.downloads, {
                        count: numbers.format(x.downloads),
                        time: x.lastDownloadedAt ? moment.format(new Date(x.lastDownloadedAt)) : "",
                      })}
                    </p>
                  )}
                  {x.status === "requested" &&
                    (approving === x.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = e.currentTarget;
                          const note = read(form, "note");
                          void send(
                            `export:${x.id}`,
                            "POST",
                            `/exports/${x.id}/approve`,
                            {
                              writtenRequest: {
                                receivedOn: read(form, "receivedOn"),
                                from: read(form, "from"),
                                reference: read(form, "reference"),
                                ...(note ? { note } : {}),
                              },
                            },
                            c.approved,
                            form,
                          );
                        }}
                        className="mt-2 flex flex-col gap-3 rounded-md bg-surface p-3"
                      >
                        <p className="text-muted">{c.approveHelp}</p>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <Field label={c.receivedOn}>
                            <input type="date" name="receivedOn" required dir="ltr" className={inputClass} />
                          </Field>
                          <Field label={c.from}>
                            <input name="from" required maxLength={200} dir="auto" className={inputClass} />
                          </Field>
                          <Field label={c.reference}>
                            <input name="reference" required maxLength={200} dir="auto" className={inputClass} />
                          </Field>
                        </div>
                        <Field label={c.note}>
                          <input name="note" maxLength={1000} dir="auto" className={inputClass} />
                        </Field>
                        <div className="flex flex-wrap gap-2">
                          <Button type="submit" disabled={busy}>
                            {c.approve}
                          </Button>
                          <Button variant="secondary" onClick={() => setApproving(null)}>
                            {c.cancel}
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <div>
                        <Button variant="secondary" onClick={() => setApproving(x.id)}>
                          {c.approveOpen}
                        </Button>
                      </div>
                    ))}
                  {said(`export:${x.id}`)}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <p className="font-medium">{c.deletion}</p>
          {d && d.status !== "cancelled" ? (
            <div className="flex flex-col gap-2 rounded-md border border-line p-3">
              <p>
                <Pill tone={d.status === "done" ? "ok" : "warn"}>{(c.deletionStatus as Record<string, string>)[d.status] ?? d.status}</Pill>
              </p>
              <p dir="auto">{fill(c.deletionReason, { reason: d.reason })}</p>
              {d.writtenInstruction && <p dir="auto" className="text-muted">{fill(c.writtenInstruction, { text: d.writtenInstruction })}</p>}
              <p className="text-muted">
                {fill(c.deletionRequested, { name: d.requestedBy?.name ?? "", time: moment.format(new Date(d.requestedAt)) })}
              </p>
              {d.approvedBy && d.approvedAt && (
                <p className="text-muted">{fill(c.deletionApproved, { name: d.approvedBy.name, time: moment.format(new Date(d.approvedAt)) })}</p>
              )}
              {d.status === "requested" && (
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => void send("deletion", "POST", `/deletion/${d.id}/approve`, {}, c.deletionApprovedDone)}>
                    {c.approveDeletion}
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void send("deletion", "POST", `/deletion/${d.id}/cancel`, {}, c.deletionCancelled)}>
                    {c.cancelDeletion}
                  </Button>
                </div>
              )}
              {d.status === "approved" && (
                <>
                  <p>{c.runIt}</p>
                  <code dir="ltr" className="block rounded-md bg-surface px-2 py-1 text-xs break-all">
                    {`pnpm --filter api platform:delete-client --deletion ${d.id} --backups-expire-on <YYYY-MM-DD>`}
                  </code>
                  <div>
                    <Button variant="secondary" disabled={busy} onClick={() => void send("deletion", "POST", `/deletion/${d.id}/cancel`, {}, c.deletionCancelled)}>
                      {c.cancelDeletion}
                    </Button>
                  </div>
                </>
              )}
              {d.status === "done" && (
                <>
                  <p>{fill(c.executed, { time: d.executedAt ? moment.format(new Date(d.executedAt)) : "" })}</p>
                  {d.certificateSha256 && (
                    <>
                      <p className="text-muted">{c.certificateSha}</p>
                      <code dir="ltr" className="block rounded-md bg-surface px-2 py-1 text-xs break-all">
                        {d.certificateSha256}
                      </code>
                    </>
                  )}
                  {d.certificate != null && (
                    <div>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify({ certificate: d.certificate, signature: d.signature }, null, 2)], {
                              type: "application/json",
                            }),
                          );
                          const link = document.createElement("a");
                          link.href = url;
                          link.download = `deletion-certificate-${d.id}.json`;
                          document.body.append(link);
                          link.click();
                          link.remove();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        }}
                      >
                        {c.certificate}
                      </Button>
                    </div>
                  )}
                </>
              )}
              {said("deletion")}
            </div>
          ) : view.deletable ? (
            <p className="text-muted">
              {fill(c.notDeletable, { why: (c.deletable as Record<string, string>)[view.deletable] ?? view.deletable })}
              {view.retainUntil && view.deletable === "before_retention" ? ` ${fill(c.retainedUntil, { day: day(view.retainUntil) ?? "" })}` : ""}
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const instruction = read(form, "writtenInstruction");
                void send(
                  "deletion",
                  "POST",
                  "/deletion",
                  { reason: read(form, "reason"), ...(instruction ? { writtenInstruction: instruction } : {}) },
                  c.deletionAsked,
                  form,
                );
              }}
              className="flex flex-col gap-3"
            >
              <p className="text-muted">{c.deletionHelp}</p>
              <Field label={c.reason}>
                <textarea name="reason" required maxLength={1000} rows={2} dir="auto" className={`${inputClass} h-auto py-2`} />
              </Field>
              <Field label={c.instruction} help={c.instructionHelp}>
                <input name="writtenInstruction" maxLength={1000} dir="auto" className={inputClass} />
              </Field>
              {said("deletion")}
              <div>
                <Button type="submit" disabled={busy}>
                  {c.askDeletion}
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Panel>
  );
}
