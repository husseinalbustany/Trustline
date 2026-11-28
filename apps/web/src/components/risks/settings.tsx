"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { dateTimeFormat, fill, momentFrom, numberFormat } from "@/lib/format";
import { isReviewer } from "@/lib/identity";
import type { Localized } from "@/lib/localized";
import {
  appetites,
  bandAt,
  bands,
  isStale,
  type ApprovalRoute,
  type Band,
  type Category,
  type Committee,
  type Matrix,
  type MatrixHead,
  type PickerPerson,
  type PickerRole,
  type RiskSettings,
} from "@/lib/risks";
import { BandPill, Notice, useBandWord, usePick } from "./bits";
import { localizedOf, textOf } from "./move-form";
import { MatrixGrid } from "./rating";
import type { RisksProps, RisksText } from "./types";
import { useExplain } from "./use-explain";

const tabs = ["general", "matrix", "categories", "committees", "routes"] as const;
type Tab = (typeof tabs)[number];

/**
 * The risk settings of the whole organization: how risks are rated, the
 * categories with their appetite and tolerance, the committees, and the
 * routes of acceptance and closure. Written by whoever manages risks for
 * the whole organization; read by any manager.
 */
export function RiskSettingsPage({ lang, t }: RisksProps) {
  const session = useSession();
  const asked = useSearchParams().get("tab");
  const tab: Tab = tabs.find((x) => x === asked) ?? "general";
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  const reach = session.scope?.["risks.manage"];
  const writes = reach === "all" && !isReviewer(session);
  const s = t.settings;

  useEffect(() => {
    if (!reach) return;
    let current = true;
    api<RiskSettings>("/risks/settings")
      .then((next) => {
        if (!current) return;
        setSettings(next);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [reach, round]);

  if (!reach) return <EmptyState>{t.noAccess}</EmptyState>;
  const reload = () => setRound((n) => n + 1);

  return (
    <>
      <PageHeader title={s.title} description={s.description} />
      {!writes && <p className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-sm">{s.wholeOnly}</p>}
      <nav aria-label={s.tabsLabel} className="mt-4 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((x) => (
          <Link
            key={x}
            href={`/${lang}/risks/settings${x === "general" ? "" : `?tab=${x}`}`}
            aria-current={tab === x ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              tab === x ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {s.tabs[x]}
          </Link>
        ))}
      </nav>
      <div className="mt-6">
        {failed ? (
          <EmptyState>{t.loadError}</EmptyState>
        ) : !settings ? (
          <EmptyState>{t.loading}</EmptyState>
        ) : tab === "general" ? (
          <General t={t} lang={lang} settings={settings} writes={writes} onSaved={setSettings} />
        ) : tab === "matrix" ? (
          <Matrices t={t} lang={lang} settings={settings} writes={writes} onChanged={reload} />
        ) : tab === "categories" ? (
          <Categories t={t} lang={lang} settings={settings} writes={writes} onChanged={reload} />
        ) : tab === "committees" ? (
          <Committees t={t} lang={lang} writes={writes} onChanged={reload} />
        ) : (
          <Routes t={t} lang={lang} writes={writes} />
        )}
      </div>
    </>
  );
}

/** A form that saves, says why when refused, and reads again when stale. */
function SettingsForm({
  t,
  lang,
  onSubmit,
  onDone,
  confirm,
  children,
  disabled,
  extra,
}: {
  t: RisksText;
  lang: string;
  onSubmit: (data: FormData) => Promise<unknown>;
  onDone: () => void;
  confirm?: string;
  children: ReactNode;
  disabled?: boolean;
  extra?: ReactNode;
}) {
  const explain = useExplain(t, lang);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    const kept = form.current;
    return () => {
      kept?.reset();
      setSaid(null);
    };
  }, []);
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setSaid(null);
    try {
      await onSubmit(data);
      setSaid({ ok: true, text: t.saved });
      onDone();
    } catch (err) {
      setSaid({ ok: false, text: isStale(err) ? t.stale : explain(err) });
      if (isStale(err)) onDone();
    }
    setBusy(false);
  }
  return (
    <form ref={form} onSubmit={send} className="flex flex-col gap-4">
      <fieldset disabled={disabled} className="contents">
        {children}
      </fieldset>
      {said && (
        <p role={said.ok ? "status" : "alert"} className={`text-sm ${said.ok ? "text-accent" : "text-danger"}`}>
          {said.text}
        </p>
      )}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t.saving : (confirm ?? t.save)}
          </Button>
          {extra}
        </div>
      )}
    </form>
  );
}

