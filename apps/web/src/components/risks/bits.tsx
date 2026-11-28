"use client";

import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  TriangleAlert,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { Pill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { dayFormat, fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import {
  bandTone,
  riskPath,
  type Band,
  type Matrix,
  type Names,
  type Rating,
  type RiskSettings,
  type RiskStatus,
  type RiskSummary,
  type Standing,
} from "@/lib/risks";
import type { RisksText } from "./types";

/**
 * The settings every risk screen reads: the matrix in use (the bands' names,
 * the levels), the categories and the committees. Anyone with the module
 * may read them.
 */
export function useRiskSettings() {
  const [settings, setSettings] = useState<RiskSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
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
  }, [round]);
  return { settings, failed, reload: () => setRound((n) => n + 1) };
}

/** Client text in the reader's language, else the client's own default. */
export function usePick(lang: string) {
  const session = useSession();
  return (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
}

/**
 * A band's name as the client calls it in the matrix in use, else the
 * starting name. A band is never shown by its colour alone.
 */
export function useBandWord(t: RisksText, lang: string, matrix: Matrix | null | undefined) {
  const inLang = usePick(lang);
  return (band: Band) => {
    const named = matrix?.bands.find((b) => b.code === band)?.name;
    return (named && inLang(named)) || t.bands[band];
  };
}

/** A band, by its name and tone, with the score where there is room: "High · 12". */
export function BandPill({
  band,
  score,
  word,
  lang,
  label,
}: {
  band: Band;
  score?: number;
  word: (band: Band) => string;
  lang: string;
  /** What the rating is, before the band: "Target". */
  label?: string;
}) {
  const name = word(band);
  const text =
    score === undefined
      ? name
      : `${name} · ${numberFormat(lang).format(score)}`;
  return (
    <Pill
      tone={bandTone[band]}
      icon={
        band === "extreme" ? (
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
        ) : undefined
      }
    >
      {label ? (
        <>
          <span className="font-normal">{label}</span>
          <bdi>{text}</bdi>
        </>
      ) : (
        <bdi>{text}</bdi>
      )}
    </Pill>
  );
}

export function RatingPill({
  rating,
  word,
  lang,
  label,
}: {
  rating: Rating | null;
  word: (band: Band) => string;
  lang: string;
  label?: string;
}) {
  if (!rating) return null;
  return (
    <BandPill
      band={rating.band}
      score={rating.score}
      word={word}
      lang={lang}
      label={label}
    />
  );
}

const statusTone = {
  proposed: "warn",
  open: "ok",
  closed: "neutral",
  rejected: "neutral",
} as const satisfies Record<RiskStatus, string>;

export function StatusPill({ t, status }: { t: RisksText; status: RiskStatus }) {
  return <Pill tone={statusTone[status] ?? "neutral"}>{t.status[status]}</Pill>;
}

export function StandingPill({
  t,
  standing,
  acceptedUntil,
  lang,
}: {
  t: RisksText;
  standing: Standing | null;
  acceptedUntil?: string | null;
  lang: string;
}) {
  if (!standing || standing === "within") return null;
  if (standing === "above_accepted") {
    return (
      <Pill tone="neutral">
        {fill(t.standing.above_accepted, {
          day: dayFormat(lang)(acceptedUntil) ?? "",
        })}
      </Pill>
    );
  }
  return (
    <Pill tone={standing === "above_not_addressed" ? "danger" : "warn"}>
      {t.standing[standing]}
    </Pill>
  );
}

export function ReviewPill({
  t,
  review,
}: {
  t: RisksText;
  review: "due" | "overdue" | null;
}) {
  if (!review) return null;
  return (
    <Pill
      tone={review === "overdue" ? "danger" : "warn"}
      icon={<CalendarClock className="size-3 shrink-0" aria-hidden />}
    >
      {t.review[review]}
    </Pill>
  );
}

/** Up or down since the last review: an arrow, and the words. */
export function TrendMark({
  t,
  trend,
}: {
  t: RisksText;
  trend: "up" | "down" | null;
}) {
  if (!trend) return null;
  const Icon = trend === "up" ? ArrowUp : ArrowDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${trend === "up" ? "text-danger" : "text-accent"}`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {t.trend[trend]}
    </span>
  );
}

export function CommitteeMark({ name }: { name: string }) {
  return (
    <Pill tone="neutral" icon={<Users className="size-3 shrink-0" aria-hidden />}>
      <bdi>{name}</bdi>
    </Pill>
  );
}

/**
 * Wording a client wrote, which may be in any of its languages: shown in
 * the reader's, else another, with a plain note when it is not theirs.
 */
export function Wording({
  t,
  text,
  lang,
  className = "",
}: {
  t: RisksText;
  text: Localized | null | undefined;
  lang: string;
  className?: string;
}) {
  const inLang = usePick(lang);
  const shown = inLang(text);
  if (!shown) return <p className="text-sm text-muted">{t.text.none}</p>;
  const other = !text?.[lang];
  return (
    <div className={className}>
      <p dir="auto" className="text-sm break-words whitespace-pre-line">
        {shown}
      </p>
      {other && <p className="mt-1 text-xs text-muted">{t.text.notInYourLanguage}</p>}
    </div>
  );
}

/** A name from one of the maps the API sends, or a plain "someone". */
export function useNamer(lang: string, names: Partial<Names>, t: RisksText) {
  const inLang = usePick(lang);
  return {
    person: (id: string | null | undefined) =>
      (id && inLang(names.people?.[id])) || t.someone,
    unit: (id: string | null | undefined) =>
      id === null ? t.wholeOrganization : (id && inLang(names.units?.[id])) || t.someUnit,
    category: (id: string | null | undefined) =>
      (id && inLang(names.categories?.[id])) || "",
    committee: (id: string | null | undefined) =>
      (id && inLang(names.committees?.[id])) || t.someCommittee,
  };
}

/**
 * One risk as a row of a list: the register, my risks, the reviews due,
 * a committee's list and an incident's panel all show it so.
 */
export function RiskRow({
  t,
  lang,
  risk,
  names,
  word,
  extra,
}: {
  t: RisksText;
  lang: string;
  risk: RiskSummary;
  names: Partial<Names>;
  word: (band: Band) => string;
  /** More to say on this list: "Raised the risk". */
  extra?: ReactNode;
}) {
  const inLang = usePick(lang);
  const name = useNamer(lang, names, t);
  const day = dayFormat(lang);
  const category = name.category(risk.categoryId);
  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link
          href={riskPath(lang, risk.id)}
          className="font-medium text-accent hover:underline"
        >
          <bdi dir="ltr" className="whitespace-nowrap">
            {risk.reference}
          </bdi>
        </Link>
        {risk.current ? (
          <RatingPill rating={risk.current} word={word} lang={lang} />
        ) : (
          <Pill tone="neutral">{t.notRated}</Pill>
        )}
        {risk.status !== "open" && <StatusPill t={t} status={risk.status} />}
        <StandingPill
          t={t}
          standing={risk.standing}
          acceptedUntil={risk.acceptedUntil}
          lang={lang}
        />
        <ReviewPill t={t} review={risk.review} />
        {risk.escalatedToCommitteeId && (
          <CommitteeMark name={name.committee(risk.escalatedToCommitteeId)} />
        )}
        {risk.closureRequested && <Pill tone="warn">{t.closure.waiting}</Pill>}
        {(risk.rerateNeeded || risk.targetAboveCurrent) && (
          <Pill tone="warn">{t.rateAgain}</Pill>
        )}
        {extra}
      </div>
      <p className="mt-1.5 text-sm font-medium break-words">
        <Link href={riskPath(lang, risk.id)} className="hover:underline">
          <bdi>{inLang(risk.title)}</bdi>
        </Link>
      </p>
      <p className="mt-1 text-sm text-muted">
        <bdi>{name.unit(risk.orgUnitId)}</bdi>
        {category && (
          <>
            {" "}
            <span className="inline-block">
              {"· "}
              <bdi>{category}</bdi>
            </span>
          </>
        )}{" "}
        <span className="inline-block">
          {"· "}
          {fill(t.list.owner, { name: name.person(risk.ownerId) })}
        </span>
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {risk.target && (
          <span>
            {fill(t.list.target, {
              band: `${word(risk.target.band)} · ${numberFormat(lang).format(risk.target.score)}`,
            })}
          </span>
        )}
        <TrendMark t={t} trend={risk.trend} />
        {risk.nextReviewOn && risk.status === "open" && (
          <span>{fill(t.list.nextReview, { date: day(risk.nextReviewOn) ?? "" })}</span>
        )}
        {risk.actions.open > 0 && (
          <span className={risk.actions.overdue > 0 ? "font-medium text-danger" : ""}>
            {fill(risk.actions.overdue > 0 ? t.list.actionsOverdue : t.list.actionsOpen, {
              open: numberFormat(lang).format(risk.actions.open),
              overdue: numberFormat(lang).format(risk.actions.overdue),
            })}
          </span>
        )}
      </p>
    </li>
  );
}

/** A plain line saying the page could not be read, or is being read. */
export function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "danger" }) {
  const tones = {
    muted: "border-line bg-surface",
    warn: "border-warn bg-warn-soft",
    danger: "border-danger bg-danger-soft",
  };
  return (
    <p className={`rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>{children}</p>
  );
}
