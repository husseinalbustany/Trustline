"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { SettingsTabs } from "@/components/admin/settings-tabs";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, codeOf, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, numberFormat } from "@/lib/format";
import { pick } from "@/lib/localized";
import type { AiFeatureState, AiProvider, AiSettings } from "@/lib/ai";
import { AiMark } from "./ai-mark";

export type AiText = Dictionary["ai"];

/** Who processes the requests, and where, in a sentence. */
export function useProviderWords(t: AiText) {
  return (p: AiProvider) => {
    const regions = t.regions as Record<string, string>;
    const region = regions[p.region] ?? p.region;
    const where = (t.inference as Record<string, string>)[p.inferenceType];
    return fill(t.providerLine, {
      provider: (t.providers as Record<string, string>)[p.kind] ?? p.kind,
      where: where ? fill(where, { region }) : region,
    });
  };
}

/**
 * The organization's use of AI: what Trustline offers it, who processes the
 * requests and where, its own switch, and this month's use against each
 * allowance. Whole-organization administrators see all of it and switch it;
 * everyone else sees what is offered and whether it is on.
 */
export function AiSettingsView({
  lang,
  t,
  tabs,
}: {
  lang: string;
  t: AiText;
  tabs: Dictionary["admin"]["settings"]["tabs"];
}) {
  const session = useSession();
  const full = session.scope?.["settings.manage"] === "all";
  const moduleOn = hasModule(session, "ai_assistant");
  // While suspended, AI can only be switched off.
  const suspended = session.tenant.subscription?.status === "suspended";
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useLayoutEffect(
    () => () => {
      setMessage(null);
      setConfirming(false);
    },
    [],
  );
  const provider = useProviderWords(t);
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);

  useEffect(() => {
    if (!moduleOn) return;
    let current = true;
    api<AiSettings>("/ai/settings").then(
      (s) => {
        if (current) setSettings(s);
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 404 ? t.notIncluded : t.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [moduleOn, t]);

  async function switchTo(enabled: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      setSettings(await api<AiSettings>("/ai/settings", { method: "PUT", body: { enabled } }));
      setConfirming(false);
      setMessage({ ok: true, text: enabled ? t.switch.nowOn : t.switch.nowOff });
    } catch (err) {
      const code = codeOf(err);
      setMessage({
        ok: false,
        text:
          code === "ai_not_offered"
            ? t.errors.ai_not_offered
            : code === "subscription_suspended"
              ? t.switch.suspended
              : statusOf(err) === 403
                ? t.noAccess
                : t.error,
      });
    }
    setBusy(false);
  }

  const featureNames = t.features as Record<string, string>;
  const units = t.units as Record<string, string>;
  const reasons = t.reasons as Record<string, string>;

  const usage = (f: AiFeatureState) => {
    if (f.used === undefined) return null;
    const of =
      f.allowance === null
        ? fill(t.usage.noLimit, { used: numbers.format(f.used), unit: units[f.feature] ?? "" })
        : fill(t.usage.of, {
            used: numbers.format(f.used),
            allowance: numbers.format(f.allowance ?? 0),
            unit: units[f.feature] ?? "",
          });
    const share =
      f.allowance && f.allowance > 0 ? Math.min(100, Math.round((100 * f.used) / f.allowance)) : null;
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm">{of}</p>
        {share !== null && (
          <div
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share}
            aria-label={of}
            className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-surface"
          >
            <div
              className={`h-full ${f.reached ? "bg-danger" : f.warning ? "bg-warn" : "bg-accent"}`}
              style={{ width: `${share}%` }}
            />
          </div>
        )}
        {f.reached ? (
          <p className="text-sm text-danger">{fill(t.usage.reached, { date: day(settings?.resetsOn) ?? "" })}</p>
        ) : f.warning ? (
          <p className="text-sm text-warn">{t.usage.warning}</p>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <PageHeader title={t.title} description={t.intro} />
      <SettingsTabs lang={lang} t={tabs} current="ai" />
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        {!moduleOn ? (
          <Panel>
            <EmptyState>{t.notIncluded}</EmptyState>
          </Panel>
        ) : problem ? (
          <Panel>
            <EmptyState>{problem}</EmptyState>
          </Panel>
        ) : !settings ? (
          <Panel>
            <EmptyState>{t.loading}</EmptyState>
          </Panel>
        ) : (
          <>
            <Panel title={t.switch.title}>
              <div className="flex flex-col gap-3 p-4 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <Pill tone={settings.enabled ? "ok" : "neutral"}>
                    {settings.enabled ? t.switch.isOn : t.switch.isOff}
                  </Pill>
                  {!settings.available && <span className="text-muted">{t.notAvailable}</span>}
                </p>
                <p className="text-muted">{t.switch.help}</p>
                {settings.switchedAt && (
                  <p className="text-xs text-muted">
                    {fill(t.switch.lastChanged, {
                      name:
                        pick(settings.switchedBy?.name, lang, session.tenant.defaultLocale) || t.formerUser,
                      time: moment.format(new Date(settings.switchedAt)),
                    })}
                  </p>
                )}
                {full && (
                  <>
                    {suspended && <p className="text-muted">{t.switch.suspendedNote}</p>}
                    {settings.enabled ? (
                      <div>
                        <Button variant="secondary" disabled={busy} onClick={() => void switchTo(false)}>
                          {t.switch.off}
                        </Button>
                      </div>
                    ) : confirming ? (
                      <div role="alert" className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3">
                        <p>{t.switch.confirmOn}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button disabled={busy} onClick={() => void switchTo(true)}>
                            {t.switch.on}
                          </Button>
                          <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                            {t.cancel}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <Button disabled={busy || !settings.available || suspended} onClick={() => setConfirming(true)}>
                          {t.switch.on}
                        </Button>
                      </div>
                    )}
                    {message && (
                      <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-accent" : "text-danger"}>
                        {message.text}
                      </p>
                    )}
                  </>
                )}
              </div>
            </Panel>

            <Panel title={t.featuresTitle}>
              <ul>
                {settings.features.map((f) => (
                  <li key={f.feature} className="flex flex-col gap-2 border-b border-line px-4 py-3 text-sm last:border-b-0">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{featureNames[f.feature] ?? f.feature}</span>
                      <Pill tone={f.active ? "ok" : "neutral"}>
                        {f.active ? t.state.active : f.offered ? t.state.offered : t.state.notOffered}
                      </Pill>
                    </div>
                    {f.provider ? (
                      <p className="text-muted">{provider(f.provider)}</p>
                    ) : (
                      f.reason && <p className="text-muted">{reasons[f.reason] ?? t.state.notOffered}</p>
                    )}
                    {full && f.model && (
                      <p className="text-xs text-muted">
                        {fill(t.model, { model: f.model })}
                      </p>
                    )}
                    {full && f.offered && usage(f)}
                  </li>
                ))}
              </ul>
              {full && settings.month && (
                <p className="border-t border-line px-4 py-2 text-xs text-muted">
                  {fill(t.usage.month, { date: day(settings.resetsOn) ?? "" })}
                </p>
              )}
            </Panel>

            {full && (
              <Panel title={t.medicalOption.title}>
                <p className="p-4 text-sm">
                  {settings.medicalOptionAllowed ? t.medicalOption.allowed : t.medicalOption.notAllowed}
                </p>
              </Panel>
            )}

            <Panel title={t.howTitle}>
              <div className="flex flex-col gap-2 p-4 text-sm text-muted">
                <AiMark>{t.markExample}</AiMark>
                <p>{t.how1}</p>
                <p>{t.how2}</p>
                <p>{t.how3}</p>
              </div>
            </Panel>
          </>
        )}
      </div>
    </>
  );
}
