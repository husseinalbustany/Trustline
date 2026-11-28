"use client";

import { ShieldAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, ApiError, codeOf, statusOf } from "@/lib/api";
import { dateTimeFormat, fill, languageNameIn, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";

type Text = Dictionary["dataExport"];

type Named = { id: string; name: Localized | null } | null;

type Export = {
  id: string;
  status: "requested" | "approved" | "refused" | "lapsed" | "cancelled" | "making" | "ready" | "failed" | "expired" | (string & {});
  reason: "contract_end" | "on_request" | (string & {});
  note: string | null;
  locale: string;
  requestedBy: Named;
  requestedAt: string;
  lapsesAt: string | null;
  approvedBy: Named;
  approvedAt: string | null;
  refusedBy: Named;
  refusedAt: string | null;
  refusedReason: string | null;
  cancelledAt: string | null;
  phase: "data" | "documents" | "archive" | null;
  failure: string | null;
  snapshotAt: string | null;
  sizeBytes: number | null;
  archiveSha256: string | null;
  readyAt: string | null;
  expiresAt: string | null;
  expiredAt: string | null;
  downloads: number;
  downloadsLeft: number;
  revision: number;
  may: { approve: boolean; refuse: boolean; cancel: boolean; download: boolean };
};

const tones: Record<string, "ok" | "warn" | "danger" | "neutral"> = {
  requested: "warn",
  approved: "neutral",
  making: "neutral",
  ready: "ok",
  refused: "danger",
  failed: "danger",
  lapsed: "neutral",
  cancelled: "neutral",
  expired: "neutral",
};

/** A refusal of the export routes, in words. */
function explain(t: Text, err: unknown): string {
  const code = codeOf(err);
  const e = t.errors as Record<string, string>;
  if (code && Object.hasOwn(e, code)) return e[code];
  const status = statusOf(err);
  return status === 403 ? t.noAccess : status === 404 ? t.errors.notFound : status === 400 ? t.errors.invalid : t.errors.generic;
}

/**
 * A full export of the organization's data, for those who hold
 * `data.export` for the whole organization: one asks, another approves,
 * then either downloads it a few times within a few days. Each step is
 * signed with a password; the file's fingerprint and its signed manifest
 * let anyone check it later.
 */
export function DataExport({ lang, t }: { lang: string; t: Text }) {
  const session = useSession();
  const allowed = session.scope?.["data.export"] === "all";
  const [items, setItems] = useState<Export[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useLayoutEffect(() => () => setMessage(null), []);
  const languageName = languageNameIn(lang);
  const { locales, defaultLocale } = session.tenant;

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    api<{ items: Export[] }>("/exports?pageSize=50").then(
      (r) => {
        if (current) setItems(r.items);
      },
      (err) => {
        if (current) setProblem(explain(t, err));
      },
    );
    return () => {
      current = false;
    };
  }, [allowed, round, t]);

  // While one is being made or awaits, it is read again now and then.
  const waiting = !!items?.some((x) => ["requested", "approved", "making"].includes(x.status));
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setRound((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, [waiting]);

  async function request(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const note = String(data.get("note") ?? "").trim();
    setBusy(true);
    setMessage(null);
    try {
      await api("/exports", {
        method: "POST",
        body: {
          reason: String(data.get("reason")),
          ...(note ? { note } : {}),
          locale: String(data.get("locale")),
          password: String(data.get("password") ?? ""),
        },
      });
      form.reset();
      setMessage({ ok: true, text: t.requested });
      setRound((n) => n + 1);
    } catch (err) {
      const input = form.elements.namedItem("password");
      if (input instanceof HTMLInputElement) input.value = "";
      setMessage({ ok: false, text: explain(t, err) });
    }
    setBusy(false);
  }

  const open = !!items?.some((x) => ["requested", "approved", "making"].includes(x.status));

  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      {!allowed ? (
        <div className="mt-6">
          <Panel>
            <EmptyState>{t.noAccess}</EmptyState>
          </Panel>
        </div>
      ) : (
        <div className="mt-6 flex max-w-3xl flex-col gap-6">
          <Panel title={t.request.title}>
            <form onSubmit={request} className="flex flex-col gap-5 p-4">
              <div className="flex items-start gap-3 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                <div className="flex flex-col gap-1">
                  <p>{t.request.everything}</p>
                  <p className="font-medium">{t.request.twoPeople}</p>
                  <p>{t.request.responsibility}</p>
                </div>
              </div>
              {open ? (
                <p className="text-sm text-muted">{t.request.onlyOne}</p>
              ) : (
                <>
                  <Field label={t.request.reason}>
                    <select name="reason" required defaultValue="on_request" className={inputClass}>
                      <option value="on_request">{t.reasons.on_request}</option>
                      <option value="contract_end">{t.reasons.contract_end}</option>
                    </select>
                  </Field>
                  <Field label={t.request.note} help={t.request.noteHelp}>
                    <textarea name="note" rows={2} maxLength={1000} dir="auto" className={`${inputClass} h-auto py-2`} />
                  </Field>
                  <Field label={t.request.language} help={t.request.languageHelp}>
                    <select
                      name="locale"
                      defaultValue={locales.includes(lang) ? lang : defaultLocale}
                      className={inputClass}
                    >
                      {locales.map((l) => (
                        <option key={l} value={l}>
                          {languageName(l)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t.password} help={t.request.passwordHelp}>
                    <input
                      name="password"
                      type="password"
                      required
                      autoComplete="current-password"
                      dir="ltr"
                      className={inputClass}
                    />
                  </Field>
                  <div>
                    <Button type="submit" disabled={busy}>
                      {t.request.submit}
                    </Button>
                  </div>
                </>
              )}
              {message && (
                <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>
                  {message.text}
                </p>
              )}
            </form>
          </Panel>

          <Panel title={t.list.title}>
            {problem ? (
              <EmptyState>{problem}</EmptyState>
            ) : !items ? (
              <EmptyState>{t.loading}</EmptyState>
            ) : items.length === 0 ? (
              <EmptyState>{t.list.empty}</EmptyState>
            ) : (
              <ul>
                {items.map((x) => (
                  <ExportRow key={x.id} lang={lang} t={t} item={x} onChanged={() => setRound((n) => n + 1)} />
                ))}
              </ul>
            )}
          </Panel>

          <CheckHelp t={t} />
        </div>
      )}
    </>
  );
}

function ExportRow({
  lang,
  t,
  item: x,
  onChanged,
}: {
  lang: string;
  t: Text;
  item: Export;
  onChanged: () => void;
}) {
  const session = useSession();
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const numbers = numberFormat(lang);
  const languageName = languageNameIn(lang);
  const [open, setOpen] = useState<"approve" | "refuse" | "download" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useLayoutEffect(() => () => setMessage(null), []);
  const name = (p: Named) => pick(p?.name, lang, session.tenant.defaultLocale) || t.formerUser;
  const when = (iso: string | null) => (iso ? moment.format(new Date(iso)) : "");
  const statuses = t.status as Record<string, string>;
  const phases = t.phases as Record<string, string>;
  const megabytes = (bytes: number) =>
    new Intl.NumberFormat(new Intl.Locale(lang, { numberingSystem: "latn" }).toString(), {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 1,
    }).format(bytes / 1_000_000);

  async function send(path: string, body: Record<string, unknown>, done: string, form?: HTMLFormElement) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/exports/${x.id}/${path}`, { method: "POST", body });
      form?.reset();
      setOpen(null);
      setMessage({ ok: true, text: done });
      onChanged();
    } catch (err) {
      const input = form?.elements.namedItem("password");
      if (input instanceof HTMLInputElement) input.value = "";
      setMessage({ ok: false, text: explain(t, err) });
      if (codeOf(err) === "stale_export") onChanged();
    }
    setBusy(false);
  }

  /** The archive, saved as the API names it; its fingerprint kept to show. */
  async function download(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");
    form.reset();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/exports/${x.id}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(res.status, data.code, undefined, undefined, data);
      }
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "export.zip";
      setFingerprint(res.headers.get("X-Archive-SHA256") ?? x.archiveSha256);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setOpen(null);
      setMessage({ ok: true, text: t.download.done });
      onChanged();
    } catch (err) {
      setMessage({ ok: false, text: explain(t, err) });
    }
    setBusy(false);
  }

  const passwordField = (
    <Field label={t.password}>
      <input name="password" type="password" required autoComplete="current-password" dir="ltr" className={inputClass} />
    </Field>
  );

  return (
    <li className="flex flex-col gap-2 border-b border-line px-4 py-3 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{(t.reasons as Record<string, string>)[x.reason] ?? x.reason}</span>
        <Pill tone={tones[x.status] ?? "neutral"}>{statuses[x.status] ?? x.status}</Pill>
      </div>
      {x.note && (
        <p dir="auto" className="text-muted">
          {x.note}
        </p>
      )}
      <p className="text-muted">
        {fill(t.list.requested, { name: name(x.requestedBy), time: when(x.requestedAt) })}
        {" · "}
        {fill(t.list.language, { language: languageName(x.locale) })}
      </p>
      {x.status === "requested" && x.lapsesAt && (
        <p className="text-muted">{fill(t.list.lapses, { time: when(x.lapsesAt) })}</p>
      )}
      {x.approvedBy && <p className="text-muted">{fill(t.list.approved, { name: name(x.approvedBy), time: when(x.approvedAt) })}</p>}
      {x.refusedBy && (
        <p className="text-muted">
          {fill(t.list.refused, { name: name(x.refusedBy), time: when(x.refusedAt) })}{" "}
          <bdi dir="auto">{x.refusedReason}</bdi>
        </p>
      )}
      {x.cancelledAt && <p className="text-muted">{fill(t.list.cancelled, { time: when(x.cancelledAt) })}</p>}
      {x.status === "making" && x.phase && <p>{fill(t.list.phase, { phase: phases[x.phase] ?? x.phase })}</p>}
      {x.status === "failed" && <p className="text-danger">{t.list.failed}</p>}
      {x.status === "ready" && (
        <p>
          {fill(t.list.ready, {
            size: x.sizeBytes !== null ? megabytes(x.sizeBytes) : "",
            expires: when(x.expiresAt),
            left: numbers.format(x.downloadsLeft),
          })}
        </p>
      )}
      {x.snapshotAt && <p className="text-xs text-muted">{fill(t.list.snapshot, { time: when(x.snapshotAt) })}</p>}
      {x.downloads > 0 && <p className="text-xs text-muted">{fill(t.list.downloads, { count: numbers.format(x.downloads) })}</p>}
      {(fingerprint ?? x.archiveSha256) && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted">{t.list.sha}</p>
          <code dir="ltr" className="block rounded-md bg-surface px-2 py-1 text-xs break-all select-all">
            {fingerprint ?? x.archiveSha256}
          </code>
        </div>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-accent" : "text-danger"}>
          {message.text}
        </p>
      )}
      {open === null && (
        <div className="flex flex-wrap gap-2">
          {x.may.approve && <Button onClick={() => setOpen("approve")}>{t.approve.open}</Button>}
          {x.may.refuse && (
            <Button variant="secondary" onClick={() => setOpen("refuse")}>
              {t.refuse.open}
            </Button>
          )}
          {x.may.download && <Button onClick={() => setOpen("download")}>{t.download.open}</Button>}
          {x.may.cancel && (
            <Button variant="secondary" disabled={busy} onClick={() => void send("cancel", { revision: x.revision }, t.cancel.done)}>
              {t.cancel.open}
            </Button>
          )}
        </div>
      )}
      {open === "approve" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            void send("approve", { password: String(new FormData(form).get("password") ?? ""), revision: x.revision }, t.approve.done, form);
          }}
          className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3"
        >
          <p>{t.approve.intro}</p>
          {passwordField}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {t.approve.submit}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(null)}>
              {t.cancelButton}
            </Button>
          </div>
        </form>
      )}
      {open === "refuse" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            void send("refuse", { reason: String(new FormData(form).get("reason") ?? "").trim(), revision: x.revision }, t.refuse.done, form);
          }}
          className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3"
        >
          <Field label={t.refuse.reason} help={t.refuse.reasonHelp}>
            <textarea name="reason" required maxLength={1000} rows={2} dir="auto" className={`${inputClass} h-auto py-2`} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {t.refuse.submit}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(null)}>
              {t.cancelButton}
            </Button>
          </div>
        </form>
      )}
      {open === "download" && (
        <form onSubmit={download} className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3">
          <p>{t.download.intro}</p>
          {passwordField}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? t.download.working : t.download.submit}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(null)}>
              {t.cancelButton}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

/** How to check an archive: its fingerprint, and its manifest against the published key. */
function CheckHelp({ t }: { t: Text }) {
  const [failed, setFailed] = useState(false);
  async function keys() {
    setFailed(false);
    try {
      const all = await api<{ exportKeys?: unknown[] }>("/audit/keys");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify({ keys: all.exportKeys ?? [] }, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "export-keys.json";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setFailed(true);
    }
  }
  return (
    <Panel title={t.check.title}>
      <div className="flex flex-col gap-2 p-4 text-sm text-muted">
        <p>{t.check.fingerprint}</p>
        <code dir="ltr" className="block rounded-md bg-surface px-3 py-2 text-xs">
          {t.check.command}
        </code>
        <p>{t.check.manifest}</p>
        <p>{t.check.files}</p>
        <div>
          <Button variant="secondary" onClick={() => void keys()}>
            {t.check.keys}
          </Button>
        </div>
        {failed && (
          <p role="alert" className="text-danger">
            {t.errors.generic}
          </p>
        )}
      </div>
    </Panel>
  );
}
