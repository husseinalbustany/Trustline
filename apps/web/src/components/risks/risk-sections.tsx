"use client";

import { FileText, Lock, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { LocalizedField } from "@/components/ui/localized-field";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api } from "@/lib/api";
import { fill } from "@/lib/format";
import type { Localized } from "@/lib/localized";
import {
  actionPath,
  type Acceptance,
  type Action,
  type Control,
  type Rating,
  type RatingKind,
  type RiskAnswer,
  type Run,
  type TimelineEvent,
} from "@/lib/risks";
import { BandPill, RatingPill, Wording } from "./bits";
import type { FormMove } from "./risk-moves";
import type { RiskContext } from "./context";
import { MoveForm, TextBox, localizedOf, textOf } from "./move-form";
import { MatrixGrid } from "./rating";

type Props = { c: RiskContext };

/** A term and what it is, as one line of a description list. */
function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{term}</dt>
      <dd className="mt-0.5 text-sm break-words">{children}</dd>
    </div>
  );
}

/** What can be corrected, and how it is sent. */
type Correction =
  | { kind: "rating_rationale"; ratingId: string; value: Localized | null }
  | { kind: "review_comment"; reviewId: string; value: string }
  | { kind: "reject_reason"; value: string | null }
  | { kind: "control_reason"; controlId: string; value: string | null }
  | { kind: "note"; noteId: string; value: string }
  | { kind: "risk_text"; field: "title" | "cause" | "event" | "consequence"; value: Localized | null }
  | { kind: "close_reason"; value: string | null }
  | { kind: "link_text"; linkId: string; field: "note"; value: string | null };

/**
 * "Correct" beside a text a person wrote on the risk, for a manager:
 * the wording only, with the warning about personal details.
 */
export function Correct({ c, what }: Props & { what: Correction }) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const { t } = c;
  if (!c.risk.moves.includes("correct") || c.readOnly) return null;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-accent hover:underline"
      >
        {t.correct.open}
      </button>
    );
  }
  const localized = typeof what.value === "object";
  const { value, ...ids } = what;
  return (
    <div className="mt-2">
      <MoveForm
        t={t}
        title={fill(t.correct.titleOf, { what: t.correct.kind[what.kind] })}
        intro={t.form.noPersonalDetails}
        confirm={t.correct.save}
        explain={c.explain}
        onStale={() => c.reload(true)}
        onClose={() => setOpen(false)}
        onDone={c.adopt}
        onSubmit={(data) =>
          api<RiskAnswer>(`/risks/${c.risk.id}/corrections`, {
            method: "POST",
            body: {
              revision: c.risk.revision,
              ...ids,
              text: localized
                ? localizedOf(data, "text", session.tenant.locales)
                : textOf(data, "text"),
            },
          })
        }
      >
        {localized ? (
          <LocalizedField
            label={t.correct.text}
            name="text"
            locales={session.tenant.locales}
            multiline={what.kind !== "risk_text" || what.field !== "title"}
            required={what.kind === "risk_text" && what.field === "title" ? session.tenant.defaultLocale : undefined}
            maxLength={what.kind === "risk_text" ? (what.field === "title" ? 300 : 4000) : 1000}
            value={value as Localized | null}
          />
        ) : (
          <CorrectText value={value as string | null} max={what.kind === "review_comment" || what.kind === "note" ? 4000 : 1000} label={t.correct.text} />
        )}
      </MoveForm>
    </div>
  );
}

function CorrectText({ value, max, label }: { value: string | null; max: number; label: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {label}
      <textarea
        name="text"
        required
        rows={3}
        maxLength={max}
        dir="auto"
        defaultValue={value ?? ""}
        className="w-full rounded-md border border-line bg-background px-3 py-2 text-sm font-normal"
      />
    </label>
  );
}

/** Plain text a person wrote, shown as it is. */
export function Plain({ text }: { text: string | null | undefined }) {
  return (
    <p dir="auto" className="text-sm break-words whitespace-pre-line">
      {text}
    </p>
  );
}

