"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { isReviewer } from "@/lib/identity";
import type { RiskList, RiskSummary } from "@/lib/risks";
import { RiskRow, useBandWord, usePick, useRiskSettings } from "./bits";
import type { RisksText } from "./types";
import { useExplain } from "./use-explain";

type ForIncident = Omit<RiskList, "total"> & {
  items: (RiskSummary & { linkKind: "raised" | "supports"; linkId: string })[];
  raise: { orgUnitId: string | null; impact: number | null; linkKind: "raised" } | null;
  mayLink: boolean;
};

/**
 * The risks an incident is linked to, on the incident's page, with
 * "Raise a risk" and "Link to a risk" for those who may. The incident's
 * description is never copied into a risk.
 */
export function IncidentRisks({
  lang,
  t,
  title,
  raiseLabel,
  incidentId,
}: {
  lang: string;
  t: RisksText;
  title: string;
  raiseLabel: string;
  incidentId: string;
}) {
  const session = useSession();
  const on = hasModule(session, "risks");
  const [data, setData] = useState<ForIncident | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  const [linking, setLinking] = useState(false);
  const [found, setFound] = useState<RiskList["items"] | null>(null);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { settings } = useRiskSettings();
  const word = useBandWord(t, lang, settings?.matrix);
  const inLang = usePick(lang);
  const explain = useExplain(t, lang);
  const reviewer = isReviewer(session);

  useEffect(() => {
    if (!on) return;
    let current = true;
    api<ForIncident>(`/risks/for-incident/${incidentId}`)
      .then((next) => {
        if (!current) return;
        setData(next);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [on, incidentId, round]);

  if (!on) return null;

  async function look(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get("q") ?? "").trim();
    if (!q) return;
    try {
      const list = await api<RiskList>(`/risks?${new URLSearchParams({ q, pageSize: "10" })}`);
      setFound(list.items.filter((x) => !data?.items.some((y) => y.id === x.id)));
      setChosen(list.items[0]?.id ?? "");
    } catch {
      setFound([]);
    }
  }

  async function link(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const kind = String(new FormData(form).get("kind") ?? "supports");
    setError(null);
    try {
      await api(`/risks/${chosen}/incident-links`, { method: "POST", body: { incidentId, kind } });
      form.reset();
      setFound(null);
      setLinking(false);
      setRound((n) => n + 1);
    } catch (err) {
      setError(explain(err));
    }
  }

  const names = data
    ? {
        people: data.people,
        units: data.units,
        categories: data.categories,
        committees: Object.fromEntries((settings?.committees ?? []).map((c) => [c.id, c.name])),
      }
    : {};

  return (
    <Panel title={title}>
      {failed ? (
        <EmptyState>{t.loadError}</EmptyState>
      ) : !data ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : data.items.length === 0 ? (
        <EmptyState>{t.incidents.noneLinked}</EmptyState>
      ) : (
        <ul>
          {data.items.map((risk) => (
            <RiskRow
              key={risk.linkId}
              t={t}
              lang={lang}
              risk={risk}
              names={names}
              word={word}
              extra={<Pill tone="neutral">{t.incidents.kind[risk.linkKind]}</Pill>}
            />
          ))}
        </ul>
      )}
      {data && !reviewer && (data.raise || data.mayLink) && (
        <div className="flex flex-col gap-3 border-t border-line p-4">
          <div className="flex flex-wrap gap-2">
            {data.raise && (
              <Link
                href={`/${lang}/risks/new?fromIncident=${incidentId}`}
                className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
              >
                {raiseLabel}
              </Link>
            )}
            {data.mayLink && (
              <Button variant="secondary" aria-expanded={linking} onClick={() => setLinking(!linking)}>
                {t.incidents.linkToRisk}
              </Button>
            )}
          </div>
          {linking && (
            <div className="flex flex-col gap-3">
              <form role="search" onSubmit={look} className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label={t.incidents.findRisk}>
                    <input name="q" type="search" dir="auto" maxLength={200} autoComplete="off" className={inputClass} />
                  </Field>
                </div>
                <Button type="submit" variant="secondary">
                  {t.list.searchButton}
                </Button>
              </form>
              {found && found.length === 0 && <p className="text-sm text-muted">{t.list.empty}</p>}
              {found && found.length > 0 && (
                <form onSubmit={link} className="flex flex-col gap-3">
                  <Field label={t.incidents.chooseRisk}>
                    <select value={chosen} onChange={(e) => setChosen(e.target.value)} className={inputClass}>
                      {found.map((x) => (
                        <option key={x.id} value={x.id}>
                          {`${x.reference} · ⁨${inLang(x.title)}⁩`}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium">{t.incidents.kindLabel}</legend>
                    <div className="flex flex-wrap gap-x-5 gap-y-2">
                      {(["supports", "raised"] as const).map((k) => (
                        <label key={k} className="flex min-h-9 items-center gap-2 text-sm">
                          <input type="radio" name="kind" value={k} defaultChecked={k === "supports"} className="accent-accent" />
                          {t.incidents.kind[k]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  {error && (
                    <p role="alert" className="text-sm text-danger">
                      {error}
                    </p>
                  )}
                  <div>
                    <Button type="submit">{t.incidents.link}</Button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
