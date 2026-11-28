"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { can, useSession } from "@/components/shell/session";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, momentFrom, numberFormat } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import type { Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import {
  committeePath,
  riskPath,
  type Mine,
  type RiskList,
  type RiskSummary,
} from "@/lib/risks";
import { BandPill, RiskRow, useBandWord, useNamer, usePick, useRiskSettings } from "./bits";
import { ActionRow } from "./risk-sections";
import type { RisksProps } from "./types";

/** My risks and actions: what I own, and the steps waiting for my signature. */
export function MyRisks({ lang, t }: RisksProps) {
  const session = useSession();
  const [data, setData] = useState<Mine | null>(null);
  const [failed, setFailed] = useState(false);
  const { settings } = useRiskSettings();
  const word = useBandWord(t, lang, settings?.matrix);
  const inLang = usePick(lang);
  const day = dayFormat(lang);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const numbers = numberFormat(lang);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  // What I own is mine: the names are mine and my organization's units.
  const names = {
    people: { ...data?.people, [session.user.id]: session.user.name },
    units: { ...Object.fromEntries(units.map((u) => [u.id, u.name])), ...data?.units },
    categories: Object.fromEntries((settings?.categories ?? []).map((c) => [c.id, c.name])),
    committees: Object.fromEntries((settings?.committees ?? []).map((c) => [c.id, c.name])),
  };
  const name = useNamer(lang, names, t);
  const m = t.mine;

  useEffect(() => {
    let current = true;
    api<Mine>("/risks/mine")
      .then((next) => {
        if (!current) return;
        setData(next);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    api<OrgUnit[]>("/org-units")
      .then((list) => current && setUnits(list))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  const state = failed ? t.loadError : !data ? t.loading : null;
  return (
    <>
      <PageHeader title={m.title} description={m.description} />
      <div className="mt-6 flex flex-col gap-6">
        {data && data.steps.length > 0 && (
          <Panel title={t.approvals.title}>
            <ul>
              {data.steps.map((s) => (
                <li key={`${s.runId}-${s.position}`} className="border-b border-line px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={riskPath(lang, s.riskId)} className="font-medium text-accent hover:underline">
                      <bdi dir="ltr">{s.reference}</bdi>
                    </Link>
                    <Pill tone="warn">{t.approvals.subject[s.subject]}</Pill>
                    {s.currentBand && <BandPill band={s.currentBand} word={word} lang={lang} />}
                    {s.overdue && <Pill tone="danger">{t.approvals.overdue}</Pill>}
                  </div>
                  <p className="mt-1 text-sm font-medium"><bdi>{inLang(s.title)}</bdi></p>
                  <p className="mt-1 text-xs text-muted">
                    {fill(t.steps.position, { position: numbers.format(s.position) })} · {t.steps.kind[s.step]}
                    {s.dueAt && <> · {fill(t.steps.due, { date: moments.format(momentFrom(s.dueAt) ?? new Date()) })}</>}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>
        )}
        <Panel title={m.risks}>
          {state ? (
            <EmptyState>{state}</EmptyState>
          ) : data!.risks.length === 0 ? (
            <EmptyState>{m.noRisks}</EmptyState>
          ) : (
            <ul>
              {data!.risks.map((risk) => (
                <RiskRow key={risk.id} t={t} lang={lang} risk={risk} names={names} word={word} />
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={m.actions}>
          {state ? (
            <EmptyState>{state}</EmptyState>
          ) : data!.actions.length === 0 ? (
            <EmptyState>{m.noActions}</EmptyState>
          ) : (
            <ul>
              {data!.actions.map((action) => (
                <ActionRow
                  key={action.id}
                  t={t}
                  lang={lang}
                  action={action}
                  person={name.person}
                  day={day}
                  inLang={inLang}
                  extra={
                    <Link href={riskPath(lang, action.risk.id)} className="text-xs text-accent hover:underline">
                      <bdi dir="ltr">{action.risk.reference}</bdi>
                    </Link>
                  }
                />
              ))}
            </ul>
          )}
        </Panel>
        {data && data.committees.length > 0 && (
          <Panel title={m.committees}>
            <ul>
              {data.committees.map((x) => (
                <li key={x.id} className="border-b border-line px-4 py-3 last:border-b-0">
                  <Link href={committeePath(lang, x.id)} className="font-medium text-accent hover:underline">
                    <bdi>{inLang(x.name)}</bdi>
                  </Link>
                  <span className="ms-2 text-sm text-muted">
                    {fill(m.committeeRisks, { count: numbers.format(x.risks) })}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}

/** The reviews due within 30 days and overdue, for those who manage risks. */
export function ReviewsDue({ lang, t }: RisksProps) {
  const session = useSession();
  const [state, setState] = useState<"" | "due" | "overdue">("");
  const [unitId, setUnitId] = useState("");
  const [answer, setAnswer] = useState<{ key: string; list: RiskList } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const { settings } = useRiskSettings();
  const word = useBandWord(t, lang, settings?.matrix);
  const inLang = usePick(lang);
  const key = `${state}|${unitId}`;
  const manages = can(session, "risks.manage");

  useEffect(() => {
    if (!manages) return;
    let current = true;
    const query = new URLSearchParams();
    if (state) query.set("state", state);
    if (unitId) query.set("unitId", unitId);
    api<RiskList>(`/risks/reviews?${query}`)
      .then((list) => current && setAnswer({ key, list }))
      .catch(() => current && setFailed(key));
    return () => {
      current = false;
    };
  }, [key, state, unitId, manages]);

  useEffect(() => {
    let current = true;
    api<OrgUnit[]>("/org-units")
      .then((list) => current && setUnits(list))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);

  if (!manages) return <EmptyState>{t.noAccess}</EmptyState>;
  const data = answer?.key === key ? answer.list : null;
  const names = {
    ...(data ?? { people: {}, units: {} }),
    categories: Object.fromEntries((settings?.categories ?? []).map((c) => [c.id, c.name])),
    committees: Object.fromEntries((settings?.committees ?? []).map((c) => [c.id, c.name])),
  };
  return (
    <>
      <PageHeader title={t.reviewsDue.title} description={t.reviewsDue.description} />
      <div className="mt-6 flex flex-wrap gap-3">
        <div className="min-w-0 basis-48">
          <Field label={t.list.reviewLabel}>
            <select value={state} onChange={(e) => setState(e.target.value as typeof state)} className={inputClass}>
              <option value="">{t.reviewsDue.both}</option>
              <option value="due">{t.review.due}</option>
              <option value="overdue">{t.review.overdue}</option>
            </select>
          </Field>
        </div>
        <div className="min-w-0 basis-64">
          <Field label={t.list.unit}>
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)} className={inputClass}>
              <option value="">{t.list.all}</option>
              {unitOptions(units, (u) => inLang(u.name)).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <div className="mt-4">
        <Panel>
          {!data && failed === key ? (
            <EmptyState>{t.loadError}</EmptyState>
          ) : !data ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : data.items.length === 0 ? (
            <EmptyState>{t.reviewsDue.empty}</EmptyState>
          ) : (
            <ul>
              {data.items.map((risk) => (
                <RiskRow key={risk.id} t={t} lang={lang} risk={risk} names={names} word={word} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

type CommitteeList = Omit<RiskList, "items"> & {
  committee: { id: string; name: Localized; active: boolean };
  items: (RiskSummary & { lastReview: { reviewedOn: string; committeeId: string | null } | null })[];
};

/** The risks before one committee, with its last review of each. */
export function CommitteeRisks({ lang, t }: RisksProps) {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<CommitteeList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { settings } = useRiskSettings();
  const word = useBandWord(t, lang, settings?.matrix);
  const inLang = usePick(lang);
  const day = dayFormat(lang);
  const name = useNamer(lang, data ?? { people: {}, units: {} }, t);

  useEffect(() => {
    let current = true;
    api<CommitteeList>(`/risks/committees/${id}/risks`)
      .then((next) => {
        if (!current) return;
        setData(next);
        setProblem(null);
      })
      .catch((err) => {
        if (!current) return;
        const status = statusOf(err);
        setProblem(status === 404 ? t.notFound : status === 403 ? t.committee.notMember : t.loadError);
      });
    return () => {
      current = false;
    };
  }, [id, t]);

  if (problem || !data || data.committee.id !== id) {
    return <EmptyState>{problem ?? t.loading}</EmptyState>;
  }
  return (
    <>
      <PageHeader
        title={<bdi>{inLang(data.committee.name)}</bdi>}
        description={t.committee.description}
      />
      {!data.committee.active && (
        <p className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-sm">{t.committee.inactive}</p>
      )}
      <div className="mt-6">
        <Panel title={t.committee.risks}>
          {data.items.length === 0 ? (
            <EmptyState>{t.committee.empty}</EmptyState>
          ) : (
            <ul>
              {data.items.map((risk) => (
                <RiskRow
                  key={risk.id}
                  t={t}
                  lang={lang}
                  risk={risk}
                  names={data}
                  word={word}
                  extra={
                    <span className="text-xs text-muted">
                      {risk.lastReview
                        ? risk.lastReview.committeeId
                          ? fill(t.review.byCommittee, {
                              committee: name.committee(risk.lastReview.committeeId),
                              day: day(risk.lastReview.reviewedOn) ?? "",
                            })
                          : fill(t.committee.lastReview, { day: day(risk.lastReview.reviewedOn) ?? "" })
                        : t.committee.noReview}
                    </span>
                  }
                />
              ))}
            </ul>
          )}
        </Panel>
        <p className="mt-3 text-sm text-muted">{t.committee.recordHelp}</p>
      </div>
    </>
  );
}
