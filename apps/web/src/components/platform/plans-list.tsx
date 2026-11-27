"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { fill, numberFormat } from "@/lib/format";
import { pick } from "@/lib/localized";
import {
  limitKeys,
  platformApi,
  type Limits,
  type Plan,
} from "@/lib/platform-api";
import { moduleList, type ModuleNames } from "./module-words";
import type { PlatformProps } from "./types";

/** A plan's limits in one line: "Users 100 · Sites 1 · …". */
export function limitsLine(
  lang: string,
  limits: Limits,
  words: { limitNames: Record<string, string>; unlimited: string },
) {
  const numbers = numberFormat(lang);
  return limitKeys
    .map(
      (key) =>
        `${words.limitNames[key]} ${
          limits[key] === null ? words.unlimited : numbers.format(limits[key])
        }`,
    )
    .join(" · ");
}

/** The plans Trustline offers, retired ones included, in their order. */
export function PlansList({
  lang,
  t,
  moduleNames,
}: PlatformProps & { moduleNames: ModuleNames }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failed, setFailed] = useState(false);
  const p = t.plans;
  const numbers = numberFormat(lang);

  useEffect(() => {
    let current = true;
    platformApi<Plan[]>("/plans")
      .then((list) => {
        if (!current) return;
        setPlans(list);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      <PageHeader
        title={p.title}
        description={p.description}
        actions={
          <ButtonLink href={`/${lang}/platform/plans/new`}>
            <Plus className="size-4" aria-hidden />
            {p.add}
          </ButtonLink>
        }
      />
      <div className="mt-6">
        <Panel>
          {failed ? (
            <EmptyState>{p.loadError}</EmptyState>
          ) : !plans ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : plans.length === 0 ? (
            <EmptyState>{p.empty}</EmptyState>
          ) : (
            <ul aria-label={p.title}>
              {plans.map((plan) => (
                <li
                  key={plan.id}
                  className="flex flex-col gap-1.5 border-b border-line px-4 py-3 last:border-0"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link
                      href={`/${lang}/platform/plans/${plan.id}`}
                      className={`font-medium hover:text-accent hover:underline ${plan.active ? "" : "text-muted"}`}
                    >
                      <bdi>{pick(plan.name, lang)}</bdi>
                    </Link>
                    <bdi dir="ltr" className="font-mono text-xs text-muted">
                      {plan.code}
                    </bdi>
                    <Pill tone={plan.active ? "ok" : "neutral"}>
                      {plan.active ? p.active : p.retired}
                    </Pill>
                    <span className="ms-auto text-sm text-muted tabular-nums">
                      {fill(p.subscribers, {
                        count: numbers.format(plan.subscribers),
                      })}
                    </span>
                  </div>
                  <p className="text-sm">
                    <span className="text-muted">{p.modules} </span>
                    {plan.modules.length === 0
                      ? p.coreOnly
                      : moduleList(lang, moduleNames, plan.modules)}
                  </p>
                  <p className="text-xs text-muted tabular-nums">
                    {limitsLine(lang, plan.limits, p)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