function General({
  t,
  lang,
  settings,
  writes,
  onSaved,
}: RisksProps & { settings: RiskSettings; writes: boolean; onSaved: (s: RiskSettings) => void }) {
  const session = useSession();
  const s = t.settings;
  const inLang = usePick(lang);
  const policiesOn = hasModule(session, "policies");
  const doc = settings.frameworkDocument;
  const [found, setFound] = useState<{ id: string; label: string }[] | null>(null);
  const [chosen, setChosen] = useState<string>(settings.frameworkDocumentId ?? "");
  async function look(q: string) {
    try {
      const list = await api<{ items: { id: string; number: string; title: Localized }[] }>(
        `/policies/documents?${new URLSearchParams({ q: q.trim(), status: "active", pageSize: "20" })}`,
      );
      setFound(list.items.map((d) => ({ id: d.id, label: `${d.number} · ⁨${inLang(d.title)}⁩` })));
    } catch {
      setFound([]);
    }
  }
  const current = doc
    ? doc.title
      ? `${doc.number ?? ""} · ⁨${inLang(doc.title)}⁩`
      : t.document.restricted
    : null;
  return (
    <Panel title={s.tabs.general}>
      <div className="p-4">
        {policiesOn && !settings.frameworkDocumentId && <div className="mb-4"><Notice tone="warn">{s.frameworkMissing}</Notice></div>}
        <SettingsForm
          t={t}
          lang={lang}
          disabled={!writes}
          onDone={() => {}}
          onSubmit={async (data) => {
            const months = Number(data.get("acceptanceMaxMonths"));
            const next = await api<RiskSettings>("/risks/settings", {
              method: "PATCH",
              body: {
                revision: settings.revision,
                inherentRequired: data.get("inherentRequired") === "on",
                acceptanceMaxMonths: months,
                ...(policiesOn ? { frameworkDocumentId: chosen || null } : {}),
              },
            });
            onSaved({ ...settings, ...next, matrix: settings.matrix, categories: settings.categories, committees: settings.committees });
          }}
        >
          <label className="flex min-h-9 items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="inherentRequired"
              defaultChecked={settings.inherentRequired}
              className="mt-0.5 size-4 accent-accent"
            />
            <span>
              <span className="font-medium">{s.inherentRequired}</span>
              <span className="block text-xs text-muted">{s.inherentRequiredHelp}</span>
            </span>
          </label>
          <Field label={s.acceptanceMaxMonths} help={s.acceptanceMaxMonthsHelp}>
            <input
              type="number"
              name="acceptanceMaxMonths"
              min={1}
              max={12}
              required
              dir="ltr"
              defaultValue={settings.acceptanceMaxMonths}
              className={`${inputClass} sm:max-w-32`}
            />
          </Field>
          {policiesOn && (
            <div className="flex flex-col gap-2">
              <Field label={s.framework} help={s.frameworkHelp}>
                <input
                  name="frameworkQ"
                  type="search"
                  dir="auto"
                  maxLength={200}
                  autoComplete="off"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void look(e.currentTarget.value);
                    }
                  }}
                  onBlur={(e) => e.currentTarget.value.trim() && void look(e.currentTarget.value)}
                  className={`${inputClass} sm:max-w-md`}
                />
              </Field>
              <Field label={s.frameworkChosen}>
                <select value={chosen} onChange={(e) => setChosen(e.target.value)} className={`${inputClass} sm:max-w-md`}>
                  <option value="">{t.none}</option>
                  {current && settings.frameworkDocumentId && !found?.some((d) => d.id === settings.frameworkDocumentId) && (
                    <option value={settings.frameworkDocumentId}>{current}</option>
                  )}
                  {(found ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </Field>
              {doc && doc.title && (
                <Link href={`/${lang}/policies/${doc.id}`} className="text-sm text-accent hover:underline">
                  {s.frameworkOpen}
                </Link>
              )}
            </div>
          )}
        </SettingsForm>
      </div>
    </Panel>
  );
}

const statusTone = { draft: "warn", in_use: "ok", retired: "neutral" } as const;

