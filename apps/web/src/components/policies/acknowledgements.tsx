"use client";

import { FileDown } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, codeOf, download, statusOf } from "@/lib/api";
import {
  dateTimeFormat,
  dayFormat,
  fill,
  languageNameIn,
  numberFormat,
} from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import {
  documentPath,
  type AcknowledgementFigures,
  type History,
  type PolicyDocument,
} from "@/lib/policies";
import { VersionStatusPill } from "./pills";
import type { PoliciesProps } from "./types";
import { useExplain } from "./use-explain";

const PAGE_SIZE = 100;
const states = ["", "pending", "overdue", "acknowledged"] as const;
type State = (typeof states)[number];

/** A share as the reader's language writes it, to one decimal: "83.5%". */
export function percentOf(lang: string, value: number | null) {
  if (value === null) return null;
  return new Intl.NumberFormat(
    new Intl.Locale(lang, { numberingSystem: "latn" }).toString(),
    { style: "percent", maximumFractionDigits: 1 },
  ).format(value / 100);
}

/**
 * Who has acknowledged a published version and who has not, by unit and
 * by person: the version in force first, or any earlier one (who had
 * acknowledged the version in force on a given day). People who have left
 * can be listed as evidence, and the whole list exported. For those with
 * full sight of the document only.
 */
