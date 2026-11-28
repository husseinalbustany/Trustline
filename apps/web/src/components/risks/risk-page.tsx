"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import { useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { api, statusOf } from "@/lib/api";
import {
  dateTimeFormat,
  dayFormat,
  durationFormat,
  momentFrom,
  numberFormat,
} from "@/lib/format";
import { isReviewer } from "@/lib/identity";
import type {
  Control,
  Move,
  Risk,
  RiskAnswer,
  RiskInBrief,
  RiskGone,
} from "@/lib/risks";
import {
  CommitteeMark,
  RatingPill,
  ReviewPill,
  StandingPill,
  StatusPill,
  useBandWord,
  useNamer,
  usePick,
  useRiskSettings,
} from "./bits";
import type { RiskContext } from "./context";
import { ControlForm, LinkIncidentForm, AddActionForm, MoveFormFor, type FormMove } from "./risk-moves";
import {
  ActionRow,
  ActionsSection,
  ApprovalsSection,
  ControlsSection,
  Correct,
  IncidentsSection,
  NotesSection,
  Plain,
  RatingsSection,
  ReviewsSection,
  RiskDetails,
  TimelineSection,
} from "./risk-sections";
import type { RisksProps } from "./types";
import { useExplain } from "./use-explain";

/** The order the moves are offered in, most pressing first. */
const moveOrder: Move[] = [
  "accept_proposal",
  "reject_proposal",
  "approve_acceptance",
  "return_acceptance",
  "approve_closure",
  "return_closure",
  "review",
  "rate",
  "add_control",
  "add_action",
  "escalate",
  "de_escalate",
  "request_acceptance",
  "withdraw_acceptance",
  "link_incident",
  "close",
  "request_closure",
  "reopen",
];

/** Moves whose form sits in the section it changes. */
const inSection = new Set<FormMove>(["add_control", "edit_control", "add_action", "link_incident"]);