function Matrices({
  t,
  lang,
  settings,
  writes,
  onChanged,
}: RisksProps & { settings: RiskSettings; writes: boolean; onChanged: () => void }) {
  const session = useSession();
  const explain = useExplain(t, lang);
  const [heads, setHeads] = useState<MatrixHead[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const numbers = numberFormat(lang);
  const s = t.settings.matrix;
  const inUse = settings.matrix;
  const [size, setSize] = useState({
    likelihood: inUse?.likelihoodLevels ?? 5,
    impact: inUse?.impactLevels ?? 5,
  });

  useEffect(() => {
    let current = true;
    api<MatrixHead[]>("/risks/settings/matrices")
      .then((list) => {
        if (!current) return;
        setHeads(list);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [round]);

  const shownId = chosen ?? heads?.find((h) => h.status === "draft")?.id ?? heads?.find((h) => h.status === "in_use")?.id ?? null;
  useEffect(() => {
    if (!shownId) return;
    let current = true;
    api<Matrix>(`/risks/settings/matrices/${shownId}`)
      .then((m) => current && setMatrix(m))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [shownId, round]);

  const refresh = () => {
    setRound((n) => n + 1);
    onChanged();
  };

  async function make() {
    if (!inUse) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        size.likelihood === inUse.likelihoodLevels && size.impact === inUse.impactLevels
          ? { copyOf: inUse.id }
          : resized(inUse, size.likelihood, size.impact);
      const draft = await api<Matrix>("/risks/settings/matrices", { method: "POST", body });
      setChosen(draft.id);
      refresh();
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  }

  if (failed) return <EmptyState>{t.loadError}</EmptyState>;
  if (!heads) return <EmptyState>{t.loading}</EmptyState>;
  const draftExists = heads.some((h) => h.status === "draft");

  return (
    <div className="flex flex-col gap-6">
      <Panel title={s.versions}>
        <ul>
          {heads.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
              <button
                type="button"
                onClick={() => setChosen(h.id)}
                aria-current={shownId === h.id ? "true" : undefined}
                className="text-sm font-medium text-accent hover:underline aria-[current]:underline"
              >
                {fill(s.version, { version: numbers.format(h.version) })}
              </button>
              <Pill tone={statusTone[h.status]}>{t.matrixStatus[h.status]}</Pill>
              <span className="text-xs text-muted">
                {fill(s.size, { likelihood: numbers.format(h.likelihoodLevels), impact: numbers.format(h.impactLevels) })}
              </span>
              {h.putInUseAt && (
                <span className="text-xs text-muted">
                  {fill(s.putInUseOn, { date: moments.format(momentFrom(h.putInUseAt) ?? new Date()) })}
                </span>
              )}
            </li>
          ))}
        </ul>
        {writes && inUse && !draftExists && (
          <div className="flex flex-wrap items-end gap-3 border-t border-line p-4">
            <Field label={t.axis.likelihood}>
              <select
                value={size.likelihood}
                onChange={(e) => setSize({ ...size, likelihood: Number(e.target.value) })}
                className={`${inputClass} w-24`}
              >
                {[3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {numbers.format(n)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t.axis.impact}>
              <select
                value={size.impact}
                onChange={(e) => setSize({ ...size, impact: Number(e.target.value) })}
                className={`${inputClass} w-24`}
              >
                {[3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {numbers.format(n)}
                  </option>
                ))}
              </select>
            </Field>
            <Button onClick={make} disabled={busy}>
              {s.newVersion}
            </Button>
            <p className="basis-full text-xs text-muted">{s.newVersionHelp}</p>
            {error && (
              <p role="alert" className="basis-full text-sm text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </Panel>
      {matrix && matrix.id === shownId && (
        <MatrixEditor
          key={`${matrix.id}-${matrix.revision}`}
          t={t}
          lang={lang}
          matrix={matrix}
          committees={settings.committees}
          writes={writes}
          onChanged={refresh}
          onReplaced={(next) => {
            setMatrix(next);
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** A whole new matrix of another size, filled from the version in use. */
function resized(from: Matrix, likelihoodLevels: number, impactLevels: number) {
  const level = (axis: "likelihood" | "impact", n: number) => {
    const known = from[axis].find((l) => l.level === n);
    return {
      axis,
      level: n,
      label: known?.label ?? { [Object.keys(from[axis][0]?.label ?? { en: "" })[0] ?? "en"]: String(n) },
      descriptor: known?.descriptor ?? null,
      frequency: axis === "likelihood" ? (known?.frequency ?? null) : null,
    };
  };
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  return {
    likelihoodLevels,
    impactLevels,
    levels: [
      ...range(likelihoodLevels).map((n) => level("likelihood", n)),
      ...range(impactLevels).map((n) => level("impact", n)),
    ],
    domains: from.domains.map((d) => ({
      name: d.name,
      descriptors: Object.fromEntries(
        Object.entries(d.descriptors).filter(([k]) => Number(k) <= impactLevels),
      ),
      position: d.position,
      active: d.active,
    })),
    bands: from.bands.map((b) => ({
      code: b.code,
      name: b.name,
      reviewIntervalDays: b.reviewIntervalDays,
      escalateToCommitteeId: b.escalateToCommitteeId,
      acceptanceNeedsSignature: b.acceptanceNeedsSignature,
    })),
    // Each place takes the band of the nearest place of the old size, so
    // the bands still rise with likelihood and impact.
    cells: range(likelihoodLevels).flatMap((l) =>
      range(impactLevels).map((i) => ({
        likelihood: l,
        impact: i,
        band:
          bandAt(from, Math.min(l, from.likelihoodLevels), Math.min(i, from.impactLevels)) ?? "low",
      })),
    ),
  };
}

function MatrixEditor({
  t,
  lang,
  matrix,
  committees,
  writes,
  onChanged,
  onReplaced,
}: RisksProps & {
  matrix: Matrix;
  committees: Committee[];
  writes: boolean;
  onChanged: () => void;
  onReplaced: (m: Matrix) => void;
}) {
  const session = useSession();
  const locales = session.tenant.locales;
  const word = useBandWord(t, lang, matrix);
  const inLang = usePick(lang);
  const explain = useExplain(t, lang);
  const numbers = numberFormat(lang);
  const [cells, setCells] = useState(matrix.cells);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const s = t.settings.matrix;
  const draft = matrix.status === "draft";
  const editable = writes && matrix.status !== "retired";
  const preview = { ...matrix, cells };

  async function act(path: "put-in-use" | "discard") {
    setBusy(true);
    setError(null);
    try {
      const answer = await api<Matrix & { risksRebanded?: number; risksOutOfRange?: number }>(
        `/risks/settings/matrices/${matrix.id}/${path}`,
        { method: "POST", body: { revision: matrix.revision } },
      );
      setConfirming(false);
      setDone(
        path === "put-in-use"
          ? fill(s.putInUseDone, {
              rebanded: numbers.format(answer.risksRebanded ?? 0),
              outOfRange: numbers.format(answer.risksOutOfRange ?? 0),
            })
          : s.discarded,
      );
      onReplaced(answer);
    } catch (err) {
      setError(isStale(err) ? t.stale : explain(err));
      if (isStale(err)) onChanged();
    }
    setBusy(false);
  }

  return (
    <Panel title={fill(s.version, { version: numbers.format(matrix.version) })}>
      <div className="flex flex-col gap-6 p-4">
        {done && <p role="status" className="text-sm text-accent">{done}</p>}
        <p className="text-sm text-muted">
          {draft ? s.draftHelp : matrix.status === "in_use" ? s.inUseHelp : s.retiredHelp}
        </p>
        <MatrixGrid t={t} lang={lang} matrix={preview} ratings={{}} word={word} />

        <SettingsForm
          t={t}
          lang={lang}
          disabled={!editable}
          onDone={onChanged}
          onSubmit={(data) => {
            const level = (axis: "likelihood" | "impact", n: number) => ({
              axis,
              level: n,
              label: localizedOf(data, `${axis}${n}Label`, locales),
              descriptor: localizedOf(data, `${axis}${n}Descriptor`, locales),
              frequency: axis === "likelihood" ? localizedOf(data, `${axis}${n}Frequency`, locales) : null,
            });
            return api(`/risks/settings/matrices/${matrix.id}`, {
              method: "PATCH",
              body: {
                revision: matrix.revision,
                levels: [
                  ...matrix.likelihood.map((l) => level("likelihood", l.level)),
                  ...matrix.impact.map((l) => level("impact", l.level)),
                ],
                domains: matrix.domains.map((d) => ({
                  id: d.id,
                  name: localizedOf(data, `domain-${d.id}-name`, locales),
                  descriptors: Object.fromEntries(
                    matrix.impact.map((l) => [String(l.level), localizedOf(data, `domain-${d.id}-${l.level}`, locales)]),
                  ),
                  position: d.position,
                  active: data.get(`domain-${d.id}-active`) === "on",
                })),
                bands: matrix.bands.map((b) => ({
                  code: b.code,
                  name: localizedOf(data, `band-${b.code}-name`, locales),
                  ...(draft
                    ? {
                        reviewIntervalDays: Number(data.get(`band-${b.code}-days`)),
                        escalateToCommitteeId: textOf(data, `band-${b.code}-committee`) ?? null,
                        acceptanceNeedsSignature:
                          b.code === "high" || b.code === "extreme" || data.get(`band-${b.code}-sign`) === "on",
                      }
                    : {}),
                })),
                ...(draft ? { cells } : {}),
              },
            });
          }}
        >
          {(["likelihood", "impact"] as const).map((axis) => (
            <fieldset key={axis} className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-semibold">{t.axis[axis]}</legend>
              {matrix[axis].map((l) => (
                <details key={l.level} className="rounded-md border border-line">
                  <summary className="cursor-pointer px-3 py-2 text-sm">
                    <span className="tabular-nums">{numbers.format(l.level)}</span> <bdi>{inLang(l.label)}</bdi>
                  </summary>
                  <div className="flex flex-col gap-3 p-3">
                    <LocalizedField label={s.label} name={`${axis}${l.level}Label`} locales={locales} required={session.tenant.defaultLocale} value={l.label} />
                    {axis === "likelihood" && (
                      <LocalizedField label={s.frequency} name={`${axis}${l.level}Frequency`} locales={locales} maxLength={1000} value={l.frequency} />
                    )}
                    <LocalizedField label={s.descriptor} name={`${axis}${l.level}Descriptor`} locales={locales} multiline maxLength={1000} value={l.descriptor} />
                  </div>
                </details>
              ))}
            </fieldset>
          ))}

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold">{s.bands}</legend>
            {!draft && <p className="text-xs text-muted">{t.settings.newVersionNeeded}</p>}
            {matrix.bands.map((b) => (
              <div key={b.code} className="flex flex-col gap-3 rounded-md border border-line p-3">
                <BandPill band={b.code} word={word} lang={lang} />
                <LocalizedField label={s.bandName} name={`band-${b.code}-name`} locales={locales} required={session.tenant.defaultLocale} value={b.name} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={s.reviewInterval} help={s.reviewIntervalHelp}>
                    <input
                      type="number"
                      name={`band-${b.code}-days`}
                      min={1}
                      max={730}
                      required
                      dir="ltr"
                      disabled={!draft}
                      defaultValue={b.reviewIntervalDays}
                      className={`${inputClass} sm:max-w-32`}
                    />
                  </Field>
                  <Field label={s.escalateTo}>
                    <select
                      name={`band-${b.code}-committee`}
                      disabled={!draft}
                      defaultValue={b.escalateToCommitteeId ?? ""}
                      className={inputClass}
                    >
                      <option value="">{t.none}</option>
                      {committees.map((x) => (
                        <option key={x.id} value={x.id}>
                          {inLang(x.name)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`band-${b.code}-sign`}
                    disabled={!draft || b.code === "high" || b.code === "extreme"}
                    defaultChecked={b.acceptanceNeedsSignature || b.code === "high" || b.code === "extreme"}
                    className="size-4 accent-accent"
                  />
                  {s.signature}
                </label>
              </div>
            ))}
          </fieldset>

          {draft && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-semibold">{s.cells}</legend>
              <p className="text-xs text-muted">{s.cellsHelp}</p>
              <div className="overflow-x-auto">
                <table className="border-collapse text-xs">
                  <thead>
                    <tr>
                      <td />
                      {matrix.impact.map((i) => (
                        <th key={i.level} scope="col" className="p-1 font-normal text-muted">
                          {numbers.format(i.level)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...matrix.likelihood].reverse().map((l) => (
                      <tr key={l.level}>
                        <th scope="row" className="pe-2 text-end font-normal text-muted">
                          {numbers.format(l.level)}
                        </th>
                        {matrix.impact.map((i) => {
                          const band = cells.find((c) => c.likelihood === l.level && c.impact === i.level)?.band ?? "low";
                          return (
                            <td key={i.level} className="p-0.5">
                              <select
                                aria-label={fill(s.cellLabel, {
                                  likelihood: inLang(l.label),
                                  impact: inLang(i.label),
                                })}
                                value={band}
                                onChange={(e) =>
                                  setCells(
                                    cells.map((c) =>
                                      c.likelihood === l.level && c.impact === i.level
                                        ? { ...c, band: e.target.value as Band }
                                        : c,
                                    ),
                                  )
                                }
                                className="h-9 rounded border border-line bg-background px-1 text-xs"
                              >
                                {bands.map((x) => (
                                  <option key={x} value={x}>
                                    {word(x)}
                                  </option>
                                ))}
                              </select>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-semibold">{s.domains}</legend>
            {matrix.domains.map((d) => (
              <details key={d.id} className="rounded-md border border-line">
                <summary className="cursor-pointer px-3 py-2 text-sm">
                  <bdi>{inLang(d.name)}</bdi>
                  {!d.active && <span className="ms-2 text-xs text-muted">{s.domainOff}</span>}
                </summary>
                <div className="flex flex-col gap-3 p-3">
                  <LocalizedField label={s.domainName} name={`domain-${d.id}-name`} locales={locales} required={session.tenant.defaultLocale} value={d.name} />
                  {matrix.impact.map((l) => (
                    <LocalizedField
                      key={l.level}
                      label={fill(s.domainLevel, { level: numbers.format(l.level), label: inLang(l.label) })}
                      name={`domain-${d.id}-${l.level}`}
                      locales={locales}
                      multiline
                      maxLength={1000}
                      value={d.descriptors[String(l.level)]}
                    />
                  ))}
                  <label className="flex min-h-9 items-center gap-2 text-sm">
                    <input type="checkbox" name={`domain-${d.id}-active`} defaultChecked={d.active} className="size-4 accent-accent" />
                    {s.domainActive}
                  </label>
                </div>
              </details>
            ))}
          </fieldset>
        </SettingsForm>

        {writes && draft && (
          <div className="flex flex-col gap-3 border-t border-line pt-4">
            {confirming ? (
              <div className="flex flex-col gap-3 rounded-md border border-warn bg-warn-soft p-3">
                <p className="text-sm">
                  {fill(t.settings.putInUseConfirm, {
                    changing: numbers.format(matrix.preview?.risksChangingBand ?? 0),
                    outOfRange: numbers.format(matrix.preview?.risksOutOfRange ?? 0),
                  })}
                </p>
                {(matrix.preview?.risksTargetAboveCurrent ?? 0) > 0 && (
                  <p className="text-sm">
                    {fill(s.targetAbove, { count: numbers.format(matrix.preview?.risksTargetAboveCurrent ?? 0) })}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => act("put-in-use")} disabled={busy}>
                    {s.putInUse}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
                    {t.cancel}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setConfirming(true)}>{s.putInUse}</Button>
                <Button variant="secondary" onClick={() => act("discard")} disabled={busy}>
                  {s.discard}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted">{s.saveFirst}</p>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function Categories({
  t,
  lang,
  settings,
  writes,
  onChanged,
}: RisksProps & { settings: RiskSettings; writes: boolean; onChanged: () => void }) {
  const session = useSession();
  const locales = session.tenant.locales;
  const word = useBandWord(t, lang, settings.matrix);
  const inLang = usePick(lang);
  const [list, setList] = useState<Category[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const s = t.settings.categories;

  useEffect(() => {
    let current = true;
    api<Category[]>("/risks/settings/categories?includeInactive=true")
      .then((next) => {
        if (!current) return;
        setList(next);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [round]);

  if (failed) return <EmptyState>{t.loadError}</EmptyState>;
  if (!list) return <EmptyState>{t.loading}</EmptyState>;
  const done = () => {
    setEditing(null);
    setRound((n) => n + 1);
    onChanged();
  };
  const form = (category: Category | null) => (
    <SettingsForm
      key={category?.id ?? "new"}
      t={t}
      lang={lang}
      onDone={done}
      extra={
        <Button variant="secondary" onClick={() => setEditing(null)}>
          {t.cancel}
        </Button>
      }
      onSubmit={(data) => {
        const body = {
          name: localizedOf(data, "name", locales),
          position: Number(data.get("position") || 0),
          appetite: textOf(data, "appetite"),
          appetiteStatement: localizedOf(data, "appetiteStatement", locales),
          toleranceBand: textOf(data, "toleranceBand"),
        };
        return category
          ? api(`/risks/settings/categories/${category.id}`, {
              method: "PATCH",
              body: { revision: category.revision, ...body, active: data.get("active") === "on" },
            })
          : api("/risks/settings/categories", { method: "POST", body: { code: textOf(data, "code"), ...body } });
      }}
    >
      {!category && (
        <Field label={s.code} help={s.codeHelp}>
          <input name="code" required pattern="[a-z][a-z0-9_]{1,39}" maxLength={40} dir="ltr" className={`${inputClass} sm:max-w-64`} />
        </Field>
      )}
      <LocalizedField label={s.name} name="name" locales={locales} required={session.tenant.defaultLocale} value={category?.name} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={s.appetite}>
          <select name="appetite" required defaultValue={category?.appetite ?? "cautious"} className={inputClass}>
            {appetites.map((a) => (
              <option key={a} value={a}>
                {t.appetite[a]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={s.tolerance} help={s.toleranceHelp}>
          <select name="toleranceBand" required defaultValue={category?.toleranceBand ?? "medium"} className={inputClass}>
            {bands.map((b) => (
              <option key={b} value={b}>
                {word(b)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={s.position}>
          <input type="number" name="position" min={0} max={1000} dir="ltr" defaultValue={category?.position ?? 0} className={inputClass} />
        </Field>
      </div>
      <LocalizedField label={s.statement} name="appetiteStatement" locales={locales} multiline maxLength={1000} value={category?.appetiteStatement} />
      {category && (
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={category.active} className="size-4 accent-accent" />
          {s.active}
        </label>
      )}
    </SettingsForm>
  );
  return (
    <Panel title={t.settings.tabs.categories}>
      <ul>
        {list.map((c) => (
          <li key={c.id} className="border-b border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium"><bdi>{inLang(c.name)}</bdi></span>
              {!c.active && <Pill tone="neutral">{s.inactive}</Pill>}
              <span className="text-xs text-muted">{fill(s.appetiteIs, { appetite: t.appetite[c.appetite] })}</span>
              <BandPill band={c.toleranceBand} word={word} lang={lang} label={s.tolerance} />
            </div>
            {writes && editing !== c && (
              <button type="button" onClick={() => setEditing(c)} className="mt-1 text-xs font-medium text-accent hover:underline">
                {t.moves.edit}
              </button>
            )}
            {editing === c && <div className="mt-3">{form(c)}</div>}
          </li>
        ))}
      </ul>
      {writes && (
        <div className="p-4">
          {editing === "new" ? form(null) : (
            <Button variant="secondary" onClick={() => setEditing("new")}>
              {s.add}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

function Committees({
  t,
  lang,
  writes,
  onChanged,
}: RisksProps & { writes: boolean; onChanged: () => void }) {
  const session = useSession();
  const locales = session.tenant.locales;
  const inLang = usePick(lang);
  const [list, setList] = useState<Committee[] | null>(null);
  const [roles, setRoles] = useState<PickerRole[]>([]);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  const [editing, setEditing] = useState<Committee | "new" | null>(null);
  const s = t.settings.committees;

  useEffect(() => {
    let current = true;
    api<Committee[]>("/risks/settings/committees?includeInactive=true")
      .then((next) => {
        if (!current) return;
        setList(next);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    api<PickerRole[]>("/risks/roles")
      .then((next) => current && setRoles(next))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [round]);

  if (failed) return <EmptyState>{t.loadError}</EmptyState>;
  if (!list) return <EmptyState>{t.loading}</EmptyState>;
  const roleName = (id: string | null) => (id ? inLang(roles.find((r) => r.id === id)?.name) || t.someone : null);
  const done = () => {
    setEditing(null);
    setRound((n) => n + 1);
    onChanged();
  };
  const roleSelect = (name: string, label: string, value: string | null) => (
    <Field label={label}>
      <select name={name} defaultValue={value ?? ""} className={inputClass}>
        <option value="">{t.none}</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {inLang(r.name)}
          </option>
        ))}
      </select>
    </Field>
  );
  const form = (committee: Committee | null) => (
    <SettingsForm
      key={committee?.id ?? "new"}
      t={t}
      lang={lang}
      onDone={done}
      extra={
        <Button variant="secondary" onClick={() => setEditing(null)}>
          {t.cancel}
        </Button>
      }
      onSubmit={(data) => {
        const body = {
          name: localizedOf(data, "name", locales),
          position: Number(data.get("position") || 0),
          memberRoleId: textOf(data, "memberRoleId") ?? null,
          chairRoleId: textOf(data, "chairRoleId") ?? null,
        };
        return committee
          ? api(`/risks/settings/committees/${committee.id}`, {
              method: "PATCH",
              body: { revision: committee.revision, ...body, active: data.get("active") === "on" },
            })
          : api("/risks/settings/committees", { method: "POST", body: { code: textOf(data, "code"), ...body } });
      }}
    >
      {!committee && (
        <Field label={t.settings.categories.code} help={t.settings.categories.codeHelp}>
          <input name="code" required pattern="[a-z][a-z0-9_]{1,39}" maxLength={40} dir="ltr" className={`${inputClass} sm:max-w-64`} />
        </Field>
      )}
      <LocalizedField label={s.name} name="name" locales={locales} required={session.tenant.defaultLocale} value={committee?.name} />
      <div className="grid gap-3 sm:grid-cols-3">
        {roleSelect("memberRoleId", s.memberRole, committee?.memberRoleId ?? null)}
        {roleSelect("chairRoleId", s.chairRole, committee?.chairRoleId ?? null)}
        <Field label={t.settings.categories.position}>
          <input type="number" name="position" min={0} max={1000} dir="ltr" defaultValue={committee?.position ?? 0} className={inputClass} />
        </Field>
      </div>
      <p className="text-xs text-muted">{s.membersHelp}</p>
      {committee && (
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={committee.active} className="size-4 accent-accent" />
          {t.settings.categories.active}
        </label>
      )}
    </SettingsForm>
  );
  return (
    <Panel title={t.settings.tabs.committees}>
      <ul>
        {list.map((c) => (
          <li key={c.id} className="border-b border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/${lang}/risks/committees/${c.id}`} className="text-sm font-medium text-accent hover:underline">
                <bdi>{inLang(c.name)}</bdi>
              </Link>
              {!c.active && <Pill tone="neutral">{t.settings.categories.inactive}</Pill>}
            </div>
            {c.memberRoleId ? (
              <p className="mt-1 text-xs text-muted">
                {fill(s.members, { role: roleName(c.memberRoleId) ?? "" })}
                {c.chairRoleId && <> · {fill(s.chair, { role: roleName(c.chairRoleId) ?? "" })}</>}
              </p>
            ) : (
              <p className="mt-1 text-sm text-warn">{t.settings.committeeNoRole}</p>
            )}
            {writes && editing !== c && (
              <button type="button" onClick={() => setEditing(c)} className="mt-1 text-xs font-medium text-accent hover:underline">
                {t.moves.edit}
              </button>
            )}
            {editing === c && <div className="mt-3">{form(c)}</div>}
          </li>
        ))}
      </ul>
      {writes && (
        <div className="p-4">
          {editing === "new" ? form(null) : (
            <Button variant="secondary" onClick={() => setEditing("new")}>
              {s.add}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

type StepDraft = { kind: "review" | "approve"; who: string; dueInDays: number };

function Routes({ t, lang, writes }: RisksProps & { writes: boolean }) {
  const inLang = usePick(lang);
  const [list, setList] = useState<ApprovalRoute[] | null>(null);
  const [roles, setRoles] = useState<PickerRole[]>([]);
  const [people, setPeople] = useState<PickerPerson[]>([]);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const s = t.settings.routes;
  const numbers = numberFormat(lang);

  useEffect(() => {
    let current = true;
    api<{ items: ApprovalRoute[] }>("/risks/settings/approval-routes")
      .then((next) => {
        if (!current) return;
        setList(next.items);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    api<PickerRole[]>("/risks/roles")
      .then((next) => current && setRoles(next))
      .catch(() => {});
    api<PickerPerson[]>("/risks/people")
      .then((next) => current && setPeople(next))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [round]);

  if (failed) return <EmptyState>{t.loadError}</EmptyState>;
  if (!list) return <EmptyState>{t.loading}</EmptyState>;
  const variants = [
    { subject: "risk_acceptance", variant: "medium" },
    { subject: "risk_acceptance", variant: "high" },
    { subject: "risk_acceptance", variant: "extreme" },
    { subject: "risk_closure", variant: null },
  ] as const;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{s.description}</p>
      {variants.map((v) => {
        const key = `${v.subject}-${v.variant ?? "closure"}`;
        const route = list.find((r) => r.subject === v.subject && r.variant === v.variant);
        return (
          <Panel key={key} title={s.variant[v.variant ?? "closure"]}>
            <div className="p-4">
              {route ? (
                <>
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <bdi>{inLang(route.name)}</bdi>
                    {!route.active && <Pill tone="neutral">{t.settings.categories.inactive}</Pill>}
                  </p>
                  <ol className="mt-2 flex flex-col gap-1 border-s-2 border-line ps-3 text-sm">
                    {route.steps.map((step) => (
                      <li key={step.position}>
                        {fill(t.steps.position, { position: numbers.format(step.position) })} · {t.steps.kind[step.kind]} ·{" "}
                        <bdi>{inLang(step.userName ?? step.roleName) || t.someone}</bdi> ·{" "}
                        {fill(s.dueIn, { days: numbers.format(step.dueInDays) })}
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <p className="text-sm text-muted">{s.none}</p>
              )}
              {writes && editing !== key && (
                <button type="button" onClick={() => setEditing(key)} className="mt-2 text-xs font-medium text-accent hover:underline">
                  {route ? t.moves.edit : s.add}
                </button>
              )}
              {writes && editing === key && (
                <div className="mt-3">
                  <RouteForm
                    t={t}
                    lang={lang}
                    route={route ?? null}
                    subject={v.subject}
                    variant={v.variant}
                    roles={roles}
                    people={people}
                    onClose={() => setEditing(null)}
                    onDone={() => {
                      setEditing(null);
                      setRound((n) => n + 1);
                    }}
                  />
                </div>
              )}
            </div>
          </Panel>
        );
      })}
    </div>
  );
}

function RouteForm({
  t,
  lang,
  route,
  subject,
  variant,
  roles,
  people,
  onClose,
  onDone,
}: RisksProps & {
  route: ApprovalRoute | null;
  subject: "risk_acceptance" | "risk_closure";
  variant: "medium" | "high" | "extreme" | null;
  roles: PickerRole[];
  people: PickerPerson[];
  onClose: () => void;
  onDone: () => void;
}) {
  const session = useSession();
  const locales = session.tenant.locales;
  const inLang = usePick(lang);
  const s = t.settings.routes;
  const [steps, setSteps] = useState<StepDraft[]>(
    route?.steps.map((x) => ({
      kind: x.kind,
      who: x.userId ? `user:${x.userId}` : `role:${x.roleId}`,
      dueInDays: x.dueInDays,
    })) ?? [{ kind: "approve", who: "", dueInDays: 5 }],
  );
  const set = (i: number, next: Partial<StepDraft>) =>
    setSteps(steps.map((x, j) => (j === i ? { ...x, ...next } : x)));
  return (
    <SettingsForm
      t={t}
      lang={lang}
      onDone={onDone}
      extra={
        <Button variant="secondary" onClick={onClose}>
          {t.cancel}
        </Button>
      }
      onSubmit={(data) => {
        const body = {
          name: localizedOf(data, "name", locales),
          steps: steps.map((x) => {
            const [kind, id] = x.who.split(":");
            return { kind: x.kind, ...(kind === "user" ? { userId: id } : { roleId: id }), dueInDays: x.dueInDays };
          }),
        };
        return route
          ? api(`/risks/settings/approval-routes/${route.id}`, {
              method: "PATCH",
              body: { revision: route.revision, ...body, active: data.get("active") === "on" },
            })
          : api("/risks/settings/approval-routes", { method: "POST", body: { subject, variant, ...body } });
      }}
    >
      <LocalizedField label={s.name} name="name" locales={locales} required={session.tenant.defaultLocale} value={route?.name} />
      <ol className="flex flex-col gap-3">
        {steps.map((x, i) => (
          <li key={i} className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-end">
            <Field label={fill(t.steps.position, { position: String(i + 1) })}>
              <select value={x.kind} onChange={(e) => set(i, { kind: e.target.value as StepDraft["kind"] })} className={inputClass}>
                <option value="review">{t.steps.kind.review}</option>
                <option value="approve">{t.steps.kind.approve}</option>
              </select>
            </Field>
            <Field label={s.who}>
              <select value={x.who} required onChange={(e) => set(i, { who: e.target.value })} className={inputClass}>
                <option value="" disabled>
                  {t.choose}
                </option>
                <optgroup label={s.roles}>
                  {roles.map((r) => (
                    <option key={r.id} value={`role:${r.id}`}>
                      {inLang(r.name)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={s.people}>
                  {people.map((p) => (
                    <option key={p.id} value={`user:${p.id}`}>
                      {inLang(p.name)}
                    </option>
                  ))}
                </optgroup>
              </select>
            </Field>
            <Field label={s.days}>
              <input
                type="number"
                min={1}
                max={365}
                required
                dir="ltr"
                value={x.dueInDays}
                onChange={(e) => set(i, { dueInDays: Number(e.target.value) })}
                className={`${inputClass} w-24`}
              />
            </Field>
            <Button variant="secondary" disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
              {s.removeStep}
            </Button>
          </li>
        ))}
      </ol>
      <div>
        <Button
          variant="secondary"
          disabled={steps.length >= 10}
          onClick={() => setSteps([...steps, { kind: "approve", who: "", dueInDays: 5 }])}
        >
          {s.addStep}
        </Button>
      </div>
      <p className="text-xs text-muted">{s.lastApproves}</p>
      {route && (
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={route.active} className="size-4 accent-accent" />
          {t.settings.categories.active}
        </label>
      )}
    </SettingsForm>
  );
}
