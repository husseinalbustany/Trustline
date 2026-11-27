"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { UsageMeter } from "@/components/ui/usage-meter";
import { moduleCodes, moduleRules, type ModuleCode } from "@/config/modules";
import { codeOf, statusOf } from "@/lib/api";
import { dayFormat, fill, numberFormat } from "@/lib/format";
import { pick } from "@/lib/localized";
import {
  limitKeys,
  platformApi,
  subscriptionStatuses,
  type LimitKey,
  type Limits,
  type Plan,
  type SubscriptionStatus,
  type TenantSubscription,
} from "@/lib/platform-api";
import { dependencyRefusal, needsText, type ModuleNames } from "./module-words";
import type { PlatformProps } from "./types";

type Message = { kind: "ok" | "error"; text: string };

/** One limit as set here: the plan's, a figure of the client's own, or none. */
type Override = { mode: "plan" | "own" | "unlimited"; value: string };

type Draft = {
  planId: string;
  status: SubscriptionStatus;
  startsOn: string;
  renewsOn: string;
  trialEndsOn: string;
  addOns: ModuleCode[];
  overrides: Record<LimitKey, Override>;
  note: string;
};

const draftOf = (s: TenantSubscription): Draft => ({
  planId: s.plan.id,
  status: s.status,
  startsOn: s.startsOn,
  renewsOn: s.renewsOn ?? "",
  trialEndsOn: s.trialEndsOn ?? "",
  addOns: s.addOnModules,
  overrides: Object.fromEntries(
    limitKeys.map((key) => {
      const has = Object.hasOwn(s.limitOverrides, key);
      const value = s.limitOverrides[key];
      return [
        key,
        !has
          ? { mode: "plan", value: "" }
          : value === null || value === undefined
            ? { mode: "unlimited", value: "" }
            : { mode: "own", value: String(value) },
      ];
    }),
  ) as Record<LimitKey, Override>,
  note: s.note ?? "",
});

export const statusTone = {
  trial: "neutral",
  active: "ok",
  past_due: "warn",
  suspended: "warn",
  cancelled: "danger",
} as const;

/**
 * A client's subscription, for Trustline staff: the plan, its state and
 * dates, the modules added on top of the plan, the limits that differ from
 * it and a note; with what that makes and what is used now.
 */