export function RiskDetails({ c }: Props) {
  const { t, risk, lang } = c;
  const f = t.fields;
  const block = (field: "cause" | "event" | "consequence") => (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs text-muted">{t.form[field]}</h3>
      <Wording t={t} text={risk[field]} lang={lang} />
      <Correct c={c} what={{ kind: "risk_text", field, value: risk[field] }} />
    </div>
  );
  return (
    <Panel title={t.sections.risk}>
      <div className="flex flex-col gap-4 p-4">
        {block("cause")}
        {block("event")}
        {block("consequence")}
        <dl className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Item term={f.unit}>
            <bdi>{c.name.unit(risk.orgUnitId)}</bdi>
          </Item>
          <Item term={f.category}>
            <bdi>{c.name.category(risk.categoryId)}</bdi>
          </Item>
          <Item term={f.owner}>
            <bdi>{c.name.person(risk.ownerId)}</bdi>
          </Item>
          <Item term={f.source}>{t.source[risk.source]}</Item>
          <Item term={f.tolerance}>
            <BandPill band={risk.tolerance} word={c.word} lang={lang} />
          </Item>
          {risk.references.length > 0 && (
            <Item term={f.references}>
              <ul className="flex flex-wrap gap-1.5">
                {risk.references.map((r) => (
                  <li key={r}>
                    <Pill tone="neutral">
                      <bdi>{r}</bdi>
                    </Pill>
                  </li>
                ))}
              </ul>
            </Item>
          )}
          {risk.keywords.length > 0 && (
            <Item term={f.keywords}>
              <bdi>{risk.keywords.join(", ")}</bdi>
            </Item>
          )}
          <Item term={f.created}>
            {fill(t.byOn, { name: c.name.person(risk.createdBy), date: c.moment(risk.createdAt) })}
          </Item>
        </dl>
        {(risk.status === "rejected" || risk.status === "closed") && (
          <Correct c={c} what={{ kind: "risk_text", field: "title", value: risk.title }} />
        )}
      </div>
    </Panel>
  );
}

