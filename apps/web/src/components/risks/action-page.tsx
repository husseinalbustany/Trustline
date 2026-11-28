"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, momentFrom } from "@/lib/format";
import { isReviewer } from "@/lib/identity";
import { pick } from "@/lib/localized";
import { riskPath, type ActionMove, type ActionPage as Loaded } from "@/lib/risks";
import { RatingPill, Wording, useBandWord, useNamer, usePick, useRiskSettings } from "./bits";
import { usePeople } from "./context";
import { MoveForm, TextBox, localizedOf, textOf } from "./move-form";
import { ActionFields } from "./risk-moves";
import { Plain } from "./risk-sections";
import type { RisksProps } from "./types";
import { useExplain } from "./use-explain";

const order: ActionMove[] = ["complete", "verify", "edit", "reopen", "cancel"];

/** One action on a risk: what is to be done, by whom and when, and its checks. */
export function ActionPage({ lang, t }: RisksProps) {
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const [action, setAction] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<ActionMove | "correct" | null>(null);
  const [stale, setStale] = useState(false);
  const { settings } = useRiskSettings();
  const word = useBandWord(t, lang, settings?.matrix);
  const inLang = usePick(lang);
  const explain = useExplain(t, lang);
  const day = dayFormat(lang);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const name = useNamer(lang, { people: action?.people ?? {}, units: action?.units ?? {} }, t);
  const people = usePeople(action?.people ?? {});
  const a = t.actions;

  useEffect(() => {
    let current = true;
    api<Loaded>(`/risks/actions/${id}`)
      .then((next) => {
        if (!current) return;
        setAction(next);
        setProblem(null);
      })
      .catch((err) => current && setProblem(statusOf(err) === 404 ? t.notFound : t.loadError));
    return () => {
      current = false;
    };
  }, [id, t]);

  useLayoutEffect(
    () => () => {
      setOpen(null);
      setStale(false);
    },
    [],
  );

  const reload = async (changed = false) => {
    try {
      setAction(await api<Loaded>(`/risks/actions/${id}`));
      setStale(changed);
    } catch (err) {
      if (statusOf(err) === 404) setProblem(t.notFound);
    }
  };

  if (problem || !action || action.id !== id) {
    return <EmptyState>{problem ?? t.loading}</EmptyState>;
  }
  const moment = (iso: string | null | undefined) => {
    const at = momentFrom(iso);
    return at ? moments.format(at) : "";
  };
  const moves = isReviewer(session) ? [] : order.filter((m) => action.moves.includes(m));
  const common = {
    t,
    onClose: () => setOpen(null),
    onStale: () => reload(true),
    explain,
    onDone: () => void reload(),
  };
  const post = (path: string, body: Record<string, unknown>) =>
    api(`/risks/actions/${action.id}/${path}`, {
      method: "POST",
      body: { revision: action.revision, ...body },
    });
  const tone = {
    open: "neutral",
    in_progress: "warn",
    completed: "ok",
    verified: "ok",
    cancelled: "neutral",
  } as const;

  const form = (() => {
    switch (open) {
      case "edit":
        return (
          <MoveForm
            {...common}
            title={a.moves.edit}
            confirm={t.save}
            onSubmit={(data) => {
              const progress = action.editable === "progress";
              const due = textOf(data, "dueOn");
              const status = textOf(data, "status");
              return api(`/risks/actions/${action.id}`, {
                method: "PATCH",
                body: {
                  revision: action.revision,
                  ...(progress
                    ? {}
                    : {
                        title: localizedOf(data, "title", session.tenant.locales),
                        description: localizedOf(data, "description", session.tenant.locales),
                        ownerId: textOf(data, "ownerId"),
                        strength: textOf(data, "strength"),
                        hierarchy: textOf(data, "hierarchy") ?? null,
                      }),
                  ...(due && due !== action.dueOn ? { dueOn: due, reason: textOf(data, "reason") } : {}),
                  ...(status && status !== action.status ? { status } : {}),
                },
              });
            }}
          >
            <ActionFields
              c={{ t, inLang, timeZone: session.tenant.timeZone }}
              action={action}
              people={people}
            />
            {(action.status === "open" || action.status === "in_progress") && (
              <Field label={a.fields.status}>
                <select name="status" defaultValue={action.status} className={`${inputClass} sm:max-w-56`}>
                  <option value="open">{a.status.open}</option>
                  <option value="in_progress">{a.status.in_progress}</option>
                </select>
              </Field>
            )}
            <TextBox label={a.dueReason} help={a.dueReasonHelp} name="reason" required={false} rows={2} />
          </MoveForm>
        );
      case "complete":
        return (
          <MoveForm
            {...common}
            title={a.moves.complete}
            confirm={a.moves.complete}
            onSubmit={(data) => post("complete", { note: textOf(data, "note") })}
          >
            <TextBox label={a.completionNote} help={a.completionHelp} name="note" max={4000} />
          </MoveForm>
        );
      case "verify":
        return (
          <MoveForm
            {...common}
            title={a.moves.verify}
            intro={a.verifyIntro}
            confirm={a.moves.verify}
            onSubmit={(data) =>
              post("verify", {
                outcome: textOf(data, "outcome"),
                ...(textOf(data, "note") ? { note: textOf(data, "note") } : {}),
              })
            }
          >
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{a.outcome}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {(["effective", "not_effective"] as const).map((o) => (
                  <label key={o} className="flex min-h-9 items-center gap-2 text-sm">
                    <input type="radio" name="outcome" value={o} required className="accent-accent" />
                    {a.effectiveness[o]}
                  </label>
                ))}
              </div>
            </fieldset>
            <TextBox label={a.verificationNote} name="note" required={false} max={4000} />
          </MoveForm>
        );
      case "cancel":
      case "reopen":
        return (
          <MoveForm
            {...common}
            title={a.moves[open]}
            confirm={a.moves[open]}
            onSubmit={(data) => post(open, { reason: textOf(data, "reason") })}
          >
            <TextBox label={a.reason} help={t.form.noPersonalDetails} name="reason" />
          </MoveForm>
        );
      default:
        return null;
    }
  })();

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-baseline gap-x-3">
            <bdi dir="ltr" className="text-muted">{action.reference}</bdi>
            <bdi className="break-words">{inLang(action.title)}</bdi>
          </span>
        }
        description={
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <Pill tone={tone[action.status]}>{a.status[action.status]}</Pill>
            {action.overdue && <Pill tone="danger">{a.overdue}</Pill>}
            {action.effectiveness && (
              <Pill tone={action.effectiveness === "effective" ? "ok" : "danger"}>
                {a.effectiveness[action.effectiveness]}
              </Pill>
            )}
          </span>
        }
      />
      {stale && (
        <p role="status" className="mt-4 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">
          {t.stale}
        </p>
      )}
      {action.effectiveness === "not_effective" && (
        <p className="mt-4 rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm">{a.reRatePrompt}</p>
      )}
      {moves.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label={t.movesLabel}>
          {moves.map((move, i) => (
            <Button
              key={move}
              variant={i === 0 ? "primary" : "secondary"}
              aria-expanded={open === move}
              onClick={() => setOpen(open === move ? null : move)}
            >
              {a.moves[move]}
            </Button>
          ))}
        </div>
      )}
      {form && <div className="mt-4">{form}</div>}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel title={a.details}>
          <dl className="grid gap-4 p-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted">{a.risk}</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
                <Link href={riskPath(lang, action.risk.id)} className="text-accent hover:underline">
                  <bdi dir="ltr">{action.risk.reference}</bdi>
                  {action.risk.title && (
                    <>
                      {" "}
                      <bdi>{pick(action.risk.title, lang, session.tenant.defaultLocale)}</bdi>
                    </>
                  )}
                </Link>
                <RatingPill rating={action.risk.current} word={word} lang={lang} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{a.fields.owner}</dt>
              <dd className="mt-0.5 text-sm"><bdi>{name.person(action.ownerId)}</bdi></dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t.fields.unit}</dt>
              <dd className="mt-0.5 text-sm"><bdi>{name.unit(action.orgUnitId)}</bdi></dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{a.fields.dueOn}</dt>
              <dd className="mt-0.5 text-sm">
                {day(action.dueOn)}
                {action.dueMoved && (
                  <span className="block text-xs text-muted">
                    {fill(a.dueMoved, { day: day(action.originalDueOn) ?? "" })}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{a.fields.strength}</dt>
              <dd className="mt-0.5 text-sm">{a.strength[action.strength]}</dd>
            </div>
            {action.hierarchy && (
              <div>
                <dt className="text-xs text-muted">{t.controls.hierarchyLabel}</dt>
                <dd className="mt-0.5 text-sm">{t.control.hierarchy[action.hierarchy]}</dd>
              </div>
            )}
            {action.description && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted">{a.fields.description}</dt>
                <dd className="mt-0.5">
                  <Wording t={t} text={action.description} lang={lang} />
                </dd>
              </div>
            )}
            {action.completionNote && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted">
                  {fill(a.completedByOn, { name: name.person(action.completedBy), date: moment(action.completedAt) })}
                </dt>
                <dd className="mt-0.5"><Plain text={action.completionNote} /></dd>
              </div>
            )}
            {action.verifiedAt && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted">
                  {fill(a.verifiedByOn, { name: name.person(action.verifiedBy), date: moment(action.verifiedAt) })}
                </dt>
                <dd className="mt-0.5">{action.verificationNote && <Plain text={action.verificationNote} />}</dd>
              </div>
            )}
            {action.cancelReason && (
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted">{a.cancelReason}</dt>
                <dd className="mt-0.5"><Plain text={action.cancelReason} /></dd>
              </div>
            )}
          </dl>
        </Panel>
        <Panel title={t.sections.timeline}>
          {action.events.length === 0 ? (
            <EmptyState>{t.timeline.empty}</EmptyState>
          ) : (
            <ol className="flex flex-col gap-3 p-4">
              {action.events.map((event) => {
                const d = event.details ?? {};
                const words = a.events as Record<string, string>;
                return (
                  <li key={event.id} className="border-s-2 border-line ps-3">
                    <p className="text-sm font-medium">
                      {fill(words[event.kind] ?? words.other, {
                        from: day(d.from as string | undefined) ?? "",
                        to: day(d.to as string | undefined) ?? "",
                      })}
                    </p>
                    {event.kind === "completed" && d.onTime === false && (
                      <p className="text-sm text-muted">{a.late}</p>
                    )}
                    {event.kind === "verified" && typeof d.outcome === "string" && Object.hasOwn(a.effectiveness, d.outcome) && (
                      <p className="text-sm text-muted">{a.effectiveness[d.outcome as "effective"]}</p>
                    )}
                    {!!d.reasonGiven && <p className="text-sm text-muted">{t.text.reasonGiven}</p>}
                    <p className="text-xs text-muted">
                      {event.actorId ? <bdi>{name.person(event.actorId)}</bdi> : t.timeline.system} · {moment(event.occurredAt)}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </div>
      <p className="mt-6 text-sm">
        <Link href={`/${lang}/risks/mine`} className="text-accent hover:underline">
          {t.mine.title}
        </Link>
      </p>
    </>
  );
}
