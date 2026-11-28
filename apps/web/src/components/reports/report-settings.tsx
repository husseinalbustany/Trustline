"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { api, codeOf, statusOf } from "@/lib/api";
import { fill } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import { pick, readForm, type Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import { todayIn } from "@/lib/policies";
import { addMonths, monthOf, type MeasureSeries, type ReportSettings } from "@/lib/reports";
import { textareaClass } from "@/components/policies/types";
import { useFigures, type ReportsText } from "./reports-view";

type Message = { ok: boolean; text: string } | null;

/** The measures a correction may name: what this organization has, as the API lists it. */
type Known = { code: string; valueUnit: string }[];

/**
 * Targets, the reporting baseline, and recomputing a month: for whoever may
 * correct the organization's figures. Changes apply to months taken from
 * then on; a correction is worked out by Trustline from the records, never
 * typed in.
 */
export function ReportSettingsView({ lang, t }: { lang: string; t: ReportsText }) {
  const session = useSession();
  const s = t.settings;
  const manages = session.scope?.["reports.manage"] === "all";
  const [settings, setSettings] = useState<ReportSettings | null>(null);
  const [known, setKnown] = useState<Known>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const thisMonth = monthOf(todayIn(session.tenant.timeZone));

  useEffect(() => {
    if (!manages) return;
    let current = true;
    Promise.all([
      api<ReportSettings>("/reports/settings"),
      // Which measures there are, and their units, as the API lists them.
      api<MeasureSeries>(
        `/reports/measures?${new URLSearchParams({ from: thisMonth, to: thisMonth })}`,
      ),
    ]).then(
      ([answer, series]) => {
        if (!current) return;
        setSettings(answer);
        setKnown(series.measures.map((m) => ({ code: m.code, valueUnit: m.valueUnit })));
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 403 ? s.noAccess : s.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [manages, s, thisMonth]);

  return (
    <>
      <PageHeader title={s.title} description={s.description} />
      <div className="mt-4">
        <Link href={`/${lang}/reports`} className="text-sm text-accent hover:underline">
          {s.back}
        </Link>
      </div>
      <div className="mt-6 flex max-w-3xl flex-col gap-6">
        {!manages ? (
          <Panel>
            <EmptyState>{s.noAccess}</EmptyState>
          </Panel>
        ) : problem ? (
          <Panel>
            <EmptyState>{problem}</EmptyState>
          </Panel>
        ) : !settings ? (
          <Panel>
            <EmptyState>{s.loading}</EmptyState>
          </Panel>
        ) : (
          <>
            <Targets lang={lang} t={t} settings={settings} known={known} onSaved={setSettings} />
            {known.some((m) => m.code === "incidents.reported") && (
              <Baseline lang={lang} t={t} settings={settings} onSaved={setSettings} />
            )}
            <Correction lang={lang} t={t} known={known} thisMonth={thisMonth} />
          </>
        )}
      </div>
    </>
  );
}

/** Saves a change of settings; says what came of it. */
function useSave(t: ReportsText, settings: ReportSettings, onSaved: (s: ReportSettings) => void) {
  const s = t.settings;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  useLayoutEffect(() => () => setMessage(null), []);
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api<ReportSettings>("/reports/settings", {
        method: "PATCH",
        body: { ...body, revision: settings.revision },
      });
      setMessage({ ok: true, text: saved.revision === settings.revision ? s.unchanged : s.saved });
      onSaved(saved);
    } catch (err) {
      const code = codeOf(err);
      if (code === "stale_settings") {
        // Shown as they are now, to be checked and saved again.
        api<ReportSettings>("/reports/settings").then(onSaved, () => {});
      }
      setMessage({
        ok: false,
        text:
          code === "stale_settings"
            ? s.stale
            : code === "language_mismatch"
              ? s.languageMismatch
              : statusOf(err) === 400
                ? s.invalid
                : s.error,
      });
    }
    setBusy(false);
  };
  return { busy, message, save };
}

const Said = ({ message }: { message: Message }) =>
  message && (
    <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>
      {message.text}
    </p>
  );

function Targets({
  lang,
  t,
  settings,
  known,
  onSaved,
}: {
  lang: string;
  t: ReportsText;
  settings: ReportSettings;
  known: Known;
  onSaved: (s: ReportSettings) => void;
}) {
  const s = t.settings;
  const f = useFigures(lang, t);
  const { busy, message, save } = useSave(t, settings, onSaved);
  const unitOf = (code: string) =>
    known.find((k) => k.code === code)?.valueUnit ?? (code === "incidents.time_to_report" ? "seconds" : "percent");
  const names = t.measures as Record<string, { name: string } | undefined>;
  // Only the measures this organization has.
  const shown = settings.targets.filter((x) => known.length === 0 || known.some((k) => k.code === x.code));

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const targets: Record<string, number | null> = {};
    for (const x of shown) {
      const raw = String(data.get(x.code) ?? "").trim();
      const next = raw === "" ? null : Number(raw);
      if (next !== x.client) targets[x.code] = next;
    }
    void save({ targets });
  }

  return (
    <Panel title={s.targets}>
      <form key={settings.revision} onSubmit={submit} className="flex flex-col gap-5 p-4">
        <p className="text-sm text-muted">{s.targetsHelp}</p>
        {shown.map((x) => {
          const unit = unitOf(x.code);
          return (
            <Field
              key={x.code}
              label={names[x.code]?.name ?? x.code}
              help={`${fill(s.business, { value: f.value(unit, x.business) })} · ${fill(s.inForce, { value: f.value(unit, x.effective) })} · ${unit === "seconds" ? s.secondsUnit : s.percentUnit}`}
            >
              <input
                name={x.code}
                type="number"
                inputMode="decimal"
                min={unit === "seconds" ? 1 : 0}
                max={unit === "seconds" ? 3600 : 100}
                step={unit === "seconds" ? 1 : 0.1}
                defaultValue={x.client ?? ""}
                placeholder={x.business === null ? "" : String(x.business)}
                dir="ltr"
                className={`${inputClass} max-w-40`}
              />
            </Field>
          );
        })}
        <Said message={message} />
        <div>
          <Button type="submit" disabled={busy}>
            {s.saveTargets}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Baseline({
  lang,
  t,
  settings,
  onSaved,
}: {
  lang: string;
  t: ReportsText;
  settings: ReportSettings;
  onSaved: (s: ReportSettings) => void;
}) {
  const session = useSession();
  const s = t.settings;
  const f = useFigures(lang, t);
  const { busy, message, save } = useSave(t, settings, onSaved);
  const sources = t.targetSource as Record<string, string>;
  const { locales, defaultLocale } = session.tenant;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { monthlyAverage, note } = readForm(e.currentTarget) as {
      monthlyAverage: string;
      note: Localized;
    };
    void save({ baseline: { monthlyAverage: Number(monthlyAverage), note } });
  }

  const reported = settings.reportedTarget;
  return (
    <Panel title={s.baseline}>
      <form key={settings.revision} onSubmit={submit} className="flex flex-col gap-5 p-4">
        <p className="text-sm text-muted">{s.baselineHelp}</p>
        <Field label={s.monthlyAverage}>
          <input
            name="monthlyAverage"
            type="number"
            required
            min={0}
            max={1000000}
            step="any"
            inputMode="decimal"
            defaultValue={settings.baseline?.monthlyAverage ?? ""}
            dir="ltr"
            className={`${inputClass} max-w-40`}
          />
        </Field>
        <LocalizedField
          label={s.note}
          name="note"
          locales={locales}
          required={defaultLocale}
          value={settings.baseline?.note ?? null}
          maxLength={500}
        />
        <p className="text-xs text-muted">{s.noteHelp}</p>
        <p className="text-sm">
          {settings.firstMonthsBaseline !== null
            ? fill(s.firstMonths, { value: f.value("count", settings.firstMonthsBaseline) })
            : s.firstMonthsNone}
        </p>
        <p className="text-sm font-medium">
          {reported.value !== null
            ? fill(s.reportedTarget, {
                value: f.value("count", reported.value),
                source: (reported.source && sources[reported.source]) || "",
              })
            : s.reportedNone}
        </p>
        <Said message={message} />
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>
            {s.saveBaseline}
          </Button>
          {settings.baseline && (
            <Button variant="secondary" disabled={busy} onClick={() => void save({ baseline: null })}>
              {s.removeBaseline}
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}

/** Recompute a month from the records: a reason, never a figure. */
function Correction({
  lang,
  t,
  known,
  thisMonth,
}: {
  lang: string;
  t: ReportsText;
  known: Known;
  thisMonth: string;
}) {
  const session = useSession();
  const c = t.settings.correction;
  const f = useFigures(lang, t);
  const names = t.measures as Record<string, { name: string } | undefined>;
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [lines, setLines] = useState<string[]>([]);
  useLayoutEffect(
    () => () => {
      setMessage(null);
      setLines([]);
    },
    [],
  );
  const inLang = (text: Localized | null | undefined) => pick(text, lang, session.tenant.defaultLocale);
  // The months that can have been taken: the last 24 before this one.
  const months = Array.from({ length: 24 }, (_, i) => addMonths(thisMonth, -(i + 1)));

  useEffect(() => {
    let current = true;
    api<OrgUnit[]>("/org-units").then(
      (list) => {
        if (current) setUnits(list);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const measures = data.getAll("measures").map(String);
    if (measures.length === 0) return setMessage({ ok: false, text: c.pickMeasure });
    const unitId = String(data.get("unitId") ?? "");
    setBusy(true);
    setMessage(null);
    setLines([]);
    try {
      const done = await api<{
        month: string;
        revisions: {
          measure: string;
          unitId: string | null;
          revision: number;
          from: { value: number | null };
          to: { value: number | null };
        }[];
      }>("/reports/measures/corrections", {
        method: "POST",
        body: {
          month: String(data.get("month")),
          measures,
          ...(unitId ? { unitId } : {}),
          reason: String(data.get("reason") ?? "").trim(),
        },
      });
      form.reset();
      const unitName = (id: string | null) =>
        id ? inLang(units.find((u) => u.id === id)?.name) || id : t.organization;
      const unitOfMeasure = (code: string) => known.find((k) => k.code === code)?.valueUnit ?? "count";
      setMessage({ ok: true, text: c.done });
      setLines(
        done.revisions.map((r) =>
          fill(c.line, {
            measure: names[r.measure]?.name ?? r.measure,
            unit: unitName(r.unitId),
            from: f.value(unitOfMeasure(r.measure), r.from.value),
            to: f.value(unitOfMeasure(r.measure), r.to.value),
            revision: f.numbers.format(r.revision),
          }),
        ),
      );
    } catch (err) {
      const code = codeOf(err);
      setMessage({
        ok: false,
        text:
          code === "no_snapshot"
            ? c.noSnapshot
            : statusOf(err) === 404
              ? c.notFound
              : c.error,
      });
    }
    setBusy(false);
  }

  return (
    <Panel title={c.title}>
      <form onSubmit={submit} className="flex flex-col gap-5 p-4">
        <p className="text-sm text-muted">{c.help}</p>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={c.month}>
            <select name="month" required defaultValue={months[0]} className={inputClass}>
              {months.map((m) => (
                <option key={m} value={m}>
                  {f.month(m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={c.unit}>
            <select name="unitId" defaultValue="" className={inputClass}>
              <option value="">{c.unitAll}</option>
              {unitOptions(units, (u) => inLang(u.name)).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{c.measures}</legend>
          {known.map((k) => (
            <label key={k.code} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="measures" value={k.code} defaultChecked className="size-4" />
              {names[k.code]?.name ?? k.code}
            </label>
          ))}
        </fieldset>
        <Field label={c.reason} help={c.reasonHelp}>
          <textarea name="reason" required maxLength={1000} rows={3} dir="auto" className={textareaClass} />
        </Field>
        {message && (
          <div role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "" : "text-danger"}`}>
            <p className={message.ok ? "font-medium text-accent" : ""}>{message.text}</p>
            {lines.length > 0 && (
              <ul className="mt-1 list-disc ps-5">
                {lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div>
          <Button type="submit" disabled={busy}>
            {c.submit}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