export function RatingsSection({
  c,
  onMove,
}: Props & { onMove: (move: FormMove) => void }) {
  const { t, risk, lang, matrix } = c;
  const kinds = ["inherent", "current", "target"] as const;
  const latest = (kind: RatingKind) => risk.ratings.find((r) => r.kind === kind);
  const offered = risk.moves.includes("rate") && !c.readOnly;
  return (
    <Panel title={t.sections.ratings}>
      <div className="flex flex-col gap-4 p-4">
        {risk.currentAboveInherent && (
          <p className="flex gap-2 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t.rating.currentAboveInherent}
          </p>
        )}
        {risk.rerateNeeded && <p className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">{t.rating.rerateNeeded}</p>}
        {risk.targetAboveCurrent && <p className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">{t.targetAboveCurrent}</p>}
        <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_auto]">
          <ul className="flex flex-col gap-3">
            {kinds.map((kind) => {
              const rating: Rating | null = risk[kind];
              const record = latest(kind);
              return (
                <li key={kind} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t.ratingKind[kind]}</span>
                    {rating ? (
                      <RatingPill rating={rating} word={c.word} lang={lang} />
                    ) : (
                      <span className="text-sm text-muted">{t.notRated}</span>
                    )}
                    {rating && (
                      <span className="text-xs text-muted">
                        {fill(t.rating.levels, {
                          likelihood: c.number(rating.likelihood),
                          impact: c.number(rating.impact),
                        })}
                      </span>
                    )}
                  </div>
                  {record?.rationale && (
                    <Wording t={t} text={record.rationale} lang={lang} className="ps-1 text-muted" />
                  )}
                  {record && (
                    <p className="text-xs text-muted">
                      {fill(t.byOn, { name: c.name.person(record.ratedBy), date: c.moment(record.ratedAt) })}
                    </p>
                  )}
                  {record && (
                    <Correct c={c} what={{ kind: "rating_rationale", ratingId: record.id, value: record.rationale }} />
                  )}
                </li>
              );
            })}
            {risk.nextReviewOn && risk.status === "open" && (
              <li className="text-sm">
                {fill(t.list.nextReview, { date: c.day(risk.nextReviewOn) ?? "" })}
              </li>
            )}
          </ul>
          {matrix && (
            <MatrixGrid
              t={t}
              lang={lang}
              matrix={matrix}
              ratings={{ inherent: risk.inherent, current: risk.current, target: risk.target }}
              word={c.word}
            />
          )}
        </div>
        {offered && (
          <div>
            <Button variant="secondary" onClick={() => onMove("rate")}>
              {t.moves.rate}
            </Button>
          </div>
        )}
        {risk.ratings.length > 0 && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {fill(t.rating.history, { count: c.number(risk.ratings.length) })}
            </summary>
            <ol className="mt-2 flex flex-col gap-2 border-s-2 border-line ps-3">
              {risk.ratings.map((r) => (
                <li key={r.id} className="text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{t.ratingKind[r.kind]}</span>
                    <BandPill band={r.band} score={r.score} word={c.word} lang={lang} />
                    <span className="text-xs text-muted">
                      {fill(t.byOn, { name: c.name.person(r.ratedBy), date: c.moment(r.ratedAt) })}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </Panel>
  );
}

function ControlRow({
  c,
  control,
  onEdit,
}: Props & { control: Control; onEdit: () => void }) {
  const { t, lang } = c;
  const k = t.controls;
  const doc = control.document;
  const tone = {
    not_assessed: "neutral",
    effective: "ok",
    partly_effective: "warn",
    ineffective: "danger",
  } as const;
  return (
    <li className={`border-b border-line px-4 py-3 last:border-b-0 ${control.active ? "" : "bg-surface"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone[control.effectiveness]}>{t.control.effectiveness[control.effectiveness]}</Pill>
        <Pill tone="neutral">{t.control.kind[control.kind]}</Pill>
        {control.hierarchy && <Pill tone="neutral">{t.control.hierarchy[control.hierarchy]}</Pill>}
        {!control.active && <Pill tone="neutral">{k.off}</Pill>}
        {control.flag && <Pill tone="warn">{t.controls.flag[control.flag]}</Pill>}
      </div>
      <Wording t={t} text={control.description} lang={lang} className="mt-1.5" />
      <p className="mt-1 text-xs text-muted">
        {fill(k.ownedBy, { name: c.name.person(control.ownerId) })}
        {control.assessedOn && (
          <>
            {" "}
            <span className="inline-block">
              {"· "}
              {fill(k.assessed, { date: c.day(control.assessedOn) ?? "" })}
            </span>
          </>
        )}
      </p>
      {doc && (
        <p className="mt-1 flex items-center gap-1.5 text-sm">
          {doc.restricted && !doc.title ? (
            <>
              <Lock className="size-3.5 shrink-0 text-muted" aria-hidden />
              <span className="text-muted">{t.document.restricted}</span>
            </>
          ) : (
            <>
              <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />
              <Link href={`/${lang}/policies/${doc.id}`} className="text-accent hover:underline">
                <bdi dir="ltr">{doc.number}</bdi> <bdi>{c.inLang(doc.title)}</bdi>
              </Link>
            </>
          )}
        </p>
      )}
      {!control.active && control.inactiveReason && (
        <div className="mt-1 text-sm">
          <span className="text-xs text-muted">{k.offReason}</span>
          <Plain text={control.inactiveReason} />
          <Correct c={c} what={{ kind: "control_reason", controlId: control.id, value: control.inactiveReason }} />
        </div>
      )}
      {control.active && c.risk.moves.includes("add_control") && !c.readOnly && (
        <button type="button" onClick={onEdit} className="mt-1 text-xs font-medium text-accent hover:underline">
          {k.edit}
        </button>
      )}
    </li>
  );
}

export function ControlsSection({
  c,
  onEdit,
  editing,
}: Props & { onEdit: (control: Control | null) => void; editing: ReactNode }) {
  const { t, risk } = c;
  return (
    <Panel title={t.sections.controls}>
      {risk.controls.length === 0 ? (
        <EmptyState>{t.controls.empty}</EmptyState>
      ) : (
        <ul>
          {risk.controls.map((control) => (
            <ControlRow key={control.id} c={c} control={control} onEdit={() => onEdit(control)} />
          ))}
        </ul>
      )}
      {editing && <div className="border-t border-line p-4">{editing}</div>}
    </Panel>
  );
}

const actionTone = {
  open: "neutral",
  in_progress: "warn",
  completed: "ok",
  verified: "ok",
  cancelled: "neutral",
} as const;

export function ActionRow({
  t,
  lang,
  action,
  person,
  day,
  inLang,
  extra,
}: {
  t: RiskContext["t"];
  lang: string;
  action: Action;
  person: (id: string) => string;
  day: (d: string | null | undefined) => string | null;
  inLang: RiskContext["inLang"];
  extra?: ReactNode;
}) {
  const a = t.actions;
  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Link href={actionPath(lang, action.id)} className="font-medium text-accent hover:underline">
          <bdi dir="ltr" className="whitespace-nowrap">
            {action.reference}
          </bdi>
        </Link>
        <Pill tone={actionTone[action.status]}>{a.status[action.status]}</Pill>
        {action.overdue && <Pill tone="danger">{a.overdue}</Pill>}
        {action.effectiveness && (
          <Pill tone={action.effectiveness === "effective" ? "ok" : "danger"}>
            {a.effectiveness[action.effectiveness]}
          </Pill>
        )}
        {extra}
      </div>
      <p className="mt-1.5 text-sm font-medium break-words">
        <bdi>{inLang(action.title)}</bdi>
      </p>
      <p className="mt-1 text-sm text-muted">
        {fill(a.ownerDue, { name: person(action.ownerId), date: day(action.dueOn) ?? "" })}{" "}
        <span className="inline-block">
          {"· "}
          {a.strengthShort[action.strength]}
        </span>
      </p>
      {action.dueMoved && (
        <p className="mt-1 text-xs text-muted">{fill(a.dueMoved, { day: day(action.originalDueOn) ?? "" })}</p>
      )}
    </li>
  );
}

export function ActionsSection({ c, adding }: Props & { adding: ReactNode }) {
  const { t, risk } = c;
  const a = t.actions;
  return (
    <Panel title={t.sections.treatment}>
      <div className="flex flex-col gap-3 p-4">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Item term={t.fields.treatment}>{risk.treatment ? t.treatment[risk.treatment] : t.none}</Item>
          <Item term={t.fields.targetOn}>{c.day(risk.targetOn) ?? t.none}</Item>
        </dl>
        {risk.actionSummary.allWeaker && (
          <p className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">{a.allWeaker}</p>
        )}
        {risk.actions.some((x) => x.effectiveness === "not_effective" && x.status === "verified") && (
          <p className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">{a.reRatePrompt}</p>
        )}
      </div>
      {risk.actions.length === 0 ? (
        <EmptyState>{a.empty}</EmptyState>
      ) : (
        <ul className="border-t border-line">
          {risk.actions.map((action) => (
            <ActionRow
              key={action.id}
              t={t}
              lang={c.lang}
              action={action}
              person={c.name.person}
              day={c.day}
              inLang={c.inLang}
            />
          ))}
        </ul>
      )}
      {adding && <div className="border-t border-line p-4">{adding}</div>}
    </Panel>
  );
}

export function ReviewsSection({ c }: Props) {
  const { t, risk } = c;
  return (
    <Panel title={t.sections.reviews}>
      {risk.reviews.length === 0 ? (
        <EmptyState>{t.reviews.empty}</EmptyState>
      ) : (
        <ul>
          {risk.reviews.map((r) => (
            <li key={r.id} className="border-b border-line px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="neutral">{t.review.outcome[r.outcome]}</Pill>
                {r.late && <Pill tone="warn">{t.review.late}</Pill>}
                <span className="text-sm">
                  {r.committeeId
                    ? fill(t.review.byCommittee, {
                        committee: c.name.committee(r.committeeId),
                        day: c.day(r.reviewedOn) ?? "",
                      })
                    : fill(t.reviews.byOn, {
                        name: c.name.person(r.reviewedBy),
                        day: c.day(r.reviewedOn) ?? "",
                      })}
                </span>
              </div>
              <div className="mt-1.5">
                <Plain text={r.comment} />
                <Correct c={c} what={{ kind: "review_comment", reviewId: r.id, value: r.comment }} />
              </div>
              {r.nextReviewOn && (
                <p className="mt-1 text-xs text-muted">
                  {fill(t.list.nextReview, { date: c.day(r.nextReviewOn) ?? "" })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RunSteps({ c, run, signatures }: Props & { run: Run; signatures: { id: string; userId: string; meaning: string; signedAt: string }[] }) {
  const { t } = c;
  const s = t.steps;
  return (
    <ol className="mt-2 flex flex-col gap-2 border-s-2 border-line ps-3">
      {run.steps.map((step) => {
        const signature = signatures.find((x) => x.id === step.signatureId);
        const who = step.decidedBy ?? step.assigneeUserId;
        return (
          <li key={step.position} className="text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {fill(s.position, { position: c.number(step.position) })} · {s.kind[step.kind]}
              </span>
              <Pill tone={step.status === "approved" ? "ok" : step.status === "returned" ? "danger" : "neutral"}>
                {(s.status as Record<string, string>)[step.status] ?? s.status.other}
              </Pill>
            </span>
            <span className="block text-xs text-muted">
              {who ? <bdi>{c.name.person(who)}</bdi> : s.byRole}
              {step.decidedAt && <> · {c.moment(step.decidedAt)}</>}
              {!step.decidedAt && step.dueAt && <> · {fill(s.due, { date: c.moment(step.dueAt) })}</>}
            </span>
            {signature && (
              <span className="block text-xs text-muted">
                {fill(s.signed, {
                  meaning: (s.meaning as Record<string, string>)[signature.meaning] ?? "",
                  date: c.moment(signature.signedAt),
                })}
              </span>
            )}
            {step.comment && <Plain text={step.comment} />}
          </li>
        );
      })}
    </ol>
  );
}

const acceptanceTone = {
  in_approval: "warn",
  accepted: "ok",
  returned: "danger",
  withdrawn: "neutral",
  lapsed: "neutral",
} as const;

function AcceptanceItem({ c, acceptance }: Props & { acceptance: Acceptance }) {
  const { t, lang } = c;
  const a = t.acceptance;
  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={acceptanceTone[acceptance.status]}>{a.status[acceptance.status]}</Pill>
        <BandPill band={acceptance.bandCode} score={acceptance.score} word={c.word} lang={lang} />
        <span className="text-sm">{fill(a.untilDay, { day: c.day(acceptance.untilOn) ?? "" })}</span>
      </div>
      {acceptance.lapsedReason && (
        <p className="mt-1 text-sm text-muted">{a.lapsed[acceptance.lapsedReason]}</p>
      )}
      <h4 className="mt-2 text-xs text-muted">{a.rationale}</h4>
      <Wording t={t} text={acceptance.rationale} lang={lang} />
      {acceptance.conditions && (
        <>
          <h4 className="mt-2 text-xs text-muted">{a.conditions}</h4>
          <Wording t={t} text={acceptance.conditions} lang={lang} />
        </>
      )}
      <p className="mt-1 text-xs text-muted">
        {fill(t.byOn, { name: c.name.person(acceptance.requestedBy), date: c.moment(acceptance.requestedAt) })}
      </p>
      {acceptance.run && <RunSteps c={c} run={acceptance.run} signatures={acceptance.signatures} />}
    </li>
  );
}

export function ApprovalsSection({ c }: Props) {
  const { t, risk } = c;
  const acceptances = risk.acceptances ?? [];
  const closure = risk.closure;
  if (!risk.escalatedToCommitteeId && acceptances.length === 0 && !closure) return null;
  return (
    <Panel title={t.sections.escalation}>
      {risk.escalatedToCommitteeId && (
        <p className="border-b border-line px-4 py-3 text-sm">
          {fill(t.escalation.before, { committee: c.name.committee(risk.escalatedToCommitteeId) })}
          {risk.escalatedAt && <span className="text-muted"> · {c.moment(risk.escalatedAt)}</span>}
        </p>
      )}
      {acceptances.length > 0 && (
        <>
          <h3 className="px-4 pt-3 text-sm font-medium">{t.acceptance.title}</h3>
          <ul>
            {acceptances.map((x) => (
              <AcceptanceItem key={x.id} c={c} acceptance={x} />
            ))}
          </ul>
        </>
      )}
      {closure && (closure.requestedAt || closure.closedAt) && (
        <div className="border-t border-line px-4 py-3">
          <h3 className="text-sm font-medium">{t.closure.title}</h3>
          {closure.closedAt ? (
            <p className="mt-1 text-sm">
              {fill(t.closure.closedByOn, { name: c.name.person(closure.closedBy), date: c.moment(closure.closedAt) })}
            </p>
          ) : (
            <p className="mt-1 text-sm">{t.closure.waiting}</p>
          )}
          {closure.mergedIntoId && (
            <p className="mt-1 text-sm">
              <Link href={`/${c.lang}/risks/${closure.mergedIntoId}`} className="text-accent hover:underline">
                {t.closure.mergedLink}
              </Link>
            </p>
          )}
          {closure.closeReason && (
            <div className="mt-2">
              <h4 className="text-xs text-muted">{t.closure.reason}</h4>
              <Plain text={closure.closeReason} />
              <Correct c={c} what={{ kind: "close_reason", value: closure.closeReason }} />
            </div>
          )}
          {closure.runs.map((run) => (
            <RunSteps key={run.id} c={c} run={run} signatures={closure.signatures} />
          ))}
        </div>
      )}
    </Panel>
  );
}

export function IncidentsSection({ c, linking }: Props & { linking: ReactNode }) {
  const { t, risk, lang } = c;
  const links = risk.incidents;
  const i = t.incidents;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!links) return null;
  async function unlink(linkId: string, form: HTMLFormElement) {
    const reason = textOf(new FormData(form), "reason");
    setBusy(linkId);
    setError(null);
    try {
      await api(`/risks/${risk.id}/incident-links/${linkId}`, { method: "DELETE", body: { reason } });
      form.reset();
      await c.reload();
    } catch (err) {
      setError(c.explain(err));
    }
    setBusy(null);
  }
  const mayLink = risk.moves.includes("link_incident") && !c.readOnly;
  return (
    <Panel title={i.title}>
      <p className="px-4 pt-3 text-sm text-muted">
        {fill(i.last12Months, { count: c.number(links.last12Months) })}
      </p>
      {links.items.length === 0 && links.hidden === 0 ? (
        <EmptyState>{i.empty}</EmptyState>
      ) : (
        <ul className="mt-2">
          {links.items.map((link) => (
            <li key={link.linkId} className="border-t border-line px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/${lang}/incidents/${link.incident.id}`} className="font-medium text-accent hover:underline">
                  <bdi dir="ltr">{link.incident.reference}</bdi>
                </Link>
                <Pill tone="neutral">{i.kind[link.kind]}</Pill>
                <span className="text-xs text-muted">{c.day(link.incident.occurredOn)}</span>
              </div>
              {link.note && (
                <div className="mt-1">
                  <Plain text={link.note} />
                  <Correct c={c} what={{ kind: "link_text", linkId: link.linkId, field: "note", value: link.note }} />
                </div>
              )}
              {mayLink && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs font-medium text-accent">{i.unlink}</summary>
                  <form
                    className="mt-2 flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void unlink(link.linkId, e.currentTarget);
                    }}
                  >
                    <TextBox label={i.unlinkReason} name="reason" rows={2} />
                    <div>
                      <Button type="submit" variant="secondary" disabled={busy === link.linkId}>
                        {i.unlink}
                      </Button>
                    </div>
                  </form>
                </details>
              )}
            </li>
          ))}
          {links.hidden > 0 && (
            <li className="border-t border-line px-4 py-3 text-sm text-muted">
              {fill(i.hidden, { count: c.number(links.hidden) })}
            </li>
          )}
        </ul>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-sm text-danger">
          {error}
        </p>
      )}
      {linking && <div className="border-t border-line p-4">{linking}</div>}
    </Panel>
  );
}