/** One risk: what it is, how it is rated and treated, and what can be done. */
export function RiskPage({ lang, t }: RisksProps) {
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const [answer, setAnswer] = useState<RiskAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [behind, setBehind] = useState(false);
  const [open, setOpen] = useState<FormMove | null>(null);
  const [editing, setEditing] = useState<Control | null>(null);
  const { settings } = useRiskSettings();
  const word = useBandWord(t, lang, settings?.matrix);
  const inLang = usePick(lang);
  const explain = useExplain(t, lang);
  const day = dayFormat(lang);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const numbers = numberFormat(lang);

  useEffect(() => {
    let current = true;
    api<RiskAnswer>(`/risks/${id}`)
      .then((next) => {
        if (!current) return;
        setAnswer(next);
        setProblem(null);
      })
      .catch((err) => current && setProblem(statusOf(err) === 404 ? t.notFound : t.loadError));
    return () => {
      current = false;
    };
  }, [id, t]);

  // Hidden pages stay mounted: no form, and no notice, waits there.
  useLayoutEffect(
    () => () => {
      setOpen(null);
      setEditing(null);
      setStale(false);
    },
    [],
  );

  const reload = async (changed = false) => {
    try {
      const next = await api<RiskAnswer>(`/risks/${id}`);
      setAnswer(next);
      setStale(changed);
      setBehind(false);
    } catch (err) {
      if (statusOf(err) === 404) setProblem(t.notFound);
      else setBehind(true);
    }
  };
  const adopt = (next: RiskAnswer) => {
    setAnswer(next);
    setStale(false);
  };

  const names = answer && answer.access === "full" ? answer : {};
  const name = useNamer(lang, names, t);

  const back = (
    <p className="mt-6 text-sm">
      <Link href={`/${lang}/risks`} className="text-accent hover:underline">
        {t.back}
      </Link>
    </p>
  );

  const shown = answer?.id === id ? answer : null;
  if (problem || !shown) {
    return (
      <>
        <EmptyState>{problem ?? t.loading}</EmptyState>
        {problem && <div className="text-center">{back}</div>}
      </>
    );
  }
  if (shown.access === "none") return <Gone t={t} lang={lang} risk={shown} back={back} />;
  if (shown.access === "summary") {
    return <InBrief t={t} lang={lang} risk={shown} word={word} inLang={inLang} back={back} />;
  }

  const risk: Risk = shown;
  const c: RiskContext = {
    t,
    lang,
    risk,
    settings,
    matrix: settings?.matrix ?? null,
    word,
    inLang,
    name,
    day,
    moment: (iso) => {
      const at = momentFrom(iso);
      return at ? moments.format(at) : "";
    },
    number: (n) => numbers.format(n),
    explain,
    adopt,
    reload,
    readOnly: isReviewer(session),
    suspended: session.tenant.subscription?.status === "suspended",
    timeZone: session.tenant.timeZone,
    months: (n) => durationFormat(lang)(n, "month"),
    policiesOn: hasModule(session, "policies"),
  };
  const moves = c.readOnly ? [] : moveOrder.filter((m) => risk.moves.includes(m));
  const close = () => {
    setOpen(null);
    setEditing(null);
  };
  const choose = (move: FormMove) => {
    setEditing(null);
    setOpen(move);
  };
  const form =
    open && !inSection.has(open) ? <MoveFormFor c={c} move={open} onClose={close} /> : null;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-baseline gap-x-3">
            <bdi dir="ltr" className="whitespace-nowrap text-muted">
              {risk.reference}
            </bdi>
            <bdi className="break-words">{inLang(risk.title)}</bdi>
          </span>
        }
        description={
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <StatusPill t={t} status={risk.status} />
            {risk.current ? (
              <RatingPill rating={risk.current} word={word} lang={lang} label={t.ratingKind.current} />
            ) : (
              <span>{t.notRated}</span>
            )}
            {risk.target && <RatingPill rating={risk.target} word={word} lang={lang} label={t.ratingKind.target} />}
            <StandingPill t={t} standing={risk.standing} acceptedUntil={risk.acceptedUntil} lang={lang} />
            <ReviewPill t={t} review={risk.review} />
            {risk.escalatedToCommitteeId && (
              <CommitteeMark name={name.committee(risk.escalatedToCommitteeId)} />
            )}
          </span>
        }
        actions={
          !c.readOnly &&
          risk.moves.includes("edit") && (
            <ButtonLink variant="secondary" href={`/${lang}/risks/${risk.id}/edit`}>
              {t.moves.edit}
            </ButtonLink>
          )
        }
      />

      {stale && (
        <p role="status" className="mt-4 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">
          {t.stale}
        </p>
      )}
      {behind && (
        <p role="alert" className="mt-4 rounded-md border border-danger bg-danger-soft px-3 py-2 text-sm">
          {t.behind}
        </p>
      )}
      {risk.status === "proposed" && (
        <p className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-sm">{t.proposal.waiting}</p>
      )}
      {risk.status === "rejected" && (
        <div className="mt-4 rounded-md border border-line bg-surface px-3 py-2">
          <p className="text-sm font-medium">{t.proposal.rejected}</p>
          {risk.rejectReason && <Plain text={risk.rejectReason} />}
          {risk.rejectReason && <Correct c={c} what={{ kind: "reject_reason", value: risk.rejectReason }} />}
        </div>
      )}

      {moves.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={t.movesLabel}>
          {moves.map((move, i) => (
            <Button
              key={move}
              variant={i === 0 ? "primary" : "secondary"}
              aria-expanded={open === move}
              onClick={() => (open === move ? close() : choose(move as FormMove))}
            >
              {move === "close" ? t.closure.close : move === "request_closure" ? t.closure.request : t.moves[move as keyof typeof t.moves]}
            </Button>
          ))}
        </div>
      )}
      {form && <div className="mt-4">{form}</div>}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <RiskDetails c={c} />
          <RatingsSection c={c} onMove={choose} />
          <ControlsSection
            c={c}
            onEdit={(control) => {
              setOpen("edit_control");
              setEditing(control);
            }}
            editing={
              open === "add_control" ? (
                <ControlForm c={c} onClose={close} />
              ) : open === "edit_control" && editing ? (
                <ControlForm key={editing.id} c={c} onClose={close} control={editing} />
              ) : null
            }
          />
          <ActionsSection
            c={c}
            adding={open === "add_action" ? <AddActionForm c={c} onClose={close} /> : null}
          />
          <ReviewsSection c={c} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <ApprovalsSection c={c} />
          <IncidentsSection
            c={c}
            linking={open === "link_incident" ? <LinkIncidentForm c={c} onClose={close} /> : null}
          />
          <NotesSection c={c} />
          <TimelineSection c={c} />
        </div>
      </div>
      {back}
    </>
  );
}

/** What one of its actions' owners reads of a risk: that much, and their actions. */
function InBrief({
  t,
  lang,
  risk,
  word,
  inLang,
  back,
}: RisksProps & {
  risk: RiskInBrief;
  word: RiskContext["word"];
  inLang: RiskContext["inLang"];
  back: React.ReactNode;
}) {
  const name = useNamer(lang, { people: risk.people ?? {}, units: risk.units ?? {} }, t);
  const day = dayFormat(lang);
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-baseline gap-x-3">
            <bdi dir="ltr" className="text-muted">{risk.reference}</bdi>
            <bdi>{inLang(risk.title)}</bdi>
          </span>
        }
        description={
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <StatusPill t={t} status={risk.status} />
            <RatingPill rating={risk.current} word={word} lang={lang} label={t.ratingKind.current} />
          </span>
        }
      />
      <p className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-sm">{t.inBrief}</p>
      <div className="mt-6">
        <Panel title={t.actions.yours}>
          {risk.actions.length === 0 ? (
            <EmptyState>{t.actions.empty}</EmptyState>
          ) : (
            <ul>
              {risk.actions.map((a) => (
                <ActionRow key={a.id} t={t} lang={lang} action={a} person={name.person} day={day} inLang={inLang} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
      {back}
    </>
  );
}

/** A risk the reader no longer sees, after their own decision or move. */
function Gone({
  t,
  lang,
  risk,
  back,
}: RisksProps & { risk: RiskGone; back: React.ReactNode }) {
  return (
    <>
      <PageHeader title={<bdi dir="ltr">{risk.reference}</bdi>} />
      <p role="status" className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-sm">
        {t.gone}
      </p>
      {back}
      <p className="text-sm">
        <Link href={`/${lang}/risks/mine`} className="text-accent hover:underline">
          {t.mine.title}
        </Link>
      </p>
    </>
  );
}
