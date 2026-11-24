"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, statusOf } from "@/lib/api";
import { dateTimeFormat, fill } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import {
  valueAfter,
  type AssignableUser,
  type Incident,
  type IncidentCategory,
  type IncidentEvent,
} from "@/lib/incidents";
import { pick, readForm, type Localized } from "@/lib/localized";
import { IncidentPills } from "./pills";
import { TriagePanel } from "./triage-panel";
import { explain, textareaClass, type IncidentsProps } from "./types";

/** One incident: the report, what has happened to it, and what can be done. */
export function IncidentDetail({ lang, t }: IncidentsProps) {
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const [loaded, setLoaded] = useState<Incident | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [categories, setCategories] = useState<IncidentCategory[]>([]);
  const [staff, setStaff] = useState<AssignableUser[]>([]);
  const [staffProblem, setStaffProblem] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The list of staff is for people who triage, wherever they do.
  const mayAssign = can(session, "incidents.triage");
  const listPath = `/${lang}/incidents`;

  useEffect(() => {
    let current = true;
    Promise.all([
      api<Incident>(`/incidents/${id}`),
      api<OrgUnit[]>("/org-units"),
      api<IncidentCategory[]>("/incident-categories"),
    ])
      .then(([incident, u, c]) => {
        if (!current) return;
        setLoaded(incident);
        setUnits(u);
        setCategories(c);
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 404 ? t.notFound : t.detail.loadError),
      );
    if (mayAssign) {
      api<AssignableUser[]>("/incidents/assignable-users")
        .then((people) => {
          if (!current) return;
          setStaff(people);
          setStaffProblem(false);
        })
        .catch(() => current && setStaffProblem(true));
    }
    return () => {
      current = false;
    };
  }, [id, mayAssign, t]);

  const refresh = () =>
    api<Incident>(`/incidents/${id}`)
      .then((incident) => {
        setLoaded(incident);
        setProblem(null);
      })
      .catch((err) =>
        setProblem(statusOf(err) === 404 ? t.notFound : t.detail.loadError),
      );

  const back = (
    <p className="mt-6 text-sm">
      <Link href={listPath} className="text-accent hover:underline">
        {t.detail.back}
      </Link>
    </p>
  );
  const incident = loaded?.id === id ? loaded : null;
  if (problem || !incident) {
    return (
      <>
        <EmptyState>{problem ?? t.loading}</EmptyState>
        {problem && <div className="text-center">{back}</div>}
      </>
    );
  }

  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const dates = dateTimeFormat(lang);
  const when = (iso: string) => dates.format(new Date(iso));
  const d = t.detail;
  // The list holds the units in use. One switched off since is named from
  // the incident itself when it can be, and otherwise described.
  const unitName = (unitId: string) => {
    const known =
      incident.units?.[unitId] ??
      [...units, incident.orgUnit, incident.ownerUnit].find(
        (u) => u?.id === unitId,
      )?.name;
    return known ? inLang(known) : t.inactiveUnit;
  };

  const facts: [string, ReactNode][] = [
    [d.type, t.type[incident.type]],
    [d.category, inLang(incident.category.name)],
    [d.where, inLang(incident.orgUnit.name)],
    [d.occurredAt, when(incident.occurredAt)],
    [d.reportedAt, when(incident.reportedAt)],
    [
      d.reportedBy,
      incident.reporter ? inLang(incident.reporter.name) : d.anonymous,
    ],
    [d.harmLevel, t.harm[incident.harmLevel]],
    [
      d.ownerUnit,
      incident.ownerUnit ? inLang(incident.ownerUnit.name) : d.ownerUnitNone,
    ],
  ];
  // Who it is assigned to is for the people handling it, not the reporter.
  if (incident.access === "full") {
    facts.push([
      d.assignedTo,
      incident.assignedTo ? inLang(incident.assignedTo.name) : d.assignedToNone,
    ]);
  }

  const written: [string, string | null][] = [
    [d.whatHappened, incident.description],
    [d.immediateAction, incident.immediateAction],
    [d.closureSummary, incident.closureSummary],
    [d.rejectionReason, incident.rejectionReason],
  ];

  /** A timeline entry in words: what happened, and the details under it. */
  const describe = (event: IncidentEvent): [string, string[]] => {
    const e = t.timeline.events;
    switch (event.kind) {
      case "triaged": {
        // Newer events hold only what changed; each line shows what is there.
        const details = event.details ?? {};
        const harmLevel = valueAfter(details.harmLevel);
        const ownerUnitId = valueAfter(details.ownerUnitId);
        const categoryId = valueAfter(details.categoryId);
        const category = categoryId
          ? inLang(
              incident.categories?.[categoryId] ??
                categories.find((c) => c.id === categoryId)?.name,
            )
          : "";
        return [
          e.triaged,
          [
            harmLevel ? t.harm[harmLevel] : "",
            valueAfter(details.isSentinel) ? t.sentinel : "",
            ownerUnitId
              ? fill(t.timeline.ownerUnit, { unit: unitName(ownerUnitId) })
              : "",
            category ? fill(t.timeline.category, { category }) : "",
          ].filter(Boolean),
        ];
      }
      case "assigned": {
        const { ownerUnitId, assignedTo } = event.details;
        const unit = unitName(ownerUnitId);
        if (!assignedTo) return [fill(e.assignedUnit, { unit }), []];
        // The event names the person by id only.
        const person =
          incident.people?.[assignedTo] ??
          staff.find((p) => p.id === assignedTo)?.name ??
          (incident.assignedTo?.id === assignedTo
            ? incident.assignedTo.name
            : null);
        return [
          person
            ? fill(e.assigned, { name: inLang(person), unit })
            : fill(e.assignedSomeone, { unit }),
          [],
        ];
      }
      case "status_changed":
        return [
          event.fromStatus && event.toStatus
            ? fill(e.status_changed, {
                from: t.status[event.fromStatus],
                to: t.status[event.toStatus],
              })
            : t.actions.done,
          [],
        ];
      case "commented":
        return [
          event.details?.visibility === "internal"
            ? e.commentedInternal
            : e.commented,
          [],
        ];
      default:
        return [e[event.kind], []];
    }
  };
  const noteOf = (event: IncidentEvent) =>
    event.kind === "status_changed" ||
    event.kind === "closed" ||
    event.kind === "rejected" ||
    event.kind === "reopened"
      ? event.details?.note
      : null;

  return (
    <>
      <PageHeader
        title={<bdi dir="ltr">{incident.reference}</bdi>}
        description={
          // Names a client wrote: each keeps its own direction.
          <>
            {t.type[incident.type]} · <bdi>{inLang(incident.category.name)}</bdi>{" "}
            · <bdi>{inLang(incident.orgUnit.name)}</bdi>
          </>
        }
        actions={
          <IncidentPills
            t={t}
            status={incident.status}
            harmLevel={incident.harmLevel}
            isSentinel={incident.isSentinel}
          />
        }
      />
      {incident.access === "reporter" && (
        <p className="mt-4 rounded-md bg-surface px-3 py-2 text-sm text-muted">
          {d.reporterView}
        </p>
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title={d.report}>
          <div className="flex flex-col gap-4 p-4">
            {written.map(
              ([label, text]) =>
                text && (
                  <div key={label}>
                    <h3 className="text-xs font-medium text-muted">{label}</h3>
                    <p
                      dir="auto"
                      className="mt-1 text-sm break-words whitespace-pre-wrap"
                    >
                      {text}
                    </p>
                  </div>
                ),
            )}
            <dl className="grid gap-x-6 gap-y-3 border-t border-line pt-4 text-sm sm:grid-cols-2">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-medium text-muted">{label}</dt>
                  <dd className="mt-0.5">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Panel>

        {incident.canTriage && (
          <div className="lg:col-start-2 lg:row-span-3 lg:row-start-1">
            <TriagePanel
              lang={lang}
              t={t}
              incident={incident}
              units={units}
              categories={categories}
              staff={staff}
              staffProblem={staffProblem}
              onChange={setLoaded}
              onStale={refresh}
            />
          </div>
        )}

        <Panel title={t.timeline.title}>
          <ol className="flex flex-col gap-4 p-4">
            {incident.events.map((event) => {
              const [headline, lines] = describe(event);
              const note = noteOf(event);
              const name = event.actor
                ? inLang(event.actor.name)
                : event.kind === "reported"
                  ? t.timeline.anonymousReporter
                  : t.timeline.unknownPerson;
              return (
                <li
                  key={event.id}
                  className="border-s-2 border-line ps-3 text-sm"
                >
                  <p className="font-medium">{headline}</p>
                  {lines.length > 0 && <p>{lines.join(" · ")}</p>}
                  {note && (
                    <p className="mt-1">
                      <span className="text-muted">{t.timeline.note} </span>
                      <bdi
                        dir="auto"
                        className="break-words whitespace-pre-wrap"
                      >
                        {note}
                      </bdi>
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-muted">
                    {fill(t.timeline.byline, {
                      name,
                      date: when(event.occurredAt),
                    })}
                  </p>
                </li>
              );
            })}
          </ol>
        </Panel>

        <Panel title={t.comments.title}>
          {incident.comments.length === 0 ? (
            <p className="px-4 pt-4 text-sm text-muted">{t.comments.empty}</p>
          ) : (
            <ul>
              {incident.comments.map((comment) => (
                <li
                  key={comment.id}
                  className="border-b border-line px-4 py-3 text-sm"
                >
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    {fill(t.timeline.byline, {
                      name: inLang(comment.author.name),
                      date: when(comment.createdAt),
                    })}
                    {comment.visibility === "internal" && (
                      <Pill tone="neutral">{t.comments.internal}</Pill>
                    )}
                  </p>
                  <p
                    dir="auto"
                    className="mt-1 break-words whitespace-pre-wrap"
                  >
                    {comment.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <CommentBox t={t} incident={incident} onAdded={refresh} />
        </Panel>
      </div>
      {back}
    </>
  );
}

function CommentBox({
  t,
  incident,
  onAdded,
}: {
  t: IncidentsProps["t"];
  incident: Incident;
  onAdded: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = t.comments;
  const full = incident.access === "full";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { body, visibility } = readForm(form);
    setBusy(true);
    setError(null);
    try {
      await api(`/incidents/${incident.id}/comments`, {
        method: "POST",
        // Someone who sees only their own report can only write to everyone.
        body: { body, visibility: full ? visibility : "everyone" },
      });
      form.reset();
      await onAdded();
    } catch (err) {
      setError(explain(err, t.errors));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-4">
      <Field label={c.body} help={full ? c.bodyHelp : c.reporterHelp}>
        <textarea
          name="body"
          required
          rows={3}
          maxLength={2000}
          dir="auto"
          className={textareaClass}
        />
      </Field>
      {full && (
        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="mb-1.5 font-medium">{c.visibility}</legend>
          {(["internal", "everyone"] as const).map((value) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name="visibility"
                value={value}
                defaultChecked={value === "internal"}
                className="mt-1 accent-accent"
              />
              {value === "internal"
                ? c.visibilityInternal
                : c.visibilityEveryone}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {c.submit}
        </Button>
      </div>
    </form>
  );
}