export function ClientSubscription({
  lang,
  t,
  moduleNames,
  tenantId,
  clientName,
  onChanged,
}: PlatformProps & {
  moduleNames: ModuleNames;
  tenantId: string;
  clientName: string;
  /** After a change: the client's page reads its activity again. */
  onChanged: () => void;
}) {
  const [stored, setStoredState] = useState<TenantSubscription | null>(null);
  // The same, for putting the form back when the page is hidden.
  const storedRef = useRef<TenantSubscription | null>(null);
  const setStored = (s: TenantSubscription) => {
    storedRef.current = s;
    setStoredState(s);
  };
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirming, setConfirming] = useState<SubscriptionStatus | null>(null);
  const w = t.subscription;
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);

  useEffect(() => {
    let current = true;
    Promise.all([
      platformApi<TenantSubscription>(`/tenants/${tenantId}/subscription`),
      platformApi<Plan[]>("/plans"),
    ])
      .then(([subscription, list]) => {
        if (!current) return;
        storedRef.current = subscription;
        setStoredState(subscription);
        setDraft(draftOf(subscription));
        setPlans(list);
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 404 ? w.notFound : w.loadError),
      );
    return () => {
      current = false;
    };
  }, [tenantId, w]);

  // Visited pages stay mounted: a note about the last save, or a question
  // waiting for an answer, must not be there when the page is shown again;
  // nor what was changed and not saved.
  useLayoutEffect(
    () => () => {
      setMessage(null);
      setConfirming(null);
      if (storedRef.current) setDraft(draftOf(storedRef.current));
    },
    [],
  );

  if (problem || !stored || !plans || !draft) {
    return (
      <Panel title={w.title}>
        <EmptyState>{problem ?? t.loading}</EmptyState>
      </Panel>
    );
  }

  const set = (next: Partial<Draft>) => {
    setDraft({ ...draft, ...next });
    setConfirming(null);
  };
  const plan = plans.find((p) => p.id === draft.planId);
  const planModules = plan?.modules ?? [];
  const planLimits: Limits | undefined = plan?.limits;
  const name = (p: { name: Plan["name"] }) => pick(p.name, lang);
  const limitText = (value: number | null | undefined) =>
    value === null || value === undefined
      ? t.plans.unlimited
      : numbers.format(value);

  const explain = (err: unknown) => {
    const dependency = dependencyRefusal(
      err,
      lang,
      moduleNames,
      t.plans.form.errors,
    );
    if (dependency) return dependency;
    const code = codeOf(err);
    if (code && Object.hasOwn(w.errors, code)) {
      return w.errors[code as keyof typeof w.errors];
    }
    const status = statusOf(err);
    if (status === 404) return w.notFound;
    return status === 400 ? w.errors.invalid : w.errors.generic;
  };

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft || !stored) return;
    // Suspending and cancelling ask once, with what they do.
    const grave = draft.status === "suspended" || draft.status === "cancelled";
    if (
      grave &&
      draft.status !== stored.status &&
      confirming !== draft.status
    ) {
      setMessage(null);
      setConfirming(draft.status);
      return;
    }
    setConfirming(null);
    setBusy(true);
    setMessage(null);
    try {
      const saved = await platformApi<TenantSubscription>(
        `/tenants/${tenantId}/subscription`,
        {
          method: "PATCH",
          body: {
            planId: draft.planId,
            status: draft.status,
            startsOn: draft.startsOn,
            renewsOn: draft.renewsOn || null,
            trialEndsOn: draft.trialEndsOn || null,
            // Only modules the plan does not already hold.
            addOnModules: draft.addOns.filter((m) => !planModules.includes(m)),
            limitOverrides: Object.fromEntries(
              limitKeys
                .filter((key) => draft.overrides[key].mode !== "plan")
                .map((key) => [
                  key,
                  draft.overrides[key].mode === "unlimited"
                    ? null
                    : Number(draft.overrides[key].value),
                ]),
            ),
            note: draft.note.trim() || null,
          },
        },
      );
      setStored(saved);
      setDraft(draftOf(saved));
      setMessage({ kind: "ok", text: w.saved });
      onChanged();
    } catch (err) {
      setMessage({ kind: "error", text: explain(err) });
    }
    setBusy(false);
  }

  // The plan it is on stays in the list when it has been retired since; no
  // other retired plan can be chosen.
  const choices = plans.filter((p) => p.active || p.id === stored.plan.id);
  const legend = "mb-1 text-sm font-medium";
  const { effective, usage } = stored;

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">{w.title}</h2>
        <Pill tone={statusTone[stored.status]}>
          {w.statuses[stored.status]}
        </Pill>
      </div>

      {/* What the plan and what was agreed make, as the client has it now. */}
      <section className="flex flex-col gap-3 border-b border-line p-4">
        <h3 className="text-sm font-medium">{w.effective}</h3>
        <p className="text-sm">
          {fill(w.currentPlan, { name: name(stored.plan) })}
          {!stored.plan.active && (
            <span className="ms-2 inline-block align-middle">
              <Badge>{t.plans.retired}</Badge>
            </span>
          )}
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {moduleCodes.map((m) => {
            const on = effective.modules.includes(m);
            return (
              <li key={m}>
                <Pill tone={on ? "ok" : "neutral"}>
                  {fill(on ? w.moduleOn : w.moduleOff, {
                    module: moduleNames[m],
                  })}
                </Pill>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-col gap-3">
          <UsageMeter
            lang={lang}
            label={t.plans.limitNames.users}
            used={usage?.users ?? 0}
            max={effective.limits.users}
            t={w.meter}
          />
          <UsageMeter
            lang={lang}
            label={t.plans.limitNames.sites}
            used={usage?.sites ?? 0}
            max={effective.limits.sites}
            t={w.meter}
          />
          <p className="text-xs text-muted tabular-nums">
            {t.plans.limitNames.storageMb}{" "}
            {limitText(effective.limits.storageMb)}
            {" · "}
            {t.plans.limitNames.aiCreditsPerMonth}{" "}
            {limitText(effective.limits.aiCreditsPerMonth)}
            {" · "}
            {w.notCounted}
          </p>
        </div>
        <p className="text-xs text-muted">
          {fill(w.since, { date: day(stored.startsOn) ?? stored.startsOn })}
        </p>
      </section>

      <form onSubmit={save} className="flex flex-col gap-5 p-4">
        <Field label={w.plan} help={w.planHelp}>
          <select
            value={draft.planId}
            onChange={(e) => set({ planId: e.target.value })}
            className={inputClass}
          >
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.active
                  ? `⁨${name(p)}⁩`
                  : fill(w.planRetired, { name: name(p) })}
              </option>
            ))}
          </select>
        </Field>

        <Field label={w.status} help={w.statusHelp[draft.status]}>
          <select
            value={draft.status}
            onChange={(e) =>
              set({ status: e.target.value as SubscriptionStatus })
            }
            className={inputClass}
          >
            {subscriptionStatuses.map((status) => (
              <option key={status} value={status}>
                {w.statuses[status]}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={w.startsOn}>
            <input
              type="date"
              required
              dir="ltr"
              value={draft.startsOn}
              onChange={(e) => set({ startsOn: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label={w.renewsOn} help={w.optionalDate}>
            <input
              type="date"
              dir="ltr"
              min={draft.startsOn}
              value={draft.renewsOn}
              onChange={(e) => set({ renewsOn: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field
            label={w.trialEndsOn}
            help={
              draft.status === "trial" ? w.trialEndsRequired : w.optionalDate
            }
          >
            <input
              type="date"
              dir="ltr"
              min={draft.startsOn}
              required={draft.status === "trial"}
              value={draft.trialEndsOn}
              onChange={(e) => set({ trialEndsOn: e.target.value })}
              className={inputClass}
            />
          </Field>
        </div>
        <p className="-mt-2 text-xs text-muted">{w.datesHelp}</p>

        <fieldset className="flex flex-col gap-2">
          <legend className={legend}>{w.addOns}</legend>
          <p className="text-xs text-muted">{w.addOnsHelp}</p>
          {moduleCodes.map((module) => {
            const inPlan = planModules.includes(module);
            const needs = needsText(lang, moduleNames, t.plans.form, module);
            return (
              <label
                key={module}
                className="flex min-h-11 items-start gap-3 rounded-md border border-line px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1 accent-accent"
                  checked={inPlan || draft.addOns.includes(module)}
                  disabled={inPlan}
                  onChange={(e) =>
                    set({
                      addOns: moduleCodes.filter((m) =>
                        m === module
                          ? e.target.checked
                          : draft.addOns.includes(m),
                      ),
                    })
                  }
                />
                <span className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {moduleNames[module]}
                    {inPlan && <Badge>{w.inPlan}</Badge>}
                    {!moduleRules[module].built && (
                      <Badge>{t.plans.form.notBuilt}</Badge>
                    )}
                  </span>
                  {needs && <span className="text-xs text-muted">{needs}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className={legend}>{w.overrides}</legend>
          <p className="text-xs text-muted">{w.overridesHelp}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {limitKeys.map((key) => {
              const o = draft.overrides[key];
              const setOverride = (next: Partial<Override>) =>
                set({
                  overrides: { ...draft.overrides, [key]: { ...o, ...next } },
                });
              return (
                <div key={key} className="flex flex-col gap-2">
                  <Field label={t.plans.limitNames[key]}>
                    <select
                      value={o.mode}
                      onChange={(e) =>
                        setOverride({
                          mode: e.target.value as Override["mode"],
                        })
                      }
                      className={inputClass}
                    >
                      <option value="plan">
                        {fill(w.usePlan, {
                          value: limitText(planLimits?.[key]),
                        })}
                      </option>
                      <option value="own">{w.ownLimit}</option>
                      <option value="unlimited">{t.plans.unlimited}</option>
                    </select>
                  </Field>
                  {o.mode === "own" && (
                    <input
                      aria-label={fill(w.ownLimitOf, {
                        limit: t.plans.limitNames[key],
                      })}
                      type="number"
                      inputMode="numeric"
                      required
                      min={0}
                      max={1_000_000_000}
                      step={1}
                      dir="ltr"
                      value={o.value}
                      onChange={(e) => setOverride({ value: e.target.value })}
                      className={`${inputClass} tabular-nums`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <Field label={w.note} help={w.noteHelp}>
          <textarea
            rows={3}
            maxLength={2000}
            dir="auto"
            value={draft.note}
            onChange={(e) => set({ note: e.target.value })}
            className="w-full rounded-md border border-line bg-background px-3 py-2 text-sm font-normal"
          />
        </Field>

        {confirming && (
          <p role="alert" className="text-sm text-danger">
            {fill(
              confirming === "cancelled" ? w.confirmCancel : w.confirmSuspend,
              { name: clientName },
            )}
          </p>
        )}
        {message && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
          >
            {message.text}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {confirming ? w.confirmSave : w.save}
          </Button>
          {confirming && (
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              {t.form.cancel}
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}
