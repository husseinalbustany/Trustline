"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { UsageMeter } from "@/components/ui/usage-meter";
import { moduleRules, type ModuleCode } from "@/config/modules";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, statusOf } from "@/lib/api";
import { dayFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { useSession } from "@/components/shell/session";
import type { AdminProps } from "./types";

type Limit = { max: number | null; used: number | null };

/** What `GET /settings/subscription` answers. No price and no note. */
type Subscription = {
  plan: { code: string; name: Localized };
  status: "trial" | "active" | "past_due" | "suspended";
  startsOn: string;
  renewsOn: string | null;
  trialEndsOn: string | null;
  modules: {
    code: ModuleCode;
    enabled: boolean;
    from: "plan" | "add_on" | null;
  }[];
  limits: Record<"users" | "sites" | "storageMb" | "aiCreditsPerMonth", Limit>;
};

export const subscriptionTone = {
  trial: "neutral",
  active: "ok",
  past_due: "warn",
  suspended: "warn",
} as const;

/**
 * The organization's subscription, for its administrators: the plan, its
 * state and dates, each module on or off, and each limit with what is used.
 * It is read here and changed only by Trustline.
 */
export function SubscriptionPanel({
  lang,
  t,
  moduleNames,
}: AdminProps & { moduleNames: Dictionary["moduleNames"] }) {
  const session = useSession();
  const [loaded, setLoaded] = useState<Subscription | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const s = t.settings;
  const w = s.subscription;

  useEffect(() => {
    let current = true;
    api<Subscription>("/settings/subscription")
      .then((answer) => {
        if (!current) return;
        setLoaded(answer);
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
  }, [s, t]);

  if (problem || !loaded) {
    return (
      <Panel title={w.title}>
        <EmptyState>{problem ?? t.loading}</EmptyState>
      </Panel>
    );
  }

  const day = dayFormat(lang);
  const dates = [
    { label: w.startsOn, value: day(loaded.startsOn) },
    { label: w.trialEndsOn, value: day(loaded.trialEndsOn) },
    { label: w.renewsOn, value: day(loaded.renewsOn) },
  ].filter((d) => d.value);
  const { users, sites } = loaded.limits;

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">{w.title}</h2>
        <Pill tone={subscriptionTone[loaded.status]}>
          {w.status[loaded.status]}
        </Pill>
      </div>
      <div className="flex flex-col gap-5 p-4">
        <p className="text-sm text-muted">{w.intro}</p>

        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">{w.plan}</dt>
            <dd className="font-medium">
              <bdi>
                {pick(loaded.plan.name, lang, session.tenant.defaultLocale)}
              </bdi>
            </dd>
          </div>
          {dates.map((d) => (
            <div key={d.label}>
              <dt className="text-muted">{d.label}</dt>
              <dd className="tabular-nums">{d.value}</dd>
            </div>
          ))}
        </dl>

        <section className="flex flex-col gap-2 border-t border-line pt-4">
          <h3 className="text-sm font-medium">{w.modules}</h3>
          <ul className="divide-y divide-line rounded-md border border-line">
            {loaded.modules.map((m) => (
              <li
                key={m.code}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className={m.enabled ? "" : "text-muted"}>
                    {moduleNames[m.code] ?? m.code}
                  </span>
                  {m.enabled && !moduleRules[m.code]?.built && (
                    <Badge>{w.comingLater}</Badge>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  {m.from && (
                    <span className="text-xs text-muted">
                      {m.from === "add_on" ? w.fromAddOn : w.fromPlan}
                    </span>
                  )}
                  <Pill tone={m.enabled ? "ok" : "neutral"}>
                    {m.enabled ? w.on : w.off}
                  </Pill>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-4 border-t border-line pt-4">
          <h3 className="text-sm font-medium">{w.limits}</h3>
          <UsageMeter
            lang={lang}
            label={w.users}
            help={w.usersHelp}
            used={users.used ?? 0}
            max={users.max}
            t={w.meter}
          />
          <UsageMeter
            lang={lang}
            label={w.sites}
            help={w.sitesHelp}
            used={sites.used ?? 0}
            max={sites.max}
            t={w.meter}
          />
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {[w.storage, w.ai].map((label) => (
              <div key={label}>
                <dt className="font-medium">{label}</dt>
                <dd className="text-muted">{w.notInUse}</dd>
              </div>
            ))}
          </dl>
        </section>

        <p className="border-t border-line pt-4 text-sm text-muted">
          {w.change}
        </p>
      </div>
    </Panel>
  );
}
