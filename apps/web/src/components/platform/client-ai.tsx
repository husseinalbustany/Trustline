"use client";

import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { statusOf } from "@/lib/api";
import { fill, numberFormat } from "@/lib/format";
import { platformApi } from "@/lib/platform-api";
import { aiFeatures, type AiFeature } from "@/lib/ai";
import { aiRefusal, usd, type Connection } from "./ai-overview";
import type { PlatformProps } from "./types";

type FeatureSetting = {
  connection: { id: string; name: string; kind: string; region: string; inferenceType: string; active: boolean };
  model: string;
  quickModel: string | null;
} | null;

type ClientAiSettings = {
  tenantId: string;
  offered: boolean;
  features: Record<AiFeature, FeatureSetting>;
  planAllowances: Record<AiFeature, number | null>;
  allowanceOverrides: Partial<Record<AiFeature, number | null>>;
  allowances: Record<AiFeature, number | null>;
  medicalOptionAllowed: boolean;
  monthlySpendingLimitUsd: number | null;
  clientEnabled: boolean;
  clientSwitchedAt: string | null;
  month: string;
  usage: Record<AiFeature, { used: number; requests: number; costUsd: number }>;
  costUsd: number;
};

/**
 * A client's AI, for Trustline staff: whether it is offered, which
 * connection and model answer each feature, allowances beyond the plan's,
 * the medical option, and a spending limit, with this month's use.
 */
export function ClientAi({ lang, t, tenantId }: PlatformProps & { tenantId: string }) {
  const a = t.ai;
  const money = usd(lang);
  const numbers = numberFormat(lang);
  const [settings, setSettings] = useState<ClientAiSettings | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  useLayoutEffect(() => () => setMessage(null), []);

  useEffect(() => {
    let current = true;
    Promise.all([
      platformApi<ClientAiSettings>(`/tenants/${tenantId}/ai`),
      platformApi<Connection[]>("/ai/connections"),
    ]).then(
      ([s, c]) => {
        if (!current) return;
        setSettings(s);
        setConnections(c);
        setChosen(Object.fromEntries(aiFeatures.map((f) => [f, s.features[f]?.connection.id ?? ""])));
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 404 ? t.notFound : t.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [tenantId, t]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!settings) return;
    const data = new FormData(e.currentTarget);
    const features: Record<string, unknown> = {};
    const overrides: Record<string, number | null> = {};
    for (const f of aiFeatures) {
      const connectionId = String(data.get(`${f}.connection`) ?? "");
      features[f] = connectionId
        ? {
            connectionId,
            model: String(data.get(`${f}.model`) ?? ""),
            quickModel: String(data.get(`${f}.quickModel`) ?? "") || null,
          }
        : null;
      const allowance = String(data.get(`${f}.allowance`) ?? "");
      if (allowance === "plan") continue;
      overrides[f] = allowance === "none" ? null : Number(data.get(`${f}.allowanceValue`) ?? 0);
    }
    const limit = String(data.get("limit") ?? "").trim();
    setBusy(true);
    setMessage(null);
    try {
      setSettings(
        await platformApi<ClientAiSettings>(`/tenants/${tenantId}/ai`, {
          method: "PATCH",
          body: {
            offered: data.get("offered") === "on",
            features,
            allowanceOverrides: overrides,
            medicalOptionAllowed: data.get("medical") === "on",
            monthlySpendingLimitUsd: limit === "" ? null : Math.round(Number(limit) * 100) / 100,
          },
        }),
      );
      setMessage({ ok: true, text: a.clientSaved });
    } catch (err) {
      setMessage({ ok: false, text: aiRefusal(t, err) });
    }
    setBusy(false);
  }

  if (problem) {
    return (
      <Panel title={a.clientTitle}>
        <EmptyState>{problem}</EmptyState>
      </Panel>
    );
  }
  if (!settings) {
    return (
      <Panel title={a.clientTitle}>
        <EmptyState>{t.loading}</EmptyState>
      </Panel>
    );
  }
  const plan = (n: number | null) => (n === null ? a.noLimit : numbers.format(n));

  return (
    <Panel title={a.clientTitle}>
      <form onSubmit={save} className="flex flex-col gap-5 p-4">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Pill tone={settings.clientEnabled ? "ok" : "neutral"}>
            {settings.clientEnabled ? a.clientOn : a.clientOff}
          </Pill>
          <span className="text-muted">
            {fill(a.clientCost, { cost: money.format(settings.costUsd), month: settings.month })}
          </span>
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="offered" defaultChecked={settings.offered} className="size-4" />
          {a.offered}
        </label>
        {aiFeatures.map((f) => {
          const current = settings.features[f];
          const connection = connections.find((c) => c.id === chosen[f]);
          const override = settings.allowanceOverrides[f];
          const u = settings.usage[f];
          return (
            <fieldset key={f} className="flex flex-col gap-3 rounded-md border border-line p-3">
              <legend className="px-1 text-sm font-medium">{a.features[f]}</legend>
              <Field label={a.connection}>
                <select
                  name={`${f}.connection`}
                  value={chosen[f] ?? ""}
                  onChange={(e) => setChosen({ ...chosen, [f]: e.target.value })}
                  className={inputClass}
                >
                  <option value="">{a.notOfferedFeature}</option>
                  {connections
                    .filter((c) => c.active || c.id === current?.connection.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </Field>
              {connection && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={a.model}>
                    <select name={`${f}.model`} defaultValue={current?.model ?? connection.models[0]?.id} className={inputClass}>
                      {connection.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={a.quickModel} help={a.quickModelHelp}>
                    <select name={`${f}.quickModel`} defaultValue={current?.quickModel ?? ""} className={inputClass}>
                      <option value="">{a.sameModel}</option>
                      {connection.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={a.allowance} help={fill(a.planAllowance, { value: plan(settings.planAllowances[f]) })}>
                  <select
                    name={`${f}.allowance`}
                    defaultValue={override === undefined ? "plan" : override === null ? "none" : "set"}
                    className={inputClass}
                  >
                    <option value="plan">{a.followPlan}</option>
                    <option value="set">{a.setAllowance}</option>
                    <option value="none">{a.noLimit}</option>
                  </select>
                </Field>
                <Field label={a.allowanceValue}>
                  <input
                    name={`${f}.allowanceValue`}
                    type="number"
                    min={0}
                    dir="ltr"
                    defaultValue={typeof override === "number" ? override : ""}
                    className={`${inputClass} max-w-32`}
                  />
                </Field>
              </div>
              <p className="text-xs text-muted">
                {fill(a.featureUse, {
                  used: numbers.format(u?.used ?? 0),
                  allowance: plan(settings.allowances[f]),
                  requests: numbers.format(u?.requests ?? 0),
                  cost: money.format(u?.costUsd ?? 0),
                })}
              </p>
            </fieldset>
          );
        })}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="medical" defaultChecked={settings.medicalOptionAllowed} className="size-4" />
          {a.medical}
        </label>
        <Field label={a.clientLimit} help={a.clientLimitHelp}>
          <input
            name="limit"
            type="number"
            min={0}
            step="0.01"
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
            {a.save}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