export function NotesSection({ c }: Props) {
  const { t } = c;
  const notes = c.risk.notes ?? [];
  if (notes.length === 0) return null;
  return (
    <Panel title={t.sections.notes}>
      <ul>
        {notes.map((n) => (
          <li key={n.id} className="border-b border-line px-4 py-3 last:border-b-0">
            <p className="text-xs text-muted">
              {t.notes.kind[n.kind]} · {fill(t.byOn, { name: c.name.person(n.writtenBy), date: c.moment(n.writtenAt) })}
              {n.correctedAt && <> · {t.notes.corrected}</>}
            </p>
            <Plain text={n.text} />
            <Correct c={c} what={{ kind: "note", noteId: n.id, value: n.text }} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** One timeline entry in words: never what someone wrote, but which note. */
export function eventLines(
  c: Pick<RiskContext, "t" | "name" | "day" | "word" | "number">,
  event: TimelineEvent,
  notes: { id: string; text: string }[] = [],
): { title: string; lines: string[] } {
  const { t } = c;
  const d = event.details ?? {};
  const events = t.events as Record<string, string>;
  const fields = t.fields as Record<string, string>;
  const rating = (r: unknown) => {
    const x = r as { band?: string; score?: number } | null;
    return x?.band ? `${c.word(x.band as Rating["band"])} · ${c.number(x.score ?? 0)}` : "";
  };
  const committee = c.name.committee(
    (d.committeeId as string | undefined) ?? null,
  );
  const title = fill(events[event.kind] ?? events.other, {
    kind:
      typeof d.kind === "string" && Object.hasOwn(t.ratingKind, d.kind)
        ? t.ratingKind[d.kind as RatingKind]
        : "",
    band: rating(d.to),
    score: "",
    reason: "",
    version: c.number(Number(d.version ?? 0)),
    committee,
    day: c.day(d.untilOn as string | undefined) ?? "",
    reference: String(d.incidentReference ?? ""),
  });
  const lines: string[] = [];
  const value = (field: string, v: unknown): string => {
    if (v === null || v === undefined || v === "") return t.none;
    if (field === "orgUnitId") return c.name.unit(v as string);
    if (field === "ownerId") return c.name.person(v as string);
    if (field === "categoryId") return c.name.category(v as string) || t.none;
    if (field === "treatment" && Object.hasOwn(t.treatment, String(v))) return t.treatment[v as keyof typeof t.treatment];
    if (field === "effectiveness" && Object.hasOwn(t.control.effectiveness, String(v)))
      return t.control.effectiveness[v as keyof typeof t.control.effectiveness];
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return c.day(v) ?? v;
    if (typeof v === "boolean") return v ? t.yes : t.no;
    return typeof v === "string" || typeof v === "number" ? String(v) : "";
  };
  if (event.kind === "updated" || event.kind === "control_updated") {
    for (const [field, change] of Object.entries(d)) {
      if (["reasonGiven", "noteId", "controlId"].includes(field)) continue;
      const name = fields[field] ?? field;
      const x = change as { changed?: boolean; from?: unknown; to?: unknown };
      if (x && typeof x === "object" && x.changed) lines.push(fill(t.text.changed, { field: name }));
      else if (x && typeof x === "object" && "to" in x)
        lines.push(fill(t.text.fromTo, { field: name, from: value(field, x.from), to: value(field, x.to) }));
    }
  }
  if (event.kind === "escalated") {
    lines.push(d.automatic ? t.escalation.automatic : t.escalation.byHand);
  }
  if (event.kind === "reviewed") {
    const outcome = String(d.outcome ?? "");
    if (Object.hasOwn(t.review.outcome, outcome))
      lines.push(t.review.outcome[outcome as keyof typeof t.review.outcome]);
    if (d.late) lines.push(t.review.late);
    const cur = d.current as { from?: unknown; to?: unknown } | undefined;
    if (cur?.to) lines.push(fill(t.text.fromTo, { field: t.ratingKind.current, from: rating(cur.from) || t.none, to: rating(cur.to) }));
  }
  if (event.kind === "rebanded") {
    const changed = d.bands as Record<string, { from?: unknown; to?: unknown }> | undefined;
    for (const [kind, x] of Object.entries(changed ?? {})) {
      if (Object.hasOwn(t.ratingKind, kind))
        lines.push(
          fill(t.text.fromTo, {
            field: t.ratingKind[kind as RatingKind],
            from: x.from ? c.word(x.from as Rating["band"]) : t.none,
            to: x.to ? c.word(x.to as Rating["band"]) : t.none,
          }),
        );
    }
  }
  if (event.kind === "text_corrected" && typeof d.kind === "string" && Object.hasOwn(t.correct.kind, d.kind)) {
    lines.push(t.correct.kind[d.kind as keyof typeof t.correct.kind]);
  }
  if (event.kind === "proposal_rejected" || d.reasonGiven) {
    const note = notes.find((n) => n.id === d.noteId);
    lines.push(note ? fill(t.text.reason, { reason: note.text }) : t.text.reasonGiven);
  }
  return { title, lines };
}

export function TimelineSection({ c }: Props) {
  const { t, risk } = c;
  return (
    <Panel title={t.sections.timeline}>
      {risk.events.length === 0 ? (
        <EmptyState>{t.timeline.empty}</EmptyState>
      ) : (
        <ol className="flex flex-col gap-3 p-4">
          {risk.events.map((event) => {
            const { title, lines } = eventLines(c, event, risk.notes);
            return (
              <li key={event.id} className="border-s-2 border-line ps-3">
                <p className="text-sm font-medium">{title}</p>
                {lines.map((line, i) => (
                  <p key={i} dir="auto" className="text-sm text-muted">
                    {line}
                  </p>
                ))}
                <p className="text-xs text-muted">
                  {event.actorId ? <bdi>{c.name.person(event.actorId)}</bdi> : t.timeline.system} · {c.moment(event.occurredAt)}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
