"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/panel";
import { api, statusOf } from "@/lib/api";
import { isReviewer, type OrgUnit } from "@/lib/identity";
import type { Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import {
  isStale,
  riskPath,
  treatments,
  type Risk,
  type RiskAnswer,
} from "@/lib/risks";
import { Notice, useBandWord, usePick, useRiskSettings } from "./bits";
import { usePeople } from "./context";
import { DayBox, listOf, localizedOf, textOf } from "./move-form";
import { RatingPicker, readRating } from "./rating";
import { textareaClass, type RisksProps } from "./types";
import { useExplain } from "./use-explain";

type Raise = { orgUnitId: string | null; impact: number | null; linkKind: "raised" } | null;

/** A new risk, raised by hand or from an incident; or a risk's details changed. */
export function RiskForm({ lang, t, mode }: RisksProps & { mode: "new" | "edit" }) {
  const session = useSession();
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const search = useSearchParams();
  const fromIncident = mode === "new" ? search.get("fromIncident") : null;
  const incidentId = fromIncident && /^[0-9a-f-]{36}$/i.test(fromIncident) ? fromIncident : null;
  const { settings, failed } = useRiskSettings();
  const word = useBandWord(t, lang, settings?.matrix);
  const inLang = usePick(lang);
  const explain = useExplain(t, lang);
  const [units, setUnits] = useState<OrgUnit[] | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);
  const [raise, setRaise] = useState<Raise | undefined>(incidentId ? undefined : null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reach = session.scope?.["risks.manage"];
  const manages = !!reach && !isReviewer(session);
  const [rated, setRated] = useState({ current: manages, inherent: manages, target: false });
  const form = useRef<HTMLFormElement>(null);
  const people = usePeople(risk?.people ?? {});
  const locales = session.tenant.locales;
  const f = t.form;

  useEffect(() => {
    let current = true;
    api<OrgUnit[]>("/org-units")
      .then((list) => current && setUnits(list))
      .catch(() => current && setUnits([]));
    if (mode === "edit" && params.id) {
      api<RiskAnswer>(`/risks/${params.id}`)
        .then((next) => {
          if (!current) return;
          if (next.access !== "full") setProblem(t.notFound);
          else setRisk(next);
        })
        .catch((err) => current && setProblem(statusOf(err) === 404 ? t.notFound : t.loadError));
    }
    if (incidentId) {
      api<{ raise: Raise }>(`/risks/for-incident/${incidentId}`)
        .then((answer) => current && setRaise(answer.raise))
        .catch(() => current && setRaise(null));
    }
    return () => {
      current = false;
    };
  }, [mode, params.id, incidentId, t]);

  useLayoutEffect(() => {
    const kept = form.current;
    return () => {
      kept?.reset();
      setError(null);
    };
  }, []);

  if (!manages && !incidentId && mode === "new") {
    return <EmptyState>{t.noAccess}</EmptyState>;
  }
  if (problem) return <EmptyState>{problem}</EmptyState>;
  if (failed) return <EmptyState>{t.loadError}</EmptyState>;
  if (!settings || !units || (mode === "edit" && !risk) || raise === undefined) {
    return <EmptyState>{t.loading}</EmptyState>;
  }
  const matrix = settings.matrix;

  // The units one may put a risk in: all for a manager of the whole
  // organization, else those they manage; from an incident, any (the API decides).
  const allowed = units.filter(
    (u) => reach === "all" || !manages || (Array.isArray(reach) && reach.includes(u.id)) || u.id === risk?.orgUnitId,
  );
  const unitChoices = unitOptions(allowed, (u) => inLang(u.name));
  const wholeAllowed = reach === "all" || risk?.orgUnitId === null || !manages;
  const startUnit =
    mode === "edit" ? (risk?.orgUnitId ?? "whole") : (raise?.orgUnitId ?? session.user.orgUnitId ?? "");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    const data = new FormData(el);
    const unit = textOf(data, "orgUnitId");
    const body: Record<string, unknown> = {
      title: localizedOf(data, "title", locales),
      cause: localizedOf(data, "cause", locales),
      event: localizedOf(data, "event", locales),
      consequence: localizedOf(data, "consequence", locales),
      orgUnitId: unit === "whole" ? null : unit,
      categoryId: textOf(data, "categoryId"),
      ownerId: textOf(data, "ownerId"),
      references: listOf(data, "references"),
      keywords: listOf(data, "keywords"),
      treatment: textOf(data, "treatment") ?? null,
      targetOn: textOf(data, "targetOn") ?? null,
    };
    setBusy(true);
    setError(null);
    try {
      if (mode === "new") {
        const ratings = Object.fromEntries(
          (["current", "inherent", "target"] as const)
            .filter((k) => rated[k] && (k === "current" || rated.current))
            .map((k) => [k, readRating(data, k, locales)])
            .filter(([, v]) => v),
        );
        const created = await api<Risk>("/risks", {
          method: "POST",
          body: {
            ...body,
            ...ratings,
            ...(incidentId ? { fromIncidentId: incidentId, linkKind: "raised" } : {}),
          },
        });
        el.reset();
        router.push(riskPath(lang, created.id));
        return;
      }
      if (!risk) return;
      // Only what changed is sent, with the reason when one is given.
      const changed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        const before = (risk as unknown as Record<string, unknown>)[key] ?? null;
        if (JSON.stringify(sorted(before)) !== JSON.stringify(sorted(value))) changed[key] = value;
      }
      const reason = textOf(data, "reason");
      await api<Risk>(`/risks/${risk.id}`, {
        method: "PATCH",
        body: { revision: risk.revision, ...changed, ...(reason ? { reason } : {}) },
      });
      el.reset();
      router.push(riskPath(lang, risk.id));
      return;
    } catch (err) {
      setError(isStale(err) ? t.stale : explain(err));
    }
    setBusy(false);
  }

  const toggle = (kind: "current" | "inherent" | "target", label: string) => (
    <label className="flex min-h-9 items-center gap-2 text-sm font-medium">
      <input
        type="checkbox"
        checked={rated[kind]}
        onChange={(e) => setRated({ ...rated, [kind]: e.target.checked })}
        className="size-4 accent-accent"
      />
      {label}
    </label>
  );

  return (
    <>
      <PageHeader
        title={mode === "new" ? (incidentId ? t.newFromIncident : t.newRisk) : t.editTitle}
        description={mode === "edit" && risk ? <bdi dir="ltr">{risk.reference}</bdi> : f.intro}
      />
      <form ref={form} onSubmit={submit} className="mt-6 flex max-w-4xl flex-col gap-6">
        <Notice tone="warn">{f.noPersonalDetails}</Notice>
        {incidentId && raise === null && <Notice>{f.cannotRaise}</Notice>}
        {incidentId && raise && <Notice>{f.fromIncidentNote}</Notice>}
        <LocalizedField
          label={f.title}
          name="title"
          locales={locales}
          required={session.tenant.defaultLocale}
          maxLength={300}
          value={risk?.title}
        />
        {(["cause", "event", "consequence"] as const).map((field) => (
          <LocalizedField
            key={field}
            label={f[field]}
            name={field}
            locales={locales}
            multiline
            maxLength={4000}
            value={risk?.[field] as Localized | null | undefined}
          />
        ))}
        <p className="-mt-3 text-xs text-muted">{f.anyLanguage}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t.fields.unit}>
            <select name="orgUnitId" required defaultValue={startUnit} className={inputClass}>
              <option value="" disabled>
                {t.choose}
              </option>
              {wholeAllowed && <option value="whole">{t.wholeOrganization}</option>}
              {unitChoices.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.fields.category}>
            <select name="categoryId" required defaultValue={risk?.categoryId ?? ""} className={inputClass}>
              <option value="" disabled>
                {t.choose}
              </option>
              {settings.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {inLang(c.name)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.fields.owner}>
            <select
              name="ownerId"
              required
              defaultValue={risk?.ownerId ?? (manages ? "" : session.user.id)}
              className={inputClass}
            >
              <option value="" disabled>
                {t.choose}
              </option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {inLang(p.name) || t.someone}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t.fields.treatment}>
            <select name="treatment" defaultValue={risk?.treatment ?? ""} className={inputClass}>
              <option value="">{t.none}</option>
              {treatments.map((v) => (
                <option key={v} value={v}>
                  {t.treatment[v]}
                </option>
              ))}
            </select>
          </Field>
          <DayBox label={t.fields.targetOn} name="targetOn" value={risk?.targetOn} />
          <Field label={t.fields.keywords} help={f.keywordsHelp}>
            <input
              name="keywords"
              dir="auto"
              maxLength={1000}
              defaultValue={risk?.keywords.join(", ") ?? ""}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label={t.fields.references} help={f.referencesHelp}>
          <textarea
            name="references"
            rows={2}
            maxLength={4000}
            dir="auto"
            defaultValue={risk?.references.join("\n") ?? ""}
            className={textareaClass}
          />
        </Field>

        {mode === "new" && matrix && (
          <fieldset className="flex flex-col gap-4 rounded-lg border border-line p-4">
            <legend className="px-1 text-sm font-semibold">{f.ratings}</legend>
            <p className="text-sm text-muted">{manages ? f.ratingsHelp : f.ratingsHelpProposed}</p>
            {toggle("current", f.withCurrent)}
            {rated.current && (
              <RatingPicker
                t={t}
                lang={lang}
                matrix={matrix}
                prefix="current"
                initial={raise?.impact ? { likelihood: 0, impact: raise.impact } : null}
                word={word}
                heading={t.ratingKind.current}
              />
            )}
            {rated.current && toggle("inherent", settings.inherentRequired ? f.inherentRequired : f.withInherent)}
            {rated.current && rated.inherent && (
              <RatingPicker t={t} lang={lang} matrix={matrix} prefix="inherent" word={word} heading={t.ratingKind.inherent} />
            )}
            {rated.current && toggle("target", f.withTarget)}
            {rated.current && rated.target && (
              <RatingPicker t={t} lang={lang} matrix={matrix} prefix="target" word={word} heading={t.ratingKind.target} />
            )}
          </fieldset>
        )}

        {mode === "edit" && (
          <Field label={f.reason} help={f.reasonHelp}>
            <textarea name="reason" rows={2} maxLength={1000} dir="auto" className={textareaClass} />
          </Field>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || (incidentId !== null && raise === null)}>
            {busy ? t.saving : mode === "new" ? (manages && rated.current ? f.add : f.propose) : t.save}
          </Button>
          <Link
            href={mode === "edit" && risk ? riskPath(lang, risk.id) : `/${lang}/risks`}
            className="inline-flex h-9 items-center rounded-md border border-line px-3 text-sm font-medium hover:bg-surface"
          >
            {t.cancel}
          </Link>
        </div>
        {!can(session, "risks.manage") && mode === "new" && <p className="text-xs text-muted">{f.proposedNote}</p>}
      </form>
    </>
  );
}

/** A value as compared: lists in order, texts by language. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return [...value].sort();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== "" && v !== undefined && v !== null)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return value;
}
