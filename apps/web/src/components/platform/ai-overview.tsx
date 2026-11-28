"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { codeOf, detailsOf, statusOf } from "@/lib/api";
import { fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { platformApi } from "@/lib/platform-api";
import type { PlatformProps, PlatformText } from "./types";

export type Connection = {
  id: string;
  name: string;
  kind: "anthropic" | "bedrock" | (string & {});
  region: string;
  inferenceType: "in_region" | "regional" | "global" | (string & {});
  models: { id: string; label: string; inputUsdPerMTok: number; outputUsdPerMTok: number }[];
  credentialEnv: string;
  credentialsPresent: boolean;
  active: boolean;
  clients: number;
  createdAt: string;
  updatedAt: string;
};

type PlatformAi = {
  monthlySpendingLimitUsd: number | null;
  month: string;
  spentUsd: number;
  mode: "fake" | "real" | (string & {});
  /** In fake mode, what the fake answers with; null in real mode. */
  fakeAnswers?: "sample" | "echo" | "scripted" | (string & {}) | null;
  updatedAt: string | null;
};

type Usage = {
  tenantId: string;
  slug: string;
  name: Localized;
  month: string;
  offered: boolean;
  enabled: boolean;
  features: Record<string, { configured: boolean; allowance: number | null; used: number; costUsd: number }>;
  costUsd: number;
  monthlySpendingLimitUsd: number | null;
  near: boolean;
  over: boolean;
};

/** Dollars, to the cent. */
export const usd = (lang: string) =>
  new Intl.NumberFormat(new Intl.Locale(lang, { numberingSystem: "latn" }).toString(), {
    style: "currency",
    currency: "USD",
  });

/** Every refusal of the AI routes, in words. */
export function aiRefusal(t: PlatformText, err: unknown): string {
  const a = t.ai;
  const code = codeOf(err);
  const details = detailsOf(err);
  const e = a.errors as Record<string, string>;
  if (code && Object.hasOwn(e, code)) {
    return fill(e[code], {
      model: String(details.model ?? ""),
      feature: (a.features as Record<string, string>)[String(details.feature ?? "")] ?? String(details.feature ?? ""),
      clients: String(Array.isArray(details.tenantIds) ? details.tenantIds.length : 0),
    });
  }
  const status = statusOf(err);
  return status === 404 ? t.notFound : status === 400 ? a.errors.invalid : a.errors.generic;
}

/**
 * Trustline's AI, for its staff: whether requests go to the fake provider,
 * the spending limit over every client, the connections to providers, and
 * each client's use this month, those over or near a limit first.
 */
export function AiOverview({ lang, t }: PlatformProps) {
  const a = t.ai;
  const money = usd(lang);
  const numbers = numberFormat(lang);
  const [settings, setSettings] = useState<PlatformAi | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [usage, setUsage] = useState<Usage[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  useLayoutEffect(
    () => () => {
      setMessage(null);
      setEditing(null);
    },
    [],
  );

  useEffect(() => {
    let current = true;
    Promise.all([
      platformApi<PlatformAi>("/ai/settings"),
      platformApi<Connection[]>("/ai/connections"),
      platformApi<Usage[]>("/ai/usage"),
    ]).then(
      ([s, c, u]) => {
        if (!current) return;
        setSettings(s);
        setConnections(c);
        setUsage(u);
        setProblem(null);
      },
      () => {
        if (current) setProblem(t.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [round, t]);

  async function saveLimit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get("limit") ?? "").trim();
    setBusy(true);
    setMessage(null);
    try {
      setSettings(
        await platformApi<PlatformAi>("/ai/settings", {
          method: "PUT",
          body: { monthlySpendingLimitUsd: raw === "" ? null : Math.round(Number(raw) * 100) / 100 },
        }),
      );
      setMessage({ ok: true, text: a.limitSaved });
    } catch (err) {
      setMessage({ ok: false, text: aiRefusal(t, err) });
    }
    setBusy(false);
  }

  async function test(c: Connection) {
    setTested((was) => ({ ...was, [c.id]: a.testing }));
    try {
      const r = await platformApi<{
        works: boolean | null;
        credentialsPresent: boolean;
        mode: string;
        fakeAnswers?: string | null;
      }>(
        `/ai/connections/${c.id}/test`,
        { method: "POST", body: {} },
      );
      const said = [
        r.mode === "fake" ? a.test.fake : r.works ? a.test.works : a.test.fails,
        r.mode === "fake" && r.fakeAnswers
          ? ((a.fakeAnswers as Record<string, string>)[r.fakeAnswers] ?? "")
          : "",
        r.credentialsPresent ? a.test.credentialPresent : a.test.credentialMissing,
      ]
        .filter(Boolean)
        .join(" ");
      setTested((was) => ({ ...was, [c.id]: said }));
    } catch (err) {
      setTested((was) => ({ ...was, [c.id]: aiRefusal(t, err) }));
    }
  }

  return (
    <>
      <PageHeader title={a.title} description={a.description} />
      {problem ? (
        <EmptyState>{problem}</EmptyState>
      ) : !settings || !connections || !usage ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {settings.mode === "fake" && (
            <div role="note" className="flex flex-col gap-1 rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm">
              <p className="font-medium">{a.fakeMode}</p>
              {settings.fakeAnswers && (
                <p>{(a.fakeAnswers as Record<string, string>)[settings.fakeAnswers] ?? settings.fakeAnswers}</p>
              )}
            </div>
          )}

          <Panel title={a.spending}>
            <form onSubmit={saveLimit} className="flex flex-col gap-4 p-4">
              <p className="text-sm">
                {fill(a.spent, { spent: money.format(settings.spentUsd), month: settings.month })}
              </p>
              <Field label={a.limit} help={a.limitHelp}>
                <input
                  name="limit"
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  dir="ltr"
                  defaultValue={settings.monthlySpendingLimitUsd ?? ""}
                  className={`${inputClass} max-w-40`}
                />
              </Field>
              {message && (
                <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>
                  {message.text}
                </p>
              )}
              <div>
                <Button type="submit" disabled={busy}>
                  {a.saveLimit}
                </Button>
              </div>
            </form>
          </Panel>

          <Panel title={a.connections}>
            <div className="flex flex-col gap-3 p-4">
              <p className="text-sm text-muted">{a.connectionsHelp}</p>
              {connections.length === 0 && <p className="text-sm text-muted">{a.noConnections}</p>}
              <ul className="flex flex-col gap-3">
                {connections.map((c) => (
                  <li key={c.id} className="flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        <bdi dir="auto">{c.name}</bdi>
                      </span>
                      <Pill tone={c.active ? "ok" : "neutral"}>{c.active ? a.active : a.inactive}</Pill>
                    </div>
                    <p className="text-muted">
                      {(a.kinds as Record<string, string>)[c.kind] ?? c.kind}
                      {" · "}
                      <bdi dir="ltr">{c.region}</bdi>
                      {" · "}
                      {(a.inferenceTypes as Record<string, string>)[c.inferenceType] ?? c.inferenceType}
                      {" · "}
                      {fill(a.clientsUsing, { count: numbers.format(c.clients) })}
                    </p>
                    <p className="text-muted">
                      {a.credential}{" "}
                      <code dir="ltr" className="text-xs">
                        {c.credentialEnv}
                      </code>{" "}
                      {c.credentialsPresent ? a.credentialSet : a.credentialNotSet}
                    </p>
                    <p className="text-xs text-muted">
                      {c.models.map((m) => m.label).join(", ")}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => void test(c)}>
                        {a.testConnection}
                      </Button>
                      <Button variant="secondary" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                        {a.edit}
                      </Button>
                    </div>
                    {tested[c.id] && (
                      <p role="status" className="text-sm">
                        {tested[c.id]}
                      </p>
                    )}
                    {editing === c.id && (
                      <ConnectionForm
                        lang={lang}
                        t={t}
                        connection={c}
                        onDone={() => {
                          setEditing(null);
                          setRound((n) => n + 1);
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
              {editing === "new" ? (
                <ConnectionForm
                  lang={lang}
                  t={t}
                  connection={null}
                  onDone={() => {
                    setEditing(null);
                    setRound((n) => n + 1);
                  }}
                />
              ) : (
                <div>
                  <Button onClick={() => setEditing("new")}>{a.addConnection}</Button>
                </div>
              )}
            </div>
          </Panel>

          <Panel title={a.usage}>
            {usage.length === 0 ? (
              <EmptyState>{a.noUsage}</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-line">
                      <th scope="col" className="px-4 py-2 text-start font-medium">{a.client}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{a.features.drafting}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{a.cost}</th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">{a.state}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.map((u) => {
                      const d = u.features.drafting;
                      return (
                        <tr key={u.tenantId} className="border-b border-line last:border-b-0">
                          <th scope="row" className="px-4 py-2 text-start font-normal">
                            <Link href={`/${lang}/platform/clients/${u.tenantId}`} className="text-accent hover:underline">
                              <bdi>{pick(u.name, lang, "en")}</bdi>
                            </Link>
                            <span className="block text-xs text-muted" dir="ltr">
                              {u.slug}
                            </span>
                          </th>
                          <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                            {!d || !d.configured
                              ? "—"
                              : d.allowance === null
                                ? numbers.format(d.used)
                                : fill(a.usedOf, { used: numbers.format(d.used), allowance: numbers.format(d.allowance) })}
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap tabular-nums">
                            {money.format(u.costUsd)}
                            {u.monthlySpendingLimitUsd !== null && (
                              <span className="block text-xs text-muted">
                                {fill(a.ofLimit, { limit: money.format(u.monthlySpendingLimitUsd) })}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex flex-wrap gap-1">
                              {u.over ? (
                                <Pill tone="danger">{a.over}</Pill>
                              ) : u.near ? (
                                <Pill tone="warn">{a.near}</Pill>
                              ) : null}
                              <Pill tone={u.enabled ? "ok" : "neutral"}>{u.enabled ? a.clientOn : a.clientOff}</Pill>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

/**
 * A connection to a provider. The credential is never typed here: only
 * the name of the server's environment variable that holds it.
 */
function ConnectionForm({
  t,
  connection: c,
  onDone,
}: PlatformProps & { connection: Connection | null; onDone: () => void }) {
  const a = t.ai;
  const [kind, setKind] = useState<string>(c?.kind ?? "bedrock");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Models, one per line: id | label | input $ per million tokens | output $.
  const modelsText = (c?.models ?? [])
    .map((m) => [m.id, m.label, m.inputUsdPerMTok, m.outputUsdPerMTok].join(" | "))
    .join("\n");

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await platformApi(c ? `/ai/connections/${c.id}` : "/ai/connections", {
        method: c ? "PATCH" : "POST",
        body,
      });
      onDone();
      return;
    } catch (err) {
      setError(aiRefusal(t, err));
    }
    setBusy(false);
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const models = String(data.get("models") ?? "")
      .split("\n")
      .map((l) => l.split("|").map((x) => x.trim()))
      .filter((p) => p[0])
      .map(([id, label, input, output]) => ({
        id,
        label: label || id,
        inputUsdPerMTok: Number(input ?? 0),
        outputUsdPerMTok: Number(output ?? 0),
      }));
    void send({
      name: String(data.get("name") ?? "").trim(),
      ...(c ? {} : { kind }),
      region: String(data.get("region") ?? "").trim(),
      inferenceType: String(data.get("inferenceType")),
      models,
      credentialEnv: String(data.get("credentialEnv") ?? "").trim(),
      active: data.get("active") === "on",
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4 rounded-md border border-line bg-surface p-3">
      <p className="text-sm font-medium">{c ? a.editConnection : a.addConnection}</p>
      <Field label={a.name}>
        <input name="name" required maxLength={100} defaultValue={c?.name ?? ""} dir="auto" className={inputClass} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={a.kind} help={c ? a.kindFixed : undefined}>
          <select value={kind} disabled={!!c} onChange={(e) => setKind(e.target.value)} className={inputClass}>
            {(["bedrock", "anthropic"] as const).map((x) => (
              <option key={x} value={x}>
                {a.kinds[x]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={a.inference}>
          <select name="inferenceType" defaultValue={c?.inferenceType ?? "global"} className={inputClass}>
            {(["in_region", "regional", "global"] as const).map((x) => (
              <option key={x} value={x}>
                {a.inferenceTypes[x]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={a.region} help={kind === "bedrock" ? a.regionBedrock : a.regionAnthropic}>
          <input name="region" required maxLength={40} defaultValue={c?.region ?? ""} dir="ltr" className={inputClass} />
        </Field>
        <Field
          label={a.credentialEnvLabel}
          help={fill(a.credentialEnvHelp, {
            prefix: kind === "bedrock" ? "AI_CREDENTIAL_BEDROCK_" : "AI_CREDENTIAL_ANTHROPIC_",
          })}
        >
          <input
            name="credentialEnv"
            required
            maxLength={100}
            pattern="AI_CREDENTIAL_[A-Z0-9_]+"
            autoComplete="off"
            spellCheck={false}
            defaultValue={c?.credentialEnv ?? ""}
            dir="ltr"
            className={inputClass}
          />
        </Field>
      </div>
      <Field label={a.models} help={a.modelsHelp}>
        <textarea name="models" required rows={3} defaultValue={modelsText} dir="ltr" className={`${inputClass} h-auto py-2 font-mono text-xs`} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={c ? c.active : true} className="size-4" />
        {a.activeLabel}
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {a.save}
        </Button>
        {c?.active && (
          <Button variant="secondary" disabled={busy} onClick={() => void send({ active: false })}>
            {a.deactivate}
          </Button>
        )}
        <Button variant="secondary" disabled={busy} onClick={onDone}>
          {a.cancel}
        </Button>
      </div>
    </form>
  );
}