export function Acknowledgements({ lang, t }: PoliciesProps) {
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const explainError = useExplain(t, lang);
  const [doc, setDoc] = useState<PolicyDocument | null>(null);
  const [versions, setVersions] = useState<History["versions"]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [withLeft, setWithLeft] = useState(false);
  const [state, setState] = useState<State>("");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [answer, setAnswer] = useState<{
    key: string;
    figures: AcknowledgementFigures;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useLayoutEffect(() => () => setExported(null), []);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const k = t.acknowledgements;
  const key = `${id}:${chosen}:${withLeft}:${state}:${page}`;

  useEffect(() => {
    let current = true;
    Promise.all([
      api<PolicyDocument>(`/policies/documents/${id}`),
      api<History>(`/policies/documents/${id}/versions`).catch(() => null),
    ])
      .then(async ([d, history]) => {
        if (!current) return;
        setDoc(d);
        const published = (history?.versions ?? []).filter((v) => v.publishedAt);
        setVersions(published);
        const versionId = chosen ?? d.published?.id ?? published[0]?.id;
        if (!versionId) return setProblem(k.notPublished);
        const query = new URLSearchParams({
          page: String(page),
          pageSize: String(PAGE_SIZE),
          ...(state ? { state } : {}),
          ...(withLeft ? { includeLeft: "true" } : {}),
        });
        const figures = await api<AcknowledgementFigures>(
          `/policies/documents/${id}/versions/${versionId}/acknowledgements?${query}`,
        );
        if (!current) return;
        setAnswer({ key, figures });
        setProblem(null);
      })
      .catch((err) => {
        if (!current) return;
        setProblem(
          codeOf(err) === "missing_permission"
            ? k.noAccess
            : statusOf(err) === 404
              ? t.notFound
              : t.loadError,
        );
      });
    return () => {
      current = false;
    };
  }, [id, chosen, withLeft, state, page, key, k, t]);

  async function exportFile(versionId: string) {
    setExporting(true);
    setExported(null);
    try {
      const locale = session.tenant.locales.includes(lang) ? lang : null;
      await download(
        `/policies/documents/${id}/versions/${versionId}/acknowledgements/export${
          locale ? `?${new URLSearchParams({ locale })}` : ""
        }`,
      );
      setExported({ ok: true, text: t.export.done });
    } catch (err) {
      setExported({ ok: false, text: explainError(err) });
    }
    setExporting(false);
  }
  // The file is in the reader's language when the client uses it.
  const fileLanguage = languageNameIn(lang)(
    session.tenant.locales.includes(lang) ? lang : session.tenant.defaultLocale,
  );

  const figures = answer?.key === key ? answer.figures : null;
  const shownDoc = doc?.id === id ? doc : null;

  const chip = (on: boolean) =>
    `inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap ${
      on
        ? "border-accent bg-accent-soft font-medium text-accent"
        : "border-line text-muted hover:bg-surface hover:text-foreground"
    }`;
  const pages = figures
    ? Math.max(1, Math.ceil(figures.people.total / PAGE_SIZE))
    : 1;

  return (
    <>
      <PageHeader
        title={k.title}
        description={
          shownDoc ? (
            <>
              <bdi dir="ltr" className="whitespace-nowrap">
                {shownDoc.number}
              </bdi>{" "}
              <span className="inline-block">
                {"· "}
                <bdi>{inLang(shownDoc.title)}</bdi>
              </span>
            </>
          ) : undefined
        }
      />
      {problem ? (
        <EmptyState>{problem}</EmptyState>
      ) : !figures ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            {versions.length > 1 && (
              <div className="w-full max-w-xs">
                <Field label={k.versionLabel}>
                  <select
                    value={figures.versionId}
                    onChange={(e) => {
                      setChosen(e.target.value);
                      setPage(1);
                    }}
                    className={inputClass}
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {fill(k.versionOption, {
                          version: numbers.format(v.version),
                          status: Object.hasOwn(t.versionStatus, v.status)
                            ? t.versionStatus[v.status as keyof typeof t.versionStatus]
                            : t.versionStatus.other,
                        })}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
            <div className="flex flex-col items-start gap-1">
              <Button
                variant="secondary"
                // A long label in some languages: it wraps on a phone.
                className="h-auto! min-h-9 py-1.5 text-start whitespace-normal!"
                disabled={exporting}
                onClick={() => exportFile(figures.versionId)}
              >
                <FileDown className="size-4" aria-hidden />
                {exporting ? t.export.preparing : t.export.acknowledgements}
              </Button>
              <p className="max-w-sm text-xs text-muted">
                {fill(t.export.acknowledgementsHelp, { language: fileLanguage })}
              </p>
              {exported && (
                <p
                  role={exported.ok ? "status" : "alert"}
                  className={`text-xs ${exported.ok ? "text-accent" : "text-danger"}`}
                >
                  {exported.text}
                </p>
              )}
            </div>
          </div>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {fill(t.versionNumber, { version: numbers.format(figures.version) })}
            <VersionStatusPill t={t} status={figures.status} />
          </p>
          {!figures.acknowledgementRequired && (
            <p className="text-sm text-muted">{k.notRequired}</p>
          )}
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(
              [
                [k.targeted, numbers.format(figures.targeted)],
                [k.acknowledged, numbers.format(figures.acknowledged)],
                [k.pending, numbers.format(figures.pending)],
                [k.overdue, numbers.format(figures.overdue)],
              ] as const
            ).map(([label, value], i) => (
              <div
                key={label}
                className={`rounded-lg border p-4 ${
                  i === 3 && figures.overdue > 0
                    ? "border-danger bg-danger-soft"
                    : "border-line"
                }`}
              >
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="mt-2 text-2xl font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            {fill(k.completion, {
              percent: percentOf(lang, figures.percent) ?? "–",
              version: numbers.format(figures.version),
            })}
          </p>

          <Panel title={k.byUnit}>
            {figures.byUnit.length === 0 ? (
              <EmptyState>{k.nobody}</EmptyState>
            ) : (
              <ul>
                {figures.byUnit.map((row, i) => (
                  <li
                    key={row.orgUnit?.id ?? `none-${i}`}
                    className="flex flex-col gap-1.5 border-b border-line px-4 py-3 text-sm last:border-b-0"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <bdi className="font-medium">
                        {row.orgUnit ? inLang(row.orgUnit.name) : k.noUnit}
                      </bdi>
                      <span className="tabular-nums">
                        {fill(k.unitFigures, {
                          acknowledged: numbers.format(row.acknowledged),
                          targeted: numbers.format(row.targeted),
                          percent: percentOf(lang, row.percent) ?? "–",
                        })}
                      </span>
                    </div>
                    <div
                      aria-hidden
                      className="h-2 overflow-hidden rounded-full border border-line bg-surface"
                    >
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${row.percent ?? 0}%` }}
                      />
                    </div>
                    {row.overdue > 0 && (
                      <p className="text-xs font-medium text-danger">
                        {fill(k.unitOverdue, { count: numbers.format(row.overdue) })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={k.people}>
            <div
              role="group"
              aria-label={k.filterLabel}
              className="flex flex-wrap gap-2 px-4 pt-3"
            >
              <label className="flex min-h-9 w-full items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={withLeft}
                  onChange={(e) => {
                    setWithLeft(e.target.checked);
                    setPage(1);
                  }}
                  className="size-4 accent-accent"
                />
                {k.includeLeft}
              </label>
              {withLeft && (
                <p className="w-full text-xs text-muted">{k.leftHelp}</p>
              )}
              {states.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={state === s}
                  onClick={() => {
                    setState(s);
                    setPage(1);
                  }}
                  className={chip(state === s)}
                >
                  {s ? k.states[s] : k.all}
                </button>
              ))}
            </div>
            {figures.people.items.length === 0 ? (
              <EmptyState>{k.nobodyHere}</EmptyState>
            ) : (
              <ul className="mt-3">
                {figures.people.items.map((p) => (
                  <li
                    key={p.user.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-sm"
                  >
                    <span>
                      <bdi className="font-medium">
                        {inLang(p.user.name) || t.document.unknownPerson}
                      </bdi>
                      {p.orgUnit && (
                        <span className="text-muted">
                          {" · "}
                          <bdi>{inLang(p.orgUnit.name)}</bdi>
                        </span>
                      )}
                      {p.left && (
                        <span className="ms-2 inline-block align-middle">
                          <Pill tone="neutral">{k.left}</Pill>
                        </span>
                      )}
                    </span>
                    {p.acknowledgedAt ? (
                      <Pill tone="ok">
                        {fill(k.acknowledgedOn, {
                          date: moments.format(new Date(p.acknowledgedAt)),
                        })}
                      </Pill>
                    ) : (
                      <Pill tone={p.overdue ? "danger" : "neutral"}>
                        {fill(p.overdue ? k.wasDue : k.dueOn, {
                          date: day(p.dueOn) ?? "",
                        })}
                      </Pill>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {pages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-sm text-muted">
                <span>
                  {fill(t.list.page, {
                    page: numbers.format(page),
                    pages: numbers.format(pages),
                  })}
                </span>
                <span className="flex gap-2">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                    {t.list.previous}
                  </Button>
                  <Button variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                    {t.list.next}
                  </Button>
                </span>
              </div>
            )}
          </Panel>
        </div>
      )}
      <p className="mt-6 text-sm">
        <Link href={documentPath(lang, id)} className="text-accent hover:underline">
          {t.review.backToDocument}
        </Link>
      </p>
    </>
  );
}
