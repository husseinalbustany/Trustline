"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { moduleCodes, moduleRules, type ModuleCode } from "@/config/modules";
import { locales } from "@/i18n/config";
import { codeOf, statusOf } from "@/lib/api";
import { fill, numberFormat } from "@/lib/format";
import { pick, readForm, type Localized } from "@/lib/localized";
import {
  extraKeys,
  limitKeys,
  platformApi,
  type Extras,
  type LimitKey,
  type Limits,
  type Plan,
  type Price,
} from "@/lib/platform-api";
import { dependencyRefusal, needsText, type ModuleNames } from "./module-words";
import type { PlatformProps } from "./types";

type Message = { kind: "ok" | "error"; text: string; at?: "status" };

/** A price as typed: the amount in the currency's main unit. */
type PriceDraft = {
  key: number;
  currency: string;
  amount: string;
  term: Price["term"];
  basis: Price["basis"];
};

/** A limit as typed, and whether it is "unlimited". */
type LimitDraft = Record<LimitKey, { value: string; unlimited: boolean }>;

/** How many digits after the point a currency has: 2 for SAR, 3 for KWD. */
function digitsOf(currency: string) {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

const noExtras: Extras = {
  sso: false,
  publicReporting: false,
  clinicalAiSuggestions: false,
};

const limitDraft = (limits?: Limits): LimitDraft =>
  Object.fromEntries(
    limitKeys.map((key) => {
      const value = limits ? limits[key] : null;
      return [
        key,
        {
          value: value === null ? "" : String(value),
          // A new plan starts with no limit, said plainly.
          unlimited: value === null,
        },
      ];
    }),
  ) as LimitDraft;

let priceKeys = 0;
const priceDrafts = (prices: Price[] = []): PriceDraft[] =>
  prices.map((p) => ({
    key: ++priceKeys,
    currency: p.currency,
    amount: (p.amountMinor / 10 ** digitsOf(p.currency)).toFixed(
      digitsOf(p.currency),
    ),
    term: p.term,
    basis: p.basis,
  }));

/**
 * Adds a plan, or edits the one named. Names and descriptions are written
 * in every language the product has, since any client may be shown them.
 * A plan is retired, never deleted.
 */
export function PlanForm({
  lang,
  t,
  moduleNames,
  mode,
  id,
}: PlatformProps & {
  moduleNames: ModuleNames;
  mode: "new" | "edit";
  id?: string;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [modules, setModules] = useState<ModuleCode[]>([]);
  const [limits, setLimits] = useState<LimitDraft>(limitDraft());
  const [extras, setExtras] = useState<Extras>(noExtras);
  const [prices, setPrices] = useState<PriceDraft[]>([]);
  // Raised to draw the form again from what is stored.
  const [visit, setVisit] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirming, setConfirming] = useState(false);
  const p = t.plans;
  const f = p.form;
  const listPath = `/${lang}/platform/plans`;
  const numbers = numberFormat(lang);

  const adopt = (loaded: Plan) => {
    setPlan(loaded);
    setModules(loaded.modules);
    setLimits(limitDraft(loaded.limits));
    setExtras(loaded.extras);
    setPrices(priceDrafts(loaded.prices));
    setVisit((n) => n + 1);
  };

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    let current = true;
    platformApi<Plan>(`/plans/${id}`)
      .then((loaded) => {
        if (!current) return;
        adopt(loaded);
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 404 ? p.notFound : p.loadError),
      );
    return () => {
      current = false;
    };
  }, [mode, id, p]);

  // Visited pages stay mounted: a note about the last save, or a question
  // waiting for an answer, must not be there when the page is shown again;
  // an "add" page starts empty each time.
  useLayoutEffect(
    () => () => {
      setMessage(null);
      setConfirming(false);
      if (mode === "new") {
        setModules([]);
        setLimits(limitDraft());
        setExtras(noExtras);
        setPrices([]);
        setVisit((n) => n + 1);
      }
    },
    [mode],
  );

  const explain = (err: unknown) => {
    const dependency = dependencyRefusal(err, lang, moduleNames, f.errors);
    if (dependency) return dependency;
    const code = codeOf(err);
    if (code === "language_mismatch") return f.errors.language_mismatch;
    if (code === "code_taken") return f.errors.code_taken;
    const status = statusOf(err);
    if (status === 404) return p.notFound;
    return status === 400 ? f.errors.invalid : f.errors.generic;
  };

  async function send(
    body: Record<string, unknown>,
    done: string,
    at?: Message["at"],
    form?: HTMLFormElement,
  ) {
    setBusy(true);
    setMessage(null);
    try {
      if (mode === "new") {
        await platformApi<Plan>("/plans", { method: "POST", body });
        form?.reset();
        setModules([]);
        setLimits(limitDraft());
        setExtras(noExtras);
        setPrices([]);
        setBusy(false);
        router.push(listPath);
        return;
      }
      adopt(await platformApi<Plan>(`/plans/${id}`, { method: "PATCH", body }));
      setMessage({ kind: "ok", text: done, at });
    } catch (err) {
      setMessage({ kind: "error", text: explain(err), at });
    }
    setBusy(false);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { name, description, code, position } = readForm(form) as {
      name: Localized;
      description: Localized;
      code?: string;
      position: string;
    };
    const blank = Object.values(description ?? {}).every((v) => !v?.trim());
    const body: Record<string, unknown> = {
      name,
      description: blank ? null : description,
      modules,
      limits: Object.fromEntries(
        limitKeys.map((key) => [
          key,
          limits[key].unlimited ? null : Number(limits[key].value),
        ]),
      ),
      extras,
      prices: prices.map((price) => {
        const currency = price.currency.trim().toUpperCase();
        return {
          currency,
          amountMinor: Math.round(
            Number(price.amount) * 10 ** digitsOf(currency),
          ),
          term: price.term,
          basis: price.basis,
        };
      }),
      position: Number(position) || 0,
    };
    if (mode === "new") body.code = code;
    void send(body, f.saved, undefined, form);
  }

  // Retiring asks once, with the facts; making it available again does not.
  function setActive(active: boolean) {
    if (!active && !confirming) return setConfirming(true);
    setConfirming(false);
    void send({ active }, active ? f.reactivated : f.retiredDone, "status");
  }

  if (problem) return <EmptyState>{problem}</EmptyState>;
  if (mode === "edit" && !plan) return <EmptyState>{t.loading}</EmptyState>;

  const note = (at?: Message["at"]) =>
    message &&
    message.at === at && (
      <p
        role={message.kind === "error" ? "alert" : "status"}
        className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
      >
        {message.text}
      </p>
    );

  const toggleModule = (module: ModuleCode, on: boolean) =>
    setModules(
      moduleCodes.filter((m) => (m === module ? on : modules.includes(m))),
    );

  const legend = "mb-1 text-sm font-medium";

  return (
    <>
      <PageHeader
        title={plan ? <bdi>{pick(plan.name, lang)}</bdi> : f.newTitle}
        description={plan ? undefined : f.newDescription}
        actions={
          plan && (
            <Pill tone={plan.active ? "ok" : "neutral"}>
              {plan.active ? p.active : p.retired}
            </Pill>
          )
        }
      />

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <form
          key={`${plan?.id ?? "new"}-${visit}`}
          onSubmit={submit}
          className="flex flex-col gap-6 rounded-lg border border-line p-4 sm:p-6"
        >
          <Field label={f.code} help={plan ? f.codeFixed : f.codeHelp}>
            <input
              name={plan ? undefined : "code"}
              required={!plan}
              pattern="[a-z0-9][a-z0-9_\-]{1,39}"
              maxLength={40}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              defaultValue={plan?.code}
              disabled={!!plan}
              className={`${inputClass} disabled:bg-surface disabled:text-muted`}
            />
          </Field>

          <div className="flex flex-col gap-2">
            {/* Every language the product has, each required. */}
            <LocalizedField
              label={f.name}
              name="name"
              locales={[...locales]}
              required
              value={plan?.name}
              maxLength={100}
            />
            <p className="text-xs text-muted">{f.nameHelp}</p>
          </div>
          <div className="flex flex-col gap-2">
            <LocalizedField
              label={f.description}
              name="description"
              locales={[...locales]}
              value={plan?.description}
              maxLength={1000}
            />
            <p className="text-xs text-muted">{f.descriptionHelp}</p>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className={legend}>{f.modules}</legend>
            <p className="text-xs text-muted">{f.modulesHelp}</p>
            {moduleCodes.map((module) => {
              const needs = needsText(lang, moduleNames, f, module);
              const on = modules.includes(module);
              // A module whose needs are not met in this plan: said beside
              // it before saving, which the API would refuse.
              const unmet =
                on &&
                moduleRules[module].requiresAnyOf.length > 0 &&
                !moduleRules[module].requiresAnyOf.some((m) =>
                  modules.includes(m),
                );
              return (
                <label
                  key={module}
                  className="flex min-h-11 items-start gap-3 rounded-md border border-line px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-1 accent-accent"
                    checked={on}
                    onChange={(e) => toggleModule(module, e.target.checked)}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {moduleNames[module]}
                      {!moduleRules[module].built && (
                        <Badge>{f.notBuilt}</Badge>
                      )}
                    </span>
                    {needs && (
                      <span
                        className={`text-xs ${unmet ? "font-medium text-danger" : "text-muted"}`}
                      >
                        {needs}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
            <p className="text-xs text-muted">{f.coreNote}</p>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className={legend}>{f.limits}</legend>
            <p className="text-xs text-muted">{f.limitsHelp}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {limitKeys.map((key) => {
                const draft = limits[key];
                const set = (next: Partial<typeof draft>) =>
                  setLimits({ ...limits, [key]: { ...draft, ...next } });
                return (
                  <div key={key} className="flex flex-col gap-1.5">
                    <Field label={p.limitNames[key]} help={f.limitHelp[key]}>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        step={1}
                        max={1_000_000_000}
                        dir="ltr"
                        required={!draft.unlimited}
                        disabled={draft.unlimited}
                        value={draft.unlimited ? "" : draft.value}
                        onChange={(e) => set({ value: e.target.value })}
                        className={`${inputClass} tabular-nums disabled:bg-surface`}
                      />
                    </Field>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={draft.unlimited}
                        onChange={(e) => set({ unlimited: e.target.checked })}
                      />
                      {p.unlimited}
                    </label>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted">{f.notEnforced}</p>
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className={legend}>{f.extras}</legend>
            <p className="text-xs text-muted">{f.extrasHelp}</p>
            {extraKeys.map((key) => (
              <label key={key} className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 accent-accent"
                  checked={extras[key]}
                  onChange={(e) =>
                    setExtras({ ...extras, [key]: e.target.checked })
                  }
                />
                {p.extraNames[key]}
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className={legend}>{f.prices}</legend>
            <p className="text-xs text-muted">{f.pricesHelp}</p>
            {prices.length === 0 && (
              <p className="text-sm text-muted">{f.noPrices}</p>
            )}
            {prices.map((price, index) => {
              const set = (next: Partial<PriceDraft>) =>
                setPrices(
                  prices.map((q) =>
                    q.key === price.key ? { ...q, ...next } : q,
                  ),
                );
              return (
                <div
                  key={price.key}
                  role="group"
                  aria-label={fill(f.priceNumber, {
                    number: numbers.format(index + 1),
                  })}
                  className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-[6rem_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
                >
                  <Field label={f.currency}>
                    <input
                      required
                      pattern="[A-Za-z]{3}"
                      maxLength={3}
                      dir="ltr"
                      autoCapitalize="characters"
                      value={price.currency}
                      onChange={(e) =>
                        set({ currency: e.target.value.toUpperCase() })
                      }
                      className={inputClass}
                    />
                  </Field>
                  <Field label={f.amount}>
                    <input
                      required
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={1 / 10 ** digitsOf(price.currency || "SAR")}
                      dir="ltr"
                      value={price.amount}
                      onChange={(e) => set({ amount: e.target.value })}
                      className={`${inputClass} tabular-nums`}
                    />
                  </Field>
                  <Field label={f.term}>
                    <select
                      value={price.term}
                      onChange={(e) =>
                        set({ term: e.target.value as Price["term"] })
                      }
                      className={inputClass}
                    >
                      {(["monthly", "yearly"] as const).map((term) => (
                        <option key={term} value={term}>
                          {f.terms[term]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={f.basis}>
                    <select
                      value={price.basis}
                      onChange={(e) =>
                        set({ basis: e.target.value as Price["basis"] })
                      }
                      className={inputClass}
                    >
                      {(["flat", "per_user", "per_site"] as const).map(
                        (basis) => (
                          <option key={basis} value={basis}>
                            {f.bases[basis]}
                          </option>
                        ),
                      )}
                    </select>
                  </Field>
                  <Button
                    variant="secondary"
                    className="h-10"
                    onClick={() =>
                      setPrices(prices.filter((q) => q.key !== price.key))
                    }
                  >
                    {f.removePrice}
                  </Button>
                </div>
              );
            })}
            <div>
              <Button
                variant="secondary"
                onClick={() =>
                  setPrices([
                    ...prices,
                    {
                      key: ++priceKeys,
                      currency: "SAR",
                      amount: "",
                      term: "monthly",
                      basis: "flat",
                    },
                  ])
                }
              >
                {f.addPrice}
              </Button>
            </div>
          </fieldset>

          <Field label={f.position} help={f.positionHelp}>
            <input
              name="position"
              type="number"
              inputMode="numeric"
              min={0}
              max={100_000}
              step={1}
              dir="ltr"
              defaultValue={plan?.position ?? 0}
              className={`${inputClass} max-w-32 tabular-nums`}
            />
          </Field>

          {note()}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {plan ? f.save : f.create}
            </Button>
            <Link
              href={listPath}
              className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted hover:bg-surface hover:text-foreground"
            >
              {plan ? f.back : f.cancel}
            </Link>
          </div>
        </form>

        {plan && (
          <div className="flex flex-col gap-6">
            <Panel title={f.availability}>
              <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-sm text-muted">
                  {fill(plan.active ? f.activeHelp : f.retiredHelp, {
                    count: numbers.format(plan.subscribers),
                  })}
                </p>
                {confirming && (
                  <p role="alert" className="text-sm text-danger">
                    {fill(f.retireConfirm, {
                      count: numbers.format(plan.subscribers),
                    })}
                  </p>
                )}
                {note("status")}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setActive(!plan.active)}
                  >
                    {plan.active
                      ? confirming
                        ? f.retireConfirmButton
                        : f.retire
                      : f.reactivate}
                  </Button>
                  {confirming && (
                    <Button
                      variant="secondary"
                      onClick={() => setConfirming(false)}
                    >
                      {f.cancel}
                    </Button>
                  )}
                </div>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}
